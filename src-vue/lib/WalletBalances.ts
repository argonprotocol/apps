import { AccountEventsFilter, MainchainClients, PriceIndex, SingleFileQueue } from '@argonprotocol/apps-core';
import { createDeferred } from './Utils';
import { WalletKeys } from './WalletKeys.ts';
import { IBalanceChange, IWalletType, Wallet } from './Wallet.ts';
import { Db } from './Db.ts';
import { ArgonClient, FrameSystemEventRecord } from '@argonprotocol/mainchain';
import { WalletLedgerTable } from './db/WalletLedgerTable.ts';
import { BlockWatch, IBlockHeaderInfo } from '@argonprotocol/apps-core/src/BlockWatch.ts';

export interface IBlockToProcess {
  blockNumber: number;
  blockHash: string;
  parentHash: string;
  isFinalized: boolean;
  isProcessed: boolean;
}

export class WalletBalances {
  private deferredLoading = createDeferred<void>(false);
  private clients: MainchainClients;

  public onBalanceChange?: (balanceChange: IBalanceChange, type: IWalletType) => void;
  public onTransferIn?: (wallet: Wallet, balanceChange: IBalanceChange) => void;
  public onBlockDeleted?: (block: IBlockToProcess) => void;
  public priceIndex?: PriceIndex;

  public miningWallet: Wallet;
  public vaultingWallet: Wallet;
  public holdingWallet: Wallet;

  private isClosed = false;
  private blockHistory: IBlockToProcess[] = [];
  private blockQueue = new SingleFileQueue();
  private blockWatch: BlockWatch;

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

  private readonly tablePromise: Promise<WalletLedgerTable>;

  constructor(
    mainchainClients: MainchainClients,
    walletKeys: WalletKeys,
    dbPromise: Promise<Db>,
    blockWatch: BlockWatch,
  ) {
    this.clients = mainchainClients;
    this.miningWallet = new Wallet(walletKeys.miningAddress, 'mining', dbPromise);
    this.vaultingWallet = new Wallet(walletKeys.vaultingAddress, 'vaulting', dbPromise);
    this.holdingWallet = new Wallet(walletKeys.holdingAddress, 'holding', dbPromise);
    this.tablePromise = dbPromise.then(db => new WalletLedgerTable(db));
    this.blockWatch = blockWatch;
  }

  public async load() {
    if (this.deferredLoading.isRunning || this.deferredLoading.isSettled) {
      return this.deferredLoading.promise;
    }
    this.deferredLoading.setIsRunning(true);
    this.blockWatch.events.on('best-blocks', async (blocks: IBlockHeaderInfo[]) => {
      const latestBlock = blocks[blocks.length - 1];
      await this.loadBalancesAt(latestBlock);
    });
    await this.blockWatch.start();
    await this.loadBalancesAt(this.blockWatch.bestBlockHeader);
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
      console.log(`Loading wallet balances at block #${header.blockNumber} (${header.blockHash})`);

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
      const table = await this.tablePromise;
      await table.markFinalizedUpToBlock(finalizedBlockNumber);
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
      ////// PRUNE UNNEEDED BLOCKS
      if (firstBlockNeeded > 0) {
        const toDelete = this.blockHistory.splice(0, firstBlockNeeded);
        for (const wallet of this.wallets) {
          for (const block of toDelete) {
            wallet.dropBlock(block.blockHash);
          }
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
    }).promise;
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
    this.onBlockDeleted?.(block);
  }

  private async deleteBlock(blockHash: string): Promise<void> {
    const table = await this.tablePromise;
    await table.deleteBlock(blockHash);
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
        extrinsicEvents: [],
        inboundTransfers: [],
      };
      const hasChange = wallet.addDiffs(entry);
      if (hasChange) {
        events ??= await api.query.system.events();
        const filter = new AccountEventsFilter(wallet.address, wallet.type);
        filter.process(client, events);
        entry.extrinsicEvents = filter.eventsByExtrinsic;
        entry.inboundTransfers = filter.inboundTransfers;
        const changed = await wallet.onBalanceChange(entry, this.priceIndex?.exchangeRates);
        if (changed) {
          this.onBalanceChange?.(entry, wallet.type);
          if (entry.inboundTransfers.length) {
            this.onTransferIn?.(wallet, entry);
          }
          if (entry.inboundTransfers.length || entry.extrinsicEvents.length) {
            console.log(`Found ${wallet.type} wallet balance updates`, {
              events: entry.extrinsicEvents,
              transfers: entry.inboundTransfers,
            });
          }
        }
      }
    }
  }
}
