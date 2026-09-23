import {
  type ArgonClient,
  type ArgonQueryClient,
  BondLot,
  type Currency,
  createDeferred,
  type IBlockHeaderInfo,
  type IDeferred,
  type IFrameBondLot,
  type MiningFrames,
  type RuntimeSystemEventRecord,
  TreasuryBonds,
  type VaultBondCapacityState,
  type Vault,
} from '@argonprotocol/apps-core';
import type { Config } from './Config.ts';
import type { Db } from './Db.ts';
import type { WalletKeys } from './WalletKeys.ts';
import type { IBondLotFlexibilityTransition, IBondLotHistoryRecord } from './db/BondLotHistoryTable.ts';
import { SyncStateKeys } from './db/SyncStateTable.ts';
import { getMainchainClient } from '../stores/mainchain.ts';
import { ArgonBondsRecovery } from './recovery/ArgonBonds.ts';

const INITIAL_FINALIZED_HISTORY_BLOCKS = 90;

export type IBondHistoryFact =
  | { kind: 'release-scheduled'; lot: BondLot; block: IBlockHeaderInfo; extrinsicIndex?: number }
  | {
      kind: 'purchase';
      lot: BondLot;
      block: IBlockHeaderInfo;
      extrinsicIndex?: number;
      entryArgonotRateMicrogons?: bigint;
      isFlexibleAtPurchase: boolean;
    }
  | {
      kind: 'release';
      lot: BondLot;
      block: IBlockHeaderInfo;
      parent: IBlockHeaderInfo;
      extrinsicIndex?: number;
      closingArgonotRateMicrogons?: bigint;
      wasFlexible: boolean;
    }
  | { kind: 'flexibility'; lot: BondLot; transition: IBondLotFlexibilityTransition };

export interface IVaultArgonBondState {
  bondLots: BondLot[];
  ordinaryBonds: number;
  flexibleBonds: number;
  reservedBondSpace: number;
  currentFrame: {
    frameId: number;
    vaultBonds: number;
    flexibleBondsEligible: number;
    bondLots: IFrameBondLot[];
  };
  isLoaded: boolean;
}

export type IArgonBondFrame = {
  frameId: number;
  distributableBidPool: bigint;
  globalBonds: number;
} & IVaultArgonBondState['currentFrame'];

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
    historyCoveragePending: false,
    historyError: undefined as string | undefined,
    financialRevision: 0,
    vaultId: 0,
    currentFrameId: 0,
    distributableBidPool: 0n,
    totalActiveBonds: 0,
    vaultsById: {} as Record<number, IVaultArgonBondState>,
    capacityStatesByVault: {} as Record<number, VaultBondCapacityState>,
  };

  private blockSubscription?: VoidFunction;
  private finalizedHistorySubscription?: VoidFunction;
  private waitForLoad?: IDeferred<void>;
  private isGlobalSubscribed = false;
  private readonly vaultSubscriptionArgs = new Map<number, IVaultBondSubscription>();
  private nextVaultRefreshVersion = 0;
  private lastTotalActiveBondsRefreshVersion = 0;
  private readonly publishedVaultRefreshVersions = new Map<number, number>();
  private readonly historyRecovery: ArgonBondsRecovery;
  private recoveredHistoryFacts: IBondHistoryFact[] = [];
  private finalizedHistoryQueue = Promise.resolve();
  private finalizedHistoryCursor?: { blockNumber: number; blockHash: string };

  constructor(
    private readonly dbPromise: Promise<Db>,
    private readonly config: Pick<Config, 'isLoadedPromise' | 'upstreamOperator'>,
    private readonly currency: Pick<Currency, 'isLoadedPromise' | 'fetchMainchainRatesAtBlock' | 'priceIndex'>,
    public readonly miningFrames: MiningFrames,
    private readonly walletKeys: WalletKeys,
  ) {
    this.historyRecovery = new ArgonBondsRecovery(currency, miningFrames, walletKeys.defaultArgonAddress);
  }

  public get bondTotals() {
    return BondLot.getTotals(this.data.bondLots);
  }

  public get needsHistoryRepair(): boolean {
    return this.data.bondHistory.some(record => !record.flexibilityHistoryComplete);
  }

  public getVaultBondCapacityMicrogons(vault: Vault): bigint {
    return TreasuryBonds.getVaultBondCapacityMicrogons({ vault, priceIndex: this.currency.priceIndex });
  }

  public getFlexibleBondDisplacementPercent(vaultId: number): number | undefined {
    const vault = this.data.vaultsById[vaultId];
    if (!vault?.isLoaded || vault.currentFrame.frameId <= 0 || vault.flexibleBonds <= 0) return;

    const displacedBonds = Math.max(
      0,
      Math.min(vault.flexibleBonds, vault.currentFrame.vaultBonds) - vault.currentFrame.flexibleBondsEligible,
    );
    return Math.min(100, (displacedBonds / vault.flexibleBonds) * 100);
  }

  public availableBondSpace(vault: Vault): bigint {
    const bondState = this.data.capacityStatesByVault[vault.vaultId];

    return TreasuryBonds.availableBondSpace({
      capacityMicrogons: this.getVaultBondCapacityMicrogons(vault),
      bondState,
    });
  }

  public async load(): Promise<void> {
    if (this.waitForLoad?.isRunning || this.waitForLoad?.isResolved) return this.waitForLoad.promise;

    this.waitForLoad = createDeferred<void>();
    try {
      await this.config.isLoadedPromise;
      await this.currency.isLoadedPromise;
      await this.miningFrames.load();

      const blockWatch = this.miningFrames.blockWatch;
      await blockWatch.start();
      this.data.currentFrameId = blockWatch.bestBlockHeader.frameId ?? this.miningFrames.currentFrameId;
      this.data.vaultId = this.config.upstreamOperator?.vaultId ?? 0;

      const finalizedBlock = blockWatch.finalizedBlockHeader;
      const db = await this.dbPromise;
      const savedCursor = await db.syncStateTable.get(SyncStateKeys.BondHistory);
      if (savedCursor?.accountId === this.walletKeys.defaultArgonAddress) {
        this.finalizedHistoryCursor = savedCursor;
        this.data.historyCoveragePending = savedCursor.blockNumber < finalizedBlock.blockNumber;
      } else {
        // A finalized purchase may precede the first bond-domain load. Cover
        // recent blocks here; older missing facts belong to account recovery.
        const startBlock = Math.max(0, finalizedBlock.blockNumber - INITIAL_FINALIZED_HISTORY_BLOCKS);
        const startHeader =
          startBlock === finalizedBlock.blockNumber ? finalizedBlock : await blockWatch.getHeader(startBlock);
        this.finalizedHistoryCursor = { blockNumber: startHeader.blockNumber, blockHash: startHeader.blockHash };
        this.data.historyCoveragePending = startBlock < finalizedBlock.blockNumber;
        await db.syncStateTable.upsert(SyncStateKeys.BondHistory, {
          accountId: this.walletKeys.defaultArgonAddress,
          ...this.finalizedHistoryCursor,
        });
      }
      const finalizedClient = await blockWatch.getApi(finalizedBlock);
      const lots = await this.getOwnBondLots(finalizedClient);
      this.data.bondLots = lots;
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
      this.data.financialRevision += 1;
      void this.queueFinalizedHistory(blockWatch.finalizedBlockHeader.blockNumber);
      this.waitForLoad.resolve();
    } catch (error) {
      this.waitForLoad.reject(error);
    }

    return this.waitForLoad.promise;
  }

  public async refreshBondLots(client?: ArgonQueryClient): Promise<void> {
    client ??= await getMainchainClient(false);
    this.data.bondLots = await this.getOwnBondLots(client);
    this.setDisplayVaultId(this.config.upstreamOperator?.vaultId ?? this.data.vaultId);
    if (this.data.isLoaded) this.data.financialRevision += 1;
  }

  public async recordPurchasedBondLot(purchase: Extract<IBondHistoryFact, { kind: 'purchase' }>): Promise<void> {
    await this.load();
    await this.enqueueHistoryWork(async () => {
      const db = await this.dbPromise;
      await db.transaction(transaction => this.applyHistoryFacts(transaction, [purchase], true));
      await this.publishBondState();
    });
  }

  public async recordBondReleaseRequest(lot: BondLot, block: IBlockHeaderInfo): Promise<void> {
    await this.load();
    await this.enqueueHistoryWork(async () => {
      const db = await this.dbPromise;
      await db.bondLotHistoryTable.recordReleaseSchedule({
        lot,
        blockNumber: block.blockNumber,
        blockHash: block.blockHash,
      });
      await this.publishBondState();
    });
  }

  public async refreshHistory(): Promise<void> {
    const db = await this.dbPromise;
    this.data.bondHistory = await db.bondLotHistoryTable.fetchAll(this.walletKeys.defaultArgonAddress);
    this.data.bondLots = this.excludeRecordedReleases(this.data.bondLots);
    for (const vault of Object.values(this.data.vaultsById)) {
      vault.bondLots = this.excludeRecordedReleases(vault.bondLots);
    }
    if (this.data.isLoaded) this.data.financialRevision += 1;
  }

  private async publishBondState(): Promise<void> {
    const db = await this.dbPromise;
    const [history, client] = await Promise.all([
      db.bondLotHistoryTable.fetchAll(this.walletKeys.defaultArgonAddress),
      this.miningFrames.blockWatch.getCurrentApi(),
    ]);
    const lots = await this.getOwnBondLots(client, history);

    this.data.bondHistory = history;
    this.data.bondLots = lots;
    for (const vault of Object.values(this.data.vaultsById)) {
      vault.bondLots = this.excludeRecordedReleases(vault.bondLots, history);
    }
    this.setDisplayVaultId(this.config.upstreamOperator?.vaultId ?? this.data.vaultId);
    if (this.data.isLoaded) this.data.financialRevision += 1;
  }

  public async publishRecoveredHistory(): Promise<void> {
    await this.enqueueHistoryWork(async () => {
      const facts = this.recoveredHistoryFacts;
      const db = await this.dbPromise;
      await db.transaction(async transaction => {
        await this.applyHistoryFacts(transaction, facts);
        await transaction.bondLotHistoryTable.confirmFlexibilityHistory(this.walletKeys.defaultArgonAddress);
      });
      await this.refreshHistory();
      this.recoveredHistoryFacts = [];
    });
    if (this.finalizedHistoryCursor) {
      void this.queueFinalizedHistory(this.miningFrames.blockWatch.finalizedBlockHeader.blockNumber).catch(
        () => undefined,
      );
    }
  }

  public beginHistoryReplay(): void {
    this.recoveredHistoryFacts = [];
  }

  public discardRecoveredHistory(): void {
    this.recoveredHistoryFacts = [];
  }

  public hasStagedPurchase(lot: BondLot): boolean {
    return this.recoveredHistoryFacts.some(
      fact =>
        fact.kind === 'purchase' &&
        fact.lot.accountId === lot.accountId &&
        fact.lot.programType === lot.programType &&
        fact.lot.id === lot.id,
    );
  }

  public async refreshActiveState(args: { client: ArgonQueryClient; currentFrameId: number }): Promise<void> {
    if (!this.data.isLoaded) return;

    this.data.currentFrameId = args.currentFrameId;

    const refreshes: Promise<void>[] = [];
    refreshes.push(this.miningFrames.blockWatch.getCurrentApi().then(client => this.refreshBondLots(client)));
    if (this.isGlobalSubscribed) {
      refreshes.push(
        TreasuryBonds.getDistributableBidPool(args.client).then(value => {
          this.data.distributableBidPool = value;
        }),
      );
    }
    if (this.vaultSubscriptionArgs.size) refreshes.push(this.refreshSubscribedVaults(args.client));
    await Promise.all(refreshes);
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
    const refreshVersion = ++this.nextVaultRefreshVersion;
    client ??= await getMainchainClient(false);

    const vault = this.getVaultBonds(args.vaultId);
    const frameId = args.frameId ?? this.data.currentFrameId;
    const [activeBonds, bondState, frameBonds] = await Promise.all([
      TreasuryBonds.getActiveBonds(client, args.vaultId),
      TreasuryBonds.getVaultBondState(client, args.vaultId, args.accountId ?? args.operatorAddress),
      frameId > 0
        ? TreasuryBonds.getCurrentFrameBondLots(client, args.vaultId, args.operatorAddress)
        : Promise.resolve({
            bondLots: [],
            totalActiveBonds: 0,
            flexibleBondsEligible: 0,
            distributedEarnings: 0n,
          }),
    ]);

    if (refreshVersion < (this.publishedVaultRefreshVersions.get(args.vaultId) ?? 0)) return;
    this.publishedVaultRefreshVersions.set(args.vaultId, refreshVersion);
    if (refreshVersion >= this.lastTotalActiveBondsRefreshVersion) {
      this.data.totalActiveBonds = activeBonds.totalActiveBonds;
      this.lastTotalActiveBondsRefreshVersion = refreshVersion;
    }
    this.data.capacityStatesByVault[args.vaultId] = bondState.capacityState;
    vault.bondLots = this.excludeRecordedReleases(bondState.bondLots);
    vault.ordinaryBonds = bondState.ordinaryBonds;
    vault.flexibleBonds = bondState.flexibleBonds;
    vault.reservedBondSpace = bondState.reservedBondSpace;
    vault.currentFrame.frameId = frameId;
    vault.currentFrame.vaultBonds = activeBonds.vaultActiveBonds;
    vault.currentFrame.flexibleBondsEligible = frameBonds.flexibleBondsEligible;
    vault.currentFrame.bondLots = frameBonds.bondLots;
    vault.isLoaded = true;
  }

  public unsubscribeVault(vaultId: number): void {
    this.vaultSubscriptionArgs.delete(vaultId);
  }

  public getVaultBonds(vaultId: number): IVaultArgonBondState {
    return (this.data.vaultsById[vaultId] ??= {
      bondLots: [],
      ordinaryBonds: 0,
      flexibleBonds: 0,
      reservedBondSpace: 0,
      currentFrame: {
        frameId: 0,
        vaultBonds: 0,
        flexibleBondsEligible: 0,
        bondLots: [],
      },
      isLoaded: false,
    });
  }

  public async importHistoryBlock(block: IBlockHeaderInfo, events: readonly RuntimeSystemEventRecord[]): Promise<void> {
    this.recoveredHistoryFacts.push(...(await this.historyRecovery.readBlock(block, events)));
  }

  public async recordFinalizedTransaction(blockNumber: number): Promise<void> {
    await this.load();
    await this.queueFinalizedHistory(blockNumber);
  }

  public async retryHistory(): Promise<void> {
    await this.load();
    await this.queueFinalizedHistory(this.miningFrames.blockWatch.finalizedBlockHeader.blockNumber);
  }

  private ensureBlockSubscription(): void {
    this.blockSubscription ??= this.miningFrames.blockWatch.events.on('best-blocks', blocks => {
      void this.onNewBestBlocks(blocks).catch(error => console.error('Error refreshing Argon bonds', error));
    });
    // Transaction post-processing and finalized observation converge on this durable cursor.
    this.finalizedHistorySubscription ??= this.miningFrames.blockWatch.events.on('finalized', blocks => {
      const latestBlock = blocks.at(-1);
      if (latestBlock) void this.queueFinalizedHistory(latestBlock.blockNumber).catch(() => undefined);
    });
  }

  private queueFinalizedHistory(targetBlockNumber: number): Promise<void> {
    const cursor = this.finalizedHistoryCursor;
    if (!cursor || (targetBlockNumber <= cursor.blockNumber && !this.data.historyError)) {
      return this.finalizedHistoryQueue;
    }

    return this.enqueueHistoryWork(() => this.reconcileFinalizedHistory(targetBlockNumber));
  }

  private enqueueHistoryWork(work: () => Promise<void>): Promise<void> {
    const processing = this.finalizedHistoryQueue.catch(() => undefined).then(work);
    this.finalizedHistoryQueue = processing.catch(error => {
      const detail = error instanceof Error ? error.message : String(error);
      this.data.historyCoveragePending = true;
      this.data.historyError = `Bond history stopped at block ${this.finalizedHistoryCursor?.blockNumber ?? 0}: ${detail}`;
      if (this.data.isLoaded) this.data.financialRevision += 1;
      console.error('[ArgonBonds] Unable to reconcile finalized history', error);
    });
    return processing;
  }

  private async reconcileFinalizedHistory(targetBlockNumber: number): Promise<void> {
    const db = await this.dbPromise;
    let cursor = this.finalizedHistoryCursor;
    if (!cursor) throw new Error('Bond history cursor has not been loaded');
    const retryingPublication = !!this.data.historyError;
    const wasCoveragePending = this.data.historyCoveragePending;
    let hasChangedHistory = false;

    for (let blockNumber = cursor.blockNumber + 1; blockNumber <= targetBlockNumber; blockNumber += 1) {
      const block = await this.miningFrames.blockWatch.getHeader(blockNumber);
      if (block.parentHash !== cursor.blockHash) {
        throw new Error(`Finalized bond history changed parent at block ${blockNumber}`);
      }
      const events = await this.miningFrames.blockWatch.getEvents(block);
      const facts = await this.readFinalizedBlock(block, events);
      const nextCursor = { blockNumber, blockHash: block.blockHash };
      await db.transaction(async transaction => {
        await this.applyHistoryFacts(transaction, facts, true);
        await transaction.syncStateTable.upsert(SyncStateKeys.BondHistory, {
          accountId: this.walletKeys.defaultArgonAddress,
          ...nextCursor,
        });
      });
      this.finalizedHistoryCursor = nextCursor;
      cursor = nextCursor;
      if (facts.length) hasChangedHistory = true;
    }

    if (hasChangedHistory || retryingPublication) await this.publishBondState();

    if (this.data.historyCoveragePending) {
      this.data.historyCoveragePending =
        cursor.blockNumber < this.miningFrames.blockWatch.finalizedBlockHeader.blockNumber;
    }
    this.data.historyError = undefined;
    if (this.data.isLoaded && wasCoveragePending !== this.data.historyCoveragePending) {
      this.data.financialRevision += 1;
    }
  }

  private async readFinalizedBlock(
    block: IBlockHeaderInfo,
    events: readonly RuntimeSystemEventRecord[],
  ): Promise<IBondHistoryFact[]> {
    const hasRelevantEvent = events.some(
      ({ event }) =>
        event.section === 'treasury' &&
        (event.method === 'BondLotPurchased' ||
          event.method === 'BondLotReleaseScheduled' ||
          event.method === 'BondLotReleased' ||
          event.method === 'CouldNotReleaseBondLot' ||
          event.method === 'BondLotFlexibilityChanged' ||
          event.method === 'BondLotBackfillChanged'),
    );
    if (!hasRelevantEvent) return [];

    const accountId = this.walletKeys.defaultArgonAddress;
    const api = await this.miningFrames.blockWatch.getApi(block);
    const facts: IBondHistoryFact[] = [];
    const flexibilityByLot = new Map<number, boolean>();
    for (const [index, { event, phase }] of events.entries()) {
      if (event.section !== 'treasury') continue;
      const extrinsicIndex = phase.type === 'ApplyExtrinsic' ? phase.value : undefined;
      if (event.method === 'BondLotPurchased') {
        if (event.data.accountId !== accountId) continue;
        const stored = await api.query.treasury.bondLotById(event.data.bondLotId);
        if (!stored)
          throw new Error(`Purchased bond lot ${event.data.bondLotId} is unavailable at block ${block.blockNumber}`);
        const lot = BondLot.fromRuntime(event.data.bondLotId, stored, accountId);
        const entryArgonotRateMicrogons =
          lot.programType === 'Argonot'
            ? (await this.currency.fetchMainchainRatesAtBlock({ api, block })).ARGNOT
            : undefined;
        facts.push({
          kind: 'purchase',
          lot,
          block,
          extrinsicIndex,
          entryArgonotRateMicrogons,
          isFlexibleAtPurchase: false,
        });
      } else if (event.method === 'BondLotReleaseScheduled') {
        if (event.data.accountId !== accountId) continue;
        const stored = await api.query.treasury.bondLotById(event.data.bondLotId);
        if (!stored)
          throw new Error(`Scheduled bond lot ${event.data.bondLotId} is unavailable at block ${block.blockNumber}`);
        facts.push({
          kind: 'release-scheduled',
          lot: BondLot.fromRuntime(event.data.bondLotId, stored, accountId),
          block,
          extrinsicIndex,
        });
      } else if (event.method === 'BondLotReleased' || event.method === 'CouldNotReleaseBondLot') {
        if (event.data.accountId !== accountId) continue;
        let parent: IBlockHeaderInfo;
        try {
          parent = await this.miningFrames.blockWatch.getParentHeader(block);
        } catch (error) {
          if (!block.isFinalized || block.blockNumber === 0) throw error;
          parent = await this.miningFrames.blockWatch.getHeader(block.blockNumber - 1);
        }
        const parentApi = await this.miningFrames.blockWatch.getApi(parent);
        const stored = await parentApi.query.treasury.bondLotById(event.data.bondLotId);
        if (!stored)
          throw new Error(`Released bond lot ${event.data.bondLotId} is unavailable before block ${block.blockNumber}`);
        const lot = BondLot.fromRuntime(event.data.bondLotId, stored, accountId);
        if (
          event.method === 'CouldNotReleaseBondLot' &&
          !(await TreasuryBonds.didFailedReleaseRemoveHold({ accountId, lot, events, parentApi, api }))
        ) {
          continue;
        }
        const closingArgonotRateMicrogons =
          lot.programType === 'Argonot'
            ? (await this.currency.fetchMainchainRatesAtBlock({ api, block })).ARGNOT
            : undefined;
        facts.push({
          kind: 'release',
          lot,
          block,
          parent,
          extrinsicIndex,
          closingArgonotRateMicrogons,
          wasFlexible: flexibilityByLot.get(lot.id) ?? lot.isFlexible,
        });
      } else if (event.method === 'BondLotFlexibilityChanged' || event.method === 'BondLotBackfillChanged') {
        const stored = await api.query.treasury.bondLotById(event.data.bondLotId);
        if (!stored)
          throw new Error(`Flexible bond lot ${event.data.bondLotId} is unavailable at block ${block.blockNumber}`);
        const lot = BondLot.fromRuntime(event.data.bondLotId, stored, accountId);
        if (lot.accountId !== accountId || lot.programType !== 'Vault') continue;
        const isFlexible = event.method === 'BondLotFlexibilityChanged' ? event.data.isFlexible : event.data.isBackfill;
        flexibilityByLot.set(lot.id, isFlexible);
        facts.push({
          kind: 'flexibility',
          lot,
          transition: {
            isFlexible,
            cumulativeEarningsMicrogons: lot.lifetimeEarnings,
            source: 'flexibility-change',
            blockNumber: block.blockNumber,
            blockHash: block.blockHash,
            blockTime: new Date(block.blockTime),
            extrinsicIndex,
            eventIndex: index,
          },
        });
      }
    }
    return facts;
  }

  private async onNewBestBlocks(blocks: IBlockHeaderInfo[]): Promise<void> {
    const latestBlock = blocks.at(-1);
    if (!latestBlock) return;

    let refreshBonds = false;
    let refreshMarket = false;
    let refreshBidPool = false;
    let latestRefreshBlock: IBlockHeaderInfo | undefined;
    for (const block of blocks) {
      if (block.frameId != null) this.data.currentFrameId = block.frameId;

      const events = await this.miningFrames.blockWatch.getEvents(block);
      for (const { event } of events) {
        if (event.section === 'miningSlot' && event.method === 'SlotBidderAdded' && event.data.bidAmount > 0n) {
          refreshBidPool = true;
        } else if (event.section === 'miningSlot' && event.method === 'SlotBidderDropped') {
          refreshBidPool = true;
        } else if (event.section === 'treasury' && event.method === 'FrameEarningsDistributed') {
          refreshBonds = true;
          refreshMarket = true;
          if (event.data.bidPoolDistributed > 0n) refreshBidPool = true;
        } else if (event.section === 'treasury' && event.method === 'FrameVaultCapitalLocked') {
          refreshMarket = true;
        } else if (
          event.section === 'treasury' &&
          (event.method === 'BondLotPurchased' ||
            event.method === 'BondLotReleaseScheduled' ||
            event.method === 'BondLotReleased' ||
            event.method === 'CouldNotReleaseBondLot' ||
            event.method === 'BondLotFlexibilityChanged' ||
            event.method === 'BondLotBackfillChanged')
        ) {
          refreshBonds = true;
          refreshMarket = true;
        } else if (
          event.section === 'treasury' &&
          (event.method === 'ReservedBondSpaceChanged' || event.method === 'BackfillBondsReservedChanged')
        ) {
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

  public async getOwnBondLots(
    client: ArgonQueryClient,
    history: readonly IBondLotHistoryRecord[] = this.data.bondHistory,
  ): Promise<BondLot[]> {
    const accountId = this.walletKeys.defaultArgonAddress;
    const accountLots = await TreasuryBonds.getBondLotsByAccount(client, accountId);
    if (accountLots.length || !this.config.upstreamOperator?.vaultId) {
      return this.excludeRecordedReleases(
        accountLots.filter(lot => lot.isOwn),
        history,
      );
    }

    return this.excludeRecordedReleases(
      (await TreasuryBonds.getBondLots(client, this.config.upstreamOperator.vaultId, accountId)).filter(
        lot => lot.isOwn,
      ),
      history,
    );
  }

  private excludeRecordedReleases(
    lots: BondLot[],
    history: readonly IBondLotHistoryRecord[] = this.data.bondHistory,
  ): BondLot[] {
    const released = new Set(
      history
        .filter(record => record.releaseBlockHash !== undefined)
        .map(record => `${record.accountId}:${record.programType}:${record.bondLotId}`),
    );
    return lots.filter(lot => !released.has(`${lot.accountId}:${lot.programType}:${lot.id}`));
  }

  private setDisplayVaultId(preferredVaultId: number): void {
    const ownedVaultIds = new Set(this.data.bondLots.flatMap(lot => (lot.vaultId == null ? [] : [lot.vaultId])));
    if (preferredVaultId && (!ownedVaultIds.size || ownedVaultIds.has(preferredVaultId))) {
      this.data.vaultId = preferredVaultId;
      return;
    }

    this.data.vaultId = this.data.bondLots.find(lot => lot.vaultId != null)?.vaultId ?? preferredVaultId;
  }

  private async applyHistoryFacts(db: Db, facts: readonly IBondHistoryFact[], live = false): Promise<void> {
    for (const fact of facts) {
      if (fact.kind === 'release-scheduled') {
        await db.bondLotHistoryTable.recordReleaseSchedule({
          lot: fact.lot,
          blockNumber: fact.block.blockNumber,
          blockHash: fact.block.blockHash,
        });
      } else if (fact.kind === 'purchase') {
        await db.bondLotHistoryTable.recordObservation({
          lot: fact.lot,
          blockNumber: fact.block.blockNumber,
          blockHash: fact.block.blockHash,
          purchase: {
            blockTime: new Date(fact.block.blockTime),
            extrinsicIndex: fact.extrinsicIndex,
            entryArgonotRateMicrogons: fact.entryArgonotRateMicrogons,
          },
        });
        if (fact.lot.programType === 'Vault' && fact.isFlexibleAtPurchase) {
          await db.bondLotHistoryTable.recordFlexibility(fact.lot, {
            isFlexible: true,
            cumulativeEarningsMicrogons: fact.lot.lifetimeEarnings,
            source: 'purchase',
            blockNumber: fact.block.blockNumber,
            blockHash: fact.block.blockHash,
            blockTime: new Date(fact.block.blockTime),
            extrinsicIndex: fact.extrinsicIndex,
          });
        }
        if (live) await db.bondLotHistoryTable.confirmFlexibilityHistory(fact.lot.accountId, fact.lot.id);
      } else if (fact.kind === 'release') {
        await db.bondLotHistoryTable.recordRelease({
          lot: fact.lot,
          parentBlockNumber: fact.parent.blockNumber,
          parentBlockHash: fact.parent.blockHash,
          release: {
            blockNumber: fact.block.blockNumber,
            blockHash: fact.block.blockHash,
            blockTime: new Date(fact.block.blockTime),
            extrinsicIndex: fact.extrinsicIndex,
            closingArgonotRateMicrogons: fact.closingArgonotRateMicrogons,
          },
        });
        if (fact.lot.programType === 'Vault' && fact.wasFlexible) {
          await db.bondLotHistoryTable.recordFlexibility(fact.lot, {
            isFlexible: false,
            cumulativeEarningsMicrogons: fact.lot.lifetimeEarnings,
            source: 'release',
            blockNumber: fact.block.blockNumber,
            blockHash: fact.block.blockHash,
            blockTime: new Date(fact.block.blockTime),
            extrinsicIndex: fact.extrinsicIndex,
          });
        }
      } else {
        await db.bondLotHistoryTable.recordFlexibility(fact.lot, fact.transition);
      }
    }
  }
}
