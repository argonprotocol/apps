import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { computed, reactive, watch } from 'vue';
import BigNumber from 'bignumber.js';
import { createPublicClient, custom, getAddress, type PublicClient } from 'viem';
import { getOfflineRegistry } from '@argonprotocol/mainchain';
import {
  createDeferred,
  NetworkConfig,
  StabilizerBuy,
  StabilizerBuyQuoteUnavailableError,
  StabilizerBuyContracts,
  UnitOfMeasurement,
  BlockWatch,
} from '@argonprotocol/apps-core';
import { EthereumClient, toArgonAccountIdHex } from '../lib/EthereumClient.ts';
import { StabilizerBuyAlerts } from '../lib/StabilizerBuyAlerts.ts';
import { StabilizerBuyPurchases } from '../lib/StabilizerBuyPurchases.ts';
import { StabilizerBuys } from '../lib/StabilizerBuys.ts';
import { WalletsForEthereum } from '../lib/WalletsForEthereum.ts';
import type { IOtherToken } from '../lib/Wallet.ts';
import { SyncStateKeys, type ISyncSchemas } from '../lib/db/SyncStateTable.ts';
import type { IStabilizerBuyOpportunity, IStabilizerBuyQuote } from '../interfaces/IStabilizerBuyPurchase.ts';
import { createTestDb } from './helpers/db.ts';
import { createMockWalletKeys } from './helpers/wallet.ts';
import { buyOpportunity } from './helpers/stabilizerBuy.ts';
import { projectHistoricalStabilizerBuys } from '../lib/financials/StabilizerBuys.ts';

const native = vi.hoisted(() => ({
  api: undefined as unknown,
  pending: undefined as Promise<unknown> | undefined,
  reads: 0,
}));
vi.mock('../stores/mainchain.ts', () => ({
  getMainchainClient: async () => ({
    raw: {
      at: async () => {
        native.reads++;
        return native.pending ?? native.api;
      },
    },
    rpc: { chain: { getFinalizedHead: async () => '0x00' } },
  }),
}));

const token = buyOpportunity.quote.usdcToken;
const poolId = buyOpportunity.quote.poolId;
let fixture: Awaited<ReturnType<typeof createAlerts>>;

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
  vi.setSystemTime(Date.UTC(2026, 0, 1));
  fixture = await createAlerts();
});

afterEach(async () => {
  await fixture.alerts.close();
  await fixture.purchases.close();
  await fixture.buys.close();
  fixture.wallets.dispose();
  await fixture.db.sql.close();
  NetworkConfig.clearRuntimeOverride();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('Stabilizer buy alerts', () => {
  it('discovers an opportunity without funding or a subscription, but requires both to notify', async () => {
    fixture.config.stabilizerBuyAlert = undefined;
    fixture.balance.value = 0n;
    await fixture.alerts.refresh();
    expect(fixture.alerts.opportunity).toBeDefined();
    expect(fixture.alerts.buyNotice).toBeUndefined();
    expect(fixture.delivered).toEqual([]);

    fixture.config.stabilizerBuyAlert = { minimumApy: 12 };
    await fixture.alerts.refresh();
    expect(fixture.alerts.buyNotice).toBeUndefined();
    fixture.balance.value = 200_000_000n;
    await fixture.alerts.refresh();
    expect(fixture.delivered).toHaveLength(1);

    fixture.config.stabilizerBuyAlert = { minimumApy: fixture.alerts.opportunity!.apy + 1 };
    expect(fixture.alerts.buyNotice).toBeUndefined();
    expect(fixture.alerts.opportunity).toBeDefined();
  });

  it('does no live deal work while native prices are at target, stale or disconnected', async () => {
    fixture.quotes.mockRestore();
    const request = fixture.rpc;
    fixture.buys.data.market!.prices = { ...fixture.buys.data.market!.prices!, argonUsdPrice: BigNumber(1) };
    await expect(
      fixture.purchases.quote({
        maxUsdcIn: 100_000_000n,
        slippageBps: 50,
        deadline: BigInt(Date.now() / 1000 + 900),
        destinationAddress: fixture.buys.accountAddress,
        sourceAddress: fixture.quote.sourceAddress,
        quoterAddress: fixture.quote.quoterAddress,
      }),
    ).rejects.toBeInstanceOf(StabilizerBuyQuoteUnavailableError);
    await expect(
      fixture.purchases.quoteMaxProfit({
        maxUsdcIn: 100_000_000n,
        slippageBps: 50,
        deadline: BigInt(Date.now() / 1000 + 900),
        destinationAddress: fixture.buys.accountAddress,
        sourceAddress: fixture.quote.sourceAddress,
        quoterAddress: fixture.quote.quoterAddress,
      }),
    ).rejects.toBeInstanceOf(StabilizerBuyQuoteUnavailableError);
    await expect(fixture.purchases.previewPurchase({ ethereumQuote: fixture.quote })).rejects.toBeInstanceOf(
      StabilizerBuyQuoteUnavailableError,
    );
    await expect(
      fixture.purchases.estimateMaxProfit({
        maxUsdcIn: 100_000_000n,
        sourceAddress: fixture.quote.sourceAddress,
        quoterAddress: fixture.quote.quoterAddress,
        cache: fixture.db.financialCacheTable,
      }),
    ).rejects.toBeInstanceOf(StabilizerBuyQuoteUnavailableError);
    fixture.buys.data.market!.prices = { ...fixture.buys.data.market!.prices, argonUsdPrice: BigNumber('0.9') };
    fixture.buys.data.currentTick = 21;
    await fixture.alerts.refresh();
    expect(fixture.alerts.opportunity).toBeUndefined();
    fixture.buys.data.currentTick = 10;
    fixture.buys.blockWatch.latestHeaders = [
      { blockTime: Date.now() - 60_000, tick: 10 } as BlockWatch['bestBlockHeader'],
    ];
    expect(fixture.buys.buyDiscountPercent).toBeUndefined();
    expect(request).not.toHaveBeenCalled();
  });

  it('stops a superseded quote before Ethereum work when its native snapshot finishes', async () => {
    fixture.quotes.mockRestore();
    const waiting = createDeferred<unknown>(false);
    native.pending = waiting.promise;
    const request = fixture.rpc;
    const abort = new AbortController();
    const reads = native.reads;
    const quoting = fixture.purchases.quoteMaxProfit(
      {
        maxUsdcIn: 100_000_000n,
        slippageBps: 50,
        deadline: BigInt(Date.now() / 1000 + 900),
        destinationAddress: fixture.buys.accountAddress,
        sourceAddress: fixture.quote.sourceAddress,
        quoterAddress: fixture.quote.quoterAddress,
      },
      abort.signal,
    );
    const estimating = fixture.purchases.estimateMaxProfit({
      maxUsdcIn: 100_000_000n,
      sourceAddress: fixture.quote.sourceAddress,
      quoterAddress: fixture.quote.quoterAddress,
      cache: fixture.db.financialCacheTable,
      signal: abort.signal,
    });
    await vi.waitFor(() => expect(native.reads).toBeGreaterThan(reads));
    abort.abort();
    waiting.resolve(native.api);
    await expect(quoting).rejects.toMatchObject({ name: 'AbortError' });
    await expect(estimating).rejects.toMatchObject({ name: 'AbortError' });
    expect(request).not.toHaveBeenCalled();
  });

  it('can model historical APY at target from a cached fee estimate without enabling live deals', async () => {
    fixture.buys.data.market!.prices = { ...fixture.buys.data.market!.prices!, argonUsdPrice: BigNumber(1) };
    // External gas measurements are inputs; the historical estimate and APY projection remain real.
    vi.spyOn(StabilizerBuyContracts.prototype, 'estimateMarketPurchaseGas').mockResolvedValue(600_000n);
    vi.spyOn(StabilizerBuy, 'estimateBidFee').mockResolvedValue(1_000_000n);
    fixture.rpc.mockImplementation(async ({ method }) => {
      if (method === 'eth_getBlockByNumber')
        return { number: '0x64', timestamp: '0x3e8', baseFeePerGas: '0x0', transactions: [] };
      if (method === 'eth_maxPriorityFeePerGas' || method === 'eth_gasPrice') return '0x3b9aca00';
      throw new Error(`Unexpected historical fee RPC ${method}`);
    });
    const input = {
      sourceAddress: fixture.quote.sourceAddress,
      quoterAddress: fixture.quote.quoterAddress,
      maxUsdcIn: 100_000_000n,
    };
    const fees = await fixture.purchases.estimateHistoricalFees(input);
    expect(fees).toBeDefined();
    const history: Parameters<typeof projectHistoricalStabilizerBuys>[0]['history'] = {
      throughDate: '2026-01-03',
      ethereumBlockNumber: 100,
      argonTokenAddress: 'synthetic-argon',
      usdcTokenAddress: 'synthetic-usdc',
      pools: [],
      rewardFunding: { frameRange: [1, 2], argonBlockRange: [10, 20], frameCount: 2, averageArgonsPerFrame: '5' },
      days: [
        { date: '2026-01-01', buyCount: 2, argonBought: '120', usdcSpent: '100', costInTargetArgons: '100' },
        { date: '2026-01-02', buyCount: 0, argonBought: '0', usdcSpent: '0', costInTargetArgons: '0' },
        { date: '2026-01-03', buyCount: 1, argonBought: '110', usdcSpent: '100', costInTargetArgons: '100' },
      ],
    };
    const market = {
      ...fixture.buys.data.market!,
      matchingRate: BigNumber(1),
      auctionInclusionPercent: BigNumber('0.5'),
    };
    const result = projectHistoricalStabilizerBuys({ history, fees: fees!, market, availableUsdc: 100_000_000n });
    // 3 buys each cost 0.0006 ETH at $2,000 plus a 1 ARGN bid fee: 206.6 deployed, 230 principal + 10 reward.
    expect(result?.apy.min).toBeCloseTo(((230 / 206.6) ** (365 / 31) - 1) * 100, 8);
    expect(result?.apy.max).toBeCloseTo(((240 / 206.6) ** (365 / 31) - 1) * 100, 8);
    const requests = fixture.rpc.mock.calls.length;
    fixture.buys.data.market!.prices = { ...fixture.buys.data.market!.prices, argonUsdPrice: BigNumber('1.1') };
    expect(await fixture.purchases.estimateHistoricalFees(input)).toBe(fees);
    expect(fixture.rpc).toHaveBeenCalledTimes(requests);
    await fixture.alerts.refresh();
    expect(fixture.alerts.opportunity).toBeUndefined();
    expect(fixture.rpc).toHaveBeenCalledTimes(requests);
  });

  it('backs off failed historical fee reads instead of retrying on every price update', async () => {
    const request = fixture.rpc;
    vi.spyOn(StabilizerBuy, 'estimateBidFee').mockResolvedValue(0n);
    const input = {
      maxUsdcIn: 100_000_000n,
      sourceAddress: fixture.quote.sourceAddress,
      quoterAddress: fixture.quote.quoterAddress,
    };
    await expect(fixture.purchases.estimateHistoricalFees(input)).rejects.toThrow();
    const initialRequests = request.mock.calls.length;
    expect(initialRequests).toBeGreaterThan(0);
    for (let tick = 0; tick < 3; tick++) {
      vi.setSystemTime(Date.now() + 2_000);
      await expect(fixture.purchases.estimateHistoricalFees(input)).rejects.toThrow();
    }
    expect(request).toHaveBeenCalledTimes(initialRequests);
    advanceTicks(1);
    await expect(fixture.purchases.estimateHistoricalFees(input)).rejects.toThrow();
    expect(request.mock.calls.length).toBeGreaterThan(initialRequests);
  });

  it.each([2_000, 60_000])(
    'waits five chain ticks between background searches (tick length %s ms)',
    async tickMillis => {
      NetworkConfig.setRuntimeOverride(NetworkConfig.networkName!, {
        tickMillis,
        ticksBetweenFrames: 10,
        ethereumNetwork: { stabilizerBuyQuoterAddress: fixture.quote.quoterAddress },
      });
      await fixture.alerts.refresh();
      const first = fixture.alerts.opportunity!.observedAt;
      advanceTicks(4);
      await fixture.alerts.refresh();
      expect(fixture.alerts.opportunity!.observedAt).toEqual(first);
      advanceTicks(1);
      await fixture.alerts.refresh();
      expect(fixture.alerts.opportunity!.observedAt.getTime()).toBe(first.getTime() + 5 * tickMillis);
    },
  );

  it('commits notification history before delivery, retries a failed write, and deduplicates after restart', async () => {
    const write = fixture.db.sql.execute.bind(fixture.db.sql);
    const interrupted = vi.spyOn(fixture.db.sql, 'execute').mockImplementation(async (query, params) => {
      if (query.startsWith('INSERT INTO SyncState') && params?.[0] === SyncStateKeys.StabilizerBuyOpportunities)
        throw new Error('Interrupted notification checkpoint');
      return write(query, params);
    });
    await fixture.alerts.refresh();
    expect(fixture.alerts.data.error).toBe('Interrupted notification checkpoint');
    expect(fixture.delivered).toEqual([]);
    interrupted.mockRestore();

    await fixture.alerts.refresh();
    expect(fixture.alerts.data.error).toBeUndefined();
    expect(fixture.delivered).toHaveLength(1);
    expect(fixture.checkpointsAtDelivery).toEqual([{ accountId: fixture.buys.accountAddress, buyPoolId: poolId }]);
    await fixture.alerts.close();
    const restarted = new StabilizerBuyAlerts(
      fixture.buys,
      () => fixture.purchases,
      fixture.wallets,
      fixture.config,
      Promise.resolve(fixture.db),
      fixture.notify,
    );
    try {
      await restarted.refresh();
      expect(restarted.opportunity).toBeDefined();
      expect(fixture.delivered).toHaveLength(1);
    } finally {
      await restarted.close();
    }
  });

  it.each([false, true])('keeps discovery when a subscription is removed during a quote (reject=%s)', async rejects => {
    await fixture.alerts.refresh();
    const previous = fixture.alerts.opportunity!;
    const pending = createDeferred<Awaited<ReturnType<StabilizerBuyPurchases['quoteMaxProfit']>>>(false);
    fixture.quotes.mockReturnValueOnce(pending.promise);
    advanceTicks(5);
    const refreshing = fixture.alerts.refresh();
    try {
      await vi.waitFor(() => expect(fixture.quotes).toHaveBeenCalledTimes(2));
      fixture.config.stabilizerBuyAlert = undefined;
      if (rejects) pending.reject(new Error('Quote RPC failed'));
      else pending.resolve(fixture.result);
      await refreshing;
      expect(fixture.alerts.opportunity?.key).toBe(previous.key);
      expect(fixture.alerts.buyNotice).toBeUndefined();
      expect(fixture.delivered).toHaveLength(1);
    } finally {
      pending.resolve(fixture.result);
      await refreshing;
    }
  });

  it('does not resurrect an expired opportunity when an older quote finishes', async () => {
    await fixture.alerts.refresh();
    const pending = createDeferred<Awaited<ReturnType<StabilizerBuyPurchases['quoteMaxProfit']>>>(false);
    fixture.quotes.mockReturnValueOnce(pending.promise);
    advanceTicks(5);
    const refreshing = fixture.alerts.refresh();
    try {
      await vi.waitFor(() => expect(fixture.quotes).toHaveBeenCalledTimes(2));
      fixture.config.stabilizerBuyAlert = { minimumApy: 13 };
      fixture.alerts.expireOpportunity(fixture.alerts.opportunity!);
      pending.resolve(fixture.result);
      await refreshing;
      expect(fixture.alerts.opportunity).toBeUndefined();
    } finally {
      pending.resolve(fixture.result);
      await refreshing;
    }
  });

  it('refreshes in place and invalidates old notices when the pool or price changes', async () => {
    await fixture.alerts.refresh();
    const previous = fixture.alerts.opportunity!;
    const published: (string | undefined)[] = [];
    const stop = watch(
      computed(() => fixture.alerts.opportunity),
      value => published.push(value?.quote.poolId),
      { flush: 'sync' },
    );
    advanceTicks(5);
    await fixture.alerts.refresh();
    stop();
    expect(published).toEqual([poolId]);
    expect(fixture.alerts.opportunity?.key).toBe(previous.key);
    fixture.alerts.expireOpportunity(previous);
    expect(fixture.alerts.opportunity).toBeDefined();

    const replacement = `0x${'55'.repeat(32)}` as const;
    fixture.buys.data.market!.approvedPool = { ...fixture.buys.data.market!.approvedPool!, poolId: replacement };
    fixture.quote.poolId = replacement;
    advanceTicks(5);
    await fixture.alerts.refresh();
    expect(fixture.alerts.getNotice(previous.key)).toBeUndefined();
    expect(fixture.alerts.opportunity?.quote.poolId).toBe(replacement);

    fixture.buys.data.market!.frameId++;
    await fixture.alerts.refresh();
    expect(await fixture.db.syncStateTable.get(SyncStateKeys.StabilizerBuyOpportunities)).toHaveProperty(
      'buyPoolId',
      replacement,
    );
    fixture.buys.data.market!.frameId--;
    fixture.buys.data.market!.prices = { ...fixture.buys.data.market!.prices!, argonUsdPrice: new BigNumber('1.05') };
    await fixture.alerts.refresh();
    expect(fixture.alerts.opportunity).toBeUndefined();
    fixture.buys.data.market!.prices = { ...fixture.buys.data.market!.prices, argonUsdPrice: new BigNumber('0.95') };
  });

  it('uses reward-inclusive profitability after fees and retires an unexecutable opportunity', async () => {
    fixture.result.preview.feeEstimateWei = 6_000_000_000_000_000n;
    await fixture.alerts.refresh();
    expect(fixture.alerts.opportunity).toBeDefined();
    expect(fixture.alerts.opportunity!.apy).toBeGreaterThan(0);
    fixture.result.preview.feeEstimateWei = 8_000_000_000_000_000n;
    advanceTicks(5);
    await fixture.alerts.refresh();
    expect(fixture.alerts.opportunity).toBeUndefined();

    fixture.result.preview.feeEstimateWei = 100_000_000_000_000n;
    advanceTicks(5);
    await fixture.alerts.refresh();
    expect(fixture.alerts.opportunity).toBeDefined();
    fixture.quotes.mockRejectedValueOnce(new StabilizerBuyQuoteUnavailableError('No executable buy remains.'));
    advanceTicks(5);
    await fixture.alerts.refresh();
    expect(fixture.alerts.opportunity).toBeUndefined();
  });

  it('expires an estimate and its notice when its freshness window ends', async () => {
    await fixture.alerts.refresh();
    const key = fixture.alerts.opportunity!.key;
    expect(fixture.alerts.getNotice(key)).toBeDefined();
    await vi.advanceTimersByTimeAsync(fixture.alerts.opportunity!.expiresAt - Date.now() + 1);
    expect(fixture.alerts.data.opportunity).toBeUndefined();
    expect(fixture.alerts.getNotice(key)).toBeUndefined();
  });

  it('delivers an unfunded-bid reminder without a buy subscription and does not repeat it after restart', async () => {
    const auction: StabilizerBuy['auction'] = {
      matchingRate: new BigNumber('0.5'),
      totalMatchingBasis: 1_020_000_000n,
      budget: 50_000_000n,
      remainingBudget: 45_000_000n,
      remainingMatchingBasis: 898_000_000n,
      maturesAtFrame: 42,
    };
    const position = new StabilizerBuy(
      12,
      {
        principal: 100_000_000n,
        capturedDiscount: 40_000_000n,
        bidRate: new BigNumber('0.25'),
        positiveBidCount: 1,
        pendingLiquidRepays: 0n,
        liquidRepaymentRewardRate: null,
      },
      auction,
    );
    fixture.buys.data.positions = [position];
    fixture.buys.data.currentFrameId = 13;
    fixture.buys.data.market!.frameId = 13;
    fixture.buys.data.market!.frameRewardTicksRemaining = 1;
    fixture.buys.data.auctionsByFrame[12] = {
      auction,
      observedAtFrame: 13,
      bids: [
        { ownerAccount: fixture.buys.accountAddress, latestBid: 25, matchingBasis: 20_000_000n },
        { ownerAccount: `0x${'22'.repeat(32)}`, latestBid: 10, matchingBasis: 1_000_000_000n },
      ],
    };
    fixture.config.stabilizerBuyAlert = undefined;
    fixture.quotes.mockRejectedValueOnce(new Error('Quote RPC failed'));
    await fixture.alerts.refresh();
    expect(fixture.delivered).toMatchObject([
      {
        type: 'bid',
        position: { admissionFrame: 12 },
        bid: { latestBid: 25, requestedReward: 5_000_000n, fundingEstimate: 0n },
      },
    ]);
    await fixture.alerts.refresh();
    await fixture.alerts.close();
    const restarted = new StabilizerBuyAlerts(
      fixture.buys,
      () => fixture.purchases,
      fixture.wallets,
      fixture.config,
      Promise.resolve(fixture.db),
      fixture.notify,
    );
    try {
      await restarted.refresh();
      expect(fixture.delivered).toHaveLength(1);
    } finally {
      await restarted.close();
    }
  });
});

function advanceTicks(ticks: number) {
  fixture.buys.data.currentTick += ticks;
  const market = fixture.buys.data.market!;
  market.prices = { ...market.prices!, tick: fixture.buys.data.currentTick };
  vi.setSystemTime(Date.now() + ticks * NetworkConfig.tickMillis);
}

async function createAlerts() {
  const db = await createTestDb();
  const keys = createMockWalletKeys('test test test test test test test test test test test junk');
  const blockWatch = Object.create(BlockWatch.prototype) as BlockWatch;
  blockWatch.latestHeaders = [];
  const buys = new StabilizerBuys(blockWatch, keys.defaultArgonAddress, Promise.resolve(db));
  buys.data = reactive(buys.data) as StabilizerBuys['data'];
  buys.data.isLoaded = true;
  buys.data.isAvailable = true;
  buys.data.currentTick = 10;
  buys.data.market = {
    approvedPool: {
      chainId: 1n,
      poolManager: buyOpportunity.quote.poolManager,
      poolId,
      usdcToken: token,
      argonIsToken0: true,
    },
    prices: {
      tick: 10,
      btcUsdPrice: new BigNumber(90_000),
      argonotUsdPrice: new BigNumber(1),
      argonUsdPrice: new BigNumber('0.9'),
      argonUsdTargetPrice: new BigNumber(1),
      argonTimeWeightedAverageLiquidity: new BigNumber(1_000_000),
      usdcUsdPrice: new BigNumber(1),
      stabilizerPoolSqrtPriceX96: 1n << 96n,
    },
    matchingRate: new BigNumber('0.5'),
    frameId: 0,
    frameRewardTicksRemaining: 10_000,
    maxPriceAgeTicks: 10,
    maxPositiveBids: 4,
    purchaseHoldFrames: 30,
    liquidRepaymentRewardPercent: new BigNumber('0.05'),
    auctionInclusionPercent: new BigNumber('0.9'),
  };
  native.pending = undefined;
  native.api = {
    registry: getOfflineRegistry(),
    consts: {
      balances: { existentialDeposit: 1_000_000n },
      stabilizerBuys: { maxPriceAgeTicks: 10 },
      priceIndex: { maxDowntimeTicksBeforeReset: 10n },
    },
    query: {
      ticks: { currentTick: async () => 10 },
      stabilizerBuys: {
        approvedPool: async () => buys.data.market!.approvedPool,
        priceHistoryByTick: {
          multi: async () => [
            {
              frame: 0,
              rValue: BigNumber('0.9'),
              prices: { argonUsdTargetPrice: BigNumber(1), microgonsAtTargetPerUsdc: BigNumber(1_000_000) },
            },
          ],
        },
      },
      crosschainTransfer: {
        chainConfigBySourceChain: async () => ({
          type: 'Evm',
          value: {
            chainId: 1n,
            gateway: buyOpportunity.quote.gatewayAddress,
            argonToken: buyOpportunity.quote.poolKey.currency0,
          },
        }),
      },
      priceIndex: {
        currentEthereumPrice: async () => ({ tick: 10, ethereumUsdPrice: BigNumber(2000) }),
      },
    },
  };
  const wallets = new WalletsForEthereum(
    keys,
    Promise.resolve(db),
    Promise.resolve(db.financialCacheTable),
    async () => {
      throw new Error('Alerts do not need signing access.');
    },
  );
  await db.walletsTable.createDefaultEthereum({
    address: keys.coreEthereumAddress,
    derivationPath: keys.ethereumHdPath,
  });
  await wallets.reloadRecords();
  const balance: IOtherToken = {
    symbol: 'USDC',
    decimals: 6,
    address: token,
    chain: 'ethereum',
    unitOfMeasurement: UnitOfMeasurement.USDC,
    value: 200_000_000n,
  };
  wallets.coreWallet.data.otherTokens = [balance];
  wallets.coreWallet.data.balanceUpdatedAt = new Date();
  wallets.coreWallet.data.balanceIsCached = false;
  vi.spyOn(wallets, 'refresh').mockResolvedValue();
  const rpc = vi.fn(async (_request: Parameters<PublicClient['request']>[0]): Promise<unknown> => {
    throw new Error('Ethereum temporarily unavailable');
  });
  const ethereum = new EthereumClient(keys, 'http://ethereum.test');
  Object.defineProperty(ethereum, 'publicClient', {
    value: createPublicClient({ transport: custom({ request: rpc }, { retryCount: 0 }) }),
  });
  const purchases = new StabilizerBuyPurchases(buys, keys, ethereum, wallets);
  const quote: IStabilizerBuyQuote = {
    ...buyOpportunity.quote,
    sourceAddress: getAddress(keys.coreEthereumAddress),
    request: {
      ...buyOpportunity.quote.request,
      argonAccountId: toArgonAccountIdHex(keys.defaultArgonAddress),
      minMicrogonsOut: 105_000_000n,
      deadline: BigInt(Date.now() / 1000 + 900),
    },
    prices: {
      tick: 10,
      argonUsdTargetPrice: new BigNumber(1),
      usdcUsdPrice: new BigNumber(1),
      ethereumUsdPrice: new BigNumber(2000),
    },
  };
  const result = { minimumQuote: quote, quote, preview: { feeEstimateWei: 100_000_000_000_000n, needsPermit: true } };
  const quotes = vi.spyOn(purchases, 'estimateMaxProfit').mockImplementation(async () => ({
    ...result,
    quote: { ...result.quote, request: { ...result.quote.request } },
  }));
  const config = reactive<ConstructorParameters<typeof StabilizerBuyAlerts>[3]>({
    isLoaded: true,
    stabilizerBuyAlert: { minimumApy: 12 },
  });
  const delivered: IStabilizerBuyOpportunity[] = [];
  const checkpointsAtDelivery: (ISyncSchemas[SyncStateKeys.StabilizerBuyOpportunities] | null)[] = [];
  const notify = async (getNotice: () => IStabilizerBuyOpportunity | undefined) => {
    const notice = getNotice();
    if (notice) {
      checkpointsAtDelivery.push(await db.syncStateTable.get(SyncStateKeys.StabilizerBuyOpportunities));
      delivered.push(notice);
    }
  };
  const alerts = new StabilizerBuyAlerts(buys, () => purchases, wallets, config, Promise.resolve(db), notify);
  alerts.data = reactive(alerts.data) as StabilizerBuyAlerts['data'];
  NetworkConfig.setRuntimeOverride(NetworkConfig.networkName!, {
    ticksBetweenFrames: 10,
    tickMillis: 2_000,
    ethereumNetwork: { stabilizerBuyQuoterAddress: buyOpportunity.quote.quoterAddress },
  });
  return {
    db,
    buys,
    wallets,
    purchases,
    rpc,
    config,
    quote,
    result,
    quotes,
    alerts,
    delivered,
    checkpointsAtDelivery,
    notify,
    balance,
  };
}
