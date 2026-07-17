import {
  AccountEventsFilter,
  BlockWatch,
  createDeferred,
  createTypedEventEmitter,
  Currency as CurrencyBase,
  IBlockHeaderInfo,
  SingleFileQueue,
} from '@argonprotocol/apps-core';
import { WalletKeys } from './WalletKeys.ts';
import { IArgonWalletType, IBalanceChange, WalletForArgon } from './WalletForArgon.ts';
import { Db } from './Db.ts';
import { ApiDecoration, type FrameSupportTokensMiscIdAmountRuntimeHoldReason } from '@argonprotocol/mainchain';
import { SyncStateKeys } from './db/SyncStateTable.ts';
import { type IFinancialObservation } from '../interfaces/IFinancialPosition.ts';

export interface IBlockToProcess {
  blockNumber: number;
  blockHash: string;
  blockTime: number;
  parentHash: string;
  isFinalized: boolean;
  isProcessed: boolean;
}

export type IWalletHistoryRevisions = {
  transfers: number;
  argonotCustody: number;
  asOfBlock: number;
};

export interface IWalletEvents {
  'balance-change': (balanceChange: IBalanceChange, type: IArgonWalletType) => void;
  'transfer-in': (wallet: WalletForArgon, balanceChange: IBalanceChange) => void;
  'block-deleted': (block: IBlockToProcess) => void;
  'history:recovered': (revisions: IWalletHistoryRevisions) => void;
  'sync:best-block': (block: IBlockHeaderInfo) => void;
  'sync:finalized': (block: IBlockHeaderInfo) => void;
}

export type IArgonAccountBalance = Awaited<ReturnType<typeof readArgonWalletBalanceValues>>[number] & {
  address: string;
  wallet: WalletForArgon;
  microgonHolds: FrameSupportTokensMiscIdAmountRuntimeHoldReason[];
  micronotHolds: FrameSupportTokensMiscIdAmountRuntimeHoldReason[];
};

export interface IArgonAccountSnapshot {
  accounts: IArgonAccountBalance[];
  observation: IFinancialObservation;
}

type IWalletEventKeys = keyof IWalletEvents;
type IWalletFlatList<T extends IWalletEventKeys = IWalletEventKeys> = Parameters<IWalletEvents[T]>;

/** Tracks live wallet balances across the current best-chain window and reorgs. */
export class WalletsForArgon {
  public deferredLoading = createDeferred<void>(false);
  public events = createTypedEventEmitter<IWalletEvents>();

  public miningBotWallet: WalletForArgon;
  public operationalWallet: WalletForArgon;
  public defaultArgonWallet: WalletForArgon;

  public bestBlock?: IBlockHeaderInfo;
  public finalizedBlock?: IBlockHeaderInfo;

  private loadEvents: {
    [K in IWalletEventKeys]: IWalletFlatList<K>[];
  } = {
    'balance-change': [],
    'transfer-in': [],
    'block-deleted': [],
    'history:recovered': [],
    'sync:best-block': [],
    'sync:finalized': [],
  };
  private isClosed = false;
  private bestChainWindow: IBlockToProcess[] = [];
  private blockQueue = new SingleFileQueue();
  private blockWatch: BlockWatch;
  private readonly currency: CurrencyBase;
  private unsubscribe?: () => void;
  public readonly legacyMiningHoldAddress: string;

  public get wallets(): WalletForArgon[] {
    return [this.defaultArgonWallet, this.miningBotWallet, this.operationalWallet];
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

  public readonly dbPromise: Promise<Db>;

  constructor({
    walletKeys,
    dbPromise,
    blockWatch,
    currency,
  }: {
    walletKeys: WalletKeys;
    dbPromise: Promise<Db>;
    blockWatch: BlockWatch;
    currency: CurrencyBase;
  }) {
    this.dbPromise = dbPromise;
    this.blockWatch = blockWatch;
    this.currency = currency;
    this.legacyMiningHoldAddress = walletKeys.legacyMiningHoldAddress;
    this.defaultArgonWallet = new WalletForArgon(walletKeys.defaultArgonAddress, 'defaultArgon', dbPromise);
    this.miningBotWallet = new WalletForArgon(walletKeys.miningBotAddress, 'miningBot', dbPromise);
    this.operationalWallet = new WalletForArgon(walletKeys.operationalAddress, 'operational', dbPromise);
  }

  public configureDefaultArgonWallet(address: string): void {
    this.defaultArgonWallet.address = address;
  }

  public async readAccountSnapshot({
    api,
    header,
    includeHolds = true,
  }: {
    api: ApiDecoration<'promise'>;
    header: IBlockHeaderInfo;
    includeHolds?: boolean;
  }): Promise<IArgonAccountSnapshot> {
    const wallets = this.wallets.filter((wallet, index, all) => {
      return all.findIndex(candidate => candidate.address === wallet.address) === index;
    });
    const addresses = wallets.map(wallet => wallet.address);
    const finalizedBalances = wallets.map(wallet => {
      const balance = wallet.finalizedBalance;
      return balance?.block.blockHash === header.blockHash ? balance : undefined;
    });
    const balancesPromise = finalizedBalances.every(balance => balance !== undefined)
      ? Promise.resolve(finalizedBalances.filter((balance): balance is IBalanceChange => balance !== undefined))
      : readArgonWalletBalanceValues(api, addresses);
    const emptyHolds = addresses.map(() => [] as FrameSupportTokensMiscIdAmountRuntimeHoldReason[]);
    const [balances, microgonHolds, micronotHolds] = await Promise.all([
      balancesPromise,
      includeHolds ? api.query.balances.holds.multi(addresses) : Promise.resolve(emptyHolds),
      includeHolds ? api.query.ownership.holds.multi(addresses) : Promise.resolve(emptyHolds),
    ]);

    return {
      accounts: wallets.map((wallet, index) => ({
        ...balances[index],
        address: wallet.address,
        wallet,
        microgonHolds: [...(microgonHolds[index] ?? [])],
        micronotHolds: [...(micronotHolds[index] ?? [])],
      })),
      observation: {
        observedAt: new Date(header.blockTime),
        blockNumber: header.blockNumber,
        blockHash: header.blockHash,
      },
    };
  }

  public getLoadEvents<KEY extends IWalletEventKeys>(key: KEY): IWalletFlatList<KEY>[] {
    return this.loadEvents[key] as IWalletFlatList<KEY>[];
  }

  public async load() {
    if (this.deferredLoading.isResolved || this.deferredLoading.isRunning) {
      return this.deferredLoading.promise;
    }
    if (this.deferredLoading.isRejected) {
      this.deferredLoading = createDeferred<void>(false);
    }
    this.deferredLoading.setIsRunning(true);
    const loadStartedAt = Date.now();
    let stage: string | undefined;
    try {
      stage = 'blockWatch.start';
      await this.blockWatch.start();

      stage = 'initializeCurrentBalances';
      await this.initializeCurrentBalances();

      stage = 'subscribe';
      await this.loadBalancesAt(this.blockWatch.bestBlockHeader);
      this.unsubscribe = this.blockWatch.events.on('best-blocks', (blocks: IBlockHeaderInfo[]) => {
        const latestBlock = blocks[blocks.length - 1];
        void this.loadBalancesAt(latestBlock).catch(error => {
          if (this.canIgnoreLoadError(error)) {
            return;
          }
          console.error('[WalletsForArgon] Failed to load balances at best block', error);
        });
      });
      this.deferredLoading.resolve();
    } catch (err) {
      console.error(
        `[WalletsForArgon] Initial load failed at ${stage ?? 'start'} after ${Date.now() - loadStartedAt}ms`,
        err,
      );
      this.deferredLoading.reject(err);
    }
    return this.deferredLoading.promise;
  }

  public async close() {
    this.isClosed = true;
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    await this.blockQueue.stop(true);
  }

  public didWalletHavePreviousLife() {
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
      if (this.isClosed) {
        return;
      }
      const finalizedBlock = this.blockWatch.finalizedBlockHeader;
      const finalizedBlockNumber = finalizedBlock.blockNumber;

      const latestTrackedBlock = this.bestChainWindow.at(-1);
      if (
        !latestTrackedBlock ||
        latestTrackedBlock.blockNumber < finalizedBlockNumber ||
        (latestTrackedBlock.blockNumber === finalizedBlockNumber &&
          latestTrackedBlock.blockHash !== finalizedBlock.blockHash)
      ) {
        // Nothing in the retained live window can still reorg once finality has passed it.
        // Re-anchor here; finalized wallet history is recovered separately from sparse indexed blocks.
        await this.initializeCurrentBalances(finalizedBlock);
      }

      const oldestBlock = Math.min(...this.bestChainWindow.map(x => x.blockNumber), finalizedBlockNumber);

      let currentHeader = header;
      const isCurrentBestTreeHash = this.blockWatch.latestHeaders.some(x => x.blockHash === currentHeader.blockHash);
      if (!currentHeader.isFinalized && !isCurrentBestTreeHash) {
        // Live balance tracking only needs a stable best-chain header at this height.
        // If a non-finalized hash has already fallen off the watched best tree,
        // normalize it up front instead of retrying later while mutating history.
        currentHeader = await this.blockWatch.getHeaderByBlockNumber(currentHeader.blockNumber);
      }
      let bestChainHeader = currentHeader;
      for (let blockNumber = currentHeader.blockNumber; blockNumber >= oldestBlock; blockNumber--) {
        if (bestChainHeader.blockNumber !== blockNumber) {
          throw new Error(
            `Inconsistent block numbers when loading live wallet balances. (Expected=${blockNumber}, actual=${bestChainHeader.blockNumber})`,
          );
        }
        const entry = {
          blockNumber,
          blockHash: bestChainHeader.blockHash,
          blockTime: bestChainHeader.blockTime,
          isFinalized: blockNumber <= finalizedBlockNumber,
          isProcessed: false,
          parentHash: bestChainHeader.parentHash,
        };
        const existingBlock = this.bestChainWindow.find(b => b.blockNumber === entry.blockNumber);

        if (existingBlock?.blockHash === entry.blockHash) break;
        if (existingBlock) this.rollbackBlock(existingBlock);
        const index = this.bestChainWindow.findIndex(b => b.blockNumber > entry.blockNumber);
        if (index >= 0) {
          this.bestChainWindow.splice(index, 0, entry);
        } else {
          this.bestChainWindow.push(entry);
        }
        if (blockNumber === 0) {
          break;
        }
        bestChainHeader = await this.blockWatch.getParentHeader(bestChainHeader);
      }

      let firstBlockNeeded = 0;
      const db = await this.dbPromise;
      for (let i = 0; i < this.bestChainWindow.length; i++) {
        const block = this.bestChainWindow[i];
        block.isFinalized = block.blockNumber <= finalizedBlockNumber;
        if (block.blockHash === finalizedBlock.blockHash) {
          firstBlockNeeded = i;
          break;
        }
      }
      for (const block of this.bestChainWindow) {
        if (!block.isProcessed) {
          await this.processBlock(block);
        }
        if (this.isClosed) break;
      }
      if (this.isClosed) {
        return;
      }

      await this.finalizePendingTransfers(finalizedBlockNumber);
      await db.syncStateTable.upsert(SyncStateKeys.Wallet, {
        blockNumber: finalizedBlock.blockNumber,
        blockHash: finalizedBlock.blockHash,
        blockTime: finalizedBlock.blockTime,
        parentHash: finalizedBlock.parentHash,
        isFinalized: true,
        isProcessed: true,
      });
      if (firstBlockNeeded > 0) {
        this.bestChainWindow.splice(0, firstBlockNeeded);
      }
      for (const wallet of this.wallets) {
        wallet.trimToFinalizedBlock(finalizedBlock);
      }
      this.bestBlock = currentHeader;
      this.finalizedBlock = finalizedBlock;
      this.events.emit('sync:best-block', currentHeader);
      this.events.emit('sync:finalized', finalizedBlock);
    }).promise;
  }

  private async initializeCurrentBalances(finalizedBlock = this.blockWatch.finalizedBlockHeader): Promise<void> {
    const { balances } = await this.readBalances(this.addresses, finalizedBlock);
    for (let i = 0; i < this.wallets.length; i++) {
      const wallet = this.wallets[i];
      const balance = balances[i];
      const previousBalance = wallet.latestBalanceChange;
      const didBalanceChange = previousBalance ? wallet.hasDiff(previousBalance, balance) : undefined;
      wallet.balanceHistory = [balance];
      if (didBalanceChange ?? wallet.hasValue()) {
        this.events.emit('balance-change', balance, wallet.type);
        if (!this.deferredLoading.isSettled) {
          this.loadEvents['balance-change'].push([balance, wallet.type]);
        }
      }
    }
    this.bestChainWindow = [
      {
        blockNumber: finalizedBlock.blockNumber,
        blockHash: finalizedBlock.blockHash,
        blockTime: finalizedBlock.blockTime,
        parentHash: finalizedBlock.parentHash,
        isFinalized: true,
        isProcessed: true,
      },
    ];
    this.finalizedBlock = finalizedBlock;
  }

  private async finalizePendingTransfers(finalizedBlockNumber: number): Promise<void> {
    // Transfers first observed on the best chain become query-visible only after finality.
    // Historical recovery is handled separately by WalletHistoryRecovery.
    const ratesByBlockHash = new Map<string, ReturnType<CurrencyBase['fetchMainchainRatesAtBlock']>>();
    for (const wallet of this.wallets) {
      for (const balance of wallet.balanceHistory) {
        if (balance.block.isFinalized || balance.block.blockNumber > finalizedBlockNumber) continue;

        if (!balance.transfers.length) {
          balance.block.isFinalized = true;
          continue;
        }

        let ratesPromise = ratesByBlockHash.get(balance.block.blockHash);
        if (!ratesPromise) {
          ratesPromise = this.blockWatch.getApi(balance.block).then(api => {
            return this.currency.fetchMainchainRatesAtBlock({ api, block: balance.block });
          });
          ratesByBlockHash.set(balance.block.blockHash, ratesPromise);
        }
        await wallet.saveFinalizedTransfers(
          {
            ...balance,
            block: { ...balance.block, isFinalized: true },
          },
          await ratesPromise,
        );
        balance.block.isFinalized = true;
        this.emitTransferIn(wallet, balance);
      }
    }
  }

  private rollbackBlock(block: IBlockToProcess) {
    const index = this.bestChainWindow.findIndex(b => b.blockNumber === block.blockNumber);
    if (index >= 0) {
      this.bestChainWindow.splice(index, 1);
    }
    for (const wallet of this.wallets) {
      wallet.dropBlock(block.blockHash);
    }
    this.events.emit('block-deleted', block);
  }

  private async readBalances(
    addresses: string[],
    block: Pick<IBlockToProcess, 'blockNumber' | 'blockHash' | 'blockTime' | 'isFinalized'>,
  ): Promise<{
    balances: IBalanceChange[];
    api: ApiDecoration<'promise'>;
  }> {
    const api = await this.blockWatch.getApi(block);
    const balances = await readArgonWalletBalances(api, addresses, block);
    return { balances, api };
  }

  private async processBlock(block: IBlockToProcess) {
    const wallets = this.wallets;
    const addresses = this.addresses;
    const ownedAddresses = [...new Set([...addresses, this.legacyMiningHoldAddress].filter(Boolean))];
    const { balances, api } = await this.readBalances(addresses, block);
    const hasChanges = balances.map((entry, index) => wallets[index].addDiffs(entry));
    // Cross-chain sends move funds onto a hold without necessarily changing
    // free or reserved balances, so live transfer capture must inspect events
    // even when the balance snapshot itself is unchanged.
    const { events, api: eventApi } = await this.blockWatch.getEventsWithSpec(block);
    for (let index = 0; index < wallets.length; index += 1) {
      const filter = new AccountEventsFilter(wallets[index].address, ownedAddresses);
      filter.process(eventApi, events);
      balances[index].transfers = filter.transfers;
      balances[index].extrinsicEvents = filter.eventsByExtrinsic;
    }

    for (let i = 0; i < addresses.length; i++) {
      const wallet = wallets[i];
      const entry: IBalanceChange = balances[i];

      if (hasChanges[i] || entry.transfers.length) {
        const prices =
          entry.block.isFinalized && entry.transfers.length
            ? await this.currency.fetchMainchainRatesAtBlock({ api, block: entry.block })
            : undefined;
        const changed = await wallet.onBalanceChange(entry, prices);
        if (changed) {
          this.events.emit('balance-change', entry, wallet.type);
          if (!this.deferredLoading.isSettled) {
            this.loadEvents['balance-change'].push([entry, wallet.type]);
          }
          if (entry.block.isFinalized) this.emitTransferIn(wallet, entry);
        }
      }
    }
    block.isProcessed = true;
  }

  private emitTransferIn(wallet: WalletForArgon, balance: IBalanceChange): void {
    if (!balance.transfers.some(transfer => transfer.isInbound)) return;

    this.events.emit('transfer-in', wallet, balance);
    if (!this.deferredLoading.isSettled) {
      this.loadEvents['transfer-in'].push([wallet, balance]);
    }
  }

  private canIgnoreLoadError(error: unknown): boolean {
    if (!this.isClosed) {
      return false;
    }

    const message = error instanceof Error ? error.message : String(error);
    const lowered = message.toLowerCase();
    return (
      lowered.includes('disconnected from ws://') ||
      lowered.includes('abnormal closure') ||
      lowered.includes('queue is stopped')
    );
  }
}

export async function readArgonWalletBalanceValues(
  api: ApiDecoration<'promise'>,
  addresses: string[],
): Promise<
  Pick<IBalanceChange, 'availableMicrogons' | 'reservedMicrogons' | 'availableMicronots' | 'reservedMicronots'>[]
> {
  const [microgons, micronots] = await Promise.all([
    api.query.system.account.multi(addresses).then(accounts => accounts.map(account => account.data)),
    api.query.ownership.account.multi(addresses),
  ]);

  return addresses.map((_, index) => ({
    availableMicrogons: microgons[index]?.free.toBigInt() ?? 0n,
    reservedMicrogons: microgons[index]?.reserved.toBigInt() ?? 0n,
    availableMicronots: micronots[index]?.free.toBigInt() ?? 0n,
    reservedMicronots: micronots[index]?.reserved.toBigInt() ?? 0n,
  }));
}

export async function readArgonWalletBalances(
  api: ApiDecoration<'promise'>,
  addresses: string[],
  block: IBalanceChange['block'],
): Promise<IBalanceChange[]> {
  const balances = await readArgonWalletBalanceValues(api, addresses);
  return balances.map(balance => ({
    block: { ...block },
    ...balance,
    microgonsAdded: 0n,
    micronotsAdded: 0n,
    extrinsicEvents: [],
    transfers: [],
  }));
}
