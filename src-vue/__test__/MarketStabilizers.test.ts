import { expect, it, onTestFinished, vi } from 'vitest';
import { createPinia, disposePinia, setActivePinia } from 'pinia';
import { computed, reactive, ref, shallowReactive } from 'vue';
import { type BlockWatch, NetworkConfig, UnitOfMeasurement } from '@argonprotocol/apps-core';
import { PriceIndex } from '@argonprotocol/mainchain';
import { WalletForEthereum } from '../lib/WalletForEthereum.ts';
import { getWalletsForEthereum } from '../stores/wallets.ts';
import { useMarketStabilizers } from '../stores/marketStabilizers.ts';
import { getConfig } from '../stores/config.ts';
import { getStabilizerBuys } from '../stores/stabilizerBuys.ts';
import { Config } from '../lib/Config.ts';
import { StabilizerBuys } from '../lib/StabilizerBuys.ts';
import { StabilizerBuyStatus } from '../interfaces/IStabilizerBuyPurchase.ts';
import { instanceChecks } from '../lib/Utils.ts';
import { createTestDb } from './helpers/db.ts';
import { useFinancials } from '../stores/financials.ts';
import { reduceFinancialPositions } from '../lib/financials/index.ts';
import { createFinancialPosition } from '../interfaces/IFinancialPosition.ts';

vi.mock('../stores/wallets.ts', () => ({ getWalletsForEthereum: vi.fn() }));
vi.mock('../stores/bitcoin.ts', () => ({
  getBitcoinFissions: () => ({ getLiquids: () => [] }),
  getBitcoinLocks: () => ({}),
}));
vi.mock('../stores/stabilizerBuys.ts', () => ({
  getStabilizerBuys: vi.fn(() => ({ data: { buys: [], frameRewards: [], positions: [] } })),
  getStabilizerBuyAlerts: () => undefined,
  getStabilizerBuyPurchases: () => undefined,
}));
vi.mock('../stores/mainchain.ts', () => ({
  getMiningFrames: () => ({ events: { on: () => () => undefined } }),
}));
vi.mock('../stores/financials.ts', () => ({ useFinancials: vi.fn(() => ({})) }));
vi.mock('../stores/config.ts', () => ({ getConfig: vi.fn(() => ({ isLoaded: false })) }));
vi.mock('../stores/currency.ts', () => ({ getCurrency: () => ({ priceIndex: new PriceIndex() }) }));

it.each(['mainnet', 'dev-docker'] as const)(
  'keeps a settled Stabilizer APY fixed as observations advance and payout arrives on %s',
  network => {
    const previousNetwork = NetworkConfig.networkName!;
    NetworkConfig.setNetwork(network);
    onTestFinished(() => NetworkConfig.setNetwork(previousNetwork));

    const dayMillis = NetworkConfig.rewardTicksPerFrame * NetworkConfig.tickMillis;
    const startedAt = new Date('2026-01-01T00:00:00Z').getTime();
    const observedAt = ref(new Date(startedAt + 3 * dayMillis));
    const position = reactive(
      createFinancialPosition(
        'stabilizer-buy',
        {
          id: 'synthetic-fixed-term-buy',
          label: 'Stabilizer Buy',
          admissionFrame: 12,
          lifecycle: 'held',
          startedAt,
          returnIsComplete: true,
          capitalFlows: [
            { amount: 100_000_000n, occurredAt: startedAt },
            { amount: 10_000_000n, occurredAt: startedAt + 2 * dayMillis },
          ],
        },
        { investedCost: 110_000_000n, currentValue: 165_000_000n, paidIncome: 0n, settledPrincipalValue: 0n },
      ),
    );
    const financials = reactive({
      financialPositionAggregate: computed(() =>
        reduceFinancialPositions([
          { group: 'stabilizer', state: 'ready', positions: [position], observation: { observedAt: observedAt.value } },
        ]),
      ),
    });
    vi.mocked(useFinancials, { partial: true }).mockReturnValueOnce(financials);

    const buys = getStabilizerBuys();
    buys.data.frameRewards = [
      {
        ownerAccount: 'synthetic-owner',
        admissionFrame: 12,
        maturesAtFrame: 42,
        bidCount: 1,
        latestBid: 50,
        awardedReward: 15_000_000n,
        paidReward: 0n,
        lastUpdatedArgonBlock: 100,
        bidFees: [],
        createdAt: new Date(startedAt),
        updatedAt: new Date(startedAt),
      },
    ];
    vi.mocked(getStabilizerBuys).mockReturnValueOnce(buys);
    vi.mocked(getWalletsForEthereum, { partial: true }).mockReturnValueOnce({ persistedWallets: [] });

    const pinia = createPinia();
    setActivePinia(pinia);
    try {
      const market = useMarketStabilizers();
      // Cost includes the later bid fee: 110 invested, 150 principal + 15 bonus, over the fixed 30-frame term.
      const expectedApy = (Math.pow(165 / 110, 365 / 30) - 1) * 100;
      const awardedApy = market.returns.byFrame[12].apy;
      expect(market.returns.byFrame[12].returnAmount).toBe(55_000_000n);

      observedAt.value = new Date(startedAt + 15 * dayMillis);
      expect(market.returns.byFrame[12].apy).toBe(awardedApy);
      expect(market.returns.byFrame[12].apy).toBeCloseTo(expectedApy);
      expect(market.returns.byFrame[12].returnAmount).toBe(55_000_000n);

      // A later payout changes custody and timestamps, not the agreed holding term or earnings.
      position.lifecycle = 'completed';
      position.currentValue = 0n;
      position.settledPrincipalValue = 150_000_000n;
      position.paidIncome = 15_000_000n;
      position.endedAt = startedAt + 45 * dayMillis;
      observedAt.value = new Date(startedAt + 50 * dayMillis);
      expect(market.returns.byFrame[12].apy).toBeCloseTo(expectedApy);
      expect(market.returns.byFrame[12].returnAmount).toBe(55_000_000n);
    } finally {
      disposePinia(pinia);
    }
  },
);

it('offers only connected Ethereum wallets and totals their balances as connections change', () => {
  const coreWallet = new WalletForEthereum(`0x${'11'.repeat(20)}`);
  const connected = new WalletForEthereum(`0x${'22'.repeat(20)}`);
  connected.data.balanceUpdatedAt = new Date('2026-01-01T00:00:00Z');
  connected.data.balanceIsCached = false;
  connected.data.otherTokens = [
    {
      symbol: 'USDC',
      decimals: 6,
      address: null,
      chain: 'ethereum',
      unitOfMeasurement: UnitOfMeasurement.USDC,
      value: 3_000_000n,
    },
  ];
  const persistedWallets = shallowReactive([connected]);
  vi.mocked(getWalletsForEthereum, { partial: true }).mockReturnValue({ coreWallet, persistedWallets });

  const pinia = createPinia();
  setActivePinia(pinia);
  try {
    const market = useMarketStabilizers();
    expect(market.wallets).toEqual([connected]);
    expect(market.availableUsdc).toBe(3_000_000n);

    // Discovering a connected core wallet makes it a real choice, rather than an implicit option.
    persistedWallets.push(coreWallet);
    expect(market.wallets).toEqual([connected, coreWallet]);
    persistedWallets.splice(0, 1);
    expect(market.wallets).toEqual([coreWallet]);
    persistedWallets.splice(0, 1);
    expect(market.wallets).toEqual([]);
    expect(market.availableUsdc).toBe(0n);
  } finally {
    disposePinia(pinia);
  }
});

it('requires fresh USDC and ETH in one connected wallet once, then retains access without funding or alerts', async () => {
  const db = await createTestDb();
  instanceChecks.delete(Config.prototype.constructor);
  const config = reactive(new Config(Promise.resolve(db)));
  await config.load();
  await config.saveStabilizerBuyAlert({ minimumApy: 12 });
  vi.mocked(getConfig).mockReturnValueOnce(config);

  const usdcWallet = new WalletForEthereum(`0x${'11'.repeat(20)}`);
  const ethWallet = new WalletForEthereum(`0x${'22'.repeat(20)}`);
  for (const wallet of [usdcWallet, ethWallet]) {
    wallet.data = reactive(wallet.data);
    wallet.data.balanceUpdatedAt = new Date('2026-01-01T00:00:00Z');
    wallet.data.balanceIsCached = false;
  }
  usdcWallet.data.otherTokens = [
    {
      symbol: 'USDC',
      decimals: 6,
      address: null,
      chain: 'ethereum',
      unitOfMeasurement: UnitOfMeasurement.USDC,
      value: 3_000_000n,
    },
  ];
  ethWallet.data.otherTokens = [
    {
      symbol: 'ETH',
      decimals: 18,
      address: null,
      chain: 'ethereum',
      unitOfMeasurement: UnitOfMeasurement.ETH,
      value: 1_000_000_000_000_000n,
    },
  ];
  const persistedWallets = shallowReactive([usdcWallet, ethWallet]);
  vi.mocked(getWalletsForEthereum, { partial: true }).mockReturnValue({ persistedWallets });

  const pinia = createPinia();
  setActivePinia(pinia);
  try {
    const market = useMarketStabilizers();
    expect(market.hasAccess).toBe(false);
    expect(market.canActivate).toBe(false);
    expect(await market.activate()).toBe(false);

    usdcWallet.data.otherTokens.push(ethWallet.data.otherTokens[0]);
    usdcWallet.data.balanceIsCached = true;
    expect(market.canActivate).toBe(false);
    expect(await market.activate()).toBe(false);

    usdcWallet.data.balanceIsCached = false;
    expect(market.canActivate).toBe(true);
    expect(await market.activate()).toBe(true);
    expect(market.hasAccess).toBe(true);
    expect((await db.configTable.fetchAllAsObject()).hasActivatedStabilizerBuys).toBe('true');

    persistedWallets.splice(0);
    await config.saveStabilizerBuyAlert(undefined);
    expect(market.canActivate).toBe(false);
    expect(market.hasAccess).toBe(true);

    instanceChecks.delete(Config.prototype.constructor);
    const restarted = new Config(Promise.resolve(db));
    await restarted.load();
    expect(restarted.hasActivatedStabilizerBuys).toBe(true);
  } finally {
    disposePinia(pinia);
    await db.close();
  }
});

it.each(['buy', 'reward'] as const)(
  'restores and remembers access when persisted %s history loads into the mounted store',
  async kind => {
    const db = await createTestDb();
    instanceChecks.delete(Config.prototype.constructor);
    const config = reactive(new Config(Promise.resolve(db)));
    await config.load();
    vi.mocked(getConfig).mockReturnValueOnce(config);
    vi.mocked(getWalletsForEthereum, { partial: true }).mockReturnValue({ persistedWallets: [] });

    const ownerAccount = `0x${'33'.repeat(32)}`;
    const buys = new StabilizerBuys({} as BlockWatch, ownerAccount, Promise.resolve(db));
    buys.data = reactive(buys.data) as StabilizerBuys['data'];
    vi.mocked(getStabilizerBuys).mockReturnValueOnce(buys);

    let pinia = createPinia();
    setActivePinia(pinia);
    try {
      const market = useMarketStabilizers();
      expect(market.hasAccess).toBe(false);
      const createdAt = new Date('2026-01-01T00:00:00Z');
      if (kind === 'buy') {
        await db.stabilizerBuysTable.saveBuy({
          ownerAccount,
          id: 'completed-buy',
          status: StabilizerBuyStatus.Complete,
          argonFees: [],
          createdAt,
          updatedAt: createdAt,
        });
      } else {
        await db.stabilizerBuysTable.saveFrameRewards({
          ownerAccount,
          admissionFrame: 12,
          bidCount: 1,
          latestBid: 50,
          paidReward: 5n,
          awardedReward: 5n,
          lastUpdatedArgonBlock: 100,
          bidFees: [],
          createdAt,
          updatedAt: createdAt,
        });
      }
      expect(market.hasAccess).toBe(false);

      await buys.loadRecords();
      expect(market.hasAccess).toBe(true);
      expect(market.canActivate).toBe(false);
      await vi.waitFor(() => expect(config.hasActivatedStabilizerBuys).toBe(true));
      expect((await db.configTable.fetchAllAsObject()).hasActivatedStabilizerBuys).toBe('true');

      disposePinia(pinia);
      instanceChecks.delete(Config.prototype.constructor);
      const restarted = reactive(new Config(Promise.resolve(db)));
      await restarted.load();
      vi.mocked(getConfig).mockReturnValueOnce(restarted);
      pinia = createPinia();
      setActivePinia(pinia);
      const restoredMarket = useMarketStabilizers();
      expect(restoredMarket.data.buys).toEqual([]);
      expect(restoredMarket.hasAccess).toBe(true);
      expect(restoredMarket.canActivate).toBe(false);
    } finally {
      disposePinia(pinia);
      await buys.close();
      await db.close();
    }
  },
);
