import type { GenericEvent } from '@argonprotocol/mainchain';
import {
  AccountActivityKind,
  readEventField,
  type BlockWatch,
  type BondLot,
  type IBlockHeaderInfo,
  type IIndexerSpec,
} from '@argonprotocol/apps-core';
import type { Db } from '../Db.ts';
import { findAddressActivity } from '../IndexerClient.ts';
import { SyncStateKeys, type IFinancialHistoryDomain, type ISyncSchemas } from '../db/SyncStateTable.ts';
import type { ArgonBonds } from '../ArgonBonds.ts';
import type { VaultHistory } from './MyVault.ts';
import type { BitcoinLockRecovery } from './BitcoinLocks.ts';

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
  targetBlock: number;
  bitcoinLockRecovery?: Pick<BitcoinLockRecovery, 'hasPendingHistoryRecovery'>;
}): Promise<boolean> {
  const savedState = await args.db.syncStateTable.get(SyncStateKeys.FinancialHistory);
  const domainCheckpoints = getDomainCheckpoints(savedState, args.accountId);

  return args.enabledDomains.some(domain => {
    if (domain === 'bitcoin' && args.bitcoinLockRecovery?.hasPendingHistoryRecovery) return true;

    const checkpoint = domainCheckpoints[domain];
    const recoveryVersion = historyRecoveryVersions[domain];
    return (
      !checkpoint ||
      checkpoint.asOfBlock < args.targetBlock ||
      (recoveryVersion !== undefined && checkpoint.recoveryVersion !== recoveryVersion)
    );
  });
}

export type IFinancialHistoryImportResult = {
  importedBlockCount: number;
  domainErrors: Partial<Record<IFinancialHistoryDomain, string>>;
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
  bitcoin: 3,
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
  force?: boolean;
  minimumAsOfBlock?: number;
  onCheckStart?: () => void;
  onProgress?: (importedBlockCount: number) => void;
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
    const recoveryVersion = historyRecoveryVersions[domain];
    const recoveryVersionChanged = recoveryVersion !== undefined && checkpoint?.recoveryVersion !== recoveryVersion;
    return args.force || !checkpoint || checkpoint.asOfBlock < targetBlock || recoveryVersionChanged;
  });
  if (!domainsToRestore.length) {
    const asOfBlock = Math.min(...enabledDomains.map(domain => domainCheckpoints[domain]!.asOfBlock));
    return { importedBlockCount: 0, asOfBlock, targetBlock };
  }

  args.onCheckStart?.();

  let importedBlockCount = 0;
  const recoveryErrors: string[] = [];

  args.onProgress?.(0);
  for (const domain of domainsToRestore) {
    const checkpoint = domainCheckpoints[domain];
    const isBitcoinReplay = domain === 'bitcoin' && !!bitcoinLockRecovery;

    try {
      const result = await restoreFinancialHistoryDomain({
        db,
        blockWatch,
        accountId,
        argonBonds,
        bitcoinLockRecovery,
        vaultHistory,
        domain,
        checkpoint,
        force: args.force,
        targetBlock,
        onProgress: count => args.onProgress?.(importedBlockCount + count),
      });
      importedBlockCount += result.importedBlockCount;
      domainCheckpoints[domain] = result.checkpoint;

      const enabledCheckpoints = enabledDomains.map(enabledDomain => domainCheckpoints[enabledDomain]);
      const aggregateAsOfBlock = Math.min(...enabledCheckpoints.map(saved => saved?.asOfBlock ?? 0));
      const aggregateCheckpoint = enabledCheckpoints.find(saved => saved?.asOfBlock === aggregateAsOfBlock);
      const recoveryVersions: Partial<Record<IFinancialHistoryDomain, number>> = {};
      for (const enabledDomain of enabledDomains) {
        const recoveryVersion = domainCheckpoints[enabledDomain]?.recoveryVersion;
        if (recoveryVersion !== undefined) recoveryVersions[enabledDomain] = recoveryVersion;
      }

      if (isBitcoinReplay) {
        await bitcoinLockRecovery.commitHistoryReplay(result.checkpoint.asOfBlock >= targetBlock);
      }
      await db.syncStateTable.upsert(SyncStateKeys.FinancialHistory, {
        accountId,
        asOfBlock: aggregateAsOfBlock,
        ...(aggregateCheckpoint?.definitionVersion !== undefined
          ? { definitionVersion: aggregateCheckpoint.definitionVersion }
          : {}),
        ...(Object.keys(recoveryVersions).length ? { recoveryVersions } : {}),
        domains: enabledDomains,
        domainCheckpoints,
      });
    } catch (error) {
      if (isBitcoinReplay) bitcoinLockRecovery.cancelHistoryReplay();
      recoveryErrors.push(error instanceof Error ? error.message : `Unable to restore ${domain} history`);
    }
  }

  if (recoveryErrors.length) throw new Error(recoveryErrors.join(' '));

  const asOfBlock = Math.min(...enabledDomains.map(domain => domainCheckpoints[domain]!.asOfBlock));
  return { importedBlockCount, asOfBlock, targetBlock };
}

export class FinancialHistoryImporter {
  private readonly blockWatch: BlockWatch;
  private readonly argonBonds: Pick<ArgonBonds, 'importHistoryBlock'>;
  private readonly vaultHistory: Pick<VaultHistory, 'importBlock'>;
  private readonly enabledDomains: readonly IFinancialHistoryDomain[];
  private readonly bitcoinLockRecovery?: Pick<BitcoinLockRecovery, 'recoverBlock'>;

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
    bitcoinLockRecovery?: Pick<BitcoinLockRecovery, 'recoverBlock'>;
  }) {
    this.blockWatch = blockWatch;
    this.argonBonds = argonBonds;
    this.vaultHistory = vaultHistory;
    this.enabledDomains = enabledDomains;
    this.bitcoinLockRecovery = bitcoinLockRecovery;
  }

  public async importBlocks(
    indexedBlocks: readonly IIndexedActivityBlock[],
    onProgress?: (importedBlockCount: number) => void,
  ): Promise<IFinancialHistoryImportResult> {
    const activityMask = this.enabledDomains.reduce((mask, domain) => mask | domainActivityMasks[domain], 0);
    const blocksByNumber = new Map(
      indexedBlocks.filter(block => (block.activityMask & activityMask) !== 0).map(block => [block.blockNumber, block]),
    );
    const backlog = [...blocksByNumber.values()].sort((left, right) => left.blockNumber - right.blockNumber);
    const domainErrors: Partial<Record<IFinancialHistoryDomain, string>> = {};
    let importedBlockCount = 0;

    for (const indexedBlock of backlog) {
      for (const domain of this.enabledDomains) {
        if (!(indexedBlock.activityMask & domainActivityMasks[domain])) continue;
        const earliestSupportedSpecVersion = earliestSupportedSpecVersions[domain];
        if (indexedBlock.specVersion >= earliestSupportedSpecVersion) continue;

        domainErrors[domain] ??=
          `Block ${indexedBlock.blockNumber.toLocaleString()} uses unsupported runtime spec ${indexedBlock.specVersion}; ` +
          `earliest supported for ${domain} is ${earliestSupportedSpecVersion}`;
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

    for (let start = 0; start < supportedBacklog.length; start += 8) {
      const loadedBlocks = await Promise.all(
        supportedBacklog.slice(start, start + 8).map(indexedBlock => this.loadBlock(indexedBlock)),
      );
      for (const loadedBlock of loadedBlocks) {
        await this.importBlock(loadedBlock, domainErrors);
        importedBlockCount += 1;
        onProgress?.(importedBlockCount);
      }
    }

    return { importedBlockCount, domainErrors };
  }

  private async loadBlock(indexedBlock: IIndexedActivityBlock) {
    const block = await this.blockWatch.getHeader(indexedBlock.blockNumber);
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
  ): Promise<void> {
    const { indexedBlock, block, events } = loadedBlock;
    if (
      this.enabledDomains.includes('bonds') &&
      indexedBlock.specVersion >= earliestSupportedSpecVersions.bonds &&
      indexedBlock.activityMask & domainActivityMasks.bonds
    ) {
      try {
        await this.argonBonds.importHistoryBlock(block, events);
      } catch (error) {
        domainErrors.bonds ??= describeDomainError('bond', block.blockNumber, error);
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
        domainErrors.vaulting ??= describeDomainError('vault', block.blockNumber, error);
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
        domainErrors.bitcoin ??= describeDomainError('bitcoin', block.blockNumber, error);
      }
    }
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
  force?: boolean;
  targetBlock: number;
  onProgress?: (importedBlockCount: number) => void;
}): Promise<{ checkpoint: IFinancialHistoryCheckpoint; importedBlockCount: number }> {
  const { db, blockWatch, accountId, argonBonds, bitcoinLockRecovery, vaultHistory, domain, checkpoint } = args;
  const recoveryVersion = historyRecoveryVersions[domain];
  const recoveryVersionChanged = recoveryVersion !== undefined && checkpoint?.recoveryVersion !== recoveryVersion;
  const hasIncompleteBitcoinRecovery = domain === 'bitcoin' && bitcoinLockRecovery?.hasPendingHistoryRecovery;
  let afterBlock =
    args.force || !checkpoint || recoveryVersionChanged || hasIncompleteBitcoinRecovery ? 0 : checkpoint.asOfBlock;
  let indexedHistory = await findAddressActivity(accountId, {
    afterBlock,
    toBlock: args.targetBlock,
    activityMask: domainActivityMasks[domain],
  });

  const definitionChanged = checkpoint?.definitionVersion !== indexedHistory.definitionVersion;
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
    await bitcoinLockRecovery.beginHistoryReplay({ recoverExistingLocks: afterBlock === 0 });
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
    }).importBlocks(backlog, args.onProgress);
    importedBlockCount = result.importedBlockCount;

    const domainError = result.domainErrors[domain];
    if (domainError) throw new Error(domainError);
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
    },
  };
}

function describeDomainError(domain: 'bitcoin' | 'bond' | 'vault', blockNumber: number, error: unknown): string {
  const detail = error instanceof Error ? error.message : `Unable to decode ${domain} history`;
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
