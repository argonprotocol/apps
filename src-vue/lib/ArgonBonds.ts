import {
  type ArgonClient,
  type ArgonCurrentQueryClient,
  BondLot,
  bigIntMax,
  bigIntMin,
  type Currency,
  createDeferred,
  type IBlockHeaderInfo,
  type IDeferred,
  type IFrameBondLot,
  type MiningFrames,
  type RuntimeSystemEventRecord,
  TreasuryBonds,
  type Vault,
} from '@argonprotocol/apps-core';
import BigNumber from 'bignumber.js';
import type { Config } from './Config.ts';
import {
  runtimeClient,
  type CurrentRuntimeQueries,
  type LiveQueryRecord,
  type RuntimeQueryResult,
} from '@argonprotocol/runtime-client';
import type { Db } from './Db.ts';
import type { WalletKeys } from './WalletKeys.ts';
import type {
  IBondLotEarningsBackfill,
  IBondLotFlexibilityTransition,
  IBondLotHistoryRecord,
} from './db/BondLotHistoryTable.ts';
import type { IBondEarningsRecord } from './db/BondEarningsTable.ts';
import { SyncStateKeys } from './db/SyncStateTable.ts';
import { getMainchainClient } from '../stores/mainchain.ts';
import { ArgonBondsRecovery } from './recovery/ArgonBonds.ts';
import { getBondEarnings } from './BondEarnings.ts';

const INITIAL_FINALIZED_HISTORY_BLOCKS = 90;

export type IBondHistoryFact =
  | { kind: 'earnings-coverage'; fromFrame: number; throughFrame: number }
  | { kind: 'daily-earnings'; record: IBondEarningsRecord }
  | { kind: 'earnings-observation'; lot: BondLot; block: IBlockHeaderInfo }
  | { kind: 'earnings-backfill'; lot: BondLot; backfill: IBondLotEarningsBackfill }
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
      earningsComplete?: boolean;
    }
  | { kind: 'flexibility'; lot: BondLot; transition: IBondLotFlexibilityTransition };

export interface IVaultArgonBondState extends Awaited<ReturnType<typeof TreasuryBonds.getVaultBondState>> {
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
    dailyEarnings: [] as IBondEarningsRecord[],
    isLoaded: false,
    historyCoveragePending: false,
    historyError: undefined as string | undefined,
    financialRevision: 0,
    vaultId: 0,
    currentFrameId: 0,
    distributableBidPool: 0n,
    fullBidPool: 0n,
    bondPoolPercent: 0,
    totalActiveBonds: 0,
    frameCapital: null as RuntimeQueryResult<CurrentRuntimeQueries['treasury']['currentFrameVaultCapital']>,
    vaultRewardRate: BigNumber(0),
    averageMicrogonsPerArgonot: undefined as bigint | undefined,
    vaultsById: {} as Record<number, IVaultArgonBondState>,
  };

  private blockSubscription?: VoidFunction;
  private finalizedHistorySubscription?: VoidFunction;
  private waitForLoad?: IDeferred<void>;
  private isGlobalSubscribed = false;
  private readonly vaultSubscriptions = new Map<number, Map<symbol, IVaultBondSubscription>>();
  private readonly pendingVaultRefreshes = new Set<number>();
  private nextRefreshVersion = 0;
  private lastBondLotsRefreshVersion = 0;
  private lastBidPoolRefreshVersion = 0;
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

  public getEarningsHistory(bondLotId: number) {
    const records = this.data.dailyEarnings.filter(record => record.bondLotId === bondLotId);
    const history = this.data.bondHistory.find(record => record.bondLotId === bondLotId);
    const lot = this.data.bondLots.find(entry => entry.id === bondLotId);
    return getBondEarnings(lot, history, records, this.data.currentFrameId - 1);
  }

  public getVaultBondCapacityMicrogons(vault: Vault): bigint {
    return vault.bondCapacityMicrogons(this.currency.priceIndex);
  }

  public argonotRewardBacking({
    vault,
    argonotSecuritization,
    securitizationMicrogons = vault.securitization,
  }: {
    vault: Vault;
    argonotSecuritization: NonNullable<Awaited<ReturnType<typeof Vault.getArgonotSecuritization>>>;
    securitizationMicrogons?: bigint;
  }) {
    if (!this.data.frameCapital) return;
    const totalMicronots = TreasuryBonds.getVaultArgonotSecuritizationTarget({
      securitizationMicrogons: bigIntMax(securitizationMicrogons, vault.securitization),
      averageMicrogonsPerArgonot: this.data.averageMicrogonsPerArgonot,
    });
    if (totalMicronots === undefined) return;

    let pendingWithdrawals = 0n;
    for (const entry of vault.securitizationReleaseSchedule.values()) pendingWithdrawals += entry.argonotWithdrawals;
    const { heldMicronots } = argonotSecuritization;
    const requestedMicronots = heldMicronots - pendingWithdrawals;
    return {
      totalMicronots,
      additionalMicronots: bigIntMax(totalMicronots - heldMicronots, 0n),
      withdrawalCancellationMicronots: bigIntMax(bigIntMin(totalMicronots, heldMicronots) - requestedMicronots, 0n),
    };
  }

  public vaultRevenuePotential(vaultId: number, fullBidPool: bigint = this.data.fullBidPool) {
    const frameCapital = this.data.frameCapital;
    const position = frameCapital?.vaultSecuritizationPositions[vaultId];
    if (!position || !frameCapital) return;
    return TreasuryBonds.vaultRevenuePotential({
      position,
      frameCapital,
      fullBidPool,
      percentForVaultPool: this.data.vaultRewardRate,
    });
  }

  public getFlexibleBondDisplacementPercent(vaultId: number): number | undefined {
    const vault = this.data.vaultsById[vaultId];
    if (!vault?.isLoaded || vault.flexibleBonds <= 0) return;
    return Math.min(100, (vault.displacedFlexibleBonds / vault.flexibleBonds) * 100);
  }

  public availableBondSpace(vault: Vault): bigint {
    const bondState = this.data.vaultsById[vault.vaultId];
    if (!bondState?.isLoaded) return 0n;

    return TreasuryBonds.availableBondSpace({
      capacityMicrogons: this.getVaultBondCapacityMicrogons(vault),
      bondState,
      vault,
    });
  }

  public availableBondSpaceWithoutFlexibleDisplacement(vault: Vault): bigint {
    const state = this.data.vaultsById[vault.vaultId];
    if (!state?.isLoaded) return 0n;

    const capacity = TreasuryBonds.getBondPurchaseCapacity(this.getVaultBondCapacityMicrogons(vault));
    const unoccupiedBonds = Math.max(0, capacity - state.regularBonds - state.flexibleBonds);
    const roomWithoutDisplacement = BondLot.bondsToMicrogons(unoccupiedBonds + state.replacementBonds);
    return bigIntMin(this.availableBondSpace(vault), roomWithoutDisplacement);
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
      const finalizedApi = await blockWatch.getApi(finalizedBlock);
      const finalizedClient = runtimeClient(finalizedApi);
      const lots = await this.getOwnBondLots(finalizedClient);
      await db.transaction(async transaction => {
        for (const lot of lots)
          await transaction.bondLotHistoryTable.recordObservation({
            lot,
            blockNumber: finalizedBlock.blockNumber,
            blockHash: finalizedBlock.blockHash,
          });
      });
      const [history, dailyEarnings] = await Promise.all([
        db.bondLotHistoryTable.fetchAll(this.walletKeys.defaultArgonAddress),
        db.bondEarningsTable.fetchAll(this.walletKeys.defaultArgonAddress),
      ]);
      this.data.bondLots = this.excludeRecordedReleases(lots, history);
      this.data.bondHistory = history;
      this.data.dailyEarnings = dailyEarnings;

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

  public async refreshBondLots(
    client?: ArgonCurrentQueryClient,
    refreshVersion = ++this.nextRefreshVersion,
  ): Promise<void> {
    client ??= await getMainchainClient(false);
    const lots = await this.getOwnBondLots(client);
    if (refreshVersion < this.lastBondLotsRefreshVersion) return;
    this.lastBondLotsRefreshVersion = refreshVersion;
    this.data.bondLots = this.excludeRecordedReleases(lots);
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
      await db.transaction(transaction =>
        this.applyHistoryFacts(transaction, [{ kind: 'release-scheduled', lot, block }], true),
      );
      await this.publishBondState();
    });
  }

  public async refreshHistory(): Promise<void> {
    const db = await this.dbPromise;
    const [history, dailyEarnings] = await Promise.all([
      db.bondLotHistoryTable.fetchAll(this.walletKeys.defaultArgonAddress),
      db.bondEarningsTable.fetchAll(this.walletKeys.defaultArgonAddress),
    ]);
    this.data.bondHistory = history;
    this.data.dailyEarnings = dailyEarnings;
    this.data.bondLots = this.excludeRecordedReleases(this.data.bondLots);
    for (const vault of Object.values(this.data.vaultsById)) {
      vault.bondLots = this.excludeRecordedReleases(vault.bondLots);
    }
    if (this.data.isLoaded) this.data.financialRevision += 1;
  }

  private async publishBondState(): Promise<void> {
    const refreshVersion = ++this.nextRefreshVersion;
    const db = await this.dbPromise;
    const [history, dailyEarnings, client] = await Promise.all([
      db.bondLotHistoryTable.fetchAll(this.walletKeys.defaultArgonAddress),
      db.bondEarningsTable.fetchAll(this.walletKeys.defaultArgonAddress),
      this.miningFrames.blockWatch.getCurrentApi(),
    ]);
    const lots = await this.getOwnBondLots(client, history);

    this.data.bondHistory = history;
    this.data.dailyEarnings = dailyEarnings;
    if (refreshVersion >= this.lastBondLotsRefreshVersion) {
      this.lastBondLotsRefreshVersion = refreshVersion;
      this.data.bondLots = lots;
    }
    this.data.bondLots = this.excludeRecordedReleases(this.data.bondLots, history);
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
        fact.lot.owner === lot.owner &&
        fact.lot.programType === lot.programType &&
        fact.lot.id === lot.id,
    );
  }

  public async refreshActiveState(): Promise<void> {
    if (!this.data.isLoaded) return;

    const refreshVersion = ++this.nextRefreshVersion;
    this.data.currentFrameId = this.miningFrames.blockWatch.bestBlockHeader.frameId ?? this.data.currentFrameId;
    const client = await this.miningFrames.blockWatch.getCurrentApi();
    const refreshes: Promise<void>[] = [this.refreshBondLots(client, refreshVersion)];
    if (this.isGlobalSubscribed) {
      refreshes.push(
        TreasuryBonds.getDistributableBidPool(client).then(value => {
          if (refreshVersion < this.lastBidPoolRefreshVersion) return;
          this.lastBidPoolRefreshVersion = refreshVersion;
          this.data.distributableBidPool = value;
        }),
      );
    }
    if (this.vaultSubscriptions.size) refreshes.push(this.refreshSubscribedVaults(client, refreshVersion));
    await Promise.all(refreshes);
  }

  public async subscribeGlobal(client?: ArgonClient): Promise<void> {
    if (this.isGlobalSubscribed) return;

    const refreshVersion = ++this.nextRefreshVersion;
    client ??= await getMainchainClient(false);
    await this.miningFrames.blockWatch.start();
    this.data.currentFrameId = this.miningFrames.blockWatch.bestBlockHeader.frameId ?? this.data.currentFrameId;
    const distributableBidPool = await TreasuryBonds.getDistributableBidPool(client);
    if (refreshVersion >= this.lastBidPoolRefreshVersion) {
      this.lastBidPoolRefreshVersion = refreshVersion;
      this.data.distributableBidPool = distributableBidPool;
    }
    this.data.bondPoolPercent = TreasuryBonds.getBidPoolPercentForVaults(client);
    this.isGlobalSubscribed = true;
    this.ensureBlockSubscription();
  }

  public async subscribeVault(args: IVaultBondSubscription, client?: ArgonClient): Promise<() => void> {
    this.ensureBlockSubscription();
    const token = Symbol();
    const subscriptions = this.vaultSubscriptions.get(args.vaultId) ?? new Map<symbol, IVaultBondSubscription>();
    subscriptions.set(token, args);
    this.vaultSubscriptions.set(args.vaultId, subscriptions);
    try {
      await this.refreshVault(args, client);
    } catch (error) {
      this.pendingVaultRefreshes.add(args.vaultId);
      console.warn(`[ArgonBonds] Vault ${args.vaultId} refresh will retry on the next block`, error);
    }
    return () => {
      this.unsubscribeVault(args.vaultId, token);
    };
  }

  public async refreshVault(
    args: IVaultBondSubscription,
    client?: ArgonCurrentQueryClient,
    refreshVersion = ++this.nextRefreshVersion,
    snapshot?: {
      frameCapital: LiveQueryRecord<'treasury', 'currentFrameVaultCapital'>;
      activeBonds: Awaited<ReturnType<typeof TreasuryBonds.getActiveBonds>>;
    },
  ): Promise<void> {
    client ??= await getMainchainClient(false);

    const vault = this.getVaultBonds(args.vaultId);
    const frameId = args.frameId ?? this.data.currentFrameId;
    const frameCapital = snapshot ? snapshot.frameCapital : await client.query.treasury.currentFrameVaultCapital();
    const [activeBonds, bondState] = await Promise.all([
      snapshot?.activeBonds ?? TreasuryBonds.getActiveBonds(client, frameCapital),
      TreasuryBonds.getVaultBondState(client, args.vaultId, args.accountId ?? args.operatorAddress),
    ]);
    const frameBonds =
      frameId > 0
        ? await TreasuryBonds.getCurrentFrameBondLots(client, args.vaultId, args.operatorAddress, {
            frameCapital,
            bondState,
          })
        : { bondLots: [], totalActiveBonds: 0, flexibleBondsEligible: 0 };

    if (refreshVersion < (this.publishedVaultRefreshVersions.get(args.vaultId) ?? 0)) return;
    this.publishedVaultRefreshVersions.set(args.vaultId, refreshVersion);
    this.pendingVaultRefreshes.delete(args.vaultId);
    if (refreshVersion >= this.lastTotalActiveBondsRefreshVersion) {
      this.data.totalActiveBonds = activeBonds.totalActiveBonds;
      this.data.frameCapital = activeBonds.frameCapital ?? null;
      this.data.vaultRewardRate = activeBonds.vaultRewardRate ?? BigNumber(0);
      this.data.averageMicrogonsPerArgonot = activeBonds.averageMicrogonsPerArgonot;
      this.data.fullBidPool = activeBonds.fullBidPool ?? 0n;
      this.lastTotalActiveBondsRefreshVersion = refreshVersion;
    }
    Object.assign(vault, bondState, { bondLots: this.excludeRecordedReleases(bondState.bondLots) });
    vault.currentFrame.frameId = frameId;
    vault.currentFrame.vaultBonds = frameBonds.totalActiveBonds;
    vault.currentFrame.flexibleBondsEligible = frameBonds.flexibleBondsEligible;
    vault.currentFrame.bondLots = frameBonds.bondLots;
    vault.isLoaded = true;
  }

  public unsubscribeVault(vaultId: number, token?: symbol): void {
    const subscriptions = this.vaultSubscriptions.get(vaultId);
    if (token) subscriptions?.delete(token);
    if (!token || !subscriptions?.size) {
      this.vaultSubscriptions.delete(vaultId);
      this.pendingVaultRefreshes.delete(vaultId);
    }
  }

  public getVaultBonds(vaultId: number): IVaultArgonBondState {
    return (this.data.vaultsById[vaultId] ??= {
      bondLots: [],
      regularBonds: 0,
      flexibleBonds: 0,
      displacedFlexibleBonds: 0,
      lockedFrameTerms: null,
      reservedBondSpace: 0,
      replacementBonds: 0,
      minimumPurchaseBonds: 1,
      isAtBondLotLimit: false,
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

  public async recoverDailyEarnings(throughBlock: number, afterBlock: number): Promise<void> {
    const db = await this.dbPromise;
    const lifetimes = new Map(
      (await db.bondLotHistoryTable.fetchAll(this.walletKeys.defaultArgonAddress)).map(record => [
        record.bondLotId,
        { createdFrame: record.createdFrame, releaseFrame: record.releaseFrame },
      ]),
    );
    for (const fact of this.recoveredHistoryFacts) {
      if (fact.kind === 'daily-earnings' || fact.kind === 'earnings-coverage') continue;
      const lot = fact.lot;
      lifetimes.set(lot.id, { createdFrame: lot.createdFrameId, releaseFrame: lot.releaseFrameId ?? undefined });
    }
    this.recoveredHistoryFacts.push(
      ...(await this.historyRecovery.readDailyEarnings([...lifetimes.values()], throughBlock, afterBlock)),
    );
    const coveredFrames = this.miningFrames.frames.filter(
      frame =>
        frame.firstBlockNumber !== null &&
        frame.firstBlockNumber > afterBlock &&
        frame.firstBlockNumber <= throughBlock,
    );
    if (coveredFrames.length) {
      this.recoveredHistoryFacts.push({
        kind: 'earnings-coverage',
        fromFrame: Math.min(...coveredFrames.map(frame => frame.frameId)) - 1,
        throughFrame: Math.max(...coveredFrames.map(frame => frame.frameId)) - 1,
      });
    }
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
        for (const { event } of events) {
          if (event.section === 'treasury' && event.method === 'FrameEarningsDistributed') {
            await transaction.bondLotHistoryTable.recordEarningsCoverage(
              this.walletKeys.defaultArgonAddress,
              event.data.frameId,
              event.data.frameId,
            );
          }
        }
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
    const bondEvents = [...events.entries()].filter(([, { event }]) => {
      if (event.section !== 'treasury') return false;
      return [
        'BondLotPurchased',
        'BondLotReleaseScheduled',
        'BondLotReleased',
        'CouldNotReleaseBondLot',
        'BondLotFlexibilityChanged',
        'BondLotBackfillChanged',
        'BondLotEarningsBackfilled',
        'FrameEarningsDistributed',
        'EncumberedBondMicrogonsBurned',
      ].includes(event.method);
    });
    if (!bondEvents.length) return [];

    const accountId = this.walletKeys.defaultArgonAddress;
    const api = runtimeClient(await this.miningFrames.blockWatch.getApi(block));
    const facts: IBondHistoryFact[] = [];
    const flexibilityByLot = new Map<number, boolean>();
    const earningsBackfillsByLot = new Map<number, Pick<IBondLotEarningsBackfill, 'addedFrames' | 'addedEarnings'>>();
    const distributesEarnings = bondEvents.some(([, { event }]) => event.method === 'FrameEarningsDistributed');
    const hasBondBurn = bondEvents.some(([, { event }]) => event.method === 'EncumberedBondMicrogonsBurned');
    if (distributesEarnings || hasBondBurn) {
      for (const lot of await this.getOwnBondLots(api)) facts.push({ kind: 'earnings-observation', lot, block });
    }
    for (const [, { event }] of bondEvents) {
      if (event.section !== 'treasury' || event.method !== 'FrameEarningsDistributed') continue;
      const { frameId } = event.data;
      const parent = await this.miningFrames.blockWatch.getHeader(block.blockNumber - 1);
      const [beforePayout, frameStart] = await Promise.all([
        this.miningFrames.blockWatch.getApi(parent),
        this.miningFrames.getFrameStart(frameId),
      ]);
      const startClient = runtimeClient(frameStart.api);
      const parentClient = runtimeClient(beforePayout);
      const earnings = await TreasuryBonds.getFrameEarnings({
        frameId,
        accountId,
        frameStart: startClient,
        beforePayout: parentClient,
        payout: api,
        events,
      });
      for (const { lot, ...entry } of earnings) {
        facts.push({
          kind: 'daily-earnings',
          record: {
            ...entry,
            accountId,
            programType: lot.programType,
            bondLotId: lot.id,
            frameId,
            payoutBlockNumber: block.blockNumber,
            payoutBlockHash: block.blockHash,
          },
        });
      }
    }
    for (const [index, { event, phase }] of bondEvents) {
      if (event.section !== 'treasury') continue;
      const extrinsicIndex = phase.type === 'ApplyExtrinsic' ? phase.value : undefined;
      if (event.method === 'BondLotPurchased') {
        if (event.data.accountId !== accountId) continue;
        const lot = await BondLot.get(api, event.data.bondLotId, accountId);
        if (!lot)
          throw new Error(`Purchased bond lot ${event.data.bondLotId} is unavailable at block ${block.blockNumber}`);
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
      } else if (event.method === 'BondLotEarningsBackfilled') {
        const preceding = earningsBackfillsByLot.get(event.data.bondLotId);
        const backfill = {
          addedFrames: (preceding?.addedFrames ?? 0) + event.data.addedFrames,
          addedEarnings: (preceding?.addedEarnings ?? 0n) + event.data.addedEarnings,
        };
        earningsBackfillsByLot.set(event.data.bondLotId, backfill);
        let lot = await BondLot.get(api, event.data.bondLotId, accountId);
        if (!lot) {
          const parent = await this.miningFrames.blockWatch.getHeader(block.blockNumber - 1);
          const parentApi = runtimeClient(await this.miningFrames.blockWatch.getApi(parent));
          const previous = await BondLot.get(parentApi, event.data.bondLotId, accountId);
          if (previous) {
            lot = previous.withEarningsBackfill(backfill.addedFrames, backfill.addedEarnings);
          }
        }
        if (!lot)
          throw new Error(`Backfilled bond lot ${event.data.bondLotId} is unavailable at block ${block.blockNumber}`);
        if (lot.owner !== accountId) continue;
        facts.push({
          kind: 'earnings-backfill',
          lot,
          backfill: {
            blockNumber: block.blockNumber,
            blockHash: block.blockHash,
            eventIndex: index,
            addedFrames: event.data.addedFrames,
            addedEarnings: event.data.addedEarnings,
          },
        });
      } else if (event.method === 'BondLotReleaseScheduled') {
        if (event.data.accountId !== accountId) continue;
        const lot = await BondLot.get(api, event.data.bondLotId, accountId);
        if (!lot)
          throw new Error(`Scheduled bond lot ${event.data.bondLotId} is unavailable at block ${block.blockNumber}`);
        facts.push({
          kind: 'release-scheduled',
          lot,
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
        const parentApi = runtimeClient(await this.miningFrames.blockWatch.getApi(parent));
        let lot = await BondLot.get(parentApi, event.data.bondLotId, accountId);
        if (!lot)
          throw new Error(`Released bond lot ${event.data.bondLotId} is unavailable before block ${block.blockNumber}`);
        const backfill = earningsBackfillsByLot.get(lot.id);
        if (backfill) {
          lot = lot.withEarningsBackfill(backfill.addedFrames, backfill.addedEarnings);
        }
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
          earningsComplete: !distributesEarnings,
        });
      } else if (event.method === 'BondLotFlexibilityChanged' || event.method === 'BondLotBackfillChanged') {
        const lot = await BondLot.get(api, event.data.bondLotId, accountId);
        if (!lot)
          throw new Error(`Flexible bond lot ${event.data.bondLotId} is unavailable at block ${block.blockNumber}`);
        if (lot.owner !== accountId || lot.programType !== 'Vault') continue;
        const isFlexible = event.method === 'BondLotFlexibilityChanged' ? event.data.isFlexible : event.data.isBackfill;
        flexibilityByLot.set(lot.id, isFlexible);
        facts.push({
          kind: 'flexibility',
          lot,
          transition: {
            isFlexible,
            cumulativeEarningsMicrogons: lot.cumulativeEarnings,
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
    // Keep the notification's order even when an older event read finishes later.
    const refreshVersion = ++this.nextRefreshVersion;
    const latestBlock = blocks.at(-1);
    if (!latestBlock) return;

    let refreshBonds = false;
    let refreshMarket = this.pendingVaultRefreshes.size > 0;
    let refreshBidPool = false;
    let latestRefreshBlock: IBlockHeaderInfo | undefined;
    if (latestBlock.frameId != null) this.data.currentFrameId = latestBlock.frameId;
    for (const block of blocks) {
      const events = await this.miningFrames.blockWatch.getEvents(block);
      for (const { event } of events) {
        if (event.section === 'miningSlot' && event.method === 'SlotBidderAdded' && event.data.bidAmount > 0n) {
          refreshBidPool = true;
        } else if (event.section === 'miningSlot' && event.method === 'SlotBidderDropped') {
          refreshBidPool = true;
        } else if (
          event.section === 'vaults' &&
          (event.method === 'VaultModified' ||
            event.method === 'VaultClosed' ||
            event.method === 'FundsReleased' ||
            event.method === 'FundsScheduledForRelease' ||
            event.method === 'SecuritizationExitRequested' ||
            event.method === 'SecuritizationExitReleased' ||
            event.method === 'LostBitcoinCompensated' ||
            event.method === 'SecuritizationReturned')
        ) {
          refreshMarket = true;
        } else if (
          (event.section === 'priceIndex' && event.method === 'NewIndex') ||
          (event.section === 'bitcoinUtxos' && (event.method === 'UtxoDetected' || event.method === 'UtxoSpent')) ||
          (event.section === 'bitcoinLocks' &&
            (event.method === 'BitcoinLockTerminated' ||
              event.method === 'BitcoinLockFlexibleChanged' ||
              event.method === 'BitcoinLockResecuritized' ||
              event.method === 'BitcoinSpentAfterRelease'))
        ) {
          // Runtime 159 also derives current displacement from funded Bitcoin
          // and market prices. Runtime 160 can burn vault capital on termination.
          refreshMarket = true;
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
            event.method === 'BondLotEarningsBackfilled' ||
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
      const distributableBidPool = await TreasuryBonds.getDistributableBidPool(
        await this.miningFrames.blockWatch.getApi(latestBlock),
      );
      if (refreshVersion >= this.lastBidPoolRefreshVersion) {
        this.lastBidPoolRefreshVersion = refreshVersion;
        this.data.distributableBidPool = distributableBidPool;
      }
    }
    if (!latestRefreshBlock) return;

    const refreshApi = await this.miningFrames.blockWatch.getApi(latestRefreshBlock);
    const client = runtimeClient(refreshApi);
    const refreshes: Promise<void>[] = [];
    if (refreshBonds && this.data.isLoaded) refreshes.push(this.refreshBondLots(client, refreshVersion));
    if (refreshMarket && this.isGlobalSubscribed) refreshes.push(this.refreshSubscribedVaults(client, refreshVersion));
    await Promise.all(refreshes);
  }

  private async refreshSubscribedVaults(client: ArgonCurrentQueryClient, refreshVersion: number): Promise<void> {
    if (!this.vaultSubscriptions.size) return;
    const snapshot = client.query.treasury.currentFrameVaultCapital().then(async frameCapital => ({
      frameCapital,
      activeBonds: await TreasuryBonds.getActiveBonds(client, frameCapital),
    }));
    await Promise.all(
      [...this.vaultSubscriptions.values()].map(async subscriptions => {
        const args = [...subscriptions.values()].at(-1)!;
        const nextArgs = args.frameId === undefined ? { ...args, frameId: this.data.currentFrameId } : args;
        try {
          await this.refreshVault(nextArgs, client, refreshVersion, await snapshot);
        } catch (error) {
          if (this.vaultSubscriptions.has(args.vaultId)) this.pendingVaultRefreshes.add(args.vaultId);
          throw error;
        }
      }),
    );
  }

  public async getOwnBondLots(
    client: ArgonCurrentQueryClient,
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
    return lots.filter(lot => !released.has(`${lot.owner}:${lot.programType}:${lot.id}`));
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
      if (fact.kind === 'earnings-coverage') {
        await db.bondLotHistoryTable.recordEarningsCoverage(
          this.walletKeys.defaultArgonAddress,
          fact.fromFrame,
          fact.throughFrame,
        );
      } else if (fact.kind === 'daily-earnings') {
        await db.bondEarningsTable.upsert(fact.record);
      } else if (fact.kind === 'earnings-observation') {
        await db.bondLotHistoryTable.recordObservation({
          lot: fact.lot,
          blockNumber: fact.block.blockNumber,
          blockHash: fact.block.blockHash,
        });
      } else if (fact.kind === 'earnings-backfill') {
        await db.bondLotHistoryTable.recordObservation({
          lot: fact.lot,
          blockNumber: fact.backfill.blockNumber,
          blockHash: fact.backfill.blockHash,
        });
        await db.bondLotHistoryTable.recordEarningsBackfill(fact.lot, fact.backfill);
      } else if (fact.kind === 'release-scheduled') {
        await db.bondLotHistoryTable.recordObservation({
          lot: fact.lot,
          blockNumber: fact.block.blockNumber,
          blockHash: fact.block.blockHash,
        });
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
            cumulativeEarningsMicrogons: fact.lot.cumulativeEarnings,
            source: 'purchase',
            blockNumber: fact.block.blockNumber,
            blockHash: fact.block.blockHash,
            blockTime: new Date(fact.block.blockTime),
            extrinsicIndex: fact.extrinsicIndex,
          });
        }
        if (live) await db.bondLotHistoryTable.confirmFlexibilityHistory(fact.lot.owner, fact.lot.id);
      } else if (fact.kind === 'release') {
        await db.bondLotHistoryTable.recordRelease({
          lot: fact.lot,
          parentBlockNumber: fact.parent.blockNumber,
          parentBlockHash: fact.parent.blockHash,
          release: {
            frameId: fact.block.frameId,
            blockNumber: fact.block.blockNumber,
            blockHash: fact.block.blockHash,
            blockTime: new Date(fact.block.blockTime),
            extrinsicIndex: fact.extrinsicIndex,
            closingArgonotRateMicrogons: fact.closingArgonotRateMicrogons,
            earningsComplete: fact.earningsComplete,
          },
        });
        if (fact.lot.programType === 'Vault' && fact.wasFlexible) {
          await db.bondLotHistoryTable.recordFlexibility(fact.lot, {
            isFlexible: false,
            cumulativeEarningsMicrogons: fact.lot.cumulativeEarnings,
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
