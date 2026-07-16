import {
  AccountActivityKind,
  AccountEventsFilter,
  type BlockWatch,
  Currency,
  type IIndexerSpec,
} from '@argonprotocol/apps-core';
import type { ApiDecoration } from '@argonprotocol/mainchain';
import type { Db } from '../Db.ts';
import { FinalizedHistoryScheduler } from './Scheduler.ts';
import { findAddressActivity } from '../IndexerClient.ts';
import { type IBalanceChange, WalletForArgon } from '../WalletForArgon.ts';
import { type IWalletHistoryRevisions, readArgonWalletBalances } from '../WalletsForArgon.ts';
import { type ISyncSchemas, SyncStateKeys } from '../db/SyncStateTable.ts';

export type IIndexedWalletActivityBlock = IIndexerSpec['/v2/activity/:address']['responseType']['blocks'][number];

const custodyFlowActivityMask = AccountActivityKind.Transfer | AccountActivityKind.Crosschain;
// Faucet BalanceSet events do not carry the credited amount, so the default
// account still needs sparse before/after balance reads to recover that transfer.
// These snapshots are recovery inputs only; WalletLedger no longer persists them.
const defaultWalletActivityMask = custodyFlowActivityMask | AccountActivityKind.AccountBalance;
const balanceActivityMask = AccountActivityKind.AccountBalance;
const eventActivityMask = custodyFlowActivityMask;
const archivePrefetchSize = 10;

export class WalletHistoryRecovery {
  private readonly scheduler: FinalizedHistoryScheduler;
  private readonly dbPromise: Promise<Db>;
  private readonly blockWatch: BlockWatch;
  private readonly currency: Currency;
  private readonly recoveryWallets: readonly WalletForArgon[];
  private readonly ownedAddresses: readonly string[];
  private readonly onRecovered?: (revisions: IWalletHistoryRevisions) => void;

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

  public async prepare(): Promise<void> {
    const db = await this.dbPromise;
    const walletHistory = await db.syncStateTable.get(SyncStateKeys.WalletHistory);
    if (this.hasMatchingScope(walletHistory)) return;

    const activityMasks = this.getActivityMasks();
    const addresses = [...new Set(this.ownedAddresses)].sort();

    // The exact mask is the extraction definition. Adding a recoverable event
    // kind resets this local checkpoint and replays only sparse index matches.
    await db.syncStateTable.upsert(SyncStateKeys.WalletHistory, {
      asOfBlock: 0,
      addresses,
      activityMasks,
    });
  }

  public async hasCompleteCoverage(targetBlock: number): Promise<boolean> {
    const db = await this.dbPromise;
    const walletHistory = await db.syncStateTable.get(SyncStateKeys.WalletHistory);
    return (
      !!walletHistory?.definitionVersion &&
      walletHistory.asOfBlock >= targetBlock &&
      this.hasMatchingScope(walletHistory)
    );
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

    const needsBalanceRecovery = backlog.some(indexedBlock => (indexedBlock.activityMask & balanceActivityMask) !== 0);
    const recoveryWallets = this.recoveryWallets.map(wallet => {
      return new WalletForArgon(wallet.address, wallet.type, this.dbPromise);
    });
    const balanceAddresses = recoveryWallets.map(wallet => wallet.address);
    const startingBlock = await this.blockWatch.getHeader(afterBlock);
    if (needsBalanceRecovery) {
      const { balances } = await this.readBalances(balanceAddresses, {
        ...startingBlock,
        isFinalized: true,
      });
      for (let index = 0; index < recoveryWallets.length; index += 1) {
        recoveryWallets[index].balanceHistory = [balances[index]];
      }
    } else {
      for (const wallet of recoveryWallets) {
        wallet.balanceHistory = [
          {
            block: { ...startingBlock, isFinalized: true },
            availableMicrogons: 0n,
            reservedMicrogons: 0n,
            availableMicronots: 0n,
            reservedMicronots: 0n,
            microgonsAdded: 0n,
            micronotsAdded: 0n,
            transfers: [],
            extrinsicEvents: [],
          },
        ];
      }
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

          const [balanceSnapshot, eventSnapshot] = await Promise.all([
            indexedBlock.activityMask & balanceActivityMask
              ? this.readBalances(balanceAddresses, { ...block, isFinalized: true })
              : undefined,
            indexedBlock.activityMask & eventActivityMask ? this.blockWatch.getEventsWithSpec(block) : undefined,
          ]);
          const specVersion = eventSnapshot?.specVersion ?? balanceSnapshot?.api.runtimeVersion.specVersion.toNumber();
          if (specVersion !== indexedBlock.specVersion) {
            throw new Error(
              `Wallet history index runtime mismatch at block ${indexedBlock.blockNumber.toLocaleString()}: expected spec ${indexedBlock.specVersion}, received ${specVersion}`,
            );
          }

          return { balanceSnapshot, block, eventSnapshot };
        }),
      );

      // Archive reads are parallel within a small window, while balance deltas
      // and database writes remain ordered exactly as they occurred on chain.
      for (const { balanceSnapshot, block, eventSnapshot } of prefetchedBlocks) {
        for (let index = 0; index < recoveryWallets.length; index += 1) {
          const wallet = recoveryWallets[index];
          const previousBalance = wallet.latestBalanceChange;
          if (!previousBalance) throw new Error(`Wallet history has no starting balance for ${wallet.address}`);

          const balance = balanceSnapshot?.balances[index] ?? {
            block: { ...block, isFinalized: true },
            availableMicrogons: previousBalance.availableMicrogons,
            reservedMicrogons: previousBalance.reservedMicrogons,
            availableMicronots: previousBalance.availableMicronots,
            reservedMicronots: previousBalance.reservedMicronots,
            microgonsAdded: 0n,
            micronotsAdded: 0n,
            transfers: [],
            extrinsicEvents: [],
          };
          if (eventSnapshot) {
            const filter = new AccountEventsFilter(wallet.address, this.ownedAddresses);
            filter.process(eventSnapshot.api, eventSnapshot.events);
            balance.transfers = filter.transfers;
            balance.extrinsicEvents = filter.eventsByExtrinsic;
          }
          if (!wallet.addDiffs(balance) && !balance.transfers.length) continue;

          const ratesApi = balanceSnapshot?.api ?? eventSnapshot?.api;
          if (balance.transfers.length && !ratesApi) {
            throw new Error(`Wallet transfer block ${block.blockNumber.toLocaleString()} has no event or balance API`);
          }
          let prices: { USD: bigint; ARGNOT: bigint } | undefined;
          if (balance.transfers.length && ratesApi) {
            prices = await this.currency.fetchMainchainRatesAtBlock({
              api: ratesApi,
              block,
            });
          }
          await wallet.onBalanceChange(balance, prices);
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
      const activityMask = wallet.type === 'defaultArgon' ? defaultWalletActivityMask : custodyFlowActivityMask;
      activityMasks[wallet.address] = (activityMasks[wallet.address] ?? 0) | activityMask;
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

  private async readBalances(
    addresses: string[],
    block: IBalanceChange['block'],
  ): Promise<{ balances: IBalanceChange[]; api: ApiDecoration<'promise'> }> {
    const api = await this.blockWatch.getApi(block);
    const balances = await readArgonWalletBalances(api, addresses, block);
    return { balances, api };
  }
}
