import { describe, it, expect, vi, afterEach } from 'vitest';
import { computed, reactive, watch } from 'vue';
import BigNumber from 'bignumber.js';
import { Metadata } from '@polkadot/types';
import { decorateStorage, decorateExtrinsics } from '@polkadot/types/metadata/decorate';
import { getOfflineRegistry } from '@argonprotocol/mainchain';
import {
  NetworkConfig,
  StabilizerBuyQuoteUnavailableError,
  StabilizerBuyContracts,
  UnitOfMeasurement,
  createTypedEventEmitter,
  type BlockWatch,
  type IBlockHeaderInfo,
  type RuntimeSystemEventRecord,
} from '@argonprotocol/apps-core';
import { runtimeClient, type HistoricalEvent } from '@argonprotocol/runtime-client';
import { maxUint128, toHex } from 'viem';
import { WalletForArgon } from '../lib/WalletForArgon.ts';
import { WalletFinancials } from '../lib/financials/WalletBalances.ts';
import type { IArgonAccountBalance } from '../lib/WalletsForArgon.ts';
import { createTestDb, createTestDbAtMigration } from './helpers/db.ts';
import { StabilizerBuyAlerts } from '../lib/StabilizerBuyAlerts.ts';
import { StabilizerBuyPurchases } from '../lib/StabilizerBuyPurchases.ts';
import { createMockWalletKeys } from './helpers/wallet.ts';
import { WalletsForEthereum } from '../lib/WalletsForEthereum.ts';
import { StabilizerBuys } from '../lib/StabilizerBuys.ts';
import {
  StabilizerBuyStatus,
  type IStabilizerBuyOpportunity,
  type IStabilizerBuyQuote,
} from '../interfaces/IStabilizerBuyPurchase.ts';
import { toArgonAccountIdHex } from '../lib/EthereumClient.ts';
import * as Ethereum from '../lib/EthereumClient.ts';
import * as Mainchain from '../stores/mainchain.ts';
import { createStabilizerBuyFinancialPositions, projectStabilizerBuyQuote } from '../lib/financials/StabilizerBuys.ts';
import { calculatePositionReturn, reduceFinancialPositions } from '../lib/financials/index.ts';
import { getStabilizerBuyBidNotice } from '../lib/Alerts.ts';
import { findAddressActivity } from '../lib/IndexerClient.ts';
import { SyncStateKeys } from '../lib/db/SyncStateTable.ts';
import { ConfigSchema, TopTab } from '../interfaces/IConfig.ts';

vi.mock('../lib/IndexerClient.ts', () => ({ findAddressActivity: vi.fn() }));
afterEach(() => vi.restoreAllMocks());

const gateway = `0x${'11'.repeat(20)}` as const;
const buyer = `0x${'22'.repeat(20)}` as const;
const token = `0x${'33'.repeat(20)}` as const;
const poolId = `0x${'44'.repeat(32)}` as const;
const epoch = Date.UTC(2026, 0, 1);
const block = (blockNumber: number): IBlockHeaderInfo => ({
  blockNumber,
  blockHash: toHex(blockNumber, { size: 32 }),
  parentHash: toHex(blockNumber - 1, { size: 32 }),
  blockTime: epoch + blockNumber * 60_000,
  tick: blockNumber,
  isFinalized: true,
  author: '',
  frameId: 12,
});
const eventRecord = (event: HistoricalEvent): RuntimeSystemEventRecord => ({
  event,
  phase: { type: 'ApplyExtrinsic', value: 1 },
  topics: [],
});

describe('Stabilizer purchase history and total returns', { tags: ['no-argon-network'] }, () => {
  it('removes inactive swap tables and their saved settings on upgrade', async () => {
    const { db, migrateToLatest } = await createTestDbAtMigration(46);
    try {
      expect(await db.sql.select("SELECT name FROM sqlite_master WHERE name = 'StabilizerBuys'")).toEqual([]);
      await db.sql.execute(
        `INSERT INTO Config (key, value) VALUES ('hasActivatedStableSwaps', 'false'), ('selectedTab', '"StableSwaps"')`,
      );
      await migrateToLatest();
      expect(await db.sql.select("SELECT name FROM sqlite_master WHERE name LIKE 'StableSwap%'")).toEqual([]);
      expect(
        await db.sql.select(
          "SELECT name FROM sqlite_master WHERE name IN ('StabilizerBuys', 'StabilizerBuyFrameRewards') ORDER BY name",
        ),
      ).toEqual([{ name: 'StabilizerBuyFrameRewards' }, { name: 'StabilizerBuys' }]);
      const config = await db.configTable.fetchAllAsObject();
      expect(config).not.toHaveProperty('hasActivatedStableSwaps');
      expect(ConfigSchema.shape.selectedTab.parse(JSON.parse(config.selectedTab!))).toBe(TopTab.Home);
    } finally {
      await db.sql.close();
    }
  });

  it('rechecks a desktop bid notice against a newly finalized frame before resolving it', async () => {
    const chain = chainHistory();
    chain.setOpportunities(0.9, true);
    chain.setCompetingBid(1_000_000_000n);
    const db = await createTestDb();
    const buys = new StabilizerBuys(chain.watch, chain.accountId, Promise.resolve(db));
    const wallets = new WalletsForEthereum(
      {
        coreEthereumAddress: buyer,
        isCoreEthereumWallet: () => true,
        initializeEthereumWallet: vi.fn(),
        removeEthereumWallet: vi.fn(),
      },
      Promise.resolve(db),
      Promise.resolve(db.financialCacheTable),
      async () => {
        throw new Error('Notice resolution does not require wallet authentication.');
      },
    );
    const alerts = new StabilizerBuyAlerts(
      buys,
      () => undefined,
      wallets,
      { isLoaded: true, stabilizerBuyAlert: undefined },
      Promise.resolve(db),
    );
    try {
      await buys.load();
      const notice = getStabilizerBuyBidNotice(buys)!;
      expect(notice.position.admissionFrame).toBe(12);
      expect(buys.data.currentFrameId).toBe(13);

      let finishRead!: () => void;
      let queryStarted!: () => void;
      const started = new Promise<void>(resolve => {
        queryStarted = resolve;
      });
      const waiting = new Promise<void>(resolve => {
        finishRead = resolve;
      });
      vi.spyOn(chain.rawApi.query.miningSlot, 'nextFrameId').mockImplementation(async () => {
        queryStarted();
        await waiting;
        return getOfflineRegistry().createType('u64', 15);
      });
      vi.spyOn(chain.watch, 'getLatestFinalizedSnapshot').mockResolvedValue({
        block: block(11),
        api: runtimeClient(await chain.watch.getApi(block(11))),
      });
      expect(chain.watch.finalizedBlockHeader.blockNumber).toBe(10);
      const resolution = alerts.resolveNotice(notice.key);
      await started;
      expect(buys.data.currentFrameId).toBe(13);
      finishRead();

      expect(await resolution).toBeUndefined();
      expect(buys.data.currentFrameId).toBe(14);
      expect(buys.data.blockNumber).toBe(11);
      expect(alerts.getNotice(notice.key)).toBeUndefined();
    } finally {
      await alerts.close();
      await buys.close();
      await db.sql.close();
    }
  });

  it('shows profitable opportunities without an alert and filters notifications by reward-inclusive APY', async () => {
    const chain = chainHistory();
    chain.setOpportunities(0.9, true);
    let ticksRemaining = 10_000;
    vi.spyOn(chain.rawApi.query.miningSlot, 'frameRewardTicksRemaining').mockImplementation(async () =>
      chain.registry.createType('u64', ticksRemaining),
    );
    const db = await createTestDb();
    const buys = new StabilizerBuys(chain.watch, chain.accountId, Promise.resolve(db));
    buys.data = reactive(buys.data) as StabilizerBuys['data'];
    const config = reactive<ConstructorParameters<typeof StabilizerBuyAlerts>[3]>({
      isLoaded: true,
      stabilizerBuyAlert: undefined,
    });
    let now = Date.now();
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    let usdcBalance = 0n;
    vi.spyOn(Ethereum, 'getEthereumExecutionRpcUrl').mockReturnValue('http://ethereum.test');
    vi.spyOn(Ethereum, 'loadEthereumChainConfig').mockResolvedValue({
      chainId: 31337,
      gatewayAddress: gateway,
      argonTokenAddress: gateway,
      argonotTokenAddress: buyer,
    });
    vi.spyOn(Ethereum, 'createEthereumPublicClient').mockReturnValue({
      getBalance: async () => 0n,
      readContract: async ({ address }: { address: string }) => (address === token ? usdcBalance : 0n),
    } as unknown as ReturnType<typeof Ethereum.createEthereumPublicClient>);

    const wallets = new WalletsForEthereum(
      {
        coreEthereumAddress: buyer,
        isCoreEthereumWallet: record => record?.address.toLowerCase() === buyer,
        initializeEthereumWallet: vi.fn(),
        removeEthereumWallet: vi.fn(),
      },
      Promise.resolve(db),
      Promise.resolve(db.financialCacheTable),
      () => Promise.reject(new Error('Balance refresh does not require authentication.')),
    );
    const coreWallet = wallets.coreWallet;
    const quote: IStabilizerBuyQuote = {
      chainId: 1,
      sourceAddress: buyer,
      gatewayAddress: gateway,
      adapterAddress: gateway,
      quoterAddress: gateway,
      poolId,
      poolManager: gateway,
      usdcToken: token,
      poolKey: { currency0: gateway, currency1: token, fee: 3000, tickSpacing: 60, hooks: gateway },
      request: {
        repayLiquidId: 0n,
        repaySignature: '0x' as const,
        argonAccountId: toArgonAccountIdHex(chain.accountId),
        maxUsdcIn: 100_000_000n,
        minMicrogonsOut: 105_000_000n,
        deadline: BigInt(Math.floor(Date.now() / 1000) + 900),
      },
      quotedMicrogonsOut: 110_000_000n,
      sqrtPriceX96After: 1n << 96n,
      swapGasEstimate: 100_000n,
      minimumRewardPrincipal: 1_000_000n,
      qualifiesForRewards: true,
      prices: {
        tick: 11,
        argonUsdTargetPrice: BigNumber(1),
        usdcUsdPrice: BigNumber(1),
        ethereumUsdPrice: BigNumber(2000),
      },
    };
    const walletKeys = createMockWalletKeys();
    const ethereumClient = new Ethereum.EthereumClient(walletKeys, 'http://ethereum.test');
    let feePerGas = 1_000_000_000n;
    Object.defineProperty(ethereumClient, 'publicClient', {
      value: {
        getBlock: async () => ({ number: 100n, timestamp: BigInt(Math.floor(now / 1000)) }),
        readContract: async ({ functionName }: { functionName: string }) =>
          functionName === 'balanceOf' ? usdcBalance : 0n,
        estimateContractGas: async () => 50_000n,
        estimateFeesPerGas: async () => ({ maxFeePerGas: feePerGas, maxPriorityFeePerGas: 1n }),
      },
    });
    const purchases = new StabilizerBuyPurchases(buys, walletKeys, ethereumClient, wallets);
    vi.spyOn(Mainchain, 'getMainchainClient').mockResolvedValue({
      raw: { at: async () => ({}) },
      rpc: { chain: { getFinalizedHead: async () => '0x00' } },
    } as unknown as Awaited<ReturnType<typeof Mainchain.getMainchainClient>>);
    // The external quote curve peaks in net savings at 100 USDC; spending 200 USDC erases the discount.
    const quotePurchase = vi.spyOn(StabilizerBuyContracts.prototype, 'quote').mockImplementation(async request => {
      const amount = request.maxUsdcIn ?? 100_000_000n;
      const output = (amount * 12n) / 10n - (amount * amount) / 1_000_000_000n;
      return {
        ...quote,
        request: { ...quote.request, maxUsdcIn: amount, minMicrogonsOut: (output * 995n) / 1000n },
        quotedMicrogonsOut: output,
      };
    });
    let finishQuote: ((value: IStabilizerBuyQuote) => void) | undefined;
    const delivered: IStabilizerBuyOpportunity[] = [];
    const notify = async (getNotice: () => IStabilizerBuyOpportunity | undefined) => {
      const opportunity = getNotice();
      if (opportunity) delivered.push(opportunity);
    };
    let alerts = new StabilizerBuyAlerts(buys, () => purchases, wallets, config, Promise.resolve(db), notify);
    alerts.data = reactive(alerts.data) as StabilizerBuyAlerts['data'];
    const visibleOpportunity = computed(() => alerts.opportunity);
    const visibleDiscount = computed(() => buys.buyDiscountPercent);
    NetworkConfig.setRuntimeOverride(NetworkConfig.networkName!, {
      ticksBetweenFrames: 10,
      tickMillis: 2_000,
      ethereumNetwork: { stabilizerBuyQuoterAddress: gateway, usdcTokenAddress: token },
    });
    try {
      await buys.load();
      expect(buys.data.market).toMatchObject({
        purchaseHoldFrames: 30,
        auctionInclusionPercent: BigNumber(0.9),
      });
      await wallets.load();
      await alerts.refresh();
      expect(coreWallet.isPersisted).toBe(false);
      expect(visibleOpportunity.value).toBeDefined();
      expect(alerts.buyNotice).toBeUndefined();
      expect(visibleDiscount.value).toBeCloseTo(10);
      expect(delivered).toEqual([]);

      config.stabilizerBuyAlert = undefined;
      const unconfiguredOpportunity = visibleOpportunity.value;
      expect(unconfiguredOpportunity).toBeDefined();
      await alerts.refresh();
      expect(visibleOpportunity.value).toBe(unconfiguredOpportunity);
      expect(alerts.buyNotice).toBeUndefined();
      expect(visibleDiscount.value).toBeCloseTo(10);
      config.stabilizerBuyAlert = { minimumApy: 12 };

      usdcBalance = 200_000_000n;
      now += 60_001;

      const write = db.sql.execute.bind(db.sql);
      let interrupt = true;
      const interrupted = vi.spyOn(db.sql, 'execute').mockImplementation(async (query, params) => {
        if (
          query.startsWith('INSERT INTO SyncState') &&
          params?.[0] === SyncStateKeys.StabilizerBuyOpportunities &&
          interrupt
        ) {
          interrupt = false;
          throw new Error('Interrupted notification checkpoint');
        }
        return write(query, params);
      });
      await alerts.refresh();
      expect(alerts.opportunity?.quote.request.maxUsdcIn).toBe(100_000_000n);
      expect(alerts.opportunity?.quote.quotedMicrogonsOut).toBe(110_000_000n);
      const [savedWallet] = await db.walletsTable.fetchEthereumWallets();
      expect(savedWallet?.address).toBe(buyer);
      expect(wallets.get(savedWallet.id)).toBe(coreWallet);
      expect(coreWallet.data.otherTokens.find(token => token.unitOfMeasurement === UnitOfMeasurement.USDC)?.value).toBe(
        200_000_000n,
      );
      expect(alerts.data.error).toBe('Interrupted notification checkpoint');
      expect(delivered).toEqual([]);
      await alerts.refresh();
      interrupted.mockRestore();
      expect(alerts.data.error).toBeUndefined();
      expect(alerts.data.opportunity?.quote.quotedMicrogonsOut).toBe(110_000_000n);
      expect(alerts.data.opportunity?.apy).toBeGreaterThan(12);
      expect(delivered).toMatchObject([
        {
          type: 'buy',
          quote: { poolId, quotedMicrogonsOut: 110_000_000n },
          discountPercent: expect.closeTo(9.090909, 4),
        },
      ]);
      expect(delivered[0]).toHaveProperty('apy', visibleOpportunity.value!.apy);
      expect(visibleOpportunity.value).toBeDefined();

      const pendingQuote = new Promise<IStabilizerBuyQuote>(resolve => {
        finishQuote = resolve;
      });
      quotePurchase.mockReturnValueOnce(pendingQuote);
      const quotesBeforeRefresh = quotePurchase.mock.calls.length;
      now += 60_001;
      const refresh = alerts.refresh();
      await vi.waitFor(() => expect(quotePurchase).toHaveBeenCalledTimes(quotesBeforeRefresh + 1));
      config.stabilizerBuyAlert = { minimumApy: 13 };
      const changedSettings = alerts.refresh();
      expect(visibleOpportunity.value).toBeDefined();
      alerts.expireOpportunity(visibleOpportunity.value!);
      expect(visibleOpportunity.value).toBeUndefined();
      finishQuote!(quote);
      await Promise.all([refresh, changedSettings]);
      expect(visibleOpportunity.value).toBeUndefined();
      config.stabilizerBuyAlert = { minimumApy: 12 };
      await alerts.refresh();
      expect(visibleOpportunity.value).toBeDefined();
      expect(delivered).toHaveLength(1);

      // Removing a subscription keeps discovery active while stopping every notification path.
      for (const fails of [false, true]) {
        const quotesBeforeRemoval = quotePurchase.mock.calls.length;
        quotePurchase.mockReturnValueOnce(
          new Promise<IStabilizerBuyQuote>((resolve, reject) => {
            finishQuote = value => {
              if (fails) reject(new Error('Canceled quote RPC failed'));
              else resolve(value);
            };
          }),
        );
        now += 60_001;
        const pendingRemoval = alerts.refresh();
        await vi.waitFor(() => expect(quotePurchase.mock.calls.length).toBeGreaterThan(quotesBeforeRemoval));
        config.stabilizerBuyAlert = undefined;
        const beforeRemoval = visibleOpportunity.value;
        expect(beforeRemoval).toBeDefined();
        const removedSettings = alerts.refresh();
        finishQuote!(quote);
        await Promise.all([pendingRemoval, removedSettings]);
        expect(visibleOpportunity.value).toBeDefined();
        expect(visibleOpportunity.value!.key).toBe(beforeRemoval!.key);
        expect(alerts.buyNotice).toBeUndefined();
        if (fails) expect(alerts.data.error).toBe('Canceled quote RPC failed');
        else expect(alerts.data.error).toBeUndefined();
        expect(delivered).toHaveLength(1);

        config.stabilizerBuyAlert = { minimumApy: 12 };
        await alerts.refresh();
        expect(visibleOpportunity.value).toBeDefined();
      }

      const paidFeeApy = visibleOpportunity.value!.apy;
      feePerGas = 0n;
      now += 60_001;
      await alerts.refresh();
      expect(visibleOpportunity.value!.apy).toBeGreaterThan(paidFeeApy);
      feePerGas = 1_000_000_000n;

      alerts.expireOpportunity(alerts.opportunity!);
      usdcBalance = 1n;
      now += 60_001;
      await alerts.refresh();
      expect(visibleOpportunity.value).toBeDefined();
      expect(alerts.buyNotice).toBeUndefined();

      now += 60_001;
      quotePurchase.mockRejectedValueOnce(new StabilizerBuyQuoteUnavailableError('No executable buy remains.'));
      await alerts.refresh();
      expect(visibleOpportunity.value).toBeUndefined();
      expect(visibleDiscount.value).toBeCloseTo(10);

      usdcBalance = 200_000_000n;
      now += 60_001;
      await alerts.refresh();
      expect(visibleOpportunity.value).toBeDefined();
      expect(delivered).toHaveLength(1);

      const publishedPools: (string | undefined)[] = [];
      const originalKey = alerts.opportunity!.key;
      const oldOpportunity = alerts.opportunity!;
      const stopObserving = watch(visibleOpportunity, opportunity => publishedPools.push(opportunity?.quote.poolId), {
        flush: 'sync',
      });
      now += 60_001;
      await alerts.refresh();
      stopObserving();
      // A refreshed same-pool quote stays present, so a viewed bell is not rearmed between publications.
      expect(publishedPools).toEqual([poolId]);
      expect(alerts.opportunity?.key).toBe(originalKey);
      alerts.expireOpportunity(oldOpportunity);
      expect(alerts.opportunity).toBeDefined();
      await alerts.close();

      alerts = new StabilizerBuyAlerts(buys, () => purchases, wallets, config, Promise.resolve(db), notify);
      alerts.data = reactive(alerts.data) as StabilizerBuyAlerts['data'];
      await alerts.refresh();
      expect(alerts.data.opportunity).toBeDefined();
      expect(delivered).toHaveLength(1);
      expect(await db.syncStateTable.get(SyncStateKeys.StabilizerBuyOpportunities)).toMatchObject({
        accountId: chain.accountId,
        buyPoolId: poolId,
      });

      await alerts.close();
      feePerGas = 7_000_000_000n;
      alerts = new StabilizerBuyAlerts(buys, () => purchases, wallets, config, Promise.resolve(db), notify);
      alerts.data = reactive(alerts.data) as StabilizerBuyAlerts['data'];
      await alerts.refresh();
      expect(alerts.data.opportunity).toBeDefined();
      expect(alerts.buyNotice).toBeDefined();
      expect(delivered).toHaveLength(1);

      const rewardOnly = projectStabilizerBuyQuote({
        quote: alerts.opportunity!.quote,
        feeEstimateWei: (await purchases.previewPurchase({ ethereumQuote: alerts.opportunity!.quote })).feeEstimateWei,
        periodDays: 30,
        matchingRate: BigNumber(0.5),
      })!;
      expect(rewardOnly.apy.min).toBeLessThan(0);
      expect(rewardOnly.apy.max).toBeGreaterThan(0);
      expect(alerts.opportunity!.apy).toBe(rewardOnly.apy.max);

      feePerGas = 100_000_000_000n;
      now += 60_001;
      await alerts.refresh();
      expect(alerts.data.opportunity).toBeUndefined();
      expect(alerts.opportunity).toBeUndefined();
      expect(alerts.buyNotice).toBeUndefined();
      feePerGas = 1_000_000_000n;

      config.stabilizerBuyAlert = undefined;
      ticksRemaining = 1;
      chain.setCompetingBid(1_000_000_000n);
      chain.advance(11, 100_000_000n, 0n);
      await buys.refresh(block(11));
      await alerts.refresh();
      expect(delivered).toMatchObject([
        { type: 'buy', quote: { poolId } },
        {
          type: 'bid',
          position: { admissionFrame: 12 },
          bid: { latestBid: 25, requestedReward: 5_000_000n, fundingEstimate: 0n },
        },
      ]);
      await alerts.refresh();
      expect(delivered).toHaveLength(2);

      await alerts.close();
      alerts = new StabilizerBuyAlerts(buys, () => purchases, wallets, config, Promise.resolve(db), notify);
      alerts.data = reactive(alerts.data) as StabilizerBuyAlerts['data'];
      await alerts.refresh();
      expect(delivered).toHaveLength(2);

      config.stabilizerBuyAlert = { minimumApy: 12 };
      feePerGas = 1_000_000_000n;
      now += 60_001;
      await alerts.refresh();
      const previousKey = alerts.opportunity!.key;
      const replacementPoolId = toHex(99, { size: 32 });
      const approved = await chain.rawApi.query.stabilizerBuys.approvedPool();
      vi.spyOn(chain.rawApi.query.stabilizerBuys, 'approvedPool').mockResolvedValue({
        ...approved!,
        poolId: replacementPoolId,
      });
      chain.advance(12, 100_000_000n, 0n);
      await buys.refresh(block(12));
      expect(alerts.getNotice(previousKey)).toBeUndefined();
      quotePurchase.mockResolvedValueOnce({ ...quote, poolId: replacementPoolId });
      now += 60_001;
      await alerts.refresh();
      expect(alerts.opportunity?.quote.poolId).toBe(replacementPoolId);
      expect(alerts.opportunity?.key).not.toBe(previousKey);
      expect(alerts.getNotice(previousKey)).toBeUndefined();

      // Retire the real timer before testing expiry against a controlled external clock.
      alerts.expireOpportunity(alerts.opportunity!);
      now += 60_001;
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      config.stabilizerBuyAlert = { minimumApy: 12 };
      const expiresAt = Math.floor(now / 1000) * 1000 + 2000;
      quotePurchase.mockResolvedValueOnce({
        ...quote,
        poolId: replacementPoolId,
        request: { ...quote.request, deadline: BigInt(expiresAt / 1000) },
      });
      await alerts.refresh();
      const expiringKey = alerts.opportunity!.key;
      const visibleExpiringOpportunity = computed(() => alerts.opportunity);
      expect(visibleExpiringOpportunity.value).toBeDefined();
      const delay = expiresAt - now;
      now = expiresAt;
      await vi.advanceTimersByTimeAsync(delay);
      expect(alerts.data.opportunity).toBeUndefined();
      expect(visibleExpiringOpportunity.value).toBeUndefined();
      expect(alerts.getNotice(expiringKey)).toBeUndefined();

      chain.setOpportunities(1.05, true);
      chain.advance(13, 100_000_000n, 0n);
      await buys.refresh(block(13));
      expect(visibleDiscount.value).toBeUndefined();

      chain.setOpportunities(0.95, true);
      chain.advance(14, 100_000_000n, 0n);
      await buys.refresh(block(14));
      expect(visibleDiscount.value).toBeCloseTo(5);

      const deliveredBeforeRetry = delivered.length;
      vi.spyOn(chain.rawApi.query.miningSlot, 'nextFrameId').mockResolvedValue(chain.registry.createType('u64', 15));
      vi.spyOn(chain.rawApi.query.stabilizerBuys, 'approvedPool').mockRejectedValueOnce(
        new Error('Pool RPC unavailable'),
      );
      chain.advance(15, 100_000_000n, 0n);
      await buys.refresh(block(15));
      await alerts.refresh();
      expect(await db.syncStateTable.get(SyncStateKeys.StabilizerBuyOpportunities)).toHaveProperty(
        'buyPoolId',
        replacementPoolId,
      );

      chain.advance(16, 100_000_000n, 0n);
      await buys.refresh(block(16));
      now += 60_001;
      quotePurchase.mockResolvedValueOnce({
        ...quote,
        poolId: replacementPoolId,
        request: { ...quote.request, deadline: BigInt(Math.floor(now / 1000) + 900) },
      });
      await alerts.refresh();
      expect(visibleDiscount.value).toBeCloseTo(5);
      expect(delivered).toHaveLength(deliveredBeforeRetry);
    } finally {
      finishQuote?.(quote);
      NetworkConfig.clearRuntimeOverride();
      await alerts.close();
      vi.useRealTimers();
      await purchases.close();
      await buys.close();
      wallets.dispose();
      await db.sql.close();
    }
  });

  it('keeps a reward-only claim visible while recovering its missing award after principal was released', async () => {
    const chain = chainHistory();
    chain.events.delete(12);
    chain.events.set(14, [
      eventRecord({
        section: 'stabilizerBuys',
        method: 'PayoutCompleted',
        data: {
          account: chain.accountId,
          principal: 100_000_000n,
          reward: 0n,
        },
      }),
    ]);
    chain.events.set(15, [
      eventRecord({
        section: 'stabilizerBuys',
        method: 'RewardAwarded',
        data: {
          account: chain.accountId,
          admissionFrame: 12,
          amount: 5_000_000n,
          maturesAtFrame: 42,
        },
      }),
    ]);
    chain.advance(14, 0n, 0n);
    const metadata = new Metadata(chain.registry, { metadata: { V16: chain.registry.metadata } });
    const storage = decorateStorage(chain.registry, metadata.asLatest, metadata.version);
    chain.maturingKeys.push(
      chain.registry.createType('StorageKey', [
        storage.stabilizerBuys.auctionAllocationQueue,
        [{ ascendingRank: toHex(15, { size: 8 }), orderedId: toHex(12, { size: 8 }) }],
      ]),
    );
    const db = await createTestDb();
    const buys = new StabilizerBuys(chain.watch, chain.accountId, Promise.resolve(db));
    buys.data = reactive(buys.data) as StabilizerBuys['data'];
    const visibleValue = computed(
      () =>
        reduceFinancialPositions([
          {
            group: 'stabilizer',
            state: 'ready',
            positions: createStabilizerBuyFinancialPositions(buys.snapshot),
            observation: { observedAt: new Date(block(20).blockTime) },
          },
        ]).groupSummaries.stabilizer.currentValue,
    );
    try {
      await buys.load();
      expect(visibleValue.value).toBe(0n);
      expect(buys.data.buys).toEqual([]);
      await vi.waitFor(
        () => expect(createStabilizerBuyFinancialPositions(buys.snapshot)[0]?.settledPrincipalValue).toBe(100_000_000n),
        { timeout: 3_000 },
      );
      await buys.refresh(block(14));
      expect(createStabilizerBuyFinancialPositions(buys.snapshot)[0]).toMatchObject({
        lifecycle: 'held',
        endedAt: undefined,
        paidIncome: 0n,
        settledPrincipalValue: 100_000_000n,
      });
      expect(buys.data.frameRewards[0].awardedReward).toBeUndefined();

      chain.maturingKeys.length = 0;
      chain.advance(15, 0n, 5_000_000n);
      await buys.refresh(block(15));
      expect(visibleValue.value).toBe(5_000_000n);
      expect(buys.data.frameRewards[0].rewardAward?.amount).toBe(5_000_000n);
      expect(createStabilizerBuyFinancialPositions(buys.snapshot)[0]).toMatchObject({
        lifecycle: 'held',
        paidIncome: 0n,
        settledPrincipalValue: 100_000_000n,
      });
      expect(buys.data.isRestoringHistory).toBe(false);
    } finally {
      await buys.close();
      await db.sql.close();
    }
  });

  it('does not attribute an earlier same-block payout to a newly admitted purchase when older history is missing', async () => {
    const chain = chainHistory();
    chain.events.get(10)!.unshift({
      event: {
        section: 'stabilizerBuys',
        method: 'PayoutCompleted',
        data: { account: chain.accountId, principal: 100_000_000n, reward: 0n },
      },
      phase: { type: 'Initialization' },
      topics: [],
    });
    const db = await createTestDb();
    const buys = new StabilizerBuys(chain.watch, chain.accountId, Promise.resolve(db));
    try {
      await buys.load();
      expect(createStabilizerBuyFinancialPositions(buys.snapshot)[0]).toMatchObject({
        currentValue: 100_000_000n,
        settledPrincipalValue: 0n,
        returnIsComplete: false,
      });
      expect(
        (await db.stabilizerBuysTable.fetchAll(chain.accountId)).buys[0].purchaseArgonReleaseBlockNumber,
      ).toBeUndefined();
      expect((await db.syncStateTable.get(SyncStateKeys.StabilizerBuys))?.payoutRetryBlock).toBe(10);
    } finally {
      await buys.close();
      await db.sql.close();
    }
  });

  it('defers later payouts until missing older history is repaired, including across restart', async () => {
    const chain = chainHistory();
    const metadata = new Metadata(chain.registry, { metadata: { V16: chain.registry.metadata } });
    const storage = decorateStorage(chain.registry, metadata.asLatest, metadata.version);
    const olderKey = chain.registry.createType('StorageKey', [
      storage.stabilizerBuys.buysByAccountAndFrame,
      [chain.account, '0x0000000000000009'],
    ]);
    const olderPrincipal = chain.registry.createType('Option<PalletStabilizerBuysAccountFrameBuys>', {
      pendingLiquidRepays: 0n,
      liquidRepaymentRewardRate: null,
      principal: 100_000_000n,
      capturedDiscount: 40_000_000n,
      bidRate: 0,
      positiveBidCount: 0,
    });
    let olderIsHeld = true;
    const readCurrent = chain.rawApi.query.stabilizerBuys.buysByAccountAndFrame.entries;
    vi.spyOn(chain.rawApi.query.stabilizerBuys.buysByAccountAndFrame, 'entries').mockImplementation(async () => {
      const current = await readCurrent();
      if (!olderIsHeld) return current;
      return [[olderKey, olderPrincipal], ...current];
    });
    const addPurchase = (height: number, frame: number, nonce: bigint) => {
      chain.events.set(height, [
        eventRecord({
          section: 'stabilizerBuys',
          method: 'PurchaseRecorded',
          data: {
            account: chain.accountId,
            admissionFrame: frame,
            principal: 100_000_000n,
            matchingBasis: 20_000_000n,
          },
        }),
        eventRecord({
          ...chain.purchase,
          data: { ...chain.purchase.data, transfer: { ...chain.purchase.data.transfer, gatewayActivityNonce: nonce } },
        }),
      ]);
    };
    addPurchase(9, 9, 6n);
    const db = await createTestDb();
    let buys = new StabilizerBuys(chain.watch, chain.accountId, Promise.resolve(db));
    try {
      await buys.load();
      await buys.recoverHistory(10);
      expect(buys.data.buys).toHaveLength(2);

      chain.events.set(11, [
        eventRecord({
          section: 'stabilizerBuys',
          method: 'PayoutCompleted',
          data: { account: chain.accountId, principal: 200_000_000n, reward: 0n },
        }),
      ]);
      olderIsHeld = false;
      chain.advance(11, 100_000_000n, 0n);
      await buys.refresh(block(11));
      expect(buys.heldPrincipal).toBe(100_000_000n);
      expect(buys.data.buys.every(buy => buy.purchaseArgonReleaseBlockNumber === undefined)).toBe(true);

      chain.events.set(12, [
        eventRecord({
          section: 'stabilizerBuys',
          method: 'PayoutCompleted',
          data: { account: chain.accountId, principal: 100_000_000n, reward: 0n },
        }),
      ]);
      chain.advance(12, 0n, 0n);
      await buys.refresh(block(12));
      expect(buys.data.buys.every(buy => buy.purchaseArgonReleaseBlockNumber === undefined)).toBe(true);
      expect((await db.syncStateTable.get(SyncStateKeys.StabilizerBuys))?.payoutRetryBlock).toBe(11);

      await buys.close();
      buys = new StabilizerBuys(chain.watch, chain.accountId, Promise.resolve(db));
      await buys.load();
      expect(buys.snapshot.hasPendingHistoryGap).toBe(true);
      expect(buys.data.buys.every(buy => buy.purchaseArgonReleaseBlockNumber === undefined)).toBe(true);

      addPurchase(8, 0, 5n);
      await buys.recoverHistory(12);
      const saved = await db.stabilizerBuysTable.fetchAll(chain.accountId);
      expect(saved.buys.find(buy => buy.admissionFrame === 0)?.purchaseArgonReleaseBlockNumber).toBe(11);
      expect(saved.buys.find(buy => buy.admissionFrame === 9)?.purchaseArgonReleaseBlockNumber).toBe(11);
      expect(saved.buys.find(buy => buy.admissionFrame === 12)?.purchaseArgonReleaseBlockNumber).toBe(12);
      expect(saved.buys.every(buy => buy.status === StabilizerBuyStatus.Complete)).toBe(true);
      expect(buys.snapshot.hasPendingHistoryGap).toBe(false);
    } finally {
      await buys.close();
      await db.sql.close();
    }
  });

  it('keeps allocation unknown when a current held frame has no recovered purchase history', async () => {
    const chain = chainHistory();
    chain.advance(13, 100_000_000n, 0n);
    const db = await createTestDb();
    const buys = new StabilizerBuys(chain.watch, chain.accountId, Promise.resolve(db));
    try {
      await buys.load();
      await buys.refresh(block(13));
      expect(buys.data.buys).toEqual([]);
      expect(buys.heldPrincipal).toBe(100_000_000n);
      expect(buys.data.frameRewards[0].awardedReward).toBeUndefined();
      expect((await db.stabilizerBuysTable.fetchAll(chain.accountId)).frameRewards[0].awardedReward).toBeUndefined();
    } finally {
      await buys.close();
      await db.sql.close();
    }
  });

  it('resolves a zero award only after coherent history and native allocation completion', async () => {
    const chain = chainHistory();
    chain.events.delete(12);
    chain.events.set(14, [
      eventRecord({
        section: 'stabilizerBuys',
        method: 'PayoutCompleted',
        data: { account: chain.accountId, principal: 100_000_000n, reward: 0n },
      }),
    ]);
    chain.advance(14, 0n, 0n);
    const metadata = new Metadata(chain.registry, { metadata: { V16: chain.registry.metadata } });
    const storage = decorateStorage(chain.registry, metadata.asLatest, metadata.version);
    chain.maturingKeys.push(
      chain.registry.createType('StorageKey', [
        storage.stabilizerBuys.auctionAllocationQueue,
        [
          {
            ascendingRank: toHex(15, { size: 8 }),
            orderedId: toHex(12, { size: 8 }),
          },
        ],
      ]),
    );
    vi.spyOn(chain.rawApi.query.stabilizerBuys, 'auctions').mockImplementation(async () =>
      chain.registry.createType('Option<PalletStabilizerBuysAuction>', {
        matchingRate: 500_000,
        totalMatchingBasis: 200_000_000,
        budget: 40_000_000,
        remainingBudget: 0,
        remainingMatchingBasis: 0,
        maturesAtFrame: 42,
      }),
    );
    const db = await createTestDb();
    const buys = new StabilizerBuys(chain.watch, chain.accountId, Promise.resolve(db));
    try {
      await buys.load();
      await buys.recoverHistory(14);
      await buys.refresh(block(14));
      expect(buys.data.frameRewards[0]).toMatchObject({ requestedReward: 5_000_000n, paidReward: 0n });
      expect(buys.data.frameRewards[0].awardedReward).toBeUndefined();
      expect(createStabilizerBuyFinancialPositions(buys.snapshot)[0]).toMatchObject({
        lifecycle: 'held',
        endedAt: undefined,
      });

      chain.maturingKeys.length = 0;
      await buys.refresh(block(14));
      expect(buys.data.frameRewards[0]).toMatchObject({ awardedReward: 0n, maturesAtFrame: 42, paidReward: 0n });
      expect((await db.stabilizerBuysTable.fetchAll(chain.accountId)).frameRewards[0].awardedReward).toBe(0n);
      expect(buys.data.buys[0]).toMatchObject({ principal: 100_000_000n, purchaseArgonReleaseBlockNumber: 14 });
      expect(createStabilizerBuyFinancialPositions(buys.snapshot)[0]).toMatchObject({
        lifecycle: 'completed',
        endedAt: block(14).blockTime,
      });
    } finally {
      await buys.close();
      await db.sql.close();
    }
  });

  it('does not present a composite command fee as an exact purchase cost', async () => {
    const chain = chainHistory();
    chain.events.get(11)!.push(
      eventRecord({
        section: 'transactionPayment',
        method: 'TransactionFeePaid',
        data: {
          who: chain.accountId,
          actualFee: 300n,
          tip: 0n,
        },
      }),
    );
    const readBlock = chain.watch.getBlock.bind(chain.watch);
    vi.spyOn(chain.watch, 'getBlock').mockImplementation(async header => {
      if (header.blockNumber !== 11) return readBlock(header);
      const call = chain.calls.utility.batch([chain.calls.stabilizerBuys.bid(12, 25), chain.calls.system.remark('0x')]);
      return chain.registry.createType('SignedBlock', {
        block: {
          extrinsics: [
            chain.registry.createType('Extrinsic'),
            chain.registry.createType('Extrinsic', { method: call }),
          ],
        },
      });
    });
    const db = await createTestDb();
    const buys = new StabilizerBuys(chain.watch, chain.accountId, Promise.resolve(db));
    try {
      await buys.load();
      expect(buys.data.frameRewards[0].bidFees.every(fee => !fee.isAmbiguous)).toBe(true);
      await buys.recordPurchase(buys.data.buys[0].id, {
        ethereumTxHash: toHex(55, { size: 32 }),
        purchasedAt: new Date(block(10).blockTime),
        spentMicrogons: 90_000_000n,
        ethereumFeeMicrogons: 1_000_000n,
        usdcApprovalFeeMicrogons: 0n,
      });
      expect(createStabilizerBuyFinancialPositions(buys.snapshot)[0].investedCost).toBe(91_001_000n);
      await buys.recoverHistory(11);
      expect(buys.data.frameRewards[0].bidFees.some(fee => fee.isAmbiguous)).toBe(true);
      expect(buys.data.frameRewards[0].bidFees.at(-1)?.amount).toBe(300n);
      expect(createStabilizerBuyFinancialPositions(buys.snapshot)[0].investedCost).toBeUndefined();
    } finally {
      await buys.close();
      await db.sql.close();
    }
  });

  it('keeps imported returns incomplete until purchase costs are recorded, and preserves those costs across backfill and restart', async () => {
    const chain = chainHistory();
    const db = await createTestDb();
    const buys = new StabilizerBuys(chain.watch, chain.accountId, Promise.resolve(db));
    buys.data = reactive(buys.data) as StabilizerBuys['data'];
    const visibleReturn = computed(() => calculatePositionReturn(createStabilizerBuyFinancialPositions(buys.snapshot)));
    const visiblePrincipal = computed(() => createStabilizerBuyFinancialPositions(buys.snapshot)[0]?.currentValue);
    try {
      await buys.load();
      expect(visibleReturn.value.availability).toBe('unavailable');
      expect(visiblePrincipal.value).toBe(100_000_000n);
      await buys.recoverHistory(10);
      const purchase = buys.data.buys[0];
      expect(purchase.argonPurchaseEvent).toMatchObject({
        transfer: { amount: 100_000_000n },
        purchase: { usdcSpent: 90_000_000n },
        purchaseTick: 10,
      });
      expect(purchase).toMatchObject({
        admissionFrame: 12,
        principal: 100_000_000n,
        matchingBasis: 20_000_000n,
        purchaseArgonRecognitionBlockNumber: 10,
        purchaseArgonRecognitionBlockHash: block(10).blockHash,
        purchaseArgonRecognitionBlockTime: new Date(block(10).blockTime),
        purchaseArgonRecognitionEventIndex: 1,
      });
      expect(purchase.spentMicrogons).toBeUndefined();
      expect(visiblePrincipal.value).toBe(100_000_000n);
      expect(visibleReturn.value.availability).toBe('unavailable');

      const recordedCost = {
        ethereumTxHash: toHex(55, { size: 32 }),
        purchasedAt: new Date(block(10).blockTime),
        spentMicrogons: 44_100_000n,
        ethereumFeeMicrogons: 0n,
      };
      await buys.recordPurchase(purchase.id, recordedCost);
      await buys.recoverHistory(10);
      expect(buys.data.buys[0]).toMatchObject(recordedCost);
      expect(visibleReturn.value.availability).toBe('unavailable');

      // The purchase command supplies its separately attributable approval cost.
      const completeCost = { ...recordedCost, ethereumFeeMicrogons: 21_000n, usdcApprovalFeeMicrogons: 3_000n };
      const execute = db.sql.execute.bind(db.sql);
      let failed = false;
      const write = vi.spyOn(db.sql, 'execute').mockImplementation(async (query, params) => {
        const result = await execute(query, params);
        if (query.includes('INSERT INTO StabilizerBuys') && !failed) {
          failed = true;
          throw new Error('Interrupted purchase cost publication');
        }
        return result;
      });
      await expect(buys.recordPurchase(purchase.id, completeCost)).rejects.toThrow('Interrupted');
      expect(visibleReturn.value.availability).toBe('unavailable');
      expect((await db.stabilizerBuysTable.fetchAll(chain.accountId)).buys[0].usdcApprovalFeeMicrogons).toBeUndefined();
      write.mockRestore();
      await buys.recordPurchase(purchase.id, completeCost);
      expect(visibleReturn.value.availability).toBe('available');
      const [position] = createStabilizerBuyFinancialPositions(buys.snapshot);
      expect(position).toMatchObject({
        currentValue: 100_000_000n,
        investedCost: 44_125_000n,
        returnIsComplete: true,
        paidIncome: 0n,
      });
      expect(calculatePositionReturn([position]).returnAmount).toBe(55_875_000n);
      const wallet = new WalletForArgon('argon', chain.accountId, Promise.resolve(db));
      const account: IArgonAccountBalance = {
        address: chain.accountId,
        wallet,
        availableMicrogons: 10_000_000n,
        availableMicronots: 0n,
        reservedMicrogons: 100_000_000n,
        reservedMicronots: 0n,
        microgonHolds: [{ id: { type: 'StabilizerBuys', value: { type: 'PurchasePrincipal' } }, amount: 100_000_000n }],
        micronotHolds: [],
      };
      const walletPositions = new WalletFinancials({} as never).createFinancialPositions({
        accounts: [account],
        claimedHolds: { treasury: false, vaults: false, miningSlot: false, stabilizerBuys: true },
        liveArgonotRateMicrogons: 0n,
        holdingBasis: { activeLotsByAccount: new Map(), completedPositions: [], incompleteAccounts: new Set() },
      });
      expect(
        walletPositions.reduce((sum, entry) => sum + (entry.currentValue ?? 0n), 0n) + position.currentValue!,
      ).toBe(110_000_000n);
      chain.advance(12, 100_000_000n, 5_000_000n);
      await expect(buys.readAccountSnapshot(account, block(12))).rejects.toThrow('finalized');
      await buys.refresh(block(12));
      await buys.recoverHistory(12);
      const snapshot = (await buys.readAccountSnapshot(account, block(12)))!;
      expect(createStabilizerBuyFinancialPositions(snapshot)[0].currentValue).toBe(105_000_000n);
      chain.events.set(13, [
        eventRecord({
          section: 'transactionPayment',
          method: 'TransactionFeePaid',
          data: {
            who: chain.accountId,
            actualFee: 2_500n,
            tip: 0n,
          },
        }),
      ]);
      chain.advance(13, 100_000_000n, 5_000_000n);
      await buys.refresh(block(13));
      await buys.recoverHistory(13);
      expect(createStabilizerBuyFinancialPositions(buys.snapshot)[0].investedCost).toBe(44_127_500n);
      expect(createStabilizerBuyFinancialPositions(snapshot)[0].investedCost).toBe(44_125_000n);
      const saved = await db.stabilizerBuysTable.fetchAll(chain.accountId);
      expect(saved.buys[0].argonFees).toEqual([
        expect.objectContaining({ amount: 1_000n, blockNumber: 10, eventIndex: 2 }),
      ]);
      expect(saved.frameRewards[0].bidFees).toEqual([
        expect.objectContaining({ amount: 2_500n, blockNumber: 13, eventIndex: 0 }),
      ]);
      await buys.close();
      const restarted = new StabilizerBuys(chain.watch, chain.accountId, Promise.resolve(db));
      try {
        await restarted.load();
        expect(createStabilizerBuyFinancialPositions(restarted.snapshot)[0]).toMatchObject({
          investedCost: 44_127_500n,
          returnIsComplete: true,
          currentValue: 105_000_000n,
        });
      } finally {
        await restarted.close();
      }
    } finally {
      await buys.close();
      await db.sql.close();
    }
  });

  it.each(['ineligible', 'admission failure'])('keeps %s as completed direct credit across restart', async producer => {
    const chain = chainHistory();
    chain.events.clear();
    chain.events.set(10, [
      eventRecord(
        producer === 'admission failure'
          ? {
              section: 'crosschainTransfer',
              method: 'UniswapPurchaseAdmissionFailed',
              data: {
                sourceChain: { type: 'Ethereum' },
                gatewayActivityNonce: 7n,
                account: chain.accountId,
                error: { type: 'Unavailable' },
              },
            }
          : {
              section: 'stabilizerBuys',
              method: 'PurchaseIneligible',
              data: { account: chain.accountId, purchaseTick: 10, reason: { type: 'NoDiscount' } },
            },
      ),
      eventRecord(chain.purchase),
    ]);
    chain.advance(10, 0n, 0n);
    const db = await createTestDb();
    let buys = new StabilizerBuys(chain.watch, chain.accountId, Promise.resolve(db));
    try {
      await buys.load();
      await buys.recordPurchase(buys.data.buys[0].id, {
        ethereumTxHash: toHex(55, { size: 32 }),
        purchasedAt: new Date(block(10).blockTime),
        spentMicrogons: 90_000_000n,
        ethereumFeeMicrogons: 1_000n,
        usdcApprovalFeeMicrogons: 0n,
      });
      await buys.close();
      buys = new StabilizerBuys(chain.watch, chain.accountId, Promise.resolve(db));
      await buys.load();
      expect(buys.data.buys[0]).toMatchObject({
        status: StabilizerBuyStatus.Complete,
        purchaseArgonRecognitionBlockNumber: 10,
        purchaseArgonRecognitionBlockTime: new Date(block(10).blockTime),
      });
      if (producer === 'ineligible') expect(buys.data.buys[0].ineligibleReason).toBe('NoDiscount');
      else
        expect(buys.data.buys[0].purchaseAdmissionFailure).toMatchObject({
          gatewayActivityNonce: 7n,
          error: { type: 'Unavailable' },
        });
      expect(buys.data.buys[0].admissionFrame).toBeUndefined();
      expect(buys.data.buys[0].purchaseArgonReleaseBlockNumber).toBeUndefined();
      expect(buys.data.frameRewards).toEqual([]);
      expect(createStabilizerBuyFinancialPositions(buys.snapshot)[0]).toMatchObject({
        lifecycle: 'completed',
        currentValue: 0n,
        settledPrincipalValue: 100_000_000n,
        investedCost: 90_001_000n,
        returnIsComplete: true,
        endedAt: block(10).blockTime,
      });
    } finally {
      await buys.close();
      await db.sql.close();
    }
  });

  it.each([
    {
      name: 'mixed refund',
      burned: 60_000_000n,
      ordinary: 50_000_000n,
      refund: 40_000_000n,
      bonus: 5_000_000n,
      award: 5_000_000n,
      paidAward: 5_000_000n,
      hasPayout: true,
    },
    {
      name: 'full repayment without a wallet payout',
      burned: 100_000_000n,
      ordinary: 0n,
      refund: 0n,
      bonus: 0n,
      award: 0n,
      paidAward: 0n,
      hasPayout: false,
    },
    {
      name: 'unreceivable ordinary reward',
      burned: 99_999_999n,
      ordinary: 0n,
      refund: 0n,
      bonus: 0n,
      award: 1n,
      paidAward: 0n,
      hasPayout: true,
    },
    {
      name: 'unreceivable refund dust',
      burned: 99_999_999n,
      ordinary: 0n,
      refund: 0n,
      bonus: 0n,
      award: 0n,
      paidAward: 0n,
      hasPayout: true,
    },
  ])('reconciles $name as repayment capital, wallet refunds and actual rewards across restart', async scenario => {
    const chain = chainHistory();
    const purchase = {
      ...chain.purchase,
      data: { ...chain.purchase.data, purchase: { ...chain.purchase.data.purchase, repayLiquidId: 3 } },
    };
    chain.events.set(10, [chain.events.get(10)![0], eventRecord(purchase)]);
    chain.events.set(11, []);
    if (scenario.ordinary > 0n) {
      chain.events.get(11)!.push(
        eventRecord({
          section: 'stabilizerBuys',
          method: 'PurchaseRecorded',
          data: {
            account: chain.accountId,
            admissionFrame: 12,
            principal: scenario.ordinary,
            matchingBasis: 10_000_000n,
          },
        }),
        eventRecord({
          ...chain.purchase,
          data: {
            ...chain.purchase.data,
            transfer: { ...chain.purchase.data.transfer, gatewayActivityNonce: 8n, amount: scenario.ordinary },
          },
        }),
      );
    }
    chain.events.set(12, []);
    if (scenario.award > 0n)
      chain.events.get(12)!.push(
        eventRecord({
          section: 'stabilizerBuys',
          method: 'RewardAwarded',
          data: {
            account: chain.accountId,
            admissionFrame: 12,
            amount: scenario.award,
            maturesAtFrame: 42,
          },
        }),
      );
    chain.events.delete(13);
    const settlement: RuntimeSystemEventRecord[] = [
      eventRecord({
        section: 'stabilizerBuys',
        method: 'LiquidRepaymentCompleted',
        data: {
          account: chain.accountId,
          gatewayActivityNonce: 7n,
          liquidId: 3,
          microgonsBurned: scenario.burned,
        },
      }),
    ];
    if (scenario.bonus > 0n)
      settlement.push(
        eventRecord({
          section: 'stabilizerBuys',
          method: 'LiquidRepaymentRewardAwarded',
          data: {
            account: chain.accountId,
            admissionFrame: 12,
            amount: scenario.bonus,
          },
        }),
      );
    if (scenario.hasPayout)
      settlement.push(
        eventRecord({
          section: 'stabilizerBuys',
          method: 'PayoutCompleted',
          data: {
            account: chain.accountId,
            principal: scenario.ordinary + scenario.refund,
            reward: scenario.paidAward + scenario.bonus,
          },
        }),
      );
    chain.events.set(14, settlement);
    chain.liquidRepayments.set(
      7n,
      chain.registry.createType('PalletStabilizerBuysLiquidRepay', {
        liquidId: 3,
        admissionFrame: 12,
        microgons: 100_000_000n,
        purchaseTick: 10,
      }),
    );
    chain.advance(11, scenario.ordinary, 0n);
    const db = await createTestDb();
    let buys = new StabilizerBuys(chain.watch, chain.accountId, Promise.resolve(db));
    try {
      await buys.load();
      await buys.recoverHistory(11);
      for (const buy of buys.data.buys) {
        await buys.recordPurchase(buy.id, {
          ethereumTxHash: toHex(buy.id.endsWith(':7') ? 55 : 56, { size: 32 }),
          purchasedAt: new Date(block(10).blockTime),
          spentMicrogons: buy.repayLiquidId === 3 ? 90_000_000n : 45_000_000n,
          ethereumFeeMicrogons: 0n,
          usdcApprovalFeeMicrogons: 0n,
        });
      }
      expect(buys.heldPrincipal).toBe(100_000_000n + scenario.ordinary);
      expect(createStabilizerBuyFinancialPositions(buys.snapshot)[0].currentValue).toBe(
        100_000_000n + scenario.ordinary,
      );

      chain.advance(12, scenario.ordinary, scenario.award);
      await buys.refresh(block(12));
      chain.liquidRepayments.clear();
      chain.advance(14, 0n, 0n);
      await buys.refresh(block(14));
      await buys.refresh(block(14));
      await buys.close();
      buys = new StabilizerBuys(chain.watch, chain.accountId, Promise.resolve(db));
      await buys.load();
      await buys.recoverHistory(14);

      expect(buys.data.buys.every(buy => buy.status === StabilizerBuyStatus.Complete)).toBe(true);
      const repaid = buys.data.buys.find(buy => buy.repayLiquidId === 3)!;
      expect(repaid.liquidRepaymentEvent?.microgonsBurned).toBe(scenario.burned);
      expect(repaid.releasedPrincipal ?? 0n).toBe(scenario.refund);
      const position = createStabilizerBuyFinancialPositions(buys.snapshot)[0];
      expect(position).toMatchObject({
        currentValue: 0n,
        paidIncome: scenario.paidAward + scenario.bonus,
        settledPrincipalValue: scenario.ordinary + scenario.refund + scenario.burned,
        returnIsComplete: true,
        lifecycle: 'completed',
      });
      expect(buys.data.frameRewards[0].repaymentRewards?.length ?? 0).toBe(scenario.bonus > 0n ? 1 : 0);
      if (!scenario.hasPayout) expect(repaid.purchaseArgonReleaseBlockNumber).toBeUndefined();
    } finally {
      await buys.close();
      await db.sql.close();
    }
  });

  it('retains purchases, bids, awards and payouts across restart; principal is never reward income', async () => {
    const chain = chainHistory();
    const secondPurchase = {
      ...chain.purchase,
      data: {
        ...chain.purchase.data,
        transfer: { ...chain.purchase.data.transfer, gatewayActivityNonce: 8n, amount: 50_000_000n },
        purchaseTick: 11,
        purchase: { ...chain.purchase.data.purchase, usdcSpent: 45_000_000n, argonBought: 50n * 10n ** 18n },
      },
    };
    chain.events.get(11)!.push(
      eventRecord({
        section: 'stabilizerBuys',
        method: 'PurchaseRecorded',
        data: { account: chain.accountId, admissionFrame: 12, principal: 50_000_000n, matchingBasis: 10_000_000n },
      }),
      eventRecord(secondPurchase),
    );
    chain.events.set(14, [
      eventRecord({
        section: 'stabilizerBuys',
        method: 'PayoutCompleted',
        data: { account: chain.accountId, principal: 150_000_000n, reward: 5_000_000n },
      }),
    ]);
    const db = await createTestDb();
    let buys = new StabilizerBuys(chain.watch, chain.accountId, Promise.resolve(db));
    try {
      await buys.load();
      await buys.recoverHistory(11);
      chain.nativePurchase.capturedDiscount = 60_000_000n;
      chain.advance(12, 150_000_000n, 5_000_000n);
      await buys.refresh(block(12));
      await buys.refresh(block(12));
      expect(createStabilizerBuyFinancialPositions(buys.snapshot)[0]).toMatchObject({
        currentValue: 155_000_000n,
        paidIncome: 0n,
      });
      chain.advance(13, 150_000_000n, 5_000_000n);
      await buys.refresh(block(13));
      expect(createStabilizerBuyFinancialPositions(buys.snapshot)[0].settledPrincipalValue).toBe(0n);
      chain.advance(14, 0n, 0n);
      await buys.refresh(block(14));
      expect(createStabilizerBuyFinancialPositions(buys.snapshot)[0]).toMatchObject({
        settledPrincipalValue: 150_000_000n,
        paidIncome: 5_000_000n,
        currentValue: 0n,
      });
      await buys.close();
      buys = new StabilizerBuys(chain.watch, chain.accountId, Promise.resolve(db));
      await buys.load();
      const positions = createStabilizerBuyFinancialPositions(buys.snapshot);
      expect(positions[0]).toMatchObject({
        currentValue: 0n,
        settledPrincipalValue: 150_000_000n,
        paidIncome: 5_000_000n,
        lifecycle: 'completed',
        returnIsComplete: false,
      });
      expect(buys.data.frameRewards[0].latestBid).toBe(25);
      expect(calculatePositionReturn(positions).availability).toBe('unavailable');
      const saved = await db.stabilizerBuysTable.fetchAll(chain.accountId);
      expect(saved.buys).toHaveLength(2);
      expect(saved.frameRewards).toHaveLength(1);
      expect(saved.buys.every(buy => buy.purchaseArgonReleaseBlockNumber === 14)).toBe(true);
      expect(saved.frameRewards[0].paidReward).toBe(5_000_000n);
      expect(saved.frameRewards[0].payout?.blockNumber).toBe(14);
      await buys.recordPurchase(
        buys.data.buys.find(buy => buy.argonPurchaseEvent?.transfer.gatewayActivityNonce === 7n)!.id,
        {
          ethereumTxHash: `0x${'55'.repeat(32)}`,
          purchasedAt: new Date(block(10).blockTime),
          spentMicrogons: 90_000_000n,
          ethereumFeeMicrogons: 1_000_000n,
          usdcApprovalFeeMicrogons: 0n,
        },
      );
      await buys.recordPurchase(
        buys.data.buys.find(buy => buy.argonPurchaseEvent?.transfer.gatewayActivityNonce === 8n)!.id,
        {
          ethereumTxHash: toHex(56, { size: 32 }),
          purchasedAt: new Date(block(11).blockTime),
          spentMicrogons: 45_000_000n,
          ethereumFeeMicrogons: 0n,
          usdcApprovalFeeMicrogons: 0n,
        },
      );
      const completed = createStabilizerBuyFinancialPositions(buys.snapshot);
      expect(completed).toHaveLength(1);
      expect(completed[0]).toMatchObject({
        startedAt: block(10).blockTime,
        investedCost: 136_001_000n,
        paidIncome: 5_000_000n,
      });
      expect(completed[0].capitalFlows).toHaveLength(3);
      expect(calculatePositionReturn(completed)).toMatchObject({
        availability: 'available',
        returnAmount: 18_999_000n,
      });
      const importedDb = await createTestDb();
      const imported = new StabilizerBuys(chain.watch, chain.accountId, Promise.resolve(importedDb));
      try {
        await imported.load();
        await imported.recoverHistory(14);
        expect(imported.data.frameRewards[0]).toMatchObject({
          bidCount: 1,
          latestBid: 25,
          requestedReward: 7_500_000n,
          awardedReward: 5_000_000n,
          paidReward: 5_000_000n,
        });
      } finally {
        await imported.close();
        await importedDb.sql.close();
      }
    } finally {
      await buys.close();
      await db.sql.close();
    }
  });

  it('preserves mounted history on failed backfill and merges an older replay with a newer live payout atomically', async () => {
    const chain = chainHistory();
    const db = await createTestDb();
    const buys = new StabilizerBuys(chain.watch, chain.accountId, Promise.resolve(db));
    buys.data = reactive(buys.data) as StabilizerBuys['data'];
    const paidIncome = computed(() => createStabilizerBuyFinancialPositions(buys.snapshot)[0]?.paidIncome);
    try {
      await buys.load();
      await buys.recoverHistory(11);
      const partialCost = {
        ethereumTxHash: toHex(55, { size: 32 }),
        purchasedAt: new Date(block(10).blockTime),
        spentMicrogons: 90_000_000n,
        ethereumFeeMicrogons: 1_000_000n,
      };
      await buys.recordPurchase(buys.data.buys[0].id, partialCost);
      const savedBefore = await db.stabilizerBuysTable.fetchAll(chain.accountId);
      expect(paidIncome.value).toBe(0n);
      const execute = db.sql.execute.bind(db.sql);
      let interrupted = false;
      const write = vi.spyOn(db.sql, 'execute').mockImplementation(async (query, params) => {
        const result = await execute(query, params);
        if (!interrupted && query.includes('INSERT INTO SyncState') && params?.[0] === SyncStateKeys.StabilizerBuys) {
          interrupted = true;
          throw new Error('Interrupted history checkpoint');
        }
        return result;
      });
      await expect(buys.recoverHistory(12)).rejects.toThrow('Interrupted history checkpoint');
      expect(await db.stabilizerBuysTable.fetchAll(chain.accountId)).toEqual(savedBefore);
      expect(buys.data.frameRewards[0].rewardAward).toBeUndefined();
      expect((await db.syncStateTable.get(SyncStateKeys.StabilizerBuys))?.throughBlock).toBe(11);
      expect(paidIncome.value).toBe(0n);
      expect(buys.data.historyError).toContain('Interrupted history checkpoint');
      write.mockRestore();
      let release!: () => void;
      const barrier = new Promise<void>(resolve => {
        release = resolve;
      });
      const read = chain.watch.getEventsWithSpec.bind(chain.watch);
      vi.spyOn(chain.watch, 'getEventsWithSpec').mockImplementation(async header => {
        await barrier;
        return read(header);
      });
      const recovering = buys.recoverHistory(12);
      await vi.waitFor(() => expect(buys.data.isRestoringHistory).toBe(true));
      const quote = {
        chainId: 1,
        gatewayAddress: gateway,
        adapterAddress: gateway,
        quoterAddress: gateway,
        sourceAddress: buyer,
        poolId,
        poolManager: gateway,
        usdcToken: token,
        poolKey: { currency0: token, currency1: gateway, fee: 0, tickSpacing: 60, hooks: gateway },
        request: {
          repayLiquidId: 0n,
          repaySignature: '0x' as const,
          argonAccountId: toArgonAccountIdHex(chain.accountId),
          maxUsdcIn: 90_000_000n,
          minMicrogonsOut: 100_000_000n,
          deadline: 2_000_000_000n,
        },
        quotedMicrogonsOut: 100_000_000n,
        sqrtPriceX96After: 2n,
        swapGasEstimate: 100_000n,
        minimumRewardPrincipal: 1_000_000n,
        qualifiesForRewards: true,
      };
      await buys.createPurchase({ id: 'pending-local-buy', ethereumQuote: quote, ethereumMaxFeeWei: 100n });
      await buys.recordPurchase('pending-local-buy', {
        status: StabilizerBuyStatus.ConfirmingPurchaseOnEthereum,
        ethereumTxHash: toHex(55, { size: 32 }),
      });
      await buys.recordPurchase('pending-local-buy', {
        status: StabilizerBuyStatus.WaitingForArgonRecognition,
        ethereumConfirmedAt: new Date(block(10).blockTime),
        ethereumGatewayActivity: {
          token,
          amount: 100_000_000n,
          purchase: {
            ...chain.purchase.data.purchase,
            repayLiquidId: 0n,
            repaySignature: '0x',
            usdcToken: token,
            poolManager: gateway,
            poolId,
            timestamp: 10n,
            buyer,
            argonAccountId: quote.request.argonAccountId,
          },
          gatewayState: {
            gatewayActivityNonce: 7n,
            argonApprovalsNonce: 1n,
            argonCirculation: 0n,
            argonotCirculation: 0n,
          },
        },
      });
      expect(buys.data.buys).toHaveLength(1);
      expect(buys.data.buys[0]).toMatchObject({
        id: 'pending-local-buy',
        spentMicrogons: partialCost.spentMicrogons,
        ethereumFeeMicrogons: partialCost.ethereumFeeMicrogons,
        ethereumQuote: quote,
        argonPurchaseEvent: chain.purchase.data,
      });
      chain.advance(12, 100_000_000n, 5_000_000n);
      await buys.refresh(block(12));
      chain.events.set(13, [
        eventRecord({
          section: 'stabilizerBuys',
          method: 'BidSubmitted',
          data: { account: chain.accountId, admissionFrame: 12, rewardRate: BigNumber(0.3), positiveBidCount: 2 },
        }),
      ]);
      chain.advance(13, 100_000_000n, 5_000_000n);
      await buys.refresh(block(13));
      chain.advance(14, 0n, 0n);
      await buys.refresh(block(14));
      expect(paidIncome.value).toBe(5_000_000n);
      release();
      await recovering;
      expect(buys.data.blockNumber).toBe(14);
      expect(buys.heldPrincipal).toBe(0n);
      expect(paidIncome.value).toBe(5_000_000n);
      expect(buys.data.isRestoringHistory).toBe(false);
      expect(buys.data.historyError).toBeUndefined();
      expect(buys.data.frameRewards[0].latestBid).toBe(30);
      const saved = await db.stabilizerBuysTable.fetchAll(chain.accountId);
      expect(saved.buys).toHaveLength(1);
      expect(saved.buys[0]).toMatchObject({
        id: 'pending-local-buy',
        spentMicrogons: partialCost.spentMicrogons,
        ethereumFeeMicrogons: partialCost.ethereumFeeMicrogons,
        ethereumTxHash: toHex(55, { size: 32 }),
      });
    } finally {
      await buys.close();
      await db.sql.close();
    }
  });

  it.each(['live', 'restart'])('observes a relayed local buy and payout: %s', async mode => {
    const chain = chainHistory();
    chain.advance(mode === 'live' ? 9 : 20, 0n, 0n);
    const db = await createTestDb();
    let buys = new StabilizerBuys(chain.watch, chain.accountId, Promise.resolve(db));
    const quote = {
      chainId: 1,
      gatewayAddress: gateway,
      adapterAddress: gateway,
      quoterAddress: gateway,
      sourceAddress: buyer,
      poolId,
      poolManager: gateway,
      usdcToken: token,
      poolKey: { currency0: token, currency1: gateway, fee: 0, tickSpacing: 60, hooks: gateway },
      request: {
        repayLiquidId: 0n,
        repaySignature: '0x' as const,
        argonAccountId: toArgonAccountIdHex(chain.accountId),
        maxUsdcIn: 90_000_000n,
        minMicrogonsOut: 100_000_000n,
        deadline: 2_000_000_000n,
      },
      quotedMicrogonsOut: 100_000_000n,
      sqrtPriceX96After: 2n,
      swapGasEstimate: 100_000n,
      minimumRewardPrincipal: 1_000_000n,
      qualifiesForRewards: true,
    };
    try {
      await buys.createPurchase({ id: 'cold-local-buy', ethereumQuote: quote, ethereumMaxFeeWei: 100n });
      await buys.recordPurchase('cold-local-buy', {
        status: StabilizerBuyStatus.WaitingForArgonRecognition,
        ethereumTxHash: toHex(55, { size: 32 }),
        spentMicrogons: 90_000_000n,
        ethereumFeeMicrogons: 100n,
        usdcApprovalFeeMicrogons: 0n,
        purchaseEthereumBlockNumber: 5_000,
        ethereumConfirmedAt: new Date(block(9).blockTime),
        ethereumGatewayActivity: {
          token,
          amount: 100_000_000n,
          purchase: {
            ...chain.purchase.data.purchase,
            repayLiquidId: 0n,
            repaySignature: '0x',
            usdcToken: token,
            poolManager: gateway,
            poolId,
            timestamp: 10n,
            buyer,
            argonAccountId: quote.request.argonAccountId,
          },
          gatewayState: {
            gatewayActivityNonce: 7n,
            argonApprovalsNonce: 1n,
            argonCirculation: 0n,
            argonotCirculation: 0n,
          },
        },
      });

      if (mode === 'restart') {
        await buys.close();
        buys = new StabilizerBuys(chain.watch, chain.accountId, Promise.resolve(db));
      }
      buys.data = reactive(buys.data) as StabilizerBuys['data'];
      const visibleStatus = computed(() => buys.data.buys.find(buy => buy.id === 'cold-local-buy')?.status);
      const visibleProgress = computed(() =>
        StabilizerBuyPurchases.getProgress(buys.data.buys[0], {}, buys.data.ethereumGatewaySync),
      );

      let anchor = 1_000n;
      let proofIncluded = false;
      let anchorUnavailable = false;
      Object.assign(chain.rawApi.query, {
        ethereumVerifier: {
          latestExecutionHeaderAnchorBlockHash: async () => toHex(1, { size: 32 }),
          executionHeaderAnchors: async () => {
            if (anchorUnavailable) throw new Error('Ethereum anchor RPC unavailable');
            return { blockNumber: anchor };
          },
        },
      });
      const bestApi = runtimeClient({
        ...chain.rawApi,
        query: {
          ...chain.rawApi.query,
          crosschainTransfer: {
            gatewayStateBySourceChain: async () => ({ gatewayActivityNonce: proofIncluded ? 7n : 0n }),
          },
        },
      });
      vi.spyOn(chain.watch, 'getApi').mockImplementation(async header => {
        const api = header?.blockNumber === 99 ? bestApi : chain.api;
        return api as unknown as Awaited<ReturnType<BlockWatch['getApi']>>;
      });
      Object.defineProperty(chain.watch, 'bestBlockHeader', { get: () => block(99) });
      await buys.load();

      if (mode === 'live') {
        expect(visibleStatus.value).toBe(StabilizerBuyStatus.WaitingForArgonRecognition);
        expect(visibleProgress.value.currentStep).toBe(2);
        expect(visibleProgress.value.totalSteps).toBe(3);
        expect(visibleProgress.value.currentStepDetail).toBe('Waiting for Argon proof of 4,000 Ethereum blocks');
        expect(visibleProgress.value.overallProgressPct).toBeCloseTo(100 / 3);
        const clock = vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 600_000);
        expect(
          StabilizerBuyPurchases.getProgress(buys.data.buys[0], {}, buys.data.ethereumGatewaySync).overallProgressPct,
        ).toBeCloseTo(100 / 3);
        clock.mockRestore();

        anchorUnavailable = true;
        await buys.refresh(block(9));
        expect(visibleProgress.value.currentStepDetail).toBe('Waiting for Argon proof of 4,000 Ethereum blocks');
        anchorUnavailable = false;

        // A best-chain proof can include newer headers than the finalized snapshot.
        proofIncluded = true;
        await buys.refresh(block(9));
        expect(visibleProgress.value.currentStep).toBe(3);
        expect(visibleProgress.value.overallProgressPct).toBeCloseTo(200 / 3);
        expect(visibleStatus.value).toBe(StabilizerBuyStatus.WaitingForArgonRecognition);

        // Best-chain proof evidence can disappear; it cannot establish durable completion.
        proofIncluded = false;
        await buys.refresh(block(9));
        expect(visibleProgress.value.currentStep).toBe(2);

        anchor = 5_000n;
        await buys.refresh(block(9));
        expect(visibleProgress.value.currentStepDetail).toBe('Waiting for the gateway proof on Argon.');

        chain.advance(10, 100_000_000n, 0n);
        chain.watch.events.emit('finalized', [block(10)]);
        await vi.waitFor(() => expect(visibleStatus.value).toBe(StabilizerBuyStatus.WaitingForPrincipalReleaseOnArgon));
        expect(visibleProgress.value.overallProgressPct).toBe(100);

        chain.advance(12, 100_000_000n, 5_000_000n);
        chain.watch.events.emit('finalized', [block(12)]);
        await vi.waitFor(() => expect(buys.data.blockNumber).toBe(12));

        chain.advance(14, 0n, 0n);
        chain.watch.events.emit('finalized', [block(14)]);
      }
      await vi.waitFor(() => expect(visibleStatus.value).toBe(StabilizerBuyStatus.Complete), { timeout: 3000 });
      expect(buys.data.buys).toHaveLength(1);
      expect(buys.data.buys[0]).toMatchObject({ principal: 100_000_000n, purchaseArgonReleaseBlockNumber: 14 });
      expect((await db.stabilizerBuysTable.fetchAll(chain.accountId)).buys[0]).toMatchObject({
        status: StabilizerBuyStatus.Complete,
        ethereumTxHash: toHex(55, { size: 32 }),
        spentMicrogons: 90_000_000n,
        ethereumFeeMicrogons: 100n,
        argonPurchaseEvent: chain.purchase.data,
        purchaseArgonRecognitionBlockNumber: 10,
        purchaseArgonRecognitionBlockHash: block(10).blockHash,
        purchaseArgonRecognitionBlockTime: new Date(block(10).blockTime),
        purchaseArgonRecognitionEventIndex: 1,
        purchaseArgonReleaseBlockNumber: 14,
        purchaseArgonReleaseBlockHash: block(14).blockHash,
        purchaseArgonReleaseBlockTime: new Date(block(14).blockTime),
        purchaseArgonReleaseEventIndex: 0,
      });
      expect(
        await db.sql.select(
          'SELECT principal, purchaseArgonRecognitionBlockNumber, purchaseArgonRecognitionEventIndex, purchaseArgonReleaseBlockNumber, purchaseArgonReleaseEventIndex FROM StabilizerBuys',
        ),
      ).toEqual([
        {
          principal: '100000000',
          purchaseArgonRecognitionBlockNumber: 10,
          purchaseArgonRecognitionEventIndex: 1,
          purchaseArgonReleaseBlockNumber: 14,
          purchaseArgonReleaseEventIndex: 0,
        },
      ]);
      expect(await db.transactionsTable.fetchAll()).toEqual([]);
      expect(buys.data.frameRewards[0].paidReward).toBe(5_000_000n);
    } finally {
      await buys.close();
      await db.sql.close();
    }
  });
});

function chainHistory() {
  const registry = getOfflineRegistry();
  const metadata = new Metadata(registry, { metadata: { V16: registry.metadata } });
  const storage = decorateStorage(registry, metadata.asLatest, metadata.version);
  const calls = decorateExtrinsics(registry, metadata.asLatest, metadata.version);
  const account = registry.createType('AccountId32', new Uint8Array(32).fill(17));
  const accountId = account.toString();
  const key = registry.createType('StorageKey', [
    storage.stabilizerBuys.buysByAccountAndFrame,
    [account, '0x000000000000000c'],
  ]);
  const maturingKeys: (typeof key)[] = [];
  const nativePurchase = { capturedDiscount: 40_000_000n };
  const liquidRepayments = new Map<bigint, ReturnType<typeof registry.createType>>();

  let principal = 100_000_000n;
  let payableReward = 0n;
  let bidPercent = 25;
  let bidCount = 1;
  let competingBasis = 0n;
  let head = block(10);
  let marketPrice: BigNumber | undefined;
  let biddingOpen = false;
  const purchase: Extract<HistoricalEvent, { method: 'TransferToArgonFromSwapSettled' }> = {
    section: 'crosschainTransfer',
    method: 'TransferToArgonFromSwapSettled',
    data: {
      sourceChain: { type: 'Ethereum' },
      transfer: {
        gatewayActivityNonce: 7n,
        from: buyer,
        asset: { type: 'Argon' },
        to: accountId,
        amount: 100_000_000n,
      },
      purchaseTick: 10,
      purchase: {
        repayLiquidId: null,
        repaySignature: new Uint8Array(),
        usdcToken: token,
        usdcSpent: 90_000_000n,
        argonBought: 100n * 10n ** 18n,
        poolManager: gateway,
        poolId,
        sqrtPriceBeforeX96: 1n,
        sqrtPriceAfterX96: 2n,
      },
    },
  };
  const events = new Map<number, RuntimeSystemEventRecord[]>([
    [
      10,
      [
        eventRecord({
          section: 'stabilizerBuys',
          method: 'PurchaseRecorded',
          data: {
            account: accountId,
            admissionFrame: 12,
            principal,
            matchingBasis: 20_000_000n,
          },
        }),
        eventRecord(purchase),
        eventRecord({
          section: 'transactionPayment',
          method: 'TransactionFeePaid',
          data: { who: accountId, actualFee: 1_000n, tip: 0n },
        }),
      ],
    ],
    [
      11,
      [
        eventRecord({
          section: 'stabilizerBuys',
          method: 'BidSubmitted',
          data: {
            account: accountId,
            admissionFrame: 12,
            rewardRate: BigNumber(0.25),
            positiveBidCount: 1,
          },
        }),
      ],
    ],
    [
      12,
      [
        eventRecord({
          section: 'stabilizerBuys',
          method: 'RewardAwarded',
          data: {
            account: accountId,
            admissionFrame: 12,
            amount: 5_000_000n,
            maturesAtFrame: 42,
          },
        }),
      ],
    ],
    [
      13,
      [
        eventRecord({
          section: 'stabilizerBuys',
          method: 'PayoutFailed',
          data: { account: accountId, error: { type: 'Unavailable' } },
        }),
      ],
    ],
    [
      14,
      [
        eventRecord({
          section: 'stabilizerBuys',
          method: 'PayoutCompleted',
          data: { account: accountId, principal, reward: 5_000_000n },
        }),
      ],
    ],
  ]);
  const rawApi = {
    registry,
    consts: {
      bitcoinLocks: { argonTicksPerDay: registry.createType('u64', 1440) },
      priceIndex: { maxDowntimeTicksBeforeReset: registry.createType('u64', 10) },
      stabilizerBuys: {
        auctionInclusionPercent: registry.createType('Percent', 90),
        maxPositiveBids: registry.createType('u32', 4),
        purchaseHoldFrames: registry.createType('u64', 30),
        maxPriceAgeTicks: registry.createType('u64', 10),
      },
    },
    query: {
      crosschainTransfer: {
        gatewayStateBySourceChain: async () => {
          if (head.blockNumber < 10) return null;
          return {
            gatewayActivityNonce: 7n,
            argonApprovalsNonce: 1n,
            argonCirculation: 0n,
            argonotCirculation: 0n,
          };
        },
      },
      priceIndex: {
        current: async () =>
          marketPrice && { argonUsdPrice: marketPrice, argonUsdTargetPrice: BigNumber(1), tick: head.tick },
      },
      miningSlot: {
        nextFrameId: async () => registry.createType('u64', head.blockNumber >= 12 ? 43 : 14),
        frameRewardTicksRemaining: async () => registry.createType('u64', 1),
      },
      stabilizerBuys: {
        bidsByAuction: Object.assign(() => undefined, {
          entries: async () => {
            const bids = [
              [
                registry.createType('StorageKey', [
                  storage.stabilizerBuys.bidsByAuction,
                  [
                    12,
                    [
                      bidPercent,
                      { descendingAmount: toHex(maxUint128 - 20_000_000n, { size: 16 }), orderedId: account.toHex() },
                    ],
                  ],
                ]),
                registry.createType('Null'),
              ],
            ];
            if (competingBasis > 0n)
              bids.push([
                registry.createType('StorageKey', [
                  storage.stabilizerBuys.bidsByAuction,
                  [
                    12,
                    [
                      10,
                      {
                        descendingAmount: toHex(maxUint128 - competingBasis, { size: 16 }),
                        orderedId: `0x${'22'.repeat(32)}`,
                      },
                    ],
                  ],
                ]),
                registry.createType('Null'),
              ]);
            return bids;
          },
        }),
        matchingRate: async () => registry.createType('FixedU128', 500_000),
        auctionAllocationQueue: Object.assign(async () => null, { keys: async () => maturingKeys }),
        approvedPool: async () =>
          marketPrice && { poolId, poolManager: gateway, usdcToken: token, chainId: 1n, argonIsToken0: true },
        buysByAccountAndFrame: Object.assign(() => undefined, {
          entries: async () => {
            if (principal === 0n && liquidRepayments.size === 0) return [];

            return [
              [
                key,
                registry.createType('Option<PalletStabilizerBuysAccountFrameBuys>', {
                  pendingLiquidRepays: BigInt(liquidRepayments.size),
                  liquidRepaymentRewardRate: null,
                  principal,
                  capturedDiscount: nativePurchase.capturedDiscount,
                  bidRate: bidPercent,
                  positiveBidCount: bidCount,
                }),
              ],
            ];
          },
        }),
        auctions: async () =>
          registry.createType('Option<PalletStabilizerBuysAuction>', {
            matchingRate: 500_000,
            totalMatchingBasis: 1_020_000_000,
            budget: 50_000_000,
            remainingBudget: biddingOpen ? 50_000_000 : 45_000_000,
            remainingMatchingBasis: biddingOpen ? 918_000_000 : 898_000_000,
            maturesAtFrame: 42,
          }),
        liquidRepaysByAccountAndGatewayNonce: Object.assign(() => undefined, {
          entries: async () =>
            [...liquidRepayments].map(([nonce, repayment]) => [
              registry.createType('StorageKey', [
                storage.stabilizerBuys.liquidRepaysByAccountAndGatewayNonce,
                [account, toHex(nonce, { size: 8 })],
              ]),
              repayment,
            ]),
        }),
        payoutStateByAccount: async () =>
          registry.createType('PalletStabilizerBuysAccountPayoutState', { payableReward, nextPayoutFrame: 42 }),
      },
    },
  };
  const api = runtimeClient(rawApi);
  const watch = {
    start: async () => undefined,
    get finalizedBlockHeader() {
      return head;
    },
    events: createTypedEventEmitter<{ finalized: (blocks: [IBlockHeaderInfo]) => void }>(),
    getApi: async () => api,
    getLatestFinalizedSnapshot: async () => ({ block: head, api }),
    getHeader: async (height: number) => block(height),
    getBlock: async (header: IBlockHeaderInfo) => {
      let call = calls.stabilizerBuys.bid(12, 25);
      if (header.blockNumber === 10) {
        const proof = calls.crosschainTransfer.proveGatewayActivityStorage;
        call = proof(...proof.meta.args.map(arg => registry.createType(arg.type.toString())));
      }
      return registry.createType('SignedBlock', {
        block: { extrinsics: [registry.createType('Extrinsic'), registry.createType('Extrinsic', { method: call })] },
      });
    },
    getEvents: async (header: IBlockHeaderInfo) => events.get(header.blockNumber) ?? [],
    getEventsWithSpec: async (header: IBlockHeaderInfo) => ({
      events: events.get(header.blockNumber) ?? [],
      specVersion: 161,
      api,
    }),
    withBackgroundArchiveRead: async <T>(read: () => Promise<T>) => read(),
  } as unknown as BlockWatch;
  vi.mocked(findAddressActivity).mockImplementation(async (_address, range) => ({
    asOfBlock: range?.toBlock ?? head.blockNumber,
    definitionVersion: 5,
    blocks: [...events.keys()]
      .filter(height => height > (range?.afterBlock ?? 0) && height <= (range?.toBlock ?? head.blockNumber))
      .map(height => {
        const records = events.get(height)!;
        let activityMask = 0;
        if (records.some(({ event }) => event.section === 'stabilizerBuys' || event.section === 'crosschainTransfer')) {
          activityMask |= 1 << 14;
        }
        if (records.some(({ event }) => event.section === 'transactionPayment')) activityMask |= 1 << 11;

        return {
          blockNumber: height,
          blockHash: block(height).blockHash,
          specVersion: 161,
          activityMask,
        };
      })
      .filter(indexed => (indexed.activityMask & (range?.activityMask ?? 0x7fffffff)) !== 0),
    coverage: { fromBlock: range?.afterBlock ?? 0, toBlock: range?.toBlock ?? head.blockNumber, gaps: [] },
  }));
  return {
    calls,
    watch,
    accountId,
    account,
    purchase,
    events,
    registry,
    api,
    rawApi,
    maturingKeys,
    nativePurchase,
    liquidRepayments,
    setCompetingBid(basis: bigint) {
      competingBasis = basis;
    },
    setOpportunities(price: number, open: boolean) {
      marketPrice = BigNumber(price);
      biddingOpen = open;
    },
    advance(height: number, held: bigint, reward: bigint) {
      head = block(height);
      principal = held;
      payableReward = reward;
      for (const [blockNumber, records] of events) {
        if (blockNumber > height) continue;
        for (const { event } of records) {
          if (event.section === 'stabilizerBuys' && event.method === 'BidSubmitted') {
            bidPercent = event.data.rewardRate.times(100).toNumber();
            bidCount = event.data.positiveBidCount;
          }
        }
      }
    },
  };
}
