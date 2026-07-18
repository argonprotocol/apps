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
import { IArgonWalletType, IBalanceChange, type IWalletBalanceTransfer, WalletForArgon } from './WalletForArgon.ts';
import { Db } from './Db.ts';
import { ApiDecoration, type FrameSupportTokensMiscIdAmountRuntimeHoldReason } from '@argonprotocol/mainchain';
import { SyncStateKeys } from './db/SyncStateTable.ts';
import { type IFinancialObservation } from '../interfaces/IFinancialPosition.ts';

export type IWalletHistoryRevisions = {
  transfers: number;
  argonotCustody: number;
  asOfBlock: number;
};

export interface IWalletEvents {
  'balance-change': (balanceChange: IBalanceChange, type: IArgonWalletType) => void;
  'transfer-in': (wallet: WalletForArgon) => void;
  'history:gap': (gap: { afterBlock: number; toBlock: number }) => void;
  'history:recovered': (revisions: IWalletHistoryRevisions) => void;
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

/** Publishes current wallet balances and records finalized wallet transfers. */
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
    'history:gap': [],
    'history:recovered': [],
    'sync:finalized': [],
  };
  private isClosed = false;
  private blockQueue = new SingleFileQueue();
  private finalizedBlockQueue = new SingleFileQueue();
  private blockWatch: BlockWatch;
  private readonly currency: CurrencyBase;
  private finalizedHistoryBlock?: IBlockHeaderInfo;
  private unsubscribes: VoidFunction[] = [];
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
    const emptyHolds = addresses.map(() => [] as FrameSupportTokensMiscIdAmountRuntimeHoldReason[]);
    const [balances, microgonHolds, micronotHolds] = await Promise.all([
      readArgonWalletBalanceValues(api, addresses),
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
      const db = await this.dbPromise;
      const savedWalletSync = await db.syncStateTable.get(SyncStateKeys.Wallet);

      stage = 'blockWatch.start';
      await this.blockWatch.start();

      const initialFinalizedBlock = this.blockWatch.finalizedBlockHeader;
      if (savedWalletSync && savedWalletSync.blockNumber < initialFinalizedBlock.blockNumber) {
        this.emitHistoryGap(savedWalletSync.blockNumber, initialFinalizedBlock.blockNumber);
      }
      this.finalizedBlock = initialFinalizedBlock;
      this.finalizedHistoryBlock = initialFinalizedBlock;

      stage = 'subscribe';
      this.unsubscribes = [
        this.blockWatch.events.on('best-blocks', (blocks: IBlockHeaderInfo[]) => {
          const latestBlock = blocks[blocks.length - 1];
          void this.loadBalancesAt(latestBlock).catch(error => {
            if (this.canIgnoreLoadError(error)) return;
            console.error('[WalletsForArgon] Failed to load current balances', error);
          });
        }),
        this.blockWatch.events.on('finalized', headers => {
          void this.processFinalizedBlocks(headers).catch(error => {
            if (this.canIgnoreLoadError(error)) return;
            console.error('[WalletsForArgon] Failed to record finalized wallet transfers', error);
          });
        }),
      ];

      stage = 'loadCurrentBalances';
      await this.loadBalancesAt(this.blockWatch.bestBlockHeader);
      void db.syncStateTable.upsert(SyncStateKeys.Wallet, {
        ...initialFinalizedBlock,
        isFinalized: true,
        isProcessed: true,
      }).catch(error => {
        console.error('[WalletsForArgon] Failed to save the finalized wallet cursor', error);
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
    for (const unsubscribe of this.unsubscribes) unsubscribe();
    this.unsubscribes.length = 0;
    await Promise.all([this.blockQueue.stop(true), this.finalizedBlockQueue.stop(true)]);
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
      const isCurrentBestTreeHash = this.blockWatch.latestHeaders.some(x => x.blockHash === header.blockHash);
      const currentHeader = header.isFinalized || isCurrentBestTreeHash ? header : this.blockWatch.bestBlockHeader;
      const { balances } = await this.readBalances(this.addresses, currentHeader);

      for (let index = 0; index < this.wallets.length; index += 1) {
        const wallet = this.wallets[index];
        const balance = balances[index];
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

      this.bestBlock = currentHeader;
    }).promise;
  }

  private async processFinalizedBlocks(headers: IBlockHeaderInfo[]): Promise<void> {
    await this.finalizedBlockQueue.add(async () => {
      if (this.isClosed) return;

      const previousFinalizedBlock = this.finalizedHistoryBlock;
      const newHeaders = headers.filter(header => header.blockNumber > (previousFinalizedBlock?.blockNumber ?? -1));
      if (!newHeaders.length) return;

      const latestHeader = newHeaders.at(-1)!;
      if (!previousFinalizedBlock || newHeaders[0].blockNumber !== previousFinalizedBlock.blockNumber + 1) {
        if (previousFinalizedBlock) this.emitHistoryGap(previousFinalizedBlock.blockNumber, latestHeader.blockNumber);
      } else {
        for (const header of newHeaders) {
          await this.processFinalizedBlock(header);
        }
      }
      this.finalizedHistoryBlock = latestHeader;

      const db = await this.dbPromise;
      await db.syncStateTable.upsert(SyncStateKeys.Wallet, {
        ...latestHeader,
        isFinalized: true,
        isProcessed: true,
      });
      this.finalizedBlock = latestHeader;
      this.events.emit('sync:finalized', latestHeader);
    }).promise;
  }

  private async readBalances(
    addresses: string[],
    block: IBalanceChange['block'],
  ): Promise<{
    balances: IBalanceChange[];
    api: ApiDecoration<'promise'>;
  }> {
    const api = await this.blockWatch.getApi(block);
    const balances = await readArgonWalletBalances(api, addresses, block);
    return { balances, api };
  }

  private async processFinalizedBlock(block: IBlockHeaderInfo): Promise<void> {
    const wallets = this.wallets;
    const addresses = this.addresses;
    const ownedAddresses = [...new Set([...addresses, this.legacyMiningHoldAddress].filter(Boolean))];
    const { events, api } = await this.blockWatch.getEventsWithSpec(block);
    const transfersByWallet: IWalletBalanceTransfer[][] = [];
    for (let index = 0; index < wallets.length; index += 1) {
      const filter = new AccountEventsFilter(wallets[index].address, ownedAddresses);
      filter.process(api, events);
      transfersByWallet.push(filter.transfers);
    }

    if (!transfersByWallet.some(transfers => transfers.length)) return;

    const prices = await this.currency.fetchMainchainRatesAtBlock({ api, block });
    for (let index = 0; index < wallets.length; index += 1) {
      const transfers = transfersByWallet[index];
      if (!transfers.length) continue;

      await wallets[index].saveFinalizedTransfers({ block: { ...block, isFinalized: true }, transfers }, prices);
      this.emitTransferIn(wallets[index], transfers);
    }
  }

  private emitTransferIn(wallet: WalletForArgon, transfers: IWalletBalanceTransfer[]): void {
    if (!transfers.some(transfer => transfer.isInbound)) return;

    this.events.emit('transfer-in', wallet);
    if (!this.deferredLoading.isSettled) {
      this.loadEvents['transfer-in'].push([wallet]);
    }
  }

  private emitHistoryGap(afterBlock: number, toBlock: number): void {
    if (afterBlock >= toBlock) return;

    const gap = { afterBlock, toBlock };
    this.events.emit('history:gap', gap);
    if (!this.deferredLoading.isSettled) {
      this.loadEvents['history:gap'].push([gap]);
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
