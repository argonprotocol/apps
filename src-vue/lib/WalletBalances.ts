import {
  AccountEventsFilter,
  BlockWatch,
  createDeferred,
  createTypedEventEmitter,
  Currency as CurrencyBase,
  IBlockHeaderInfo,
  IMainchainRates,
  SingleFileQueue,
} from '@argonprotocol/apps-core';
import { WalletKeys } from './WalletKeys.ts';
import { IBalanceChange, IWalletType, Wallet } from './Wallet.ts';
import { Db } from './Db.ts';
import { ApiDecoration, ArgonClient, FrameSystemEventRecord } from '@argonprotocol/mainchain';
import { MyVault } from './MyVault.ts';
import { findAddressTransferBlocks, findAddressVaultCollects } from './IndexerClient.ts';
import { SyncStateKeys } from './db/SyncStateTable.ts';

export interface IBlockToProcess {
  blockNumber: number;
  blockHash: string;
  parentHash: string;
  isFinalized: boolean;
  isProcessed: boolean;
}

export interface IWalletEvents {
  'balance-change': (balanceChange: IBalanceChange, type: IWalletType) => void;
  'transfer-in': (wallet: Wallet, balanceChange: IBalanceChange) => void;
  'block-deleted': (block: IBlockToProcess) => void;
  'sync:best-block': (block: IBlockHeaderInfo) => void;
  'sync:finalized': (block: IBlockHeaderInfo) => void;
}

type IWalletEventKeys = keyof IWalletEvents;
type IWalletFlatList<T extends IWalletEventKeys = IWalletEventKeys> = Parameters<IWalletEvents[T]>;

export class WalletBalances {
  public deferredLoading = createDeferred<void>(false);
  public events = createTypedEventEmitter<IWalletEvents>();

  public miningWallet: Wallet;

  public miningBotWallet: Wallet;

  public vaultingWallet: Wallet;

  public bestBlock?: IBlockHeaderInfo;
  public finalizedBlock?: IBlockHeaderInfo;

  private blockBacklogBeforeUsingIndexer = 100;

  private loadEvents: {
    [K in IWalletEventKeys]: IWalletFlatList<K>[];
  } = {
    'balance-change': [],
    'transfer-in': [],
    'block-deleted': [],
    'sync:best-block': [],
    'sync:finalized': [],
  };
  private isClosed = false;
  private blockHistory: IBlockToProcess[] = [];
  private blockQueue = new SingleFileQueue();
  private blockWatch: BlockWatch;
  private myVault?: MyVault;
  private unsubscribe?: () => void;

  public get wallets(): Wallet[] {
    return [this.miningWallet, this.miningBotWallet, this.vaultingWallet];
  }

  public get addresses(): string[] {
    return this.wallets.map(wallet => wallet.address);
  }

  public get totalWalletMicrogons(): bigint {
    return this.wallets.reduce((sum, w) => sum + w.totalMicrogons, 0n);
  }

  public get totalWalletMicronots(): bigint {
    return this.wallets.reduce((sum, w) => sum + w.totalMicronots, 0n);
  }

  private readonly dbPromise: Promise<Db>;

  constructor(walletKeys: WalletKeys, dbPromise: Promise<Db>, blockWatch: BlockWatch, myVault?: MyVault) {
    this.miningWallet = new Wallet(walletKeys.miningAddress, 'mining', dbPromise);
    this.miningBotWallet = new Wallet(walletKeys.miningBotAddress, 'miningBot', dbPromise);
    this.vaultingWallet = new Wallet(walletKeys.vaultingAddress, 'vaulting', dbPromise);
    this.dbPromise = dbPromise;
    this.blockWatch = blockWatch;
    this.myVault = myVault;
  }

  public getLoadEvents<KEY extends IWalletEventKeys>(key: KEY): IWalletFlatList<KEY>[] {
    return this.loadEvents[key] as IWalletFlatList<KEY>[];
  }

  public async load() {
    if (this.deferredLoading.isRunning || this.deferredLoading.isSettled) {
      return this.deferredLoading.promise;
    }
    this.deferredLoading.setIsRunning(true);
    console.time('[WalletBalances] Load and sync wallets');
    try {
      await this.blockWatch.start();
      await this.resumeWalletSync();
      console.timeLog('[WalletBalances] Load and sync wallets', 'Synced within range of indexer');
      await this.loadBalancesAt(this.blockWatch.bestBlockHeader);
      console.log('[WalletBalances] Loaded and synced wallets', {
        mining: this.miningWallet.totalMicronots,
        miningBot: this.miningBotWallet.totalMicronots,
        vaulting: this.vaultingWallet.totalMicronots,
      });
      this.unsubscribe = this.blockWatch.events.on('best-blocks', async (blocks: IBlockHeaderInfo[]) => {
        const latestBlock = blocks[blocks.length - 1];
        await this.loadBalancesAt(latestBlock);
      });
      this.deferredLoading.resolve();
    } catch (err) {
      this.deferredLoading.reject(err);
    }
    console.timeEnd('[WalletBalances] Load and sync wallets');
    return this.deferredLoading.promise;
  }

  public async close() {
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    await this.blockQueue.stop();
    this.isClosed = true;
  }

  public async didWalletHavePreviousLife() {
    for (const wallet of this.wallets) {
      if (wallet.hasValue()) {
        return true;
      }
    }
    return false;
  }

  public async loadBalancesAt(header: IBlockHeaderInfo) {
    if (this.isClosed) {
      return;
    }
    await this.blockQueue.add(async () => {
      ///// UPDATE FINALIZED
      const finalizedBlock = this.blockWatch.finalizedBlockHeader;
      const finalizedBlockNumber = finalizedBlock.blockNumber;

      const oldestBlock = Math.min(...this.blockHistory.map(x => x.blockNumber), finalizedBlockNumber);

      /// PROCESS UP TO CURRENT BLOCK
      let historyHeader = header;
      for (let blockNumber = header.blockNumber; blockNumber >= oldestBlock; blockNumber--) {
        if (historyHeader.blockNumber !== blockNumber) {
          throw new Error(
            `Inconsistent block numbers when loading wallet balances history. (Expected=${blockNumber}, actual=${historyHeader.blockNumber})`,
          );
        }
        const entry = {
          blockNumber,
          blockHash: historyHeader.blockHash,
          isFinalized: blockNumber <= finalizedBlockNumber,
          isProcessed: false,
          parentHash: historyHeader.parentHash,
        };
        const inHistory = this.blockHistory.find(b => b.blockNumber === entry.blockNumber);

        if (inHistory) {
          // if we're caught up, stop
          if (inHistory.blockHash === entry.blockHash) {
            break;
          } else {
            await this.rollbackBlock(inHistory);
          }
        }
        const index = this.blockHistory.findIndex(b => b.blockNumber > entry.blockNumber);
        if (index >= 0) {
          this.blockHistory.splice(index, 0, entry);
        } else {
          this.blockHistory.push(entry);
        }
        if (blockNumber === 0) {
          break;
        }
        historyHeader = await this.blockWatch.getParentHeader(historyHeader);
      }

      let firstBlockNeeded = 0;
      const db = await this.dbPromise;
      for (let i = 0; i < this.blockHistory.length; i++) {
        const block = this.blockHistory[i];
        block.isFinalized = block.blockNumber <= finalizedBlockNumber;
        if (block.blockHash === finalizedBlock.blockHash) {
          firstBlockNeeded = i;
          break;
        }
      }
      for (const block of this.blockHistory) {
        if (!block.isProcessed) {
          await this.processBlock(block);
        }
        if (this.isClosed) break;
      }
      await db.walletLedgerTable.markFinalizedUpToBlock(finalizedBlockNumber);
      await db.syncStateTable.upsert(SyncStateKeys.Wallet, {
        blockNumber: finalizedBlock.blockNumber,
        blockHash: finalizedBlock.blockHash,
        parentHash: finalizedBlock.parentHash,
        isFinalized: true,
        isProcessed: true,
      });
      ////// PRUNE UNNEEDED BLOCKS
      if (firstBlockNeeded > 0) {
        this.blockHistory.splice(0, firstBlockNeeded);
      }
      for (const wallet of this.wallets) {
        wallet.trimToFinalizedBlock(finalizedBlock);
      }
      this.bestBlock = header;
      this.finalizedBlock = finalizedBlock;
      this.events.emit('sync:best-block', header);
      this.events.emit('sync:finalized', finalizedBlock);
    }).promise;
  }

  public async lookupTransferOrClaimBlocks(
    address: string,
    blockNumberSet: Set<number>,
    blockRange: [minBlock: number, maxBlock: number],
  ): Promise<{ asOfBlock: number }> {
    const [minBlock, maxBlock] = blockRange;
    let asOfBlock = minBlock;
    const transfers = await findAddressTransferBlocks(address);
    for (const { blockNumber } of transfers.transfers) {
      if (blockNumber > minBlock && blockNumber <= maxBlock) {
        blockNumberSet.add(blockNumber);
      }
    }
    asOfBlock = Math.max(asOfBlock, transfers.asOfBlock);
    if (address === this.vaultingWallet.address) {
      const vaultCollects = await findAddressVaultCollects(address);
      for (const { blockNumber } of vaultCollects.vaultCollects) {
        if (blockNumber > minBlock && blockNumber <= maxBlock) {
          blockNumberSet.add(blockNumber);
        }
      }
      asOfBlock = Math.max(asOfBlock, vaultCollects.asOfBlock);
    }
    return { asOfBlock };
  }

  /**
   * Returns the blocks processed
   */
  public async resumeWalletSync(): Promise<void> {
    const db = await this.dbPromise;
    const lastSyncedBlock = await db.syncStateTable.get(SyncStateKeys.Wallet);
    const lastSyncedBlockNumber = lastSyncedBlock?.blockNumber ?? 0;
    const bestBlockNumber = this.blockWatch.bestBlockHeader.blockNumber;
    // delete any unfinalized balance changes from last time
    const unfinalizedBlocks = await db.walletLedgerTable.findUnfinalizedBlocks();
    for (const record of unfinalizedBlocks) {
      console.log('Rolling back unfinalized wallet ledger block:', record.blockNumber, record.blockHash);
      await this.deleteBlock(record.blockHash);
    }

    console.info(`Resuming wallet sync from block ${lastSyncedBlockNumber} to ${bestBlockNumber}.`);

    let latestBlockNumberSynced = lastSyncedBlockNumber;
    const latestFinalizedNumber = this.blockWatch.finalizedBlockHeader.blockNumber;
    // if we're far behind, recover history from indexer instead of going block-by-block
    if (bestBlockNumber - lastSyncedBlockNumber > this.blockBacklogBeforeUsingIndexer) {
      const addresses = this.addresses;
      const { balances } = await this.readBalances(addresses, this.blockWatch.finalizedBlockHeader);
      const neededBlockNumbers = new Set<number>();
      let hadBalance = false;
      for (let i = 0; i < addresses.length; i++) {
        const balance = balances[i];
        const address = addresses[i];
        if (
          balance.availableMicrogons === 0n &&
          balance.availableMicronots === 0n &&
          balance.reservedMicrogons === 0n &&
          balance.reservedMicronots === 0n
        ) {
          continue;
        }
        hadBalance = true;
        // TODO: if the indexer is down, we need to record the gap in sync and inform the user
        const { asOfBlock } = await this.lookupTransferOrClaimBlocks(address, neededBlockNumbers, [
          lastSyncedBlockNumber,
          latestFinalizedNumber,
        ]);

        latestBlockNumberSynced = Math.max(latestBlockNumberSynced, asOfBlock);
      }
      if (!hadBalance) {
        // no balances, nothing to recover
        latestBlockNumberSynced = latestFinalizedNumber;
      }

      const blocks = [...neededBlockNumbers].sort((a, b) => a - b);
      console.info('Recovering wallet history from blocks with transfers', blocks);
      for (const blockNumber of blocks) {
        const blockHeader = await this.blockWatch.getHeader(blockNumber);
        await this.processBlock(
          {
            blockNumber: blockHeader.blockNumber,
            blockHash: blockHeader.blockHash,
            parentHash: blockHeader.parentHash,
            isFinalized: latestFinalizedNumber >= blockHeader.blockNumber,
            isProcessed: false,
          },
          true,
        );
      }
    }

    const syncStartBlock = Math.min(latestFinalizedNumber, latestBlockNumberSynced);
    console.info(`[WalletBalances] Resumed wallet sync to block ${syncStartBlock}. Latest is ${bestBlockNumber}.`);
    const syncedToBlock = await this.blockWatch.getHeader(syncStartBlock);
    const addresses = this.addresses;
    const { balances } = await this.readBalances(addresses, syncedToBlock);
    for (let i = 0; i < addresses.length; i++) {
      const balance = balances[i];
      const wallet = this.wallets[i];
      if (!wallet) continue;
      wallet.balanceHistory = [balance];
    }
    this.blockHistory = [
      {
        blockNumber: syncedToBlock.blockNumber,
        blockHash: syncedToBlock.blockHash,
        parentHash: syncedToBlock.parentHash,
        isFinalized: latestFinalizedNumber >= syncedToBlock.blockNumber,
        isProcessed: true,
      },
    ];
  }

  private async rollbackBlock(block: IBlockToProcess) {
    const index = this.blockHistory.findIndex(b => b.blockNumber === block.blockNumber);
    if (index >= 0) {
      this.blockHistory.splice(index, 1);
    }
    for (const wallet of this.wallets) {
      wallet.dropBlock(block.blockHash);
    }
    await this.deleteBlock(block.blockHash);
    this.events.emit('block-deleted', block);
  }

  private async deleteBlock(blockHash: string): Promise<void> {
    const db = await this.dbPromise;
    await Promise.all([
      db.vaultRevenueEventsTable.deleteBlock(blockHash),
      db.walletTransfersTable.deleteBlock(blockHash),
      db.walletLedgerTable.deleteBlock(blockHash),
    ]);
  }

  private async readBalances(
    addresses: string[],
    block: Pick<IBlockToProcess, 'blockNumber' | 'blockHash' | 'isFinalized'>,
  ): Promise<{
    balances: IBalanceChange[];
    api: ApiDecoration<'promise'>;
    client: ArgonClient;
  }> {
    const client = await this.blockWatch.getRpcClient(block.blockNumber);
    const api = await client.at(block.blockHash);
    const microgons = await api.query.system.account.multi(addresses).then(x => x.map(acc => acc.data));
    const micronots = await api.query.ownership.account.multi(addresses);

    const balances = addresses.map((_, i) => ({
      block: { ...block },
      availableMicrogons: microgons[i]?.free.toBigInt() ?? 0n,
      reservedMicrogons: microgons[i]?.reserved.toBigInt() ?? 0n,
      availableMicronots: micronots[i]?.free.toBigInt() ?? 0n,
      reservedMicronots: micronots[i]?.reserved.toBigInt() ?? 0n,
      microgonsAdded: 0n,
      micronotsAdded: 0n,
      vaultRevenueEvents: [],
      extrinsicEvents: [],
      transfers: [],
    }));
    return { balances, api, client };
  }

  private async processBlock(block: IBlockToProcess, isCatchup = false) {
    if (!block) return;
    let events: FrameSystemEventRecord[] | undefined;

    const { balances, client, api } = await this.readBalances(this.addresses, block);
    let prices: IMainchainRates | null;
    for (let i = 0; i < this.addresses.length; i++) {
      const wallet = this.wallets[i];
      const entry: IBalanceChange = balances[i];

      const hasChange = wallet.addDiffs(entry);
      if (hasChange) {
        events ??= await api.query.system.events();
        const filter = new AccountEventsFilter(
          wallet.address,
          wallet.type,
          this.addresses,
          this.myVault?.createdVault?.vaultId,
        );
        filter.process(client, events);
        entry.extrinsicEvents = filter.eventsByExtrinsic;
        entry.transfers = filter.transfers;
        entry.vaultRevenueEvents = filter.vaultRevenueEvents;

        prices ??= await new CurrencyBase(this.blockWatch.clients).fetchMainchainRates(api);
        const changed = await wallet.onBalanceChange(entry, prices);
        if (changed) {
          this.events.emit('balance-change', entry, wallet.type);
          if (!this.deferredLoading.isSettled) {
            this.loadEvents['balance-change'].push([entry, wallet.type]);
          }
          if (entry.transfers.some(x => x.isInbound)) {
            this.events.emit('transfer-in', wallet, entry);
            if (!this.deferredLoading.isSettled) {
              this.loadEvents['transfer-in'].push([wallet, entry]);
            }
          }
          if (entry.transfers.length || entry.extrinsicEvents.length) {
            console.log(
              `Found ${entry.extrinsicEvents.length} ${wallet.type} wallet balance updates at ${block.blockNumber}`,
              {
                events: entry.extrinsicEvents,
                transfers: entry.transfers,
              },
            );
          }
        }
      }
    }
  }
}
