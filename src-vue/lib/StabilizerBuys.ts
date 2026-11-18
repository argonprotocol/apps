import {
  type BlockWatch,
  SingleFileQueue,
  StabilizerBuy,
  NetworkConfig,
  StabilizerBuysUnavailableError,
  type IBlockHeaderInfo,
  type ArgonCurrentQueryClient,
} from '@argonprotocol/apps-core';
import { runtimeClient } from '@argonprotocol/runtime-client';
import { toHex } from 'viem';
import type { Db } from './Db.ts';
import { SyncStateKeys, type ISyncSchemas } from './db/SyncStateTable.ts';
import { readStabilizerBuyHistoryBlock, recoverStabilizerBuyHistory } from './recovery/StabilizerBuys.ts';
import { FinalizedHistoryScheduler } from './recovery/Scheduler.ts';
import type { IArgonAccountBalance } from './WalletsForArgon.ts';
import { toArgonAccountIdHex } from './EthereumClient.ts';
import { sleep } from './Utils.ts';
import {
  StabilizerBuyStatus,
  type IStabilizerBuyRecord,
  type IStabilizerBuyPurchaseRecord,
  type IStabilizerBuysRecord,
  type IStabilizerBuyLocation,
  type IStabilizerBuyPayout,
  type IStabilizerBuyFrameRewards,
  type IStabilizerBuyHistory,
} from '../interfaces/IStabilizerBuyPurchase.ts';

/** One account's purchase workflows, financial facts and current native claims. */
export class StabilizerBuys {
  public data = {
    market: undefined as Awaited<ReturnType<StabilizerBuys['readOpportunityMarket']>>,
    auctionsByFrame: {} as Record<
      number,
      {
        auction: StabilizerBuy['auction'];
        bids: Awaited<ReturnType<typeof StabilizerBuy.getBids>>;
        observedAtFrame: number;
      }
    >,
    buys: [] as IStabilizerBuyRecord[],
    frameRewards: [] as IStabilizerBuysRecord['frameRewards'],
    positions: [] as StabilizerBuy[],
    payableReward: 0n,
    nextPayoutFrame: null as number | null,
    currentFrameId: 0,
    currentTick: 0,
    isLoaded: false,
    isAvailable: false,
    error: undefined as string | undefined,
    blockNumber: -1,
    blockHash: undefined as string | undefined,
    financialRevision: 0,
    isRestoringHistory: false,
    historyError: undefined as string | undefined,
    ethereumGatewaySync: undefined as
      | { ethereumBlockNumber?: bigint; finalizedGatewayActivityNonce: bigint; bestGatewayActivityNonce: bigint }
      | undefined,
  };

  private loadPromise?: Promise<void>;
  private startupPromise?: Promise<void>;
  private recordsLoadPromise?: Promise<void>;
  private readonly recordWrites = new SingleFileQueue();
  private readonly refreshQueue = new SingleFileQueue();
  private readonly pendingRefreshBlocks = new Map<number, IBlockHeaderInfo>();
  private pendingRefreshPromise?: Promise<void>;
  private retryFinalizedGatewaySync = false;
  private readonly historyQueue = new SingleFileQueue();
  private isClosed = false;
  private unsubscribe?: () => void;
  private checkpoint?: ISyncSchemas[SyncStateKeys.StabilizerBuys];
  private queuedHistoryAfterBlock?: number;
  private readonly historyScheduler = new FinalizedHistoryScheduler(async toBlock => {
    const afterBlock = this.queuedHistoryAfterBlock ?? 0;
    this.queuedHistoryAfterBlock = undefined;
    try {
      await this.recoverHistory(toBlock, afterBlock);
      return toBlock;
    } catch (error) {
      this.queuedHistoryAfterBlock = Math.min(this.queuedHistoryAfterBlock ?? afterBlock, afterBlock);
      throw error;
    }
  }, 1_000);

  constructor(
    public readonly blockWatch: BlockWatch,
    public readonly accountAddress: string,
    private readonly dbPromise: Promise<Db>,
    private readonly isPaydownForecastVisible: () => boolean = () => false,
  ) {}

  public start(): Promise<void> {
    this.startupPromise ??= (async () => {
      let retryDelayMs = 1_000;
      while (!this.isClosed && !this.data.isLoaded) {
        try {
          await this.load();
        } catch (error) {
          console.warn('[StabilizerBuys] Retrying current-state load', error);
          await sleep(retryDelayMs);
          retryDelayMs = Math.min(retryDelayMs * 2, 30_000);
        }
      }
    })();
    return this.startupPromise;
  }

  public async load(): Promise<void> {
    if (this.loadPromise) return this.loadPromise;

    const loading = (async () => {
      await this.loadRecords();
      await this.blockWatch.start();
      if (this.isClosed) return;

      this.unsubscribe ??= this.blockWatch.events.on('finalized', blocks => {
        for (const block of blocks) void this.refresh(block).catch(() => undefined);
      });
      await this.refresh();
    })().catch(error => {
      if (this.loadPromise === loading) this.loadPromise = undefined;
      throw error;
    });

    this.loadPromise = loading;
    return loading;
  }

  /** Commands restore local attempts without waiting for an Argon connection. */
  public async loadRecords(): Promise<void> {
    this.recordsLoadPromise ??= (async () => {
      const db = await this.dbPromise;
      const [record, checkpoint] = await Promise.all([
        db.stabilizerBuysTable.fetchAll(this.accountAddress),
        db.syncStateTable.get(SyncStateKeys.StabilizerBuys),
      ]);
      if (this.isClosed) return;

      Object.assign(this.data, record);
      if (checkpoint?.accountId === this.accountAddress) this.checkpoint = checkpoint;
    })().catch(error => {
      this.recordsLoadPromise = undefined;
      throw error;
    });

    return this.recordsLoadPromise;
  }

  /** Display the requested Liquid before admission, and retain intent when native admission declines it. */
  public static getRequestedLiquidId(buy: IStabilizerBuyRecord): number | undefined {
    const liquidId =
      buy.repayLiquidId ??
      buy.argonPurchaseEvent?.purchase.repayLiquidId ??
      buy.ethereumGatewayActivity?.purchase.repayLiquidId ??
      buy.ethereumQuote?.request.repayLiquidId;
    if (liquidId) return Number(liquidId);
  }

  public static canDismissPurchase(buy: IStabilizerBuyRecord): boolean {
    if (buy.status !== StabilizerBuyStatus.Failed || !buy.ethereumQuote) return false;
    if (buy.ethereumTxHash || buy.usdcApprovalTxHash) return false;
    if (buy.ethereumSubmittedAt || buy.usdcApprovalSubmittedAt || buy.ethereumConfirmedAt) return false;

    return (
      !buy.gatewayTransferId &&
      !buy.ethereumGatewayActivity &&
      !buy.argonPurchaseEvent &&
      buy.admissionFrame === undefined
    );
  }

  public async dismissPurchase(id: string): Promise<void> {
    if (this.isClosed) throw new Error('Stabilizer Buys is closed.');
    await this.loadRecords();

    await this.recordWrites.add(async () => {
      const buy = this.data.buys.find(buy => buy.id === id);
      if (!buy) return;
      if (!StabilizerBuys.canDismissPurchase(buy))
        throw new Error('Only failed purchases that were never submitted can be dismissed.');

      await this.publishRecords(
        { ...this.records, buys: this.data.buys.filter(buy => buy.id !== id) },
        { buys: [], frameRewards: [] },
      );
    }).promise;
  }

  public async createPurchase({
    id,
    ethereumQuote,
    ethereumMaxFeeWei,
  }: Pick<
    IStabilizerBuyPurchaseRecord,
    'id' | 'ethereumQuote' | 'ethereumMaxFeeWei'
  >): Promise<IStabilizerBuyPurchaseRecord> {
    await this.loadRecords();

    return this.recordWrites.add(async () => {
      const existing = this.data.buys.find(buy => buy.id === id);
      if (existing) return existing as IStabilizerBuyPurchaseRecord;
      if (ethereumQuote.request.argonAccountId.toLowerCase() !== toArgonAccountIdHex(this.accountAddress).toLowerCase())
        throw new Error('The quote belongs to another Argon account.');
      if (ethereumMaxFeeWei !== undefined && ethereumMaxFeeWei <= 0n)
        throw new Error('Choose a positive Ethereum fee limit.');

      const buy: IStabilizerBuyPurchaseRecord = {
        id,
        ownerAccount: this.accountAddress,
        createdAt: new Date(),
        updatedAt: new Date(),
        argonFees: [],
        status: StabilizerBuyStatus.SubmittingPurchaseOnEthereum,
        ethereumQuote,
        ethereumMaxFeeWei,
      };
      await this.publishRecords({ ...this.records, buys: [buy, ...this.data.buys] }, { buys: [buy], frameRewards: [] });
      return buy;
    }).promise;
  }

  public async recordPurchase(id: string, patch: Partial<IStabilizerBuyRecord>): Promise<IStabilizerBuyRecord> {
    if (this.isClosed) throw new Error('Stabilizer Buys is closed.');
    await this.loadRecords();

    return this.recordWrites.add(async () => {
      const current = this.data.buys.find(buy => buy.id === id);
      if (!current) throw new Error('The saved purchase is unavailable.');

      const updated = { ...current, ...patch, updatedAt: new Date() };
      if (patch.ethereumGatewayActivity)
        updated.gatewayTransferId = `Ethereum:${patch.ethereumGatewayActivity.gatewayState.gatewayActivityNonce}`;

      const changes: IStabilizerBuysRecord = { buys: [], frameRewards: [] };
      const record = this.consolidate({ buys: [updated], frameRewards: [] }, changes);
      await this.publishRecords(record, changes);
      return record.buys.find(buy => buy.id === id)!;
    }).promise;
  }

  public async refresh(block = this.blockWatch.finalizedBlockHeader): Promise<void> {
    this.pendingRefreshBlocks.set(block.blockNumber, block);
    if (this.pendingRefreshPromise) return this.pendingRefreshPromise;

    const queued = this.refreshQueue.add(async () => {
      await this.loadRecords();
      this.pendingRefreshPromise = undefined;
      const blocks = [...this.pendingRefreshBlocks.values()].sort(
        (left, right) => left.blockNumber - right.blockNumber,
      );
      this.pendingRefreshBlocks.clear();
      const block = blocks.at(-1)!;
      try {
        const facts: IStabilizerBuyHistory = { buys: [], frameRewards: [], payouts: [], repayments: [] };
        let hasAccountActivity = false;
        let hasNewPrice = false;
        let hasEthereumStateEvent = false;
        for (const observed of blocks) {
          const events = await this.blockWatch.getEvents(observed);
          const collected = await readStabilizerBuyHistoryBlock(this.accountAddress, observed, events, this.blockWatch);
          facts.buys.push(...collected.buys);
          facts.frameRewards.push(...collected.frameRewards);
          facts.payouts.push(...collected.payouts);
          facts.repayments!.push(...(collected.repayments ?? []));

          if (observed.blockNumber <= this.data.blockNumber) continue;
          hasEthereumStateEvent ||= events.some(
            ({ event }) => event.section === 'ethereumVerifier' || event.section === 'crosschainTransfer',
          );
          hasAccountActivity ||= collected.buys.length > 0;
          for (const { event } of events) {
            if (event.section === 'priceIndex' && event.method === 'NewIndex') hasNewPrice = true;
            if (event.section !== 'stabilizerBuys') continue;
            if (!('account' in event.data)) continue;
            if (event.data.account !== this.accountAddress) continue;
            hasAccountActivity = true;
            break;
          }
        }

        const client = runtimeClient(await this.blockWatch.getApi(block));
        let currentFrameId = block.frameId;
        if (currentFrameId === undefined) {
          const nextFrameId = await client.query.miningSlot.nextFrameId();
          if (nextFrameId === null) throw new Error('The current admission frame is unavailable; retry the refresh.');
          currentFrameId = Math.max(0, nextFrameId - 1);
        }

        const newBlocks = blocks.filter(observed => observed.blockNumber > this.data.blockNumber);
        const hasHistoryGap = newBlocks.some((observed, index) => {
          const previousHash = newBlocks[index - 1]?.blockHash ?? this.data.blockHash;
          return observed.blockNumber !== this.data.blockNumber + index + 1 || observed.parentHash !== previousHash;
        });
        const needsReconciliation =
          !this.data.isAvailable ||
          currentFrameId !== this.data.currentFrameId ||
          newBlocks.length === 0 ||
          hasHistoryGap;

        const hasPendingCleanup = this.data.positions.some(position => position.heldPrincipal === 0n);
        const needsVisibleForecast =
          hasNewPrice &&
          this.isPaydownForecastVisible() &&
          this.data.positions.some(
            position =>
              currentFrameId < position.auction.maturesAtFrame &&
              position.liquidRepayments.some(repayment => repayment.priceWindow.nextFrame !== null),
          );
        let purchases = {
          positions: this.data.positions,
          payableReward: this.data.payableReward,
          nextPayoutFrame: this.data.nextPayoutFrame,
        };
        const shouldRefreshAccount =
          needsReconciliation || hasAccountActivity || hasPendingCleanup || needsVisibleForecast;
        if (shouldRefreshAccount) {
          purchases = await StabilizerBuy.getForAccount(client, this.accountAddress);
        }

        const market = await this.readOpportunityMarket(client, currentFrameId);
        const settledAuctions = await this.readSettledAuctions(client, blocks, currentFrameId);

        const frames = new Set(purchases.positions.map(position => position.admissionFrame));
        for (const rewards of this.data.frameRewards) {
          if (rewards.awardedReward === undefined && !settledAuctions.has(rewards.admissionFrame))
            frames.add(rewards.admissionFrame);
        }

        const auctionsByFrame: StabilizerBuys['data']['auctionsByFrame'] = {};
        for (const frame of frames) {
          const saved = this.data.auctionsByFrame[frame];

          // Read the definitive close once. Bids then remain frozen until native allocation is due.
          if (saved && saved.observedAtFrame > frame + 1 && saved.auction.maturesAtFrame > currentFrameId) {
            auctionsByFrame[frame] = saved;
            continue;
          }

          const auction = await client.query.stabilizerBuys.auctions(frame);

          // Failed bids can leave fee history for a frame that never had an auction.
          if (!auction) continue;

          const bids = await StabilizerBuy.getBids(client, frame);
          auctionsByFrame[frame] = { auction, bids, observedAtFrame: currentFrameId };
        }

        let consumedGatewayNonce: bigint | undefined;
        let ethereumGatewaySync: StabilizerBuys['data']['ethereumGatewaySync'];
        let retryFinalizedGatewaySync = false;
        if (
          this.data.buys.some(
            buy => buy.ethereumGatewayActivity && buy.purchaseArgonRecognitionBlockNumber === undefined,
          )
        ) {
          const refreshFinalized =
            needsReconciliation ||
            hasEthereumStateEvent ||
            this.retryFinalizedGatewaySync ||
            !this.data.ethereumGatewaySync;
          if (refreshFinalized) this.retryFinalizedGatewaySync = true;
          const result = await this.readEthereumGatewaySync(client, refreshFinalized);
          ethereumGatewaySync = result.sync;
          retryFinalizedGatewaySync = result.retryFinalized;
          consumedGatewayNonce = ethereumGatewaySync.finalizedGatewayActivityNonce;
        }

        await this.recordWrites.add(async () => {
          const isCurrent = block.blockNumber >= this.data.blockNumber;
          const frameRewards = [...facts.frameRewards];
          if (isCurrent && shouldRefreshAccount) {
            for (const position of purchases.positions) {
              const rewards: IStabilizerBuyHistory['frameRewards'][number] = {
                admissionFrame: position.admissionFrame,
                bidCount: position.purchase.positiveBidCount,
                latestBid: position.purchase.bidRate.times(100).toNumber(),
                requestedReward: position.requestedReward,
                lastUpdatedArgonBlock: block.blockNumber,
                createdAt: new Date(block.blockTime),
              };
              rewards.maturesAtFrame = position.auction.maturesAtFrame;
              frameRewards.push(rewards);
            }
          }

          const changes: IStabilizerBuysRecord = { buys: [], frameRewards: [] };
          const record = this.consolidate({ ...facts, frameRewards }, changes);
          const heldFrames = new Set(
            purchases.positions
              .filter(position => position.purchase.principal > 0n)
              .map(position => position.admissionFrame),
          );
          let payoutRetryBlock = this.checkpoint?.payoutRetryBlock;
          if (payoutRetryBlock === undefined)
            payoutRetryBlock = this.applySettlements(record, facts, heldFrames, changes);

          const unpaidReward = record.frameRewards.reduce(
            (sum, rewards) => sum + (rewards.payout ? 0n : (rewards.awardedReward ?? 0n)),
            0n,
          );
          if (isCurrent && payoutRetryBlock === undefined && unpaidReward === purchases.payableReward) {
            record.frameRewards = record.frameRewards.map(rewards => {
              const auction = settledAuctions.get(rewards.admissionFrame);
              if (!auction || rewards.awardedReward !== undefined) return rewards;
              const settled = {
                ...rewards,
                awardedReward: 0n,
                maturesAtFrame: auction.maturesAtFrame,
                updatedAt: new Date(),
              };
              changes.frameRewards.push(settled);
              return settled;
            });
          }

          let checkpoint = this.checkpoint;
          if (isCurrent) {
            checkpoint = {
              ...checkpoint,
              accountId: this.accountAddress,
              throughBlock: this.getHistoryThroughBlock(blocks),
            };
          }
          if (payoutRetryBlock !== undefined) {
            checkpoint = {
              ...checkpoint,
              accountId: this.accountAddress,
              throughBlock: Math.min(checkpoint?.throughBlock ?? block.blockNumber - 1, payoutRetryBlock - 1),
              payoutRetryBlock: Math.min(checkpoint?.payoutRetryBlock ?? payoutRetryBlock, payoutRetryBlock),
            };
          }

          let currentState: Partial<StabilizerBuys['data']> | undefined;
          if (isCurrent) {
            currentState = {
              ...purchases,
              auctionsByFrame,
              ethereumGatewaySync,
              market: market ?? this.data.market,
              currentFrameId,
              currentTick: block.tick,
              isLoaded: true,
              isAvailable: true,
              error: undefined,
              blockNumber: block.blockNumber,
              blockHash: block.blockHash,
            };
          }
          await this.publishRecords(record, changes, checkpoint, currentState);
          if (isCurrent) this.retryFinalizedGatewaySync = retryFinalizedGatewaySync;
        }).promise;

        if (this.checkpoint && this.checkpoint.throughBlock < block.blockNumber - 1)
          this.queueHistory(block, this.checkpoint.throughBlock);

        const recordedPrincipal = this.data.buys.reduce(
          (sum, buy) => sum + (buy.admissionFrame === undefined ? 0n : (buy.principal ?? 0n)),
          0n,
        );
        const settledPrincipal = this.data.buys.reduce(
          (sum, buy) =>
            sum +
            (buy.admissionFrame !== undefined && buy.status === StabilizerBuyStatus.Complete
              ? (buy.principal ?? 0n)
              : 0n),
          0n,
        );
        const unpaidReward = this.data.frameRewards.reduce(
          (sum, frame) => sum + (frame.payout ? 0n : (frame.awardedReward ?? 0n)),
          0n,
        );
        const missingPurchases = this.data.frameRewards.some(
          frame =>
            (frame.bidEvent || frame.rewardAward) &&
            !this.data.buys.some(buy => buy.admissionFrame === frame.admissionFrame),
        );
        const missingLivePurchase = this.data.positions.some(
          position => !this.data.buys.some(buy => buy.admissionFrame === position.admissionFrame),
        );
        const missingDelivery =
          consumedGatewayNonce !== undefined &&
          this.data.buys.some(
            buy =>
              buy.purchaseArgonRecognitionBlockNumber === undefined &&
              buy.ethereumGatewayActivity &&
              buy.ethereumGatewayActivity.gatewayState.gatewayActivityNonce <= consumedGatewayNonce,
          );
        if (
          this.checkpoint?.payoutRetryBlock !== undefined ||
          missingPurchases ||
          missingLivePurchase ||
          missingDelivery ||
          recordedPrincipal - settledPrincipal !== this.heldPrincipal ||
          unpaidReward !== this.data.payableReward
        )
          this.queueHistory(block, 0);
      } catch (error) {
        this.data.error = error instanceof Error ? error.message : String(error);
        if (error instanceof StabilizerBuysUnavailableError) {
          this.data.isAvailable = false;
          this.data.isLoaded = true;
          return;
        }
        for (const observed of blocks) this.pendingRefreshBlocks.set(observed.blockNumber, observed);
        throw error;
      }
    });
    const refreshing = queued.promise.finally(() => {
      if (this.pendingRefreshPromise === refreshing) this.pendingRefreshPromise = undefined;
    });
    this.pendingRefreshPromise = refreshing;
    return refreshing;
  }

  public get heldPrincipal(): bigint {
    return this.data.positions.reduce((sum, position) => sum + position.heldPrincipal, 0n);
  }

  /** Market availability does not depend on wallet funding or notification preferences. */
  public get buyDiscountPercent(): number | undefined {
    const { market, currentTick, currentFrameId, isLoaded, isAvailable } = this.data;
    if (this.isClosed || !isLoaded || !isAvailable || !market?.approvedPool) return;
    if (market.frameId !== currentFrameId) return;

    const prices = market.prices;
    if (!prices?.argonUsdPrice.gt(0) || prices.argonUsdPrice.gte(prices.argonUsdTargetPrice)) return;
    const best = this.blockWatch.bestBlockHeader;
    const latestTick = Math.max(currentTick, best?.tick ?? currentTick);
    if (BigInt(latestTick - prices.tick) > market.maxPriceAgeTicks) return;
    if (
      best?.blockTime &&
      Date.now() - best.blockTime > (Number(market.maxPriceAgeTicks) + 1) * NetworkConfig.tickMillis
    )
      return;

    return prices.argonUsdTargetPrice.minus(prices.argonUsdPrice).div(prices.argonUsdTargetPrice).times(100).toNumber();
  }

  public get snapshot() {
    return {
      ...this.data,
      accountAddress: this.accountAddress,
      hasPendingHistoryGap:
        !!this.checkpoint &&
        (this.checkpoint.payoutRetryBlock !== undefined || this.checkpoint.throughBlock < this.data.blockNumber),
    } as const;
  }

  /** Capture published claims only after they agree with the wallet's block. */
  public async readAccountSnapshot(account: IArgonAccountBalance, block: IBlockHeaderInfo) {
    const { address, microgonHolds } = account;
    const snapshot = this.snapshot;
    const heldPrincipal = microgonHolds
      .filter(hold => hold.id.type === 'StabilizerBuys')
      .reduce((sum, hold) => sum + hold.amount, 0n);
    if (heldPrincipal !== snapshot.positions.reduce((sum, position) => sum + position.heldPrincipal, 0n))
      throw new Error('Waiting for a finalized Stabilizer Buys snapshot matching the wallet balances.');

    // The finalized domain already reconciled this block. A best head can also
    // reuse those claims when the intervening canonical blocks have no account activity.
    if (snapshot.isAvailable && snapshot.blockHash) {
      if (snapshot.blockHash === block.blockHash) return snapshot;

      const headers = this.blockWatch.latestHeaders.filter(
        header => header.blockNumber > snapshot.blockNumber && header.blockNumber <= block.blockNumber,
      );
      if (
        headers[0]?.parentHash === snapshot.blockHash &&
        headers.at(-1)?.blockHash === block.blockHash &&
        block.frameId === snapshot.currentFrameId
      ) {
        let hasAccountActivity = false;
        for (const header of headers) {
          const events = await this.blockWatch.getEvents(header);
          hasAccountActivity = events.some(
            ({ event }) =>
              event.section === 'stabilizerBuys' && 'account' in event.data && event.data.account === address,
          );
          if (hasAccountActivity) break;
        }
        if (!hasAccountActivity) return snapshot;
      }
    }

    // Check known claims and the wallet's total hold; no map scans or price forecasts are needed.
    const client = runtimeClient(await this.blockWatch.getApi(block));
    const liquidRepayments = snapshot.positions.flatMap(position => position.liquidRepayments);
    try {
      const [payout, purchases, repayments] = await Promise.all([
        client.query.stabilizerBuys.payoutStateByAccount(address),
        client.query.stabilizerBuys.buysByAccountAndFrame.multi(
          snapshot.positions.map(position => [address, toHex(BigInt(position.admissionFrame), { size: 8 })]),
        ),
        client.query.stabilizerBuys.liquidRepaysByAccountAndGatewayNonce.multi(
          liquidRepayments.map(repayment => [address, toHex(repayment.gatewayActivityNonce, { size: 8 })]),
        ),
      ]);
      if (!payout || !purchases || !repayments) throw new StabilizerBuysUnavailableError();

      const repaymentsByNonce = new Map(
        liquidRepayments.map((repayment, index) => [repayment.gatewayActivityNonce, repayments[index]]),
      );
      const samePrincipal = purchases.every((purchase, index) => {
        if (!purchase) return false;
        const position = snapshot.positions[index];
        let principal = purchase.principal;
        for (const repayment of position.liquidRepayments) {
          const current = repaymentsByNonce.get(repayment.gatewayActivityNonce);
          if (!current) return false;
          principal += current.microgons;
        }
        return principal === position.heldPrincipal;
      });
      if (!samePrincipal || payout.payableReward !== snapshot.payableReward)
        throw new Error('Waiting for a finalized Stabilizer Buys snapshot matching the wallet balances.');
    } catch (error) {
      if (error instanceof StabilizerBuysUnavailableError && heldPrincipal === 0n && !snapshot.buys.length) return;
      throw error;
    }

    return snapshot;
  }

  /** Backfill merges normalized facts and its checkpoint in one account commit. */
  public async recoverHistory(
    toBlock = this.blockWatch.finalizedBlockHeader.blockNumber,
    afterBlock = 0,
  ): Promise<void> {
    await this.load();
    return this.historyQueue.add(async () => {
      this.data.isRestoringHistory = true;
      try {
        const recovered = await recoverStabilizerBuyHistory({
          blockWatch: this.blockWatch,
          accountId: this.accountAddress,
          afterBlock,
          toBlock,
        });
        await this.recordWrites.add(async () => {
          const changes: IStabilizerBuysRecord = { buys: [], frameRewards: [] };
          const record = this.consolidate(recovered.records, changes);
          const heldFrames = new Set(
            this.data.positions
              .filter(position => position.purchase.principal > 0n)
              .map(position => position.admissionFrame),
          );
          const payoutRetryBlock = this.applySettlements(record, recovered.records, heldFrames, changes);
          if (payoutRetryBlock !== undefined) {
            throw new Error(
              `A payout at block ${payoutRetryBlock} is missing its purchase or bonus history. Use Find Missing Data to retry.`,
            );
          }

          let throughBlock = this.checkpoint?.throughBlock ?? 0;
          if (!this.checkpoint || afterBlock <= throughBlock)
            throughBlock = Math.max(throughBlock, recovered.throughBlock);
          const checkpoint: ISyncSchemas[SyncStateKeys.StabilizerBuys] = {
            accountId: this.accountAddress,
            throughBlock,
            definitionVersion: recovered.definitionVersion,
          };
          const pendingPayout = this.checkpoint?.payoutRetryBlock;
          if (pendingPayout !== undefined && pendingPayout > recovered.throughBlock)
            checkpoint.payoutRetryBlock = pendingPayout;

          await this.publishRecords(record, changes, checkpoint);
          this.data.historyError = undefined;
        }).promise;
      } catch (error) {
        this.data.historyError = error instanceof Error ? error.message : String(error);
        throw error;
      } finally {
        this.data.isRestoringHistory = false;
      }
    }).promise;
  }

  public async close(): Promise<void> {
    this.isClosed = true;
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    await this.historyScheduler.close();
    await this.historyQueue.stop();
    await this.refreshQueue.stop();
    await this.recordWrites.stop(true);
  }

  private get records(): IStabilizerBuysRecord {
    const { buys, frameRewards } = this.data;
    return { buys, frameRewards };
  }

  /** Commit the records and recovery cursor before publishing any observer-visible state. */
  private async publishRecords(
    record: IStabilizerBuysRecord,
    changes: IStabilizerBuysRecord,
    checkpoint = this.checkpoint,
    currentState?: Partial<StabilizerBuys['data']>,
  ): Promise<void> {
    const db = await this.dbPromise;
    const buys = new Map(record.buys.map(buy => [buy.id, buy]));
    const rewards = new Map(record.frameRewards.map(frame => [frame.admissionFrame, frame]));
    const recordsChanged =
      changes.buys.length > 0 ||
      changes.frameRewards.length > 0 ||
      record.buys.length !== this.data.buys.length ||
      record.frameRewards.length !== this.data.frameRewards.length;
    const wasLoaded = this.data.isLoaded;
    const heldPrincipal = this.heldPrincipal;
    const payableReward = this.data.payableReward;
    const hadPendingHistoryGap = this.snapshot.hasPendingHistoryGap;

    await db.transaction(async transaction => {
      for (const previous of this.data.buys) {
        if (!buys.has(previous.id)) await transaction.stabilizerBuysTable.deleteBuy(this.accountAddress, previous.id);
      }
      for (const id of new Set(changes.buys.map(buy => buy.id))) {
        if (buys.has(id)) await transaction.stabilizerBuysTable.saveBuy(buys.get(id)!);
      }
      for (const frame of new Set(changes.frameRewards.map(frame => frame.admissionFrame)))
        await transaction.stabilizerBuysTable.saveFrameRewards(rewards.get(frame)!);
      if (checkpoint) await transaction.syncStateTable.upsert(SyncStateKeys.StabilizerBuys, checkpoint);
    });

    Object.assign(this.data, record, currentState);
    this.checkpoint = checkpoint;
    if (
      recordsChanged ||
      wasLoaded !== this.data.isLoaded ||
      heldPrincipal !== this.heldPrincipal ||
      payableReward !== this.data.payableReward ||
      hadPendingHistoryGap !== this.snapshot.hasPendingHistoryGap
    )
      this.data.financialRevision += 1;
  }

  private consolidate(
    incoming: Pick<IStabilizerBuyHistory, 'buys' | 'frameRewards'>,
    changes: IStabilizerBuysRecord,
  ): IStabilizerBuysRecord {
    const buys = new Map(this.data.buys.map(buy => [buy.id, buy]));
    const transfers = new Map(
      this.data.buys.filter(buy => buy.gatewayTransferId).map(buy => [buy.gatewayTransferId, buy]),
    );

    for (const buy of incoming.buys) {
      const previous = buys.get(buy.id);
      const transfer = transfers.get(buy.gatewayTransferId);
      const consolidated = { ...transfer, ...previous, ...buy };

      // Preserve the local command's identity when its native delivery is backfilled.
      let command = buy;
      if (previous?.ethereumQuote) command = previous;
      else if (transfer?.ethereumQuote) command = transfer;
      if (command.ethereumQuote) {
        consolidated.id = command.id;
        consolidated.createdAt = command.createdAt;
      }

      consolidated.argonFees = mergeLocations(
        mergeLocations(transfer?.argonFees ?? [], previous?.argonFees ?? []),
        buy.argonFees,
      );

      if (consolidated.purchaseArgonRecognitionBlockNumber !== undefined) {
        delete consolidated.statusError;
        consolidated.status = StabilizerBuyStatus.WaitingForPrincipalReleaseOnArgon;
        const fullyRepaid = consolidated.liquidRepaymentEvent?.microgonsBurned === consolidated.principal;
        if (
          consolidated.admissionFrame === undefined ||
          consolidated.purchaseArgonReleaseBlockNumber !== undefined ||
          fullyRepaid
        )
          consolidated.status = StabilizerBuyStatus.Complete;
      }

      if (transfer && transfer.id !== consolidated.id) buys.delete(transfer.id);
      buys.set(consolidated.id, consolidated);
      changes.buys.push(consolidated);
      if (consolidated.gatewayTransferId) transfers.set(consolidated.gatewayTransferId, consolidated);
    }

    const frameRewards = new Map(this.data.frameRewards.map(rewards => [rewards.admissionFrame, rewards]));
    for (const facts of incoming.frameRewards) {
      const previous = frameRewards.get(facts.admissionFrame);
      const rewards: IStabilizerBuyFrameRewards = {
        ownerAccount: this.accountAddress,
        bidCount: 0,
        latestBid: 0,
        lastUpdatedArgonBlock: 0,
        paidReward: 0n,
        createdAt: facts.createdAt ?? new Date(),
        ...previous,
        ...facts,
        bidFees: mergeLocations(previous?.bidFees ?? [], facts.bidFees ?? []),
        repaymentRewards: mergeLocations(previous?.repaymentRewards ?? [], facts.repaymentRewards ?? []),
        updatedAt: new Date(),
      };
      if (previous) rewards.createdAt = new Date(Math.min(previous.createdAt.getTime(), rewards.createdAt.getTime()));
      if (previous?.bidEvent && (!rewards.bidEvent || compareLocations(previous.bidEvent, rewards.bidEvent) > 0))
        rewards.bidEvent = previous.bidEvent;
      if (
        previous?.rewardAward &&
        (!rewards.rewardAward || compareLocations(previous.rewardAward, rewards.rewardAward) > 0)
      )
        rewards.rewardAward = previous.rewardAward;

      if (rewards.rewardAward) {
        rewards.awardedReward = rewards.rewardAward.amount;
        rewards.maturesAtFrame = rewards.rewardAward.maturesAtFrame;
      }
      if (rewards.bidEvent && rewards.bidEvent.blockNumber > rewards.lastUpdatedArgonBlock) {
        rewards.bidCount = rewards.bidEvent.positiveBidCount;
        rewards.latestBid = rewards.bidEvent.rewardRate.times(100).toNumber();
        const purchases = [...buys.values()].filter(buy => buy.admissionFrame === rewards.admissionFrame);
        delete rewards.requestedReward;
        if (purchases.length && purchases.every(buy => buy.matchingBasis !== undefined)) {
          const basis = purchases.reduce((sum, buy) => sum + buy.matchingBasis!, 0n);
          rewards.requestedReward = (basis * BigInt(rewards.latestBid)) / 100n;
        }
      }

      frameRewards.set(rewards.admissionFrame, rewards);
      changes.frameRewards.push(rewards);
    }

    return {
      buys: [...buys.values()].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime()),
      frameRewards: [...frameRewards.values()].sort((a, b) => a.admissionFrame - b.admissionFrame),
    };
  }

  private applySettlements(
    record: IStabilizerBuysRecord,
    history: Pick<IStabilizerBuyHistory, 'payouts' | 'repayments'>,
    heldFrames: Set<number>,
    changes: IStabilizerBuysRecord,
  ): number | undefined {
    const { payouts, repayments = [] } = history;
    if (!payouts.length && !repayments.length) return;

    record.buys = record.buys.map(buy => ({ ...buy }));
    record.frameRewards = record.frameRewards.map(rewards => ({ ...rewards }));

    for (const repayment of repayments) {
      const buy = record.buys.find(buy => buy.gatewayTransferId === `Ethereum:${repayment.gatewayActivityNonce}`);
      if (!buy || buy.principal === undefined) return repayment.blockNumber;
      if (buy.liquidRepaymentEvent && compareLocations(buy.liquidRepaymentEvent, repayment) > 0) continue;

      buy.liquidRepaymentEvent = repayment;
      buy.repayLiquidId = repayment.liquidId;
      if (repayment.microgonsBurned === buy.principal) buy.status = StabilizerBuyStatus.Complete;
      changes.buys.push(buy);
    }

    const purchasesByFrame = new Map<number, IStabilizerBuyRecord[]>();
    for (const buy of record.buys) {
      if (buy.admissionFrame === undefined || buy.repayLiquidId !== undefined) continue;
      const purchases = purchasesByFrame.get(buy.admissionFrame) ?? [];
      purchases.push(buy);
      purchasesByFrame.set(buy.admissionFrame, purchases);
    }
    const orderedFrames = [...purchasesByFrame.keys()].sort((a, b) => a - b);
    const previousPayoutByBlock = new Map<string, number>();

    for (const payout of [...payouts].sort(compareLocations)) {
      const previousIndex = previousPayoutByBlock.get(payout.blockHash) ?? -1;
      previousPayoutByBlock.set(payout.blockHash, payout.eventIndex);
      let remainingPrincipal = payout.principal;
      const released = new Map<IStabilizerBuyRecord, bigint>();

      for (const buy of record.buys) {
        const repayment = buy.liquidRepaymentEvent;
        if (!repayment || repayment.blockHash !== payout.blockHash) continue;
        if (repayment.eventIndex <= previousIndex || repayment.eventIndex >= payout.eventIndex) continue;

        const refund = buy.principal! - repayment.microgonsBurned;
        // The runtime can burn an unreceivable remainder. Only the payout proves a wallet credit.
        if (payout.principal === 0n) released.set(buy, 0n);
        else {
          remainingPrincipal -= refund;
          released.set(buy, refund);
        }
      }

      for (const buy of record.buys) {
        if (buy.repayLiquidId !== undefined) continue;
        if (
          buy.purchaseArgonReleaseBlockHash === payout.blockHash &&
          buy.purchaseArgonReleaseEventIndex === payout.eventIndex
        )
          remainingPrincipal -= buy.releasedPrincipal ?? buy.principal ?? 0n;
      }

      for (const frame of orderedFrames) {
        if (remainingPrincipal === 0n) break;
        if (heldFrames.has(frame)) continue;
        const unpaid = purchasesByFrame.get(frame)!.filter(buy => buy.purchaseArgonReleaseBlockNumber === undefined);
        if (!unpaid.length) continue;

        const hasLaterPurchase = unpaid.some(buy => {
          if (buy.purchaseArgonRecognitionBlockNumber === undefined) return true;
          if (buy.purchaseArgonRecognitionBlockNumber !== payout.blockNumber)
            return buy.purchaseArgonRecognitionBlockNumber > payout.blockNumber;
          return buy.purchaseArgonRecognitionEventIndex! >= payout.eventIndex;
        });
        if (hasLaterPurchase) continue;

        const principal = unpaid.reduce((sum, buy) => sum + (buy.principal ?? 0n), 0n);
        if (principal > remainingPrincipal) break;
        remainingPrincipal -= principal;
        for (const buy of unpaid) released.set(buy, buy.principal ?? 0n);
      }

      let paidReward = payout.reward;
      for (const rewards of record.frameRewards) {
        for (const reward of rewards.repaymentRewards ?? []) {
          if (
            reward.blockHash !== payout.blockHash ||
            reward.eventIndex <= previousIndex ||
            reward.eventIndex >= payout.eventIndex
          )
            continue;
          paidReward -= reward.amount;
        }
      }
      const rewarded = record.frameRewards.filter(rewards => {
        if (!rewards.rewardAward || compareLocations(rewards.rewardAward, payout) >= 0) return false;
        return !rewards.payout || compareLocations(rewards.payout, payout) === 0;
      });
      const awardedReward = rewarded.reduce((sum, rewards) => sum + (rewards.awardedReward ?? 0n), 0n);

      // Ordinary rewards are credited together or retired when the aggregate is below the account minimum.
      if (remainingPrincipal !== 0n || (paidReward !== 0n && paidReward !== awardedReward)) return payout.blockNumber;

      const { principal: _principal, reward: _reward, ...location } = payout;
      for (const [buy, principal] of released) {
        buy.releasedPrincipal = principal;
        buy.purchaseArgonReleaseBlockNumber = payout.blockNumber;
        buy.purchaseArgonReleaseBlockHash = payout.blockHash;
        buy.purchaseArgonReleaseBlockTime = new Date(payout.blockTime);
        buy.purchaseArgonReleaseEventIndex = payout.eventIndex;
        buy.status = StabilizerBuyStatus.Complete;
        buy.updatedAt = new Date();
        changes.buys.push(buy);
      }
      for (const rewards of rewarded) {
        rewards.paidReward = paidReward === 0n ? 0n : rewards.awardedReward!;
        rewards.payout = location;
        rewards.updatedAt = new Date();
        changes.frameRewards.push(rewards);
      }
    }
  }

  private queueHistory(block: IBlockHeaderInfo, afterBlock: number): void {
    this.queuedHistoryAfterBlock = Math.min(this.queuedHistoryAfterBlock ?? afterBlock, afterBlock);
    this.historyScheduler.queue(block.blockNumber);
  }

  private async readEthereumGatewaySync(client: ArgonCurrentQueryClient, refreshFinalized: boolean) {
    let ethereumBlockNumber = this.data.ethereumGatewaySync?.ethereumBlockNumber;
    let finalizedGatewayActivityNonce = this.data.ethereumGatewaySync?.finalizedGatewayActivityNonce ?? 0n;
    let retryFinalized = false;
    if (refreshFinalized) {
      try {
        const [gateway, anchorHash] = await Promise.all([
          client.query.crosschainTransfer.gatewayStateBySourceChain('Ethereum'),
          client.query.ethereumVerifier.latestExecutionHeaderAnchorBlockHash(),
        ]);
        finalizedGatewayActivityNonce = gateway?.gatewayActivityNonce ?? 0n;
        if (anchorHash) {
          const anchor = await client.query.ethereumVerifier.executionHeaderAnchors(anchorHash);
          ethereumBlockNumber = anchor?.blockNumber;
        } else {
          ethereumBlockNumber = undefined;
        }
      } catch (error) {
        retryFinalized = true;
        console.warn('[StabilizerBuys] Finalized Ethereum progress will retry on the next finalized block', error);
      }
    }

    let bestGatewayActivityNonce = finalizedGatewayActivityNonce;
    try {
      // Best-chain proof inclusion is provisional; only finalized purchase events complete a buy.
      const bestClient = runtimeClient(await this.blockWatch.getApi(this.blockWatch.bestBlockHeader));
      const gateway = await bestClient.query.crosschainTransfer.gatewayStateBySourceChain('Ethereum');
      bestGatewayActivityNonce = gateway?.gatewayActivityNonce ?? finalizedGatewayActivityNonce;
    } catch (error) {
      console.warn('[StabilizerBuys] Ethereum gateway progress will retry on the next finalized block', error);
    }

    return {
      sync: { ethereumBlockNumber, finalizedGatewayActivityNonce, bestGatewayActivityNonce },
      retryFinalized,
    };
  }

  private getHistoryThroughBlock(blocks: readonly IBlockHeaderInfo[]): number {
    let throughBlock = this.checkpoint?.throughBlock ?? blocks[0].blockNumber - 1;
    for (const block of blocks) {
      if (block.blockNumber > throughBlock + 1) break;
      throughBlock = Math.max(throughBlock, block.blockNumber);
    }
    return throughBlock;
  }

  private async readSettledAuctions(
    client: ArgonCurrentQueryClient,
    blocks: readonly IBlockHeaderInfo[],
    currentFrameId: number,
  ) {
    const frames: number[] = [];
    if (
      this.checkpoint &&
      this.checkpoint.payoutRetryBlock === undefined &&
      this.getHistoryThroughBlock(blocks) >= blocks.at(-1)!.blockNumber
    ) {
      for (const rewards of this.data.frameRewards) {
        if (rewards.awardedReward !== undefined) continue;

        const purchases = this.data.buys.filter(buy => buy.admissionFrame === rewards.admissionFrame);
        if (!purchases.length) continue;
        const recordedPrincipal = purchases.reduce(
          (sum, buy) =>
            sum +
            (buy.repayLiquidId === undefined && buy.purchaseArgonReleaseBlockNumber === undefined
              ? (buy.principal ?? 0n)
              : 0n),
          0n,
        );
        const heldPrincipal =
          this.data.positions.find(position => position.admissionFrame === rewards.admissionFrame)?.purchase
            .principal ?? 0n;
        if (recordedPrincipal !== heldPrincipal) continue;

        let isDue = false;
        if (rewards.maturesAtFrame !== undefined) isDue = rewards.maturesAtFrame <= currentFrameId;
        const principalReleased = purchases.some(buy => buy.purchaseArgonReleaseBlockNumber !== undefined);
        if (isDue || principalReleased) frames.push(rewards.admissionFrame);
      }
    }
    try {
      return await StabilizerBuy.getSettledAuctions(client, frames);
    } catch (error) {
      console.warn('[StabilizerBuys] Reward allocation status will retry on the next finalized block', error);
      return new Map<number, StabilizerBuy['auction']>();
    }
  }

  private async readOpportunityMarket(client: ArgonCurrentQueryClient, frameId: number) {
    try {
      const rules = client.consts.stabilizerBuys;
      if (!rules) throw new StabilizerBuysUnavailableError();

      const [approvedPool, prices, matchingRate, frameRewardTicksRemaining, auction] = await client.queryMulti([
        client.query.stabilizerBuys.approvedPool,
        client.query.priceIndex.current,
        client.query.stabilizerBuys.matchingRate,
        client.query.miningSlot.frameRewardTicksRemaining,
        [client.query.stabilizerBuys.auctions, frameId],
      ]);

      return {
        approvedPool,
        prices,
        matchingRate: auction?.matchingRate ?? matchingRate,
        frameId,
        frameRewardTicksRemaining,
        maxPriceAgeTicks: rules.maxPriceAgeTicks,
        maxPositiveBids: client.consts.stabilizerBuys.maxPositiveBids,
        purchaseHoldFrames: rules.purchaseHoldFrames,
        liquidRepaymentRewardPercent: rules.liquidRepaymentRewardPercent,
        auctionInclusionPercent: rules.auctionInclusionPercent,
      };
    } catch (error) {
      console.warn('[StabilizerBuys] Purchase opportunity data is unavailable; retaining the last observation', error);
    }
  }
}

function compareLocations(left: IStabilizerBuyLocation, right: IStabilizerBuyLocation): number {
  return left.blockNumber - right.blockNumber || left.eventIndex - right.eventIndex;
}

function mergeLocations<Fact extends IStabilizerBuyLocation>(previous: Fact[], incoming: Fact[]): Fact[] {
  const merged = new Map(previous.map(fact => [`${fact.blockHash}:${fact.eventIndex}`, fact]));
  for (const fact of incoming) merged.set(`${fact.blockHash}:${fact.eventIndex}`, fact);

  return [...merged.values()].sort(compareLocations);
}
