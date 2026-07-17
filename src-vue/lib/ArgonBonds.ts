import type { ArgonClient, FrameSystemEventRecord } from '@argonprotocol/mainchain';
import {
  type ArgonQueryClient,
  BondLot,
  type Currency,
  type IBlockHeaderInfo,
  type IFrameBondLot,
  type MiningFrames,
  TreasuryBonds,
} from '@argonprotocol/apps-core';
import type { Config } from './Config.ts';
import type { Db } from './Db.ts';
import type { TransactionInfo } from './TransactionInfo.ts';
import type { TransactionTracker } from './TransactionTracker.ts';
import type { WalletKeys } from './WalletKeys.ts';
import type { IBondLotHistoryRecord } from './db/BondLotHistoryTable.ts';
import { getMainchainClient } from '../stores/mainchain.ts';
import { ArgonBondsRecovery } from './recovery/ArgonBonds.ts';

export interface IVaultArgonBondState {
  bondLots: BondLot[];
  currentFrame: {
    frameId: number;
    vaultBonds: number;
    bondLots: IFrameBondLot[];
  };
  isLoaded: boolean;
}

export type IArgonBondFrame = {
  frameId: number;
  distributableBidPool: bigint;
  globalBonds: number;
} & IVaultArgonBondState['currentFrame'];

export type IBuyVaultBondMetadata = {
  vaultId: number;
  bondPurchaseMicrogons: bigint;
};

export type IBuyArgonotBondMetadata = {
  bondPurchaseMicronots: bigint;
};

type IVaultBondSubscription = {
  vaultId: number;
  operatorAddress: string;
  accountId?: string;
  frameId?: number;
};

export class ArgonBonds {
  public data = {
    bondLots: [] as BondLot[],
    bondHistory: [] as IBondLotHistoryRecord[],
    isLoaded: false,
    vaultId: 0,
    currentFrameId: 0,
    distributableBidPool: 0n,
    totalActiveBonds: 0,
    vaultsById: {} as Record<number, IVaultArgonBondState>,
  };

  private blockSubscription?: VoidFunction;
  private finalizedHistorySubscription?: VoidFunction;
  private loadPromise?: Promise<void>;
  private isGlobalSubscribed = false;
  private readonly vaultSubscriptionArgs = new Map<number, IVaultBondSubscription>();
  private readonly historyRecovery: ArgonBondsRecovery;

  constructor(
    private readonly dbPromise: Promise<Db>,
    private readonly config: Pick<Config, 'isLoadedPromise' | 'upstreamOperator'>,
    private readonly currency: Pick<Currency, 'isLoadedPromise' | 'fetchMainchainRatesAtBlock'>,
    public readonly miningFrames: MiningFrames,
    private readonly walletKeys: WalletKeys,
    private readonly transactionTracker: TransactionTracker,
  ) {
    this.historyRecovery = new ArgonBondsRecovery({
      dbPromise,
      currency,
      miningFrames,
      walletKeys,
      transactionTracker,
    });
  }

  public get completedBondHistory(): IBondLotHistoryRecord[] {
    return this.data.bondHistory.filter(record => record.releaseBlockHash);
  }

  public get bondTotals() {
    return BondLot.getTotals(this.data.bondLots);
  }

  public async load(): Promise<void> {
    if (this.data.isLoaded) return;

    this.loadPromise ??= (async () => {
      await this.config.isLoadedPromise;
      await this.currency.isLoadedPromise;
      await this.miningFrames.load();

      const blockWatch = this.miningFrames.blockWatch;
      await blockWatch.start();
      this.data.vaultId = this.config.upstreamOperator?.vaultId ?? 0;

      const finalizedBlock = blockWatch.finalizedBlockHeader;
      const finalizedClient = await blockWatch.getApi(finalizedBlock);
      const lots = await this.getOwnBondLots(finalizedClient);
      this.data.bondLots = lots;
      const db = await this.dbPromise;
      await Promise.all(
        lots.map(lot =>
          db.bondLotHistoryTable.recordObservation({
            lot,
            blockNumber: finalizedBlock.blockNumber,
            blockHash: finalizedBlock.blockHash,
          }),
        ),
      );
      await this.refreshHistory();

      this.ensureBlockSubscription();
      this.data.isLoaded = true;
      void this.historyRecovery
        .repairLocalPurchases()
        .then(async didRepair => {
          if (didRepair) await this.refreshHistory();
        })
        .catch(error => console.warn('[ArgonBonds] Unable to restore purchase history from local transactions', error));
    })().catch(error => {
      this.loadPromise = undefined;
      throw error;
    });

    return this.loadPromise;
  }

  public async refreshBondLots(client?: ArgonQueryClient): Promise<void> {
    client ??= await getMainchainClient(false);
    this.data.bondLots = await this.getOwnBondLots(client);
    this.setDisplayVaultId(this.config.upstreamOperator?.vaultId ?? this.data.vaultId);
  }

  public saveBondPurchase(info: TransactionInfo): void {
    if (!info.isPostProcessed) return;
    const postProcessor = info.createPostProcessor();
    void (async () => {
      try {
        await this.transactionTracker.ensureStoredEvents(info);
        await this.recordFinalizedPurchase(info);
        await Promise.all([this.refreshHistory(), this.refreshBondLots()]);
        postProcessor.resolve();
      } catch (error) {
        console.error('Unable to save finalized bond purchase history', error);
        postProcessor.reject(error as Error);
      }
    })();
  }

  public saveBondLiquidation(lotAtSubmission: BondLot, info: TransactionInfo): void {
    if (!info.isPostProcessed) return;
    const postProcessor = info.createPostProcessor();
    void (async () => {
      try {
        await this.recordFinalizedLiquidation(lotAtSubmission, info);
        await Promise.all([this.refreshHistory(), this.refreshBondLots()]);
        postProcessor.resolve();
      } catch (error) {
        console.error('Unable to save finalized bond liquidation history', error);
        postProcessor.reject(error as Error);
      }
    })();
  }

  public async refreshHistory(): Promise<void> {
    this.data.bondHistory = await (
      await this.dbPromise
    ).bondLotHistoryTable.fetchAll(this.walletKeys.defaultArgonAddress);
  }

  public async subscribeGlobal(client?: ArgonClient): Promise<void> {
    if (this.isGlobalSubscribed) return;

    client ??= await getMainchainClient(false);
    await this.miningFrames.blockWatch.start();
    this.data.currentFrameId = this.miningFrames.blockWatch.bestBlockHeader.frameId ?? this.data.currentFrameId;
    this.data.distributableBidPool = await TreasuryBonds.getDistributableBidPool(client);
    this.isGlobalSubscribed = true;
    this.ensureBlockSubscription();
  }

  public async subscribeVault(args: IVaultBondSubscription, client?: ArgonClient): Promise<() => void> {
    client ??= await getMainchainClient(false);
    this.ensureBlockSubscription();
    this.unsubscribeVault(args.vaultId);
    this.vaultSubscriptionArgs.set(args.vaultId, args);
    await this.refreshVault(args, client);
    return () => this.unsubscribeVault(args.vaultId);
  }

  public async refreshVault(args: IVaultBondSubscription, client?: ArgonQueryClient): Promise<void> {
    client ??= await getMainchainClient(false);

    const vault = this.getVaultBonds(args.vaultId);
    const frameId = args.frameId ?? this.data.currentFrameId;
    const [activeBonds, bondLots, frameBonds] = await Promise.all([
      TreasuryBonds.getActiveBonds(client, args.vaultId),
      TreasuryBonds.getBondLots(client, args.vaultId, args.accountId ?? args.operatorAddress),
      frameId > 0
        ? TreasuryBonds.getCurrentFrameBondLots(client, args.vaultId, args.operatorAddress)
        : Promise.resolve({ bondLots: [] }),
    ]);

    this.data.totalActiveBonds = activeBonds.totalActiveBonds;
    vault.bondLots = bondLots;
    vault.currentFrame.frameId = frameId;
    vault.currentFrame.vaultBonds = activeBonds.vaultActiveBonds;
    vault.currentFrame.bondLots = frameBonds.bondLots;
    vault.isLoaded = true;
  }

  public unsubscribeVault(vaultId: number): void {
    this.vaultSubscriptionArgs.delete(vaultId);
  }

  public getVaultBonds(vaultId: number): IVaultArgonBondState {
    return (this.data.vaultsById[vaultId] ??= {
      bondLots: [],
      currentFrame: {
        frameId: 0,
        vaultBonds: 0,
        bondLots: [],
      },
      isLoaded: false,
    });
  }

  public async importHistoryBlock(block: IBlockHeaderInfo, events: readonly FrameSystemEventRecord[]): Promise<void> {
    await this.historyRecovery.importBlock(block, events);
  }

  private ensureBlockSubscription(): void {
    this.blockSubscription ??= this.miningFrames.blockWatch.events.on('best-blocks', blocks => {
      void this.onNewBestBlocks(blocks).catch(error => console.error('Error refreshing Argon bonds', error));
    });
    this.finalizedHistorySubscription ??= this.miningFrames.blockWatch.events.on('finalized', blocks => {
      void this.importFinalizedFrameHistory(blocks).catch(error => {
        console.error('Error recording finalized Argon bond history', error);
      });
    });
  }

  private async importFinalizedFrameHistory(blocks: IBlockHeaderInfo[]): Promise<void> {
    const frameBlocks = blocks.filter(block => block.isNewFrame);
    if (!frameBlocks.length) return;

    for (const block of frameBlocks) {
      const events = await this.miningFrames.blockWatch.getEvents(block);
      await this.historyRecovery.importBlock(block, events);
    }
    await this.refreshHistory();
  }

  private async onNewBestBlocks(blocks: IBlockHeaderInfo[]): Promise<void> {
    const latestBlock = blocks.at(-1);
    if (!latestBlock) return;

    let refreshBonds = false;
    let refreshMarket = false;
    let refreshBidPool = false;
    let latestRefreshBlock: IBlockHeaderInfo | undefined;
    const typeClient = await getMainchainClient(false);

    for (const block of blocks) {
      if (block.frameId != null) this.data.currentFrameId = block.frameId;

      const events = await this.miningFrames.blockWatch.getEvents(block);
      for (const { event } of events) {
        if (typeClient.events.miningSlot.SlotBidderAdded.is(event) && event.data.bidAmount.toBigInt() > 0n) {
          refreshBidPool = true;
        } else if (typeClient.events.miningSlot.SlotBidderDropped.is(event)) {
          refreshBidPool = true;
        } else if (typeClient.events.treasury.FrameEarningsDistributed.is(event)) {
          refreshBonds = true;
          refreshMarket = true;
          if (event.data.bidPoolDistributed.toBigInt() > 0n) refreshBidPool = true;
        } else if (typeClient.events.treasury.FrameVaultCapitalLocked.is(event)) {
          refreshMarket = true;
        } else if (
          typeClient.events.treasury.BondLotPurchased.is(event) ||
          typeClient.events.treasury.BondLotReleaseScheduled.is(event) ||
          typeClient.events.treasury.BondLotReleased.is(event)
        ) {
          refreshBonds = true;
          refreshMarket = true;
        }
      }

      if (block.isNewFrame) {
        refreshBonds = true;
        refreshMarket = true;
      }
      if (refreshBonds || refreshMarket) latestRefreshBlock = block;
    }

    if (refreshBidPool && this.isGlobalSubscribed) {
      this.data.distributableBidPool = await TreasuryBonds.getDistributableBidPool(
        await this.miningFrames.blockWatch.getApi(latestBlock),
      );
    }
    if (!latestRefreshBlock) return;

    const client = await this.miningFrames.blockWatch.getApi(latestRefreshBlock);
    const refreshes: Promise<void>[] = [];
    if (refreshBonds && this.data.isLoaded) refreshes.push(this.refreshBondLots(client));
    if (refreshMarket && this.isGlobalSubscribed) refreshes.push(this.refreshSubscribedVaults(client));
    await Promise.all(refreshes);
  }

  private async refreshSubscribedVaults(client: ArgonQueryClient): Promise<void> {
    await Promise.all(
      [...this.vaultSubscriptionArgs.values()].map(args => {
        const nextArgs = args.frameId === undefined ? { ...args, frameId: this.data.currentFrameId } : args;
        return this.refreshVault(nextArgs, client);
      }),
    );
  }

  private async getOwnBondLots(client: ArgonQueryClient): Promise<BondLot[]> {
    const accountId = this.walletKeys.defaultArgonAddress;
    const accountLots = await TreasuryBonds.getBondLotsByAccount(client, accountId);
    if (accountLots.length || !this.config.upstreamOperator?.vaultId) {
      return accountLots.filter(lot => lot.isOwn);
    }

    return (await TreasuryBonds.getBondLots(client, this.config.upstreamOperator.vaultId, accountId)).filter(
      lot => lot.isOwn,
    );
  }

  private setDisplayVaultId(preferredVaultId: number): void {
    const ownedVaultIds = new Set(this.data.bondLots.flatMap(lot => (lot.vaultId == null ? [] : [lot.vaultId])));
    if (preferredVaultId && (!ownedVaultIds.size || ownedVaultIds.has(preferredVaultId))) {
      this.data.vaultId = preferredVaultId;
      return;
    }

    this.data.vaultId = this.data.bondLots.find(lot => lot.vaultId != null)?.vaultId ?? preferredVaultId;
  }

  private async recordFinalizedPurchase(info: TransactionInfo): Promise<void> {
    const block = await this.getFinalizedTransactionBlock(info);
    const api = await this.miningFrames.blockWatch.getApi(block);
    const event = info.txResult.events.find(event => {
      return (
        api.events.treasury.BondLotPurchased.is(event) &&
        event.data.accountId.toString() === this.walletKeys.defaultArgonAddress
      );
    });
    if (!event || !api.events.treasury.BondLotPurchased.is(event)) {
      throw new Error('BondLotPurchased event not found in transaction result');
    }

    await this.historyRecovery.recordPurchase(
      block,
      event.data.bondLotId.toNumber(),
      info.tx.blockExtrinsicIndex ?? info.txResult.extrinsicIndex,
    );
  }

  private async recordFinalizedLiquidation(lotAtSubmission: BondLot, info: TransactionInfo): Promise<void> {
    const block = await this.getFinalizedTransactionBlock(info);
    const api = await this.miningFrames.blockWatch.getApi(block);
    const lotOption = await api.query.treasury.bondLotById(lotAtSubmission.id);
    if (lotOption.isNone) {
      throw new Error(`Liquidated bond lot ${lotAtSubmission.id} not found at finalized block`);
    }

    const accountId = this.walletKeys.defaultArgonAddress;
    const lot = BondLot.fromRuntime(lotAtSubmission.id, lotOption.unwrap(), accountId);
    const nativePrincipal = lot.principalMicrogons ?? lot.principalMicronots;
    const submittedNativePrincipal = lotAtSubmission.principalMicrogons ?? lotAtSubmission.principalMicronots;
    if (
      lot.accountId !== lotAtSubmission.accountId ||
      lot.programType !== lotAtSubmission.programType ||
      nativePrincipal !== submittedNativePrincipal
    ) {
      throw new Error(`Liquidated bond lot ${lotAtSubmission.id} no longer matches its submitted identity`);
    }

    await (
      await this.dbPromise
    ).bondLotHistoryTable.recordObservation({
      lot,
      blockNumber: block.blockNumber,
      blockHash: block.blockHash,
    });
  }

  private async getFinalizedTransactionBlock(info: TransactionInfo): Promise<IBlockHeaderInfo> {
    await info.txResult.waitForFinalizedBlock;
    const blockNumber = info.txResult.blockNumber ?? info.tx.blockHeight;
    if (blockNumber === undefined) throw new Error('Finalized bond transaction is missing its inclusion block');
    return this.miningFrames.blockWatch.getHeader(blockNumber);
  }
}
