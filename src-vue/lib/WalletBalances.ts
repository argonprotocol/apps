import {
  AccountEventsFilter,
  BlockWatch,
  createTypedEventEmitter,
  IBlockHeaderInfo,
  PriceIndex,
  SingleFileQueue,
} from '@argonprotocol/apps-core';
import { createDeferred } from './Utils';
import { WalletKeys } from './WalletKeys.ts';
import { IBalanceChange, IWalletType, Wallet } from './Wallet.ts';
import { Db } from './Db.ts';
import { ArgonClient, FrameSystemEventRecord } from '@argonprotocol/mainchain';
import { MyVault } from './MyVault.ts';

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
}

export class WalletBalances {
  private deferredLoading = createDeferred<void>(false);

  public events = createTypedEventEmitter<IWalletEvents>();
  public priceIndex?: PriceIndex;

  public miningWallet: Wallet;
  public vaultingWallet: Wallet;
  public holdingWallet: Wallet;

  private isClosed = false;
  private blockHistory: IBlockToProcess[] = [];
  private blockQueue = new SingleFileQueue();
  private blockWatch: BlockWatch;
  private myVault?: MyVault;

  public get wallets(): Wallet[] {
    return [this.miningWallet, this.vaultingWallet, this.holdingWallet];
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
    this.vaultingWallet = new Wallet(walletKeys.vaultingAddress, 'vaulting', dbPromise);
    this.holdingWallet = new Wallet(walletKeys.holdingAddress, 'holding', dbPromise);
    this.dbPromise = dbPromise;
    this.blockWatch = blockWatch;
    this.myVault = myVault;
  }

  public async load() {
    if (this.deferredLoading.isRunning || this.deferredLoading.isSettled) {
      return this.deferredLoading.promise;
    }
    this.deferredLoading.setIsRunning(true);
    await this.blockWatch.start();
    await this.loadBalancesAt(this.blockWatch.bestBlockHeader);
    this.blockWatch.events.on('best-blocks', async (blocks: IBlockHeaderInfo[]) => {
      const latestBlock = blocks[blocks.length - 1];
      await this.loadBalancesAt(latestBlock);
    });
    this.deferredLoading.resolve();
  }

  public async close() {
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
          isFinalized: blockNumber >= finalizedBlockNumber,
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
      const table = db.walletLedgerTable;
      for (let i = 0; i < this.blockHistory.length; i++) {
        const block = this.blockHistory[i];
        if (block.blockNumber <= finalizedBlockNumber) {
          block.isFinalized = true;
        }
        if (block.blockHash === finalizedBlock.blockHash) {
          firstBlockNeeded = i;
          break;
        }
      }
      for (const block of this.blockHistory) {
        if (!block.isProcessed) {
          const client = await this.blockWatch.getRpcClient(block.blockNumber);
          await this.loadFromApi(client, block);
          block.isProcessed = true;
        }
        if (this.isClosed) break;
      }
      await table.markFinalizedUpToBlock(finalizedBlockNumber);
      ////// PRUNE UNNEEDED BLOCKS
      if (firstBlockNeeded > 0) {
        const toDelete = this.blockHistory.splice(0, firstBlockNeeded);
        for (const wallet of this.wallets) {
          for (const block of toDelete) {
            wallet.dropBlock(block.blockHash);
          }
        }
      }
    }).promise;
  }

  public getVaultUnallocatedFunds(): bigint {
    const wallet = this.vaultingWallet;
    if (wallet.availableMicrogons > 0n && this.myVault) {
      const mintInWallet =
        this.myVault.bitcoinLocksStore.totalMinted - (this.myVault.metadata?.personalBitcoinMintAmountMovedOut ?? 0n);
      // what's left at this point is just anything collected plus
      return wallet.totalMicrogons - mintInWallet - MyVault.OperationalReserves;
    }
    return 0n;
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

  private async loadFromApi(client: ArgonClient, block: IBlockToProcess) {
    const api = await client.at(block.blockHash);
    const addresses = this.wallets.map(wallet => wallet.address);
    const microgons = await api.query.system.account.multi(addresses).then(x => x.map(acc => acc.data));
    const micronots = await api.query.ownership.account.multi(addresses);
    let events: FrameSystemEventRecord[] | undefined;

    for (let i = 0; i < this.addresses.length; i++) {
      const wallet = this.wallets[i];
      const entry: IBalanceChange = {
        block,
        availableMicrogons: microgons[i]?.free.toBigInt() ?? 0n,
        reservedMicrogons: microgons[i]?.reserved.toBigInt() ?? 0n,
        availableMicronots: micronots[i]?.free.toBigInt() ?? 0n,
        reservedMicronots: micronots[i]?.reserved.toBigInt() ?? 0n,
        microgonsAdded: 0n,
        micronotsAdded: 0n,
        vaultRevenueEvents: [],
        extrinsicEvents: [],
        transfers: [],
      };
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
        const prices =
          this.priceIndex?.exchangeRates ??
          (await new PriceIndex(this.blockWatch.clients).fetchMicrogonExchangeRatesTo(api));
        const changed = await wallet.onBalanceChange(entry, prices);
        if (changed) {
          this.events.emit('balance-change', entry, wallet.type);
          if (entry.transfers.some(x => x.isInbound)) {
            this.events.emit('transfer-in', wallet, entry);
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
