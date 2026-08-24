import type { GenericEvent } from '@argonprotocol/mainchain';
import {
  ACCOUNT_ACTIVITY_DEFINITION_VERSION,
  AccountActivityKind,
  readEventField,
  type BlockWatch,
  type BondLot,
  type IBlockHeaderInfo,
  type IIndexerSpec,
  type MainchainClients,
} from '@argonprotocol/apps-core';
import type { Db } from '../Db.ts';
import { findAddressActivity } from '../IndexerClient.ts';
import { SyncStateKeys, type IFinancialHistoryDomain, type ISyncSchemas } from '../db/SyncStateTable.ts';
import type { ArgonBonds } from '../ArgonBonds.ts';
import type { VaultHistory } from './MyVault.ts';
import type { BitcoinHistoryReplayLockScope, BitcoinLockRecovery } from './BitcoinLocks.ts';

type IIndexedActivityBlock = IIndexerSpec['/v2/activity/:address']['responseType']['blocks'][number];
export type { IFinancialHistoryDomain } from '../db/SyncStateTable.ts';
type IFinancialHistoryCheckpoint = NonNullable<
  NonNullable<ISyncSchemas[SyncStateKeys.FinancialHistory]['domainCheckpoints']>[IFinancialHistoryDomain]
>;

export function getEnabledFinancialHistoryDomains(args: {
  force: boolean;
  hasExtensionTreasury: boolean;
  hasExtensionOperations: boolean;
  walletAccountsHadPreviousLife: boolean;
}): IFinancialHistoryDomain[] {
  const restorePreviousLife = args.force || args.walletAccountsHadPreviousLife;
  const enabledDomains: IFinancialHistoryDomain[] = [];
  if (restorePreviousLife || args.hasExtensionTreasury) enabledDomains.push('bitcoin', 'bonds');
  if (restorePreviousLife || args.hasExtensionOperations) enabledDomains.push('vaulting');
  return enabledDomains;
}

export async function needsFinancialHistoryRecovery(args: {
  db: Db;
  accountId: string;
  enabledDomains: readonly IFinancialHistoryDomain[];
  bitcoinLockRecovery?: Pick<BitcoinLockRecovery, 'hasPendingHistoryRecovery'>;
  recoverMissingCheckpointsFor: readonly IFinancialHistoryDomain[];
}): Promise<boolean> {
  const savedState = await args.db.syncStateTable.get(SyncStateKeys.FinancialHistory);
  const domainCheckpoints = getDomainCheckpoints(savedState, args.accountId);

  return args.enabledDomains.some(domain => {
    if (domain === 'bitcoin' && args.bitcoinLockRecovery?.hasPendingHistoryRecovery) return true;

    const checkpoint = domainCheckpoints[domain];
    if (!checkpoint) return args.recoverMissingCheckpointsFor.includes(domain);

    const recoveryVersion = historyRecoveryVersions[domain];
    return (
      checkpoint.partialRecovery || (recoveryVersion !== undefined && checkpoint.recoveryVersion !== recoveryVersion)
    );
  });
}

export type IFinancialHistoryImportResult = {
  importedBlockCount: number;
  domainErrors: Partial<Record<IFinancialHistoryDomain, string>>;
  failedAtBlock?: number;
};

export type IFinancialHistoryRestoreResult = {
  importedBlockCount: number;
  asOfBlock: number;
  targetBlock: number;
};

const domainActivityMasks: Record<IFinancialHistoryDomain, number> = {
  bonds: AccountActivityKind.BondPosition,
  bitcoin: AccountActivityKind.BitcoinLock | AccountActivityKind.BitcoinMint,
  vaulting: AccountActivityKind.VaultPosition | AccountActivityKind.VaultRevenue,
};
const earliestSupportedSpecVersions: Record<IFinancialHistoryDomain, number> = {
  bonds: 151,
  bitcoin: 130,
  vaulting: 116,
};
const historyRecoveryVersions: Partial<Record<IFinancialHistoryDomain, number>> = {
  bitcoin: 8,
  bonds: 1,
};

export async function restoreFinancialHistory(args: {
  db: Db;
  blockWatch: BlockWatch;
  accountId: string;
  argonBonds: ArgonBonds;
  bitcoinLockRecovery?: BitcoinLockRecovery;
  vaultHistory: VaultHistory;
  enabledDomains: readonly IFinancialHistoryDomain[];
  recoverMissingCheckpointsFor: readonly IFinancialHistoryDomain[];
  mainchainClients?: MainchainClients;
  force?: boolean;
  minimumAsOfBlock?: number;
  onCheckStart?: () => void;
  onActiveBitcoinLocksFound?: (count: number) => void;
  onProgress?: (
    importedBlockCount: number,
    domainProgress?: {
      domain: IFinancialHistoryDomain;
      recoveredBlockCount: number;
      totalBlockCount: number;
    },
  ) => void;
  onDomainComplete?: (result: { domain: IFinancialHistoryDomain; asOfBlock: number; error?: string }) => void;
}): Promise<IFinancialHistoryRestoreResult> {
  const { db, blockWatch, accountId, argonBonds, bitcoinLockRecovery, vaultHistory } = args;
  const enabledDomains = [...new Set(args.enabledDomains)];
  const targetBlock = args.minimumAsOfBlock ?? blockWatch.finalizedBlockHeader.blockNumber;
  if (!enabledDomains.length) return { importedBlockCount: 0, asOfBlock: targetBlock, targetBlock };

  const savedState = await db.syncStateTable.get(SyncStateKeys.FinancialHistory);
  const domainCheckpoints = getDomainCheckpoints(savedState, accountId);

  const domainsToRestore = enabledDomains.filter(domain => {
    if (domain === 'bitcoin' && bitcoinLockRecovery?.hasPendingHistoryRecovery) return true;

    const checkpoint = domainCheckpoints[domain];
    if (!checkpoint) return args.force || args.recoverMissingCheckpointsFor.includes(domain);

    const recoveryVersion = historyRecoveryVersions[domain];
    const recoveryVersionChanged = recoveryVersion !== undefined && checkpoint.recoveryVersion !== recoveryVersion;
    return args.force || checkpoint.asOfBlock < targetBlock || recoveryVersionChanged;
  });
  const checkpointDomains = enabledDomains.filter(
    domain => domainCheckpoints[domain] || domainsToRestore.includes(domain),
  );
  for (const domain of enabledDomains) {
    if (domainsToRestore.includes(domain)) continue;

    args.onDomainComplete?.({
      domain,
      asOfBlock: domainCheckpoints[domain]?.asOfBlock ?? targetBlock,
    });
  }
  if (!domainsToRestore.length) {
    const asOfBlock = checkpointDomains.length
      ? Math.min(...checkpointDomains.map(domain => domainCheckpoints[domain]!.asOfBlock))
      : targetBlock;
    return { importedBlockCount: 0, asOfBlock, targetBlock };
  }

  args.onCheckStart?.();

  let importedBlockCount = 0;
  const recoveryErrors: string[] = [];
  const saveDomainCheckpoint = async (
    domain: IFinancialHistoryDomain,
    checkpoint: IFinancialHistoryCheckpoint,
  ): Promise<void> => {
    domainCheckpoints[domain] = checkpoint;

    const checkpoints = checkpointDomains.map(checkpointDomain => domainCheckpoints[checkpointDomain]);
    const aggregateAsOfBlock = Math.min(...checkpoints.map(saved => saved?.asOfBlock ?? 0));
    const aggregateCheckpoint = checkpoints.find(saved => saved?.asOfBlock === aggregateAsOfBlock);
    const recoveryVersions: Partial<Record<IFinancialHistoryDomain, number>> = {};
    for (const checkpointDomain of checkpointDomains) {
      const recoveryVersion = domainCheckpoints[checkpointDomain]?.recoveryVersion;
      if (recoveryVersion !== undefined) recoveryVersions[checkpointDomain] = recoveryVersion;
    }

    await db.syncStateTable.upsert(SyncStateKeys.FinancialHistory, {
      accountId,
      asOfBlock: aggregateAsOfBlock,
      ...(aggregateCheckpoint?.definitionVersion !== undefined
        ? { definitionVersion: aggregateCheckpoint.definitionVersion }
        : {}),
      ...(Object.keys(recoveryVersions).length ? { recoveryVersions } : {}),
      domains: checkpointDomains,
      domainCheckpoints,
    });
  };

  for (const domain of domainsToRestore) {
    let checkpoint = domainCheckpoints[domain];
    const isBitcoinReplay = domain === 'bitcoin' && !!bitcoinLockRecovery;
    let domainAsOfBlock = checkpoint?.asOfBlock ?? 0;
    let domainError: string | undefined;
    args.onProgress?.(importedBlockCount, {
      domain,
      recoveredBlockCount: 0,
      totalBlockCount: 0,
    });

    try {
      let result!: Awaited<ReturnType<typeof restoreFinancialHistoryDomain>>;
      for (let attempt = 0; attempt < 2; attempt += 1) {
        result = await restoreFinancialHistoryDomain({
          db,
          blockWatch,
          accountId,
          argonBonds,
          bitcoinLockRecovery,
          vaultHistory,
          domain,
          checkpoint,
          recoverMissingCheckpointsFor: args.recoverMissingCheckpointsFor,
          mainchainClients: args.mainchainClients,
          force: args.force,
          targetBlock,
          onActiveBitcoinLocksFound: args.onActiveBitcoinLocksFound,
          onProgress: (recoveredBlockCount, totalBlockCount) =>
            args.onProgress?.(importedBlockCount + recoveredBlockCount, {
              domain,
              recoveredBlockCount,
              totalBlockCount,
            }),
          onCheckpoint: checkpoint => saveDomainCheckpoint(domain, checkpoint),
        });

        if (isBitcoinReplay) {
          await bitcoinLockRecovery.commitHistoryReplay(true);
        }
        await saveDomainCheckpoint(domain, result.checkpoint);
        domainAsOfBlock = result.checkpoint.asOfBlock;

        if (attempt > 0 || !isBitcoinReplay || !result.retryFromStart) break;
        checkpoint = result.checkpoint;
      }

      importedBlockCount += result.importedBlockCount;
      if (result.error) throw new Error(result.error);
    } catch (error) {
      if (isBitcoinReplay) {
        try {
          await bitcoinLockRecovery.cancelHistoryReplay();
        } catch (recoveryError) {
          console.warn('Unable to release active Bitcoin locks after history recovery failed:', recoveryError);
        }
      }
      domainError = error instanceof Error ? error.message : `Unable to restore ${domain} history`;
      recoveryErrors.push(domainError);
      if (isBitcoinReplay && args.mainchainClients) {
        await bitcoinLockRecovery.recoverActiveLockCreationDetails(args.mainchainClients).catch(recoveryError => {
          console.warn('Unable to restore active Bitcoin lock creation details:', recoveryError);
        });
      }
    } finally {
      args.onDomainComplete?.({
        domain,
        asOfBlock: domainAsOfBlock,
        ...(domainError ? { error: domainError } : {}),
      });
    }
  }

  if (recoveryErrors.length) throw new Error(recoveryErrors.join(' '));

  const asOfBlock = Math.min(...checkpointDomains.map(domain => domainCheckpoints[domain]!.asOfBlock));
  return { importedBlockCount, asOfBlock, targetBlock };
}

export class FinancialHistoryImporter {
  private readonly blockWatch: BlockWatch;
  private readonly argonBonds: Pick<ArgonBonds, 'importHistoryBlock'>;
  private readonly vaultHistory: Pick<VaultHistory, 'importBlock'>;
  private readonly enabledDomains: readonly IFinancialHistoryDomain[];
  private readonly bitcoinLockRecovery?: Pick<BitcoinLockRecovery, 'markHistoryReplayFailure' | 'recoverBlock'>;

  constructor({
    blockWatch,
    argonBonds,
    vaultHistory,
    enabledDomains,
    bitcoinLockRecovery,
  }: {
    blockWatch: BlockWatch;
    argonBonds: Pick<ArgonBonds, 'importHistoryBlock'>;
    vaultHistory: Pick<VaultHistory, 'importBlock'>;
    enabledDomains: readonly IFinancialHistoryDomain[];
    bitcoinLockRecovery?: Pick<BitcoinLockRecovery, 'markHistoryReplayFailure' | 'recoverBlock'>;
  }) {
    this.blockWatch = blockWatch;
    this.argonBonds = argonBonds;
    this.vaultHistory = vaultHistory;
    this.enabledDomains = enabledDomains;
    this.bitcoinLockRecovery = bitcoinLockRecovery;
  }

  public async importBlocks(
    indexedBlocks: readonly IIndexedActivityBlock[],
    options: {
      onProgress?: (importedBlockCount: number, totalBlockCount: number) => void;
      onCheckpoint?: (blockNumber: number) => Promise<void>;
    } = {},
  ): Promise<IFinancialHistoryImportResult> {
    const activityMask = this.enabledDomains.reduce((mask, domain) => mask | domainActivityMasks[domain], 0);
    const blocksByNumber = new Map(
      indexedBlocks.filter(block => (block.activityMask & activityMask) !== 0).map(block => [block.blockNumber, block]),
    );
    const backlog = [...blocksByNumber.values()].sort((left, right) => left.blockNumber - right.blockNumber);
    const domainErrors: Partial<Record<IFinancialHistoryDomain, string>> = {};
    let failedAtBlock: number | undefined;
    let importedBlockCount = 0;
    let lastCheckpointedBlockNumber: number | undefined;

    for (const indexedBlock of backlog) {
      for (const domain of this.enabledDomains) {
        if (!(indexedBlock.activityMask & domainActivityMasks[domain])) continue;
        const earliestSupportedSpecVersion = earliestSupportedSpecVersions[domain];
        if (indexedBlock.specVersion >= earliestSupportedSpecVersion) continue;

        const error =
          `Block ${indexedBlock.blockNumber.toLocaleString()} uses unsupported runtime spec ${indexedBlock.specVersion}; ` +
          `earliest supported for ${domain} is ${earliestSupportedSpecVersion}`;
        domainErrors[domain] ??= error;
        console.warn(`[FinancialHistory] ${error}; skipping this ${domain} block`);
        if (this.enabledDomains.length === 1) {
          failedAtBlock = Math.min(failedAtBlock ?? indexedBlock.blockNumber, indexedBlock.blockNumber);
        }
      }
    }
    const supportedBacklog = backlog.filter(indexedBlock => {
      return this.enabledDomains.some(domain => {
        return (
          (indexedBlock.activityMask & domainActivityMasks[domain]) !== 0 &&
          indexedBlock.specVersion >= earliestSupportedSpecVersions[domain]
        );
      });
    });
    let batchSize = 8;
    for (let start = 0; start < supportedBacklog.length; ) {
      const batch = supportedBacklog.slice(start, start + batchSize);
      const loadedBlocks = await Promise.allSettled(batch.map(indexedBlock => this.loadBlock(indexedBlock)));
      if (batchSize > 1 && loadedBlocks.some(result => result.status === 'rejected')) {
        // Archive RPCs can satisfy a direct block lookup but time out under concurrent historical reads.
        // No block has been imported yet, so retry this batch in order and keep the remaining replay bounded.
        batchSize = 1;
        continue;
      }

      let lastImportedBlockNumber: number | undefined;
      for (let index = 0; index < loadedBlocks.length; index += 1) {
        const loadedResult = loadedBlocks[index];
        const indexedBlock = batch[index];
        if (loadedResult.status === 'rejected') {
          const detail =
            loadedResult.reason instanceof Error ? loadedResult.reason.message : 'Unable to load historical block';
          for (const domain of this.enabledDomains) {
            if (!(indexedBlock.activityMask & domainActivityMasks[domain])) continue;

            let label: 'bitcoin' | 'bond' | 'vault' = 'vault';
            if (domain === 'bonds') label = 'bond';
            if (domain === 'bitcoin') label = 'bitcoin';
            const error = describeDomainError(label, indexedBlock.blockNumber, detail);
            domainErrors[domain] ??= error;
            console.warn(`[FinancialHistory] ${error}; skipping this block`);
          }
          failedAtBlock = Math.min(failedAtBlock ?? indexedBlock.blockNumber, indexedBlock.blockNumber);
          continue;
        }

        const loadedBlock = loadedResult.value;
        const hasImportError = await this.importBlock(loadedBlock, domainErrors);
        if (hasImportError && this.enabledDomains.length === 1) {
          failedAtBlock = Math.min(
            failedAtBlock ?? loadedBlock.indexedBlock.blockNumber,
            loadedBlock.indexedBlock.blockNumber,
          );
          continue;
        }
        importedBlockCount += 1;
        lastImportedBlockNumber = loadedBlock.indexedBlock.blockNumber;
        options.onProgress?.(importedBlockCount, supportedBacklog.length);
      }
      if (lastImportedBlockNumber !== undefined) {
        const checkpointBlockNumber =
          failedAtBlock === undefined ? lastImportedBlockNumber : Math.min(lastImportedBlockNumber, failedAtBlock - 1);
        if (
          checkpointBlockNumber >= 0 &&
          (lastCheckpointedBlockNumber === undefined || checkpointBlockNumber > lastCheckpointedBlockNumber)
        ) {
          await options.onCheckpoint?.(checkpointBlockNumber);
          lastCheckpointedBlockNumber = checkpointBlockNumber;
        }
      }
      start += batch.length;
    }

    return {
      importedBlockCount,
      domainErrors,
      ...(failedAtBlock !== undefined ? { failedAtBlock } : {}),
    };
  }

  private async loadBlock(indexedBlock: IIndexedActivityBlock) {
    const block = await this.blockWatch.getHeader(indexedBlock);
    if (block.blockHash.toLowerCase() !== indexedBlock.blockHash.toLowerCase()) {
      throw new Error(
        `Indexer hash mismatch at block ${indexedBlock.blockNumber.toLocaleString()}: expected ${indexedBlock.blockHash}, received ${block.blockHash}`,
      );
    }

    const { events, specVersion } = await this.blockWatch.getEventsWithSpec(block);
    if (specVersion !== indexedBlock.specVersion) {
      throw new Error(
        `Indexer runtime mismatch at block ${indexedBlock.blockNumber.toLocaleString()}: expected spec ${indexedBlock.specVersion}, received ${specVersion}`,
      );
    }
    return { indexedBlock, block, events };
  }

  private async importBlock(
    loadedBlock: Awaited<ReturnType<FinancialHistoryImporter['loadBlock']>>,
    domainErrors: Partial<Record<IFinancialHistoryDomain, string>>,
  ): Promise<boolean> {
    const { indexedBlock, block, events } = loadedBlock;
    let hasError = false;
    if (
      this.enabledDomains.includes('bonds') &&
      indexedBlock.specVersion >= earliestSupportedSpecVersions.bonds &&
      indexedBlock.activityMask & domainActivityMasks.bonds
    ) {
      try {
        await this.argonBonds.importHistoryBlock(block, events);
      } catch (error) {
        const detail = describeDomainError('bond', block.blockNumber, error);
        domainErrors.bonds ??= detail;
        console.warn(`[FinancialHistory] ${detail}; skipping this bond block`);
        hasError = true;
      }
    }
    if (
      this.enabledDomains.includes('vaulting') &&
      indexedBlock.specVersion >= earliestSupportedSpecVersions.vaulting &&
      indexedBlock.activityMask & domainActivityMasks.vaulting
    ) {
      try {
        await this.vaultHistory.importBlock(block, events);
      } catch (error) {
        const detail = describeDomainError('vault', block.blockNumber, error);
        domainErrors.vaulting ??= detail;
        console.warn(`[FinancialHistory] ${detail}; skipping this vault block`);
        hasError = true;
      }
    }
    if (
      this.enabledDomains.includes('bitcoin') &&
      indexedBlock.specVersion >= earliestSupportedSpecVersions.bitcoin &&
      indexedBlock.activityMask & domainActivityMasks.bitcoin
    ) {
      try {
        if (!this.bitcoinLockRecovery) throw new Error('Bitcoin lock history recovery is not configured');
        await this.bitcoinLockRecovery.recoverBlock(block, events);
      } catch (error) {
        this.bitcoinLockRecovery?.markHistoryReplayFailure();
        const detail = describeDomainError('bitcoin', block.blockNumber, error);
        domainErrors.bitcoin ??= detail;
        console.warn(`[FinancialHistory] ${detail}; skipping this Bitcoin block`);
        hasError = true;
      }
    }
    return hasError;
  }
}

async function restoreFinancialHistoryDomain(args: {
  db: Db;
  blockWatch: BlockWatch;
  accountId: string;
  argonBonds: ArgonBonds;
  bitcoinLockRecovery?: BitcoinLockRecovery;
  vaultHistory: VaultHistory;
  domain: IFinancialHistoryDomain;
  checkpoint?: IFinancialHistoryCheckpoint;
  recoverMissingCheckpointsFor: readonly IFinancialHistoryDomain[];
  mainchainClients?: MainchainClients;
  force?: boolean;
  targetBlock: number;
  onActiveBitcoinLocksFound?: (count: number) => void;
  onProgress?: (importedBlockCount: number, totalBlockCount: number) => void;
  onCheckpoint?: (checkpoint: IFinancialHistoryCheckpoint) => Promise<void>;
}): Promise<{
  checkpoint: IFinancialHistoryCheckpoint;
  importedBlockCount: number;
  error?: string;
  retryFromStart?: boolean;
}> {
  const { db, blockWatch, accountId, argonBonds, bitcoinLockRecovery, vaultHistory, domain, checkpoint } = args;
  const recoveryVersion = historyRecoveryVersions[domain];
  const recoveryVersionChanged =
    !!checkpoint && recoveryVersion !== undefined && checkpoint.recoveryVersion !== recoveryVersion;
  const hasPendingBitcoinRecovery = domain === 'bitcoin' && bitcoinLockRecovery?.hasPendingHistoryRecovery;
  const shouldRestartBitcoinRecovery =
    domain === 'bitcoin' && (hasPendingBitcoinRecovery || checkpoint?.partialRecovery);
  let afterBlock =
    args.force || !checkpoint || recoveryVersionChanged || shouldRestartBitcoinRecovery ? 0 : checkpoint.asOfBlock;

  if (domain === 'bitcoin' && bitcoinLockRecovery && afterBlock === 0) {
    if (args.mainchainClients) {
      const activeLocks = await bitcoinLockRecovery.recoverActiveLocks();
      args.onActiveBitcoinLocksFound?.(activeLocks.length);
    } else if (args.onActiveBitcoinLocksFound) {
      const finalizedApi = await blockWatch.getFinalizedApi();
      const activeLockIds = await bitcoinLockRecovery.findActiveLockIds(finalizedApi);
      args.onActiveBitcoinLocksFound(activeLockIds.length);
    }
  }

  let indexedHistory = await findAddressActivity(accountId, {
    afterBlock,
    toBlock: args.targetBlock,
    activityMask: domainActivityMasks[domain],
  });
  const minimumCompatibleDefinitionVersion = ACCOUNT_ACTIVITY_DEFINITION_VERSION - 1;
  if (indexedHistory.definitionVersion < minimumCompatibleDefinitionVersion) {
    throw new Error(
      `Activity index definition ${indexedHistory.definitionVersion} is older than the minimum compatible definition ${minimumCompatibleDefinitionVersion}`,
    );
  }

  const definitionChanged = !!checkpoint && checkpoint.definitionVersion !== indexedHistory.definitionVersion;
  if (afterBlock > 0 && definitionChanged) {
    afterBlock = 0;
    indexedHistory = await findAddressActivity(accountId, {
      afterBlock,
      toBlock: args.targetBlock,
      activityMask: domainActivityMasks[domain],
    });
  }

  if (indexedHistory.coverage.gaps.length) {
    const firstGap = indexedHistory.coverage.gaps[0];
    throw new Error(
      `Investment history index has a coverage gap from block ${firstGap.fromBlock.toLocaleString()} to ${firstGap.toBlock.toLocaleString()}: ${firstGap.reason}`,
    );
  }

  if (domain === 'bitcoin' && bitcoinLockRecovery) {
    let lockScope: BitcoinHistoryReplayLockScope = afterBlock === 0 ? 'all' : 'encountered';
    const canRepairOnlyPendingLocks =
      hasPendingBitcoinRecovery &&
      !checkpoint?.partialRecovery &&
      !args.force &&
      !recoveryVersionChanged &&
      !definitionChanged &&
      (!!checkpoint || !args.recoverMissingCheckpointsFor.includes(domain));
    if (canRepairOnlyPendingLocks) lockScope = 'pending';

    await bitcoinLockRecovery.beginHistoryReplay({ lockScope });
  }

  const backlog =
    afterBlock === 0
      ? indexedHistory.blocks
      : indexedHistory.blocks.filter(block => block.blockNumber > checkpoint!.asOfBlock);
  let importedBlockCount = 0;

  if (backlog.length) {
    const result = await new FinancialHistoryImporter({
      blockWatch,
      argonBonds,
      vaultHistory,
      enabledDomains: [domain],
      bitcoinLockRecovery,
    }).importBlocks(backlog, {
      onProgress: args.onProgress,
      async onCheckpoint(blockNumber) {
        await args.onCheckpoint?.({
          asOfBlock: blockNumber,
          definitionVersion: indexedHistory.definitionVersion,
          ...(recoveryVersion !== undefined ? { recoveryVersion } : {}),
          partialRecovery: true,
        });
      },
    });
    importedBlockCount = result.importedBlockCount;

    const domainError = result.domainErrors[domain];
    if (domainError) {
      return {
        importedBlockCount,
        error: domainError,
        ...(domain === 'bitcoin' && afterBlock > 0 ? { retryFromStart: true } : {}),
        checkpoint: {
          asOfBlock: Math.max(afterBlock, (result.failedAtBlock ?? afterBlock + 1) - 1),
          definitionVersion: indexedHistory.definitionVersion,
          ...(recoveryVersion !== undefined ? { recoveryVersion } : {}),
          partialRecovery: true,
        },
      };
    }
  }

  const recoveredThroughBlock = Math.min(indexedHistory.asOfBlock, args.targetBlock);
  if (domain === 'bonds' && backlog.some(block => block.activityMask & domainActivityMasks.bonds)) {
    await argonBonds.refreshHistory();
  }

  if (afterBlock === 0 && recoveredThroughBlock >= args.targetBlock) {
    if (domain === 'bonds') {
      const bondHistory = await db.bondLotHistoryTable.fetchAll(accountId);
      const activeBondLots = argonBonds.data.bondLots;
      const earliestEventBackedBondFrame = activeBondLots.length
        ? argonBonds.miningFrames.earliestWithSpec(earliestSupportedSpecVersions.bonds)
        : 0;
      if (hasMissingBondPurchases(activeBondLots, bondHistory, earliestEventBackedBondFrame)) {
        throw new Error('The indexer has not restored all active bond purchases yet');
      }
    }

    if (domain === 'bitcoin') {
      if (!bitcoinLockRecovery) throw new Error('Bitcoin lock history recovery is not configured');

      const finalizedApi = await blockWatch.getFinalizedApi();
      const missingLockIds = await bitcoinLockRecovery.findMissingActiveLockIds(finalizedApi);
      if (missingLockIds.length) {
        throw new Error(
          `The indexer has not restored active Bitcoin lock${missingLockIds.length === 1 ? '' : 's'} ${missingLockIds.join(', ')}`,
        );
      }
    }

    if (domain === 'vaulting') {
      const finalizedApi = await blockWatch.getFinalizedApi();
      const vaultId = await finalizedApi.query.vaults.vaultIdByOperator(accountId);
      if (vaultId.isSome) {
        const capitalHistory = await db.vaultCapitalHistoryTable.fetchAll(accountId, vaultId.unwrap().toNumber());
        if (capitalHistory[0]?.eventType !== 'created') {
          throw new Error('The indexer has not restored the vault creation event yet');
        }
      }
    }
  }

  return {
    importedBlockCount,
    checkpoint: {
      asOfBlock: recoveredThroughBlock,
      definitionVersion: indexedHistory.definitionVersion,
      ...(recoveryVersion !== undefined ? { recoveryVersion } : {}),
      ...(recoveredThroughBlock < args.targetBlock ? { partialRecovery: true } : {}),
    },
  };
}

function describeDomainError(domain: 'bitcoin' | 'bond' | 'vault', blockNumber: number, error: unknown): string {
  let detail = `Unable to decode ${domain} history`;
  if (error instanceof Error) detail = error.message;
  if (typeof error === 'string') detail = error;
  let label = 'Vault';
  if (domain === 'bond') label = 'Bond';
  if (domain === 'bitcoin') label = 'Bitcoin lock';
  return `${label} history failed at block ${blockNumber.toLocaleString()}: ${detail}`;
}

function hasMissingBondPurchases(
  activeBondLots: readonly BondLot[],
  history: readonly { programType: string; bondLotId: number; purchaseBlockHash?: string }[],
  earliestEventBackedBondFrame: number,
): boolean {
  return activeBondLots.some(lot => {
    // Pre-bond treasury allocations were migrated into Vault lots without a
    // BondLotPurchased event. Their created frame supplies the ARGN basis date.
    if (lot.programType === 'Vault' && lot.createdFrame < earliestEventBackedBondFrame) return false;

    return !history.some(record => {
      return record.programType === lot.programType && record.bondLotId === lot.id && !!record.purchaseBlockHash;
    });
  });
}

function getDomainCheckpoints(
  savedState: ISyncSchemas[SyncStateKeys.FinancialHistory] | null,
  accountId: string,
): NonNullable<ISyncSchemas[SyncStateKeys.FinancialHistory]['domainCheckpoints']> {
  if (savedState?.accountId !== accountId) return {};

  const domainCheckpoints = { ...savedState.domainCheckpoints };
  for (const domain of savedState.domains ?? []) {
    if (domainCheckpoints[domain]) continue;

    domainCheckpoints[domain] = {
      asOfBlock: savedState.asOfBlock,
      ...(savedState.definitionVersion !== undefined ? { definitionVersion: savedState.definitionVersion } : {}),
      ...(savedState.recoveryVersions?.[domain] !== undefined
        ? { recoveryVersion: savedState.recoveryVersions[domain] }
        : {}),
    };
  }
  return domainCheckpoints;
}

export function readRequiredEventField(
  event: Pick<GenericEvent, 'data' | 'method' | 'section'>,
  name: string,
  block: IBlockHeaderInfo,
) {
  const value = readEventField(event, name);
  if (value !== undefined) return value;

  throw new Error(
    `Historical ${event.section}.${event.method} at block ${block.blockNumber.toLocaleString()} is missing ${name}`,
  );
}

export function readRequiredEventNumber(
  event: Pick<GenericEvent, 'data' | 'method' | 'section'>,
  name: string,
  block: IBlockHeaderInfo,
): number {
  const value = Number(readRequiredEventField(event, name, block).toString());
  if (Number.isSafeInteger(value)) return value;

  throw new Error(
    `Historical ${event.section}.${event.method} at block ${block.blockNumber.toLocaleString()} has invalid ${name}`,
  );
}

export function readRequiredEventBigInt(
  event: Pick<GenericEvent, 'data' | 'method' | 'section'>,
  names: readonly string[],
  block: IBlockHeaderInfo,
): bigint {
  for (const name of names) {
    const value = readEventField(event, name);
    if (value !== undefined) return BigInt(value.toString());
  }

  throw new Error(
    `Historical ${event.section}.${event.method} at block ${block.blockNumber.toLocaleString()} is missing ${names.join(' or ')}`,
  );
}
