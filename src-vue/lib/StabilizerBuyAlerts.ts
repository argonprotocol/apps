import { NetworkConfig, UnitOfMeasurement, StabilizerBuyQuoteUnavailableError } from '@argonprotocol/apps-core';
import { getAddress } from 'viem';
import type { Config } from './Config.ts';
import type { Db } from './Db.ts';
import type { StabilizerBuys } from './StabilizerBuys.ts';
import type { StabilizerBuyPurchases } from './StabilizerBuyPurchases.ts';
import type { WalletsForEthereum } from './WalletsForEthereum.ts';
import type { IStabilizerBuyOpportunity } from '../interfaces/IStabilizerBuyPurchase.ts';
import { SyncStateKeys, type ISyncSchemas } from './db/SyncStateTable.ts';
import { projectStabilizerBuyQuote } from './financials/StabilizerBuys.ts';
import { getStabilizerBuyBidNotice } from './Alerts.ts';
import { notifyStabilizerBuyOpportunity } from './SystemNotifications.ts';

type OpportunityCheckpoint = ISyncSchemas[SyncStateKeys.StabilizerBuyOpportunities];

/** Observes opportunities; purchases and bids still require explicit user commands. */
export class StabilizerBuyAlerts {
  public data = {
    opportunity: undefined as Extract<IStabilizerBuyOpportunity, { type: 'buy' }> | undefined,
    error: undefined as string | undefined,
  };

  private checkpoint?: OpportunityCheckpoint;
  private refreshPromise?: Promise<void>;
  private lastQuoteAt = 0;
  private quoteRevision = 0;
  private timer?: ReturnType<typeof setInterval>;
  private expiryTimer?: ReturnType<typeof setTimeout>;
  private isClosed = false;

  constructor(
    private readonly buys: StabilizerBuys,
    private readonly getPurchases: () => StabilizerBuyPurchases | undefined,
    private readonly wallets: WalletsForEthereum,
    private readonly config: Pick<Config, 'isLoaded' | 'stabilizerBuyAlert'>,
    private readonly dbPromise: Promise<Db>,
    private readonly notify = notifyStabilizerBuyOpportunity,
  ) {}

  public start(): void {
    if (this.timer || this.isClosed) return;
    this.timer = setInterval(() => void this.refresh().catch(() => undefined), 60_000);
    void this.refresh().catch(() => undefined);
  }

  public refresh(): Promise<void> {
    if (this.isClosed) return Promise.resolve();

    this.refreshPromise ??= this.check().finally(() => {
      this.refreshPromise = undefined;
    });

    return this.refreshPromise;
  }

  public async close(): Promise<void> {
    this.isClosed = true;
    clearInterval(this.timer);
    clearTimeout(this.expiryTimer);
    await this.refreshPromise?.catch(() => undefined);
  }

  /** A desktop click can arrive before subscriptions catch up after sleep. */
  public async resolveNotice(key: string): Promise<IStabilizerBuyOpportunity | undefined> {
    const { block } = await this.buys.blockWatch.getLatestFinalizedSnapshot();
    await this.buys.refresh(block);
    if (this.buyNotice?.key === key) {
      this.lastQuoteAt = 0;
      await this.refresh();
    }
    return this.getNotice(key);
  }

  public getNotice(key: string): IStabilizerBuyOpportunity | undefined {
    if (this.isClosed || !this.buys.data.isLoaded || !this.buys.data.isAvailable) return;

    const opportunity = this.buyNotice;
    if (opportunity?.key === key) return opportunity;

    const bid = getStabilizerBuyBidNotice(this.buys);
    if (bid?.key === key) return bid;
  }

  public get opportunity(): Extract<IStabilizerBuyOpportunity, { type: 'buy' }> | undefined {
    const opportunity = this.data.opportunity;
    const market = this.buys.data.market;
    if (this.isClosed || !opportunity) return;
    if (this.buys.buyDiscountPercent === undefined) return;
    if (opportunity.expiresAt <= Date.now()) return;
    if (opportunity.quote.poolId !== market?.approvedPool?.poolId) return;
    return opportunity;
  }

  public get buyNotice(): Extract<IStabilizerBuyOpportunity, { type: 'buy' }> | undefined {
    const opportunity = this.opportunity;
    const settings = this.config.stabilizerBuyAlert;
    if (!opportunity || !settings || opportunity.apy < settings.minimumApy) return;

    const wallet = this.wallets.findByAddress(opportunity.quote.sourceAddress);
    if (!wallet || wallet.data.balanceIsCached || wallet.data.fetchErrorMsg) return;
    const usdc = wallet.data.otherTokens.find(token => token.unitOfMeasurement === UnitOfMeasurement.USDC);
    if ((usdc?.value ?? 0n) >= opportunity.quote.request.maxUsdcIn) return opportunity;
  }

  public expireOpportunity(opportunity: Extract<IStabilizerBuyOpportunity, { type: 'buy' }>): void {
    if (this.data.opportunity !== opportunity) return;
    this.quoteRevision++;
    this.lastQuoteAt = 0;
    this.publishOpportunity(undefined);
  }

  private async check(): Promise<void> {
    if (!this.config.isLoaded || !this.buys.data.isLoaded) return;

    const db = await this.dbPromise;
    this.checkpoint ??= (await db.syncStateTable.get(SyncStateKeys.StabilizerBuyOpportunities)) ?? {
      accountId: this.buys.accountAddress,
    };
    if (this.checkpoint.accountId !== this.buys.accountAddress)
      this.checkpoint = { accountId: this.buys.accountAddress };

    // Quote failures must not suppress a bidding reminder, or erase a still-valid quote.
    try {
      await this.refreshBuyOpportunity(db);

      const opportunity = this.buyNotice;
      if (opportunity && this.checkpoint.buyPoolId !== opportunity.quote.poolId) {
        await this.saveAndNotify(db, { buyPoolId: opportunity.quote.poolId }, opportunity);
        this.data.error = undefined;
      }
    } catch (error) {
      if (error instanceof StabilizerBuyQuoteUnavailableError) {
        this.publishOpportunity(undefined);
        this.data.error = undefined;
      } else this.data.error = (error as Error).message;
    }

    await this.remindUnfundedBid(db);
  }

  private async refreshBuyOpportunity(db: Db): Promise<void> {
    const market = this.buys.data.market;
    const quoteExpired =
      this.data.opportunity && this.data.opportunity.quote.request.deadline <= BigInt(Math.floor(Date.now() / 1000));
    if (quoteExpired) this.publishOpportunity(undefined);

    // A failed market read must not reset notification history for the same pool.
    if (!this.buys.data.isAvailable) return;
    if (market?.frameId !== this.buys.data.currentFrameId) return;

    if (this.buys.buyDiscountPercent === undefined || !market?.approvedPool) {
      this.publishOpportunity(undefined);
      if (this.checkpoint?.buyPoolId) {
        const { buyPoolId: _poolId, ...checkpoint } = this.checkpoint;
        await db.syncStateTable.upsert(SyncStateKeys.StabilizerBuyOpportunities, checkpoint);
        this.checkpoint = checkpoint;
      }
      this.data.error = undefined;
      return;
    }

    if (this.buys.data.error || Date.now() - this.lastQuoteAt < 60_000) return;

    this.lastQuoteAt = Date.now();
    const revision = this.quoteRevision;

    const quoterAddress = NetworkConfig.get().ethereumNetwork.stabilizerBuyQuoterAddress;
    if (!quoterAddress) throw new Error('This network has no Stabilizer price quoter configured.');

    const purchases = this.getPurchases();
    if (!purchases) throw new Error('Configure an Ethereum RPC in Settings to watch buying opportunities.');

    await this.wallets.refresh();

    const wallets = this.wallets.persistedWallets;
    const fundedWallet = wallets.find(
      wallet =>
        !wallet.data.balanceIsCached &&
        !wallet.data.fetchErrorMsg &&
        wallet.data.otherTokens.some(
          token =>
            token.unitOfMeasurement === UnitOfMeasurement.USDC &&
            token.address?.toLowerCase() === market.approvedPool!.usdcToken.toLowerCase() &&
            token.value > 0n,
        ),
    );
    const wallet = fundedWallet ?? wallets[0] ?? this.wallets.coreWallet;
    const balance = fundedWallet?.data.otherTokens.find(
      token => token.unitOfMeasurement === UnitOfMeasurement.USDC,
    )?.value;
    if (!market.matchingRate) {
      this.publishOpportunity(undefined);
      return;
    }

    const request = {
      maxUsdcIn: balance ?? 0n,
      slippageBps: 50,
      deadline: BigInt(Math.floor(Date.now() / 1000) + 15 * 60),
      destinationAddress: this.buys.accountAddress,
      sourceAddress: wallet.address,
      quoterAddress: getAddress(quoterAddress),
    };
    const { quote, preview } = await purchases.quoteMaxProfit(request);
    if (this.isClosed || revision !== this.quoteRevision) return;
    if (this.buys.data.market?.approvedPool?.poolId !== quote.poolId) return;
    if (this.buys.data.market?.prices?.argonUsdPrice.gte(this.buys.data.market.prices.argonUsdTargetPrice)) return;

    const projection = projectStabilizerBuyQuote({
      quote,
      feeEstimateWei: preview.feeEstimateWei,
      periodDays: market.purchaseHoldFrames,
      matchingRate: market.matchingRate,
    });

    if (projection && projection.apy.max > 0) {
      const previous = this.opportunity;
      let key: string;
      if (previous && previous.quote.poolId === quote.poolId) key = previous.key;
      else key = `buy:${crypto.randomUUID()}`;

      this.publishOpportunity({
        type: 'buy',
        key,
        quote,
        apy: projection.apy.max,
        discountPercent: projection.discountPercent,
        observedAt: new Date(),
        expiresAt: Number(quote.request.deadline) * 1000,
      });
    } else this.publishOpportunity(undefined);
    this.data.error = undefined;
  }

  private async remindUnfundedBid(db: Db): Promise<void> {
    const market = this.buys.data.market;
    if (market?.frameId !== this.buys.data.currentFrameId) return;

    const remaining = market.frameRewardTicksRemaining;
    const reminderTicks = Math.min(NetworkConfig.rewardTicksPerFrame / 10, 3_600_000 / NetworkConfig.tickMillis);
    if (remaining == null || remaining > reminderTicks) return;

    const notice = getStabilizerBuyBidNotice(this.buys);
    if (!notice?.bid || this.checkpoint?.bidFrame === notice.position.admissionFrame) return;

    await this.saveAndNotify(db, { bidFrame: notice.position.admissionFrame }, notice);
  }

  private async saveAndNotify(
    db: Db,
    patch: Partial<OpportunityCheckpoint>,
    opportunity: IStabilizerBuyOpportunity,
  ): Promise<void> {
    const checkpoint = { ...this.checkpoint!, ...patch };
    await db.syncStateTable.upsert(SyncStateKeys.StabilizerBuyOpportunities, checkpoint);
    this.checkpoint = checkpoint;

    // Mark before native delivery: a crash may miss one banner, never repeat it on every restart.
    if (!this.isClosed) await this.notify(() => this.getNotice(opportunity.key));
  }

  private publishOpportunity(opportunity: Extract<IStabilizerBuyOpportunity, { type: 'buy' }> | undefined): void {
    clearTimeout(this.expiryTimer);
    this.data.opportunity = opportunity;
    if (!opportunity) return;

    this.expiryTimer = setTimeout(
      () => {
        if (this.data.opportunity?.expiresAt === opportunity.expiresAt) this.publishOpportunity(undefined);
      },
      Math.max(0, opportunity.expiresAt - Date.now()),
    );
  }
}
