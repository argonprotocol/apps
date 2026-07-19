import {
  AccountActivityKind,
  AccountEventsFilter,
  type BlockWatch,
  Currency,
  type IIndexerSpec,
} from '@argonprotocol/apps-core';
import type { Db } from '../Db.ts';
import { FinalizedHistoryScheduler } from './Scheduler.ts';
import { findAddressActivity } from '../IndexerClient.ts';
import { WalletForArgon } from '../WalletForArgon.ts';
import { type IWalletHistoryRevisions } from '../WalletsForArgon.ts';
import { type ISyncSchemas, SyncStateKeys } from '../db/SyncStateTable.ts';

export type IIndexedWalletActivityBlock = IIndexerSpec['/v2/activity/:address']['responseType']['blocks'][number];

const custodyFlowActivityMask = AccountActivityKind.Transfer | AccountActivityKind.Crosschain;
const archivePrefetchSize = 10;

export class WalletHistoryRecovery {
  private readonly scheduler: FinalizedHistoryScheduler;
  private readonly dbPromise: Promise<Db>;
  private readonly blockWatch: BlockWatch;
  private readonly currency: Currency;
  private readonly recoveryWallets: readonly WalletForArgon[];
  private readonly ownedAddresses: readonly string[];
  private readonly onRecovered?: (revisions: IWalletHistoryRevisions) => void;
  private liveCoverageThroughBlock = 0;
  private pendingLiveGapThroughBlock = 0;

  constructor({
    dbPromise,
    blockWatch,
    currency,
    recoveryWallets,
    ownedAddresses,
    onRecovered,
  }: {
    dbPromise: Promise<Db>;
    blockWatch: BlockWatch;
    currency: Currency;
    recoveryWallets: readonly WalletForArgon[];
    ownedAddresses: readonly string[];
    onRecovered?: (revisions: IWalletHistoryRevisions) => void;
  }) {
    this.dbPromise = dbPromise;
    this.blockWatch = blockWatch;
    this.currency = currency;
    this.recoveryWallets = recoveryWallets;
    this.ownedAddresses = ownedAddresses;
    this.onRecovered = onRecovered;
    this.scheduler = new FinalizedHistoryScheduler(async (targetBlock, force) => {
      try {
        const db = await this.dbPromise;
        const recoveredBlock = await this.recover(targetBlock, force);
        this.liveCoverageThroughBlock = Math.max(this.liveCoverageThroughBlock, recoveredBlock);
        if (recoveredBlock >= this.pendingLiveGapThroughBlock) this.pendingLiveGapThroughBlock = 0;
        const revisions: IWalletHistoryRevisions = {
          transfers: db.walletTransfersTable.revision,
          argonotCustody: db.walletTransfersTable.argonotCustodyRevision ?? 0,
          asOfBlock: recoveredBlock,
        };
        this.onRecovered?.(revisions);
        return recoveredBlock;
      } catch (error) {
        console.warn(`Wallet history recovery failed through block ${targetBlock.toLocaleString()}`, error);
        throw error;
      }
    });
  }

  public async prepare(): Promise<boolean> {
    const db = await this.dbPromise;
    const walletHistory = await db.syncStateTable.get(SyncStateKeys.WalletHistory);
    if (this.hasMatchingScope(walletHistory)) return false;

    const activityMasks = this.getActivityMasks();
    const addresses = [...new Set(this.ownedAddresses)].sort();

    // The exact mask is the extraction definition. Adding a recoverable event
    // kind resets this local checkpoint and replays only sparse index matches.
    await db.syncStateTable.upsert(SyncStateKeys.WalletHistory, {
      asOfBlock: 0,
      addresses,
      activityMasks,
    });
    return true;
  }

  public async hasCompleteCoverage(targetBlock: number): Promise<boolean> {
    const db = await this.dbPromise;
    const walletHistory = await db.syncStateTable.get(SyncStateKeys.WalletHistory);
    if (!walletHistory?.definitionVersion || !this.hasMatchingScope(walletHistory)) {
      this.liveCoverageThroughBlock = 0;
      return false;
    }

    this.liveCoverageThroughBlock = Math.max(this.liveCoverageThroughBlock, walletHistory.asOfBlock);
    return this.liveCoverageThroughBlock >= targetBlock;
  }

  public advanceLiveCoverage(blockNumber: number): void {
    if (this.pendingLiveGapThroughBlock > this.liveCoverageThroughBlock) return;
    this.liveCoverageThroughBlock = Math.max(this.liveCoverageThroughBlock, blockNumber);
  }

  public markLiveGap({ afterBlock, toBlock }: { afterBlock: number; toBlock: number }): void {
    this.liveCoverageThroughBlock = Math.min(this.liveCoverageThroughBlock, afterBlock);
    this.pendingLiveGapThroughBlock = Math.max(this.pendingLiveGapThroughBlock, toBlock);
  }

  public queue(targetBlock: number): void {
    this.scheduler.queue(targetBlock);
  }

  public recoverNow(targetBlock: number, force = false): Promise<void> {
    return this.scheduler.runNow(targetBlock, force);
  }

  public close(): Promise<void> {
    return this.scheduler.close();
  }

  public async findActivityBlocks(
    address: string,
    blocksByNumber: Map<number, IIndexedWalletActivityBlock>,
    blockRange: [afterBlock: number, toBlock: number],
  ): Promise<{ asOfBlock: number; definitionVersion: number }> {
    const [afterBlock, toBlock] = blockRange;
    const activityMask = this.getActivityMasks()[address];
    if (activityMask === undefined) throw new Error(`Wallet history does not own ${address}`);

    const activity = await findAddressActivity(address, {
      afterBlock,
      toBlock,
      activityMask,
    });
    const firstGap = activity.coverage.gaps[0];
    if (firstGap) {
      throw new Error(
        `Wallet history index has a coverage gap from block ${firstGap.fromBlock.toLocaleString()} to ${firstGap.toBlock.toLocaleString()}: ${firstGap.reason}`,
      );
    }

    for (const indexedBlock of activity.blocks) {
      if ((indexedBlock.activityMask & activityMask) === 0) continue;

      const existing = blocksByNumber.get(indexedBlock.blockNumber);
      if (
        existing &&
        (existing.blockHash.toLowerCase() !== indexedBlock.blockHash.toLowerCase() ||
          existing.specVersion !== indexedBlock.specVersion)
      ) {
        throw new Error(`Wallet history index returned conflicting block ${indexedBlock.blockNumber.toLocaleString()}`);
      }
      blocksByNumber.set(indexedBlock.blockNumber, {
        ...indexedBlock,
        activityMask: (existing?.activityMask ?? 0) | indexedBlock.activityMask,
      });
    }
    return {
      asOfBlock: Math.max(afterBlock, activity.asOfBlock),
      definitionVersion: activity.definitionVersion,
    };
  }

  private async recover(targetBlock: number, force: boolean): Promise<number> {
    const db = await this.dbPromise;
    const savedState = await db.syncStateTable.get(SyncStateKeys.WalletHistory);
    let afterBlock = force ? 0 : (savedState?.asOfBlock ?? 0);
    if (!force && afterBlock >= targetBlock) return afterBlock;

    const indexedBlocks = new Map<number, IIndexedWalletActivityBlock>();
    const recoveryAddresses = Object.keys(this.getActivityMasks()).sort();
    // The lowest indexer asOfBlock prevents claiming blocks the indexer has not safely covered.
    let indexedAccounts = await Promise.all(
      recoveryAddresses.map(address => this.findActivityBlocks(address, indexedBlocks, [afterBlock, targetBlock])),
    );
    let definitionVersions = new Set(indexedAccounts.map(result => result.definitionVersion));
    if (definitionVersions.size !== 1) throw new Error('Wallet history index returned conflicting definition versions');

    let definitionVersion = indexedAccounts[0]?.definitionVersion ?? 0;
    if (afterBlock > 0 && savedState?.definitionVersion !== definitionVersion) {
      afterBlock = 0;
      indexedBlocks.clear();
      indexedAccounts = await Promise.all(
        recoveryAddresses.map(address => this.findActivityBlocks(address, indexedBlocks, [afterBlock, targetBlock])),
      );
      definitionVersions = new Set(indexedAccounts.map(result => result.definitionVersion));
      if (definitionVersions.size !== 1)
        throw new Error('Wallet history index returned conflicting definition versions');
      definitionVersion = indexedAccounts[0]?.definitionVersion ?? 0;
    }
    const recoveredThroughBlock = Math.min(targetBlock, ...indexedAccounts.map(result => result.asOfBlock));
    const backlog = [...indexedBlocks.values()]
      .filter(indexedBlock => indexedBlock.blockNumber <= recoveredThroughBlock)
      .sort((left, right) => left.blockNumber - right.blockNumber);
    const checkpoint = {
      addresses: [...new Set(this.ownedAddresses)].sort(),
      activityMasks: this.getActivityMasks(),
      definitionVersion,
    };
    if (!backlog.length) {
      await db.syncStateTable.upsert(SyncStateKeys.WalletHistory, {
        asOfBlock: recoveredThroughBlock,
        ...checkpoint,
      });
      return recoveredThroughBlock;
    }

    for (let offset = 0; offset < backlog.length; offset += archivePrefetchSize) {
      const chunk = backlog.slice(offset, offset + archivePrefetchSize);
      const prefetchedBlocks = await Promise.all(
        chunk.map(async indexedBlock => {
          const block = await this.blockWatch.getHeader(indexedBlock.blockNumber);
          if (block.blockHash.toLowerCase() !== indexedBlock.blockHash.toLowerCase()) {
            throw new Error(
              `Wallet history index hash mismatch at block ${indexedBlock.blockNumber.toLocaleString()}: expected ${indexedBlock.blockHash}, received ${block.blockHash}`,
            );
          }

          const eventSnapshot = await this.blockWatch.getEventsWithSpec(block);
          if (eventSnapshot.specVersion !== indexedBlock.specVersion) {
            throw new Error(
              `Wallet history index runtime mismatch at block ${indexedBlock.blockNumber.toLocaleString()}: expected spec ${indexedBlock.specVersion}, received ${eventSnapshot.specVersion}`,
            );
          }

          return { block, eventSnapshot };
        }),
      );

      // Archive reads are parallel within a small window, while database writes
      // remain ordered exactly as they occurred on chain.
      for (const { block, eventSnapshot } of prefetchedBlocks) {
        let prices: { USD: bigint; ARGNOT: bigint } | undefined;
        for (const wallet of this.recoveryWallets) {
          const filter = new AccountEventsFilter(wallet.address, this.ownedAddresses);
          filter.process(eventSnapshot.api, eventSnapshot.events);
          if (!filter.transfers.length) continue;

          prices ??= await this.currency.fetchMainchainRatesAtBlock({
            api: eventSnapshot.api,
            block,
          });
          await wallet.saveFinalizedTransfers(
            { block: { ...block, isFinalized: true }, transfers: filter.transfers },
            prices,
          );
        }
      }

      await db.syncStateTable.upsert(SyncStateKeys.WalletHistory, {
        asOfBlock: chunk.at(-1)!.blockNumber,
        ...checkpoint,
      });
    }

    await db.syncStateTable.upsert(SyncStateKeys.WalletHistory, {
      asOfBlock: recoveredThroughBlock,
      ...checkpoint,
    });
    return recoveredThroughBlock;
  }

  private getActivityMasks(): Record<string, number> {
    const activityMasks: Record<string, number> = {};
    for (const wallet of this.recoveryWallets) {
      activityMasks[wallet.address] = (activityMasks[wallet.address] ?? 0) | custodyFlowActivityMask;
    }
    return Object.fromEntries(Object.entries(activityMasks).sort());
  }

  private hasMatchingScope(walletHistory: ISyncSchemas[SyncStateKeys.WalletHistory] | null): boolean {
    if (!walletHistory) return false;

    const activityMasks = this.getActivityMasks();
    const storedActivityMasks = walletHistory.activityMasks ?? {};
    if (Object.keys(activityMasks).length !== Object.keys(storedActivityMasks).length) return false;
    if (Object.entries(activityMasks).some(([address, mask]) => storedActivityMasks[address] !== mask)) return false;

    const addresses = [...new Set(this.ownedAddresses)].sort();
    const storedAddresses = [...(walletHistory.addresses ?? [])].sort();
    return (
      addresses.length === storedAddresses.length &&
      addresses.every((address, index) => address === storedAddresses[index])
    );
  }
}
