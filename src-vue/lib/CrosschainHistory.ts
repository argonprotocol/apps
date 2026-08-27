import {
  AccountActivityKind,
  bigIntMax,
  bigNumberToBigInt,
  type BlockWatch,
  Currency,
  type IIndexerSpec,
  MICROGONS_PER_ARGON,
  MICRONOTS_PER_ARGONOT,
  MoveToken,
  type RuntimeSystemEventRecord,
} from '@argonprotocol/apps-core';
import BigNumber from 'bignumber.js';
import { findAddressActivity } from './IndexerClient.ts';
import type { IGlobalCouncilApproval, IGlobalCouncilChange } from './GlobalCouncil.ts';
import type { WalletKeys } from './WalletKeys.ts';
import { FinancialCacheTypes, type FinancialCacheTable } from './db/FinancialCacheTable.ts';

export type ICrosschainHistoryDetails =
  | {
      kind: 'transferAuthorization';
      transferId: string;
      authoritySigningKey: string;
      authorityOwnerAccount?: string;
      sourceAccount: string;
      destinationAccount: string;
      moveToken: MoveToken.ARGN | MoveToken.ARGNOT;
      amount: bigint;
      microgonsPerArgonot: bigint;
      tip: bigint;
      tipValueMicrogons: bigint;
      microgonCollateral: bigint;
      micronotCollateral: bigint;
    }
  | {
      kind: 'councilApproval';
      queueNonce: bigint;
      targetKind: IGlobalCouncilApproval['targetKind'];
      targetValue: string;
      authorityOwnerAccount?: string;
      councilChange?: IGlobalCouncilChange;
    }
  | {
      kind: 'authorityLifecycle';
      action: 'registered';
      authoritySigningKey: string;
      queueNonce: bigint;
    };

export type ICrosschainHistoryRecord = {
  accountId: string;
  id: string;
  blockNumber: number;
  blockTime: Date;
  extrinsicIndex?: number;
  eventIndex: number;
  details: ICrosschainHistoryDetails;
};

type IFindAddressActivity = typeof findAddressActivity;
type IIndexedActivity = IIndexerSpec['/v2/activity/:address']['responseType'];
const INCOMPLETE_COVERAGE_RETRY_MILLIS = 2_500;
const INCOMPLETE_COVERAGE_RETRIES = 3;

export class CrosschainHistory {
  public data: {
    records: ICrosschainHistoryRecord[];
    isSyncing: boolean;
    coverageComplete: boolean;
    error?: string;
  } = {
    records: [],
    isSyncing: false,
    coverageComplete: false,
  };

  private refreshPromise?: Promise<void>;
  private refreshRequested = false;
  private refreshedThroughBlock = 0;
  private definitionVersion?: number;
  private readonly cacheRestorePromise: Promise<void>;

  constructor(
    private readonly walletKeys: Pick<WalletKeys, 'vaultingAddress'>,
    private readonly blockWatch: Pick<
      BlockWatch,
      'start' | 'finalizedBlockHeader' | 'getHeader' | 'getEventsWithSpec' | 'getBlock'
    >,
    private readonly financialCache?: Promise<FinancialCacheTable>,
    private readonly findActivity: IFindAddressActivity = findAddressActivity,
  ) {
    this.cacheRestorePromise = financialCache ? this.restoreCachedHistory() : Promise.resolve();
  }

  public refresh(): Promise<void> {
    if (this.refreshPromise) {
      this.refreshRequested = true;
      return this.refreshPromise;
    }

    const refresh = async () => {
      if (this.financialCache) await this.cacheRestorePromise;

      let incompleteCoverageRetries = 0;
      let retryIncompleteCoverage = false;
      do {
        this.refreshRequested = false;
        await this.refreshHistory();
        retryIncompleteCoverage =
          !this.data.coverageComplete && !this.data.error && incompleteCoverageRetries < INCOMPLETE_COVERAGE_RETRIES;
        if (retryIncompleteCoverage) {
          incompleteCoverageRetries += 1;
          await new Promise(resolve => setTimeout(resolve, INCOMPLETE_COVERAGE_RETRY_MILLIS));
        }
      } while (this.refreshRequested || retryIncompleteCoverage);
      if (!this.data.coverageComplete && !this.data.error) {
        this.data.error = 'Crosschain history is waiting for activity index coverage';
      }
    };
    this.refreshPromise = refresh().finally(() => {
      this.refreshPromise = undefined;
    });
    return this.refreshPromise;
  }

  public hasSeenRecipient(destinationAccount: string, excludeTransferId?: string): boolean | undefined {
    if (!this.data.coverageComplete) return undefined;

    const normalizedDestination = destinationAccount.toLowerCase();
    return this.data.records.some(record => {
      return (
        record.details.kind === 'transferAuthorization' &&
        record.details.destinationAccount.toLowerCase() === normalizedDestination &&
        record.details.transferId.toLowerCase() !== excludeTransferId?.toLowerCase()
      );
    });
  }

  public getSponsoredTransferValue(microgonsPerArgonot: bigint) {
    const transferIds = new Set<string>();

    return this.data.records.reduce((total, record) => {
      if (record.details.kind !== 'transferAuthorization') return total;

      const transferId = record.details.transferId.toLowerCase();
      if (transferIds.has(transferId)) return total;
      transferIds.add(transferId);

      if (record.details.moveToken === MoveToken.ARGN) return total + record.details.amount;
      return total + (record.details.amount * microgonsPerArgonot) / BigInt(MICRONOTS_PER_ARGONOT);
    }, 0n);
  }

  public getTransferTips(): bigint {
    return this.data.records.reduce((total, record) => {
      if (record.details.kind !== 'transferAuthorization') return total;
      return total + record.details.tipValueMicrogons;
    }, 0n);
  }

  private async refreshHistory(): Promise<void> {
    this.data.isSyncing = true;
    this.data.error = undefined;

    try {
      await this.blockWatch.start();

      const accountId = this.walletKeys.vaultingAddress;
      const targetBlock = this.blockWatch.finalizedBlockHeader.blockNumber;
      let afterBlock = this.refreshedThroughBlock;
      let indexedHistory = await this.findActivity(accountId, {
        afterBlock,
        toBlock: targetBlock,
        activityMask: AccountActivityKind.Fee,
      });

      const definitionChanged =
        this.definitionVersion !== undefined && this.definitionVersion !== indexedHistory.definitionVersion;
      if (definitionChanged) {
        afterBlock = 0;
        indexedHistory = await this.findActivity(accountId, {
          afterBlock,
          toBlock: targetBlock,
          activityMask: AccountActivityKind.Fee,
        });
      }
      if (indexedHistory.coverage.gaps.length) {
        throw new Error('Crosschain history is incomplete because the activity index has a coverage gap');
      }

      const records = await this.replay(indexedHistory);
      if (definitionChanged) this.data.records = [];

      const recordsById = new Map(this.data.records.map(record => [record.id, record]));
      for (const record of records) recordsById.set(record.id, record);
      this.data.records = [...recordsById.values()].sort(
        (left, right) => right.blockNumber - left.blockNumber || right.eventIndex - left.eventIndex,
      );

      const recoveredThroughBlock = Math.min(indexedHistory.asOfBlock, targetBlock);
      this.data.coverageComplete = recoveredThroughBlock >= targetBlock;
      this.refreshedThroughBlock = recoveredThroughBlock;
      this.definitionVersion = indexedHistory.definitionVersion;
      await this.cacheHistory(accountId);
    } catch (error) {
      this.data.coverageComplete = false;
      this.data.error = error instanceof Error ? error.message : String(error);
      console.warn('[CrosschainHistory] Unable to refresh indexed history', error);
    } finally {
      this.data.isSyncing = false;
    }
  }

  private async restoreCachedHistory(): Promise<void> {
    try {
      const cache = await this.financialCache;
      const accountId = this.walletKeys.vaultingAddress;
      const cached = await cache?.get(FinancialCacheTypes.CrosschainHistory, accountId);
      if (!cached) return;
      if (
        cached.records.some(record => {
          return (
            record.details.kind === 'transferAuthorization' &&
            (record.details.microgonsPerArgonot == null || record.details.tipValueMicrogons == null)
          );
        })
      ) {
        return;
      }

      this.data.records = cached.records;
      this.refreshedThroughBlock = cached.refreshedThroughBlock;
      this.definitionVersion = cached.definitionVersion;
    } catch (error) {
      console.warn('[CrosschainHistory] Unable to restore cached history', error);
    }
  }

  private async cacheHistory(accountId: string): Promise<void> {
    try {
      const cache = await this.financialCache;
      if (!cache || this.definitionVersion === undefined) return;

      await cache.upsert(FinancialCacheTypes.CrosschainHistory, accountId, {
        records: this.data.records,
        definitionVersion: this.definitionVersion,
        refreshedThroughBlock: this.refreshedThroughBlock,
      });
    } catch (error) {
      console.warn('[CrosschainHistory] Unable to cache indexed history', error);
    }
  }

  private async replay(indexedHistory: IIndexedActivity): Promise<ICrosschainHistoryRecord[]> {
    const records: ICrosschainHistoryRecord[] = [];
    const indexedBlocks = [...indexedHistory.blocks].sort((left, right) => left.blockNumber - right.blockNumber);

    for (const indexedBlock of indexedBlocks) {
      const block = await this.blockWatch.getHeader(indexedBlock.blockNumber);
      if (block.blockHash.toLowerCase() !== indexedBlock.blockHash.toLowerCase()) {
        throw new Error(`Crosschain history block hash mismatch at ${indexedBlock.blockNumber}`);
      }

      const { api, events, specVersion } = await this.blockWatch.getEventsWithSpec(block);
      if (specVersion !== indexedBlock.specVersion) {
        throw new Error(`Crosschain history runtime mismatch at ${indexedBlock.blockNumber}`);
      }

      const signedBlock = await this.blockWatch.getBlock(block);
      for (const [eventIndex, eventRecord] of events.entries()) {
        const details = await this.recoverOwnedEventDetails(api, signedBlock, eventRecord);
        if (!details) continue;

        const extrinsicIndex = eventRecord.phase.type === 'ApplyExtrinsic' ? eventRecord.phase.value : undefined;
        records.push({
          accountId: this.walletKeys.vaultingAddress,
          id: `${block.blockHash}:${eventIndex}`,
          blockNumber: block.blockNumber,
          blockTime: new Date(block.blockTime),
          extrinsicIndex,
          eventIndex,
          details,
        });
      }
    }

    return records;
  }

  private async recoverOwnedEventDetails(
    api: Awaited<ReturnType<BlockWatch['getApi']>>,
    signedBlock: Awaited<ReturnType<BlockWatch['getBlock']>>,
    eventRecord: RuntimeSystemEventRecord,
  ): Promise<ICrosschainHistoryDetails | undefined> {
    const { event, phase } = eventRecord;
    if (event.section !== 'crosschainTransfer') return;

    if (event.method === 'QueueEntryApprovalRecorded') {
      if (phase.type !== 'ApplyExtrinsic') return;
      const extrinsic = signedBlock.block.extrinsics[phase.value];
      if (!extrinsic?.isSigned || extrinsic.signer.toString() !== this.walletKeys.vaultingAddress) return;

      const { target, approvalQueueNonce } = event.data;
      if (target.type === 'MintingAuthorityActivation') {
        const targetValue = target.value;
        const authority = await api.query.crosschainTransfer.mintingAuthoritiesBySigner(targetValue);
        return {
          kind: 'councilApproval',
          queueNonce: approvalQueueNonce,
          targetKind: 'mintingAuthorityActivation',
          targetValue,
          ...(authority ? { authorityOwnerAccount: authority.accountId } : {}),
        };
      }
      if (target.type === 'MintingAuthorityDeactivation') {
        const targetValue = target.value;
        const authority = await api.query.crosschainTransfer.mintingAuthoritiesBySigner(targetValue);
        return {
          kind: 'councilApproval',
          queueNonce: approvalQueueNonce,
          targetKind: 'mintingAuthorityDeactivation',
          targetValue,
          ...(authority ? { authorityOwnerAccount: authority.accountId } : {}),
        };
      }
      if (target.type === 'GlobalIssuanceCouncilRotation') {
        const targetValue = target.value;
        const [activeCouncilHashOption, targetCouncilOption] = await Promise.all([
          api.query.crosschainTransfer.activeGlobalIssuanceCouncilByDestinationChain('Ethereum'),
          api.query.crosschainTransfer.globalIssuanceCouncilByHash(targetValue),
        ]);
        const activeCouncil = activeCouncilHashOption
          ? await api.query.crosschainTransfer.globalIssuanceCouncilByHash(activeCouncilHashOption)
          : undefined;
        const activeMemberAccounts = new Set(
          activeCouncil ? Object.values(activeCouncil.members).map(member => member.accountId) : [],
        );
        const targetCouncil = targetCouncilOption ?? undefined;
        const targetMemberAccounts = new Set(
          targetCouncil ? Object.values(targetCouncil.members).map(member => member.accountId) : [],
        );
        return {
          kind: 'councilApproval',
          queueNonce: approvalQueueNonce,
          targetKind: 'globalIssuanceCouncilRotation',
          targetValue,
          ...(targetCouncil
            ? {
                councilChange: {
                  vaultCount: targetMemberAccounts.size,
                  newVaultCount: [...targetMemberAccounts].filter(accountId => !activeMemberAccounts.has(accountId))
                    .length,
                  leavingVaultCount: [...activeMemberAccounts].filter(accountId => !targetMemberAccounts.has(accountId))
                    .length,
                  epochMicrogonsPerArgonot: targetCouncil.epochMicrogonsPerArgonot,
                },
              }
            : {}),
        };
      }
      return;
    }

    if (event.method === 'TransferCollateralized') {
      const transferId = event.data.transferId;
      const authoritySigningKey = event.data.destinationSigningKey;

      const authority = await api.query.crosschainTransfer.mintingAuthoritiesBySigner(authoritySigningKey);
      if (!authority) return;

      const authorityOwnerAccount = authority.accountId;
      if (authorityOwnerAccount !== this.walletKeys.vaultingAddress) {
        return;
      }
      const transfer = await api.query.crosschainTransfer.transferOutById(transferId);
      if (!transfer) return;

      const moveToken = transfer.asset.type === 'Argon' ? MoveToken.ARGN : MoveToken.ARGNOT;
      const microgonsPerArgonot = transfer.microgonsPerArgonot;
      const tip = transfer.mintingAuthorityTip;
      const microgonCollateral = event.data.microgonCollateral;
      const micronotCollateral = event.data.micronotCollateral;
      const amount = transfer.amount;
      const authorityTip = calculateMintingAuthorityTipShare({
        moveToken,
        mintingAuthorityTip: tip,
        totalCollateral: bigIntMax(amount, transfer.totalAttachedCollateral),
        microgonsPerArgonot,
        microgonCollateral,
        micronotCollateral,
      });
      return {
        kind: 'transferAuthorization',
        transferId,
        authoritySigningKey,
        authorityOwnerAccount,
        sourceAccount: transfer.argonAccountId,
        destinationAccount: transfer.destinationAccount,
        moveToken,
        amount,
        microgonsPerArgonot,
        tip: authorityTip,
        tipValueMicrogons: convertMintingAuthorityTipToMicrogons({
          moveToken,
          mintingAuthorityTip: authorityTip,
          microgonsPerArgonot,
        }),
        microgonCollateral,
        micronotCollateral,
      };
    }

    if (event.method === 'MintingAuthorityRegistered') {
      if (event.data.accountId !== this.walletKeys.vaultingAddress) return;
      return {
        kind: 'authorityLifecycle',
        action: 'registered',
        authoritySigningKey: event.data.destinationSigningKey,
        queueNonce: event.data.approvalQueueNonce,
      };
    }
  }
}

export function calculateMintingAuthorityTipShare(args: {
  moveToken: MoveToken.ARGN | MoveToken.ARGNOT;
  mintingAuthorityTip: bigint;
  totalCollateral: bigint;
  microgonsPerArgonot: bigint;
  microgonCollateral: bigint;
  micronotCollateral: bigint;
}): bigint {
  const {
    moveToken,
    mintingAuthorityTip,
    totalCollateral,
    microgonsPerArgonot,
    microgonCollateral,
    micronotCollateral,
  } = args;
  if (mintingAuthorityTip <= 0n || totalCollateral <= 0n) return 0n;

  const collateralShare =
    moveToken === MoveToken.ARGNOT
      ? micronotCollateral
      : microgonCollateral +
        bigNumberToBigInt(
          BigNumber(micronotCollateral).multipliedBy(microgonsPerArgonot).dividedBy(MICROGONS_PER_ARGON),
        );

  return bigNumberToBigInt(BigNumber(mintingAuthorityTip).multipliedBy(collateralShare).dividedBy(totalCollateral));
}

export function convertMintingAuthorityTipToMicrogons(args: {
  moveToken: MoveToken.ARGN | MoveToken.ARGNOT;
  mintingAuthorityTip: bigint;
  microgonsPerArgonot: bigint;
}): bigint {
  const { moveToken, mintingAuthorityTip, microgonsPerArgonot } = args;
  if (moveToken === MoveToken.ARGN) return mintingAuthorityTip;
  return Currency.convertMicronotToMicrogonAtPrice(mintingAuthorityTip, microgonsPerArgonot);
}
