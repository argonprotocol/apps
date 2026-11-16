import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { computed, reactive, shallowReactive, watch } from 'vue';
import BigNumber from 'bignumber.js';
import { Metadata } from '@polkadot/types';
import { decorateExtrinsics } from '@polkadot/types/metadata/decorate';
import { getOfflineRegistry } from '@argonprotocol/mainchain';
import {
  createTypedEventEmitter,
  type StabilizerBuy,
  type BlockWatch,
  type IBlockHeaderInfo,
  type RuntimeSystemEventRecord,
} from '@argonprotocol/apps-core';
import { runtimeClient, type HistoricalEvent, type LiveQueryRecord } from '@argonprotocol/runtime-client';
import { maxUint128, toHex } from 'viem';
import { WalletForArgon } from '../lib/WalletForArgon.ts';
import { WalletFinancials } from '../lib/financials/WalletBalances.ts';
import type { IArgonAccountBalance } from '../lib/WalletsForArgon.ts';
import { createTestDb, createTestDbAtMigration } from './helpers/db.ts';
import { buyOpportunity } from './helpers/stabilizerBuy.ts';
import { StabilizerBuyAlerts } from '../lib/StabilizerBuyAlerts.ts';
import { StabilizerBuyPurchases } from '../lib/StabilizerBuyPurchases.ts';
import { WalletsForEthereum } from '../lib/WalletsForEthereum.ts';
import { StabilizerBuys } from '../lib/StabilizerBuys.ts';
import {
  StabilizerBuyStatus,
  type IStabilizerBuyQuote,
  type IStabilizerBuyRecord,
} from '../interfaces/IStabilizerBuyPurchase.ts';
import { toArgonAccountIdHex } from '../lib/EthereumClient.ts';
import { createStabilizerBuyFinancialPositions } from '../lib/financials/StabilizerBuys.ts';
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
  frameId: blockNumber >= 12 ? 42 : 13,
});
const eventRecord = (
  event: HistoricalEvent,
  phase: RuntimeSystemEventRecord['phase'] = { type: 'ApplyExtrinsic', value: 1 },
): RuntimeSystemEventRecord => ({
  event,
  phase,
  topics: [],
});

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

describe('Stabilizer purchase history and total returns', () => {
  let chain: ReturnType<typeof chainHistory>;
  let db: Awaited<ReturnType<typeof createTestDb>>;
  let buys: StabilizerBuys;
  beforeEach(async () => {
    chain = chainHistory();
    db = await createTestDb();
    buys = new StabilizerBuys(chain.watch, chain.accountId, Promise.resolve(db));
  });
  afterEach(async () => {
    await buys.close();
    await db.sql.close();
  });

  it('advances an empty account checkpoint without announcing another financial change', async () => {
    chain.events.clear();
    chain.advance(10, 0n, 0n);
    buys.data = shallowReactive(buys.data);
    const observations: { isLoaded: boolean; blockNumber: number }[] = [];
    const stopObserving = watch(
      () => buys.data.financialRevision,
      () => observations.push({ isLoaded: buys.data.isLoaded, blockNumber: buys.data.blockNumber }),
      { flush: 'sync' },
    );
    await buys.load();
    const revision = buys.data.financialRevision;
    expect(revision).toBe(1);
    expect(observations).toEqual([{ isLoaded: true, blockNumber: 10 }]);

    chain.advance(11, 0n, 0n);
    chain.watch.events.emit('finalized', [block(10), block(11)]);
    await vi.waitFor(() => expect(buys.data.blockNumber).toBe(11));

    expect(await db.syncStateTable.get(SyncStateKeys.StabilizerBuys)).toMatchObject({ throughBlock: 11 });
    expect(buys.data.isLoaded).toBe(true);
    expect(buys.data.financialRevision).toBe(revision);
    expect(observations).toEqual([{ isLoaded: true, blockNumber: 10 }]);

    chain.advance(12, 0n, 0n);
    await buys.refresh(block(12));
    expect(buys.data.currentFrameId).toBe(42);
    expect(await db.syncStateTable.get(SyncStateKeys.StabilizerBuys)).toMatchObject({ throughBlock: 12 });
    stopObserving();
  });

  it('keeps held purchases current without rereading or republishing quiet blocks, and validates a payout before the domain catches up', async () => {
    buys.data = shallowReactive(buys.data);
    chain.advance(10, 100_000_000n, 0n, 14);
    chain.events.set(11, [
      eventRecord({
        section: 'stabilizerBuys',
        method: 'PayoutFailed',
        data: { account: 'synthetic-other-owner', error: { type: 'Unavailable' } },
      }),
    ]);
    await buys.load();
    const revision = buys.data.financialRevision;
    const saved = await db.stabilizerBuysTable.fetchAll(chain.accountId);
    const account: IArgonAccountBalance = {
      address: chain.accountId,
      wallet: new WalletForArgon('argon', chain.accountId, Promise.resolve(db)),
      availableMicrogons: 10_000_000n,
      availableMicronots: 0n,
      reservedMicrogons: 100_000_000n,
      reservedMicronots: 0n,
      microgonHolds: [{ id: { type: 'StabilizerBuys', value: { type: 'PurchasePrincipal' } }, amount: 100_000_000n }],
      micronotHolds: [],
    };
    const payoutRead = vi.spyOn(chain.rawApi.query.stabilizerBuys, 'payoutStateByAccount');
    chain.advance(11, 100_000_000n, 0n, 14);
    const quietBlock = chain.watch.finalizedBlockHeader;

    // The published predecessor has been trimmed, but this header still extends it.
    const quietBest = (await buys.readAccountSnapshot(account, quietBlock))!;
    expect(createStabilizerBuyFinancialPositions(quietBest)[0].currentValue).toBe(100_000_000n);
    expect(payoutRead).not.toHaveBeenCalled();
    await buys.refresh(quietBlock);
    expect(buys.data.blockHash).toBe(quietBlock.blockHash);
    expect(buys.data.financialRevision).toBe(revision);
    expect((await db.stabilizerBuysTable.fetchAll(chain.accountId)).frameRewards).toEqual(saved.frameRewards);
    expect(
      createStabilizerBuyFinancialPositions((await buys.readAccountSnapshot(account, quietBlock))!)[0].currentValue,
    ).toBe(100_000_000n);
    expect(payoutRead).not.toHaveBeenCalled();

    // Allocation is work-bounded: the bonus arrives later in the same frame,
    // without changing the total hold.
    chain.advance(12, 100_000_000n, 5_000_000n, 14);
    const awardBlock = chain.watch.finalizedBlockHeader;
    await expect(buys.readAccountSnapshot(account, awardBlock)).rejects.toThrow('finalized');
    await buys.refresh(awardBlock);
    const awarded = (await buys.readAccountSnapshot(account, awardBlock))!;
    expect(createStabilizerBuyFinancialPositions(awarded)[0].currentValue).toBe(105_000_000n);
    expect(buys.data.financialRevision).toBeGreaterThan(revision);
    expect((await db.stabilizerBuysTable.fetchAll(chain.accountId)).frameRewards[0].awardedReward).toBe(5_000_000n);
  });

  it('refreshes pending paydown forecasts on frame turns, page entry and visible price updates', async () => {
    let visible = false;
    buys = new StabilizerBuys(chain.watch, chain.accountId, Promise.resolve(db), () => visible);
    const purchaseEvents = chain.events.get(10)!;
    chain.events.clear();
    chain.events.set(10, purchaseEvents);
    chain.liquidRepayments.set(7n, {
      liquidId: 3,
      admissionFrame: 12,
      microgons: 100_000_000n,
      purchaseTick: 10,
      eligibleRewardPercent: BigNumber(0.05),
      microgonsAtTargetPerBtc: BigNumber(68_000_000_000),
      purchaseRValue: BigNumber(0.75),
      priceWindow: { nextFrame: 12n, nextTick: 10n, rValueHighWater: BigNumber(0.75) },
    });
    chain.framePrices.set(12, { firstTick: 10n, endTick: null, rValue: BigNumber(0.75) });
    chain.advance(10, 0n, 0n, 12);
    await buys.load();
    expect(buys.data.positions[0].liquidRepayments[0].observedRValueHighWater?.toNumber()).toBe(0.75);
    expect(buys.heldPrincipal).toBe(100_000_000n);

    // Hidden price changes preserve the last projection and the account's live claims.
    chain.framePrices.set(12, { firstTick: 10n, endTick: null, rValue: BigNumber(0.8) });
    chain.events.set(11, [eventRecord({ section: 'priceIndex', method: 'NewIndex', data: {} })]);
    chain.advance(11, 0n, 0n, 12);
    await buys.refresh(chain.watch.finalizedBlockHeader);
    expect(buys.data.positions[0].liquidRepayments[0].observedRValueHighWater?.toNumber()).toBe(0.75);
    expect(buys.heldPrincipal).toBe(100_000_000n);
    expect(await db.syncStateTable.get(SyncStateKeys.StabilizerBuys)).toMatchObject({ throughBlock: 11 });

    // Opening the page reconciles immediately, even at the same finalized head.
    visible = true;
    await buys.refresh();
    expect(buys.data.positions[0].liquidRepayments[0].observedRValueHighWater?.toNumber()).toBe(0.8);

    chain.framePrices.set(12, { firstTick: 10n, endTick: null, rValue: BigNumber(0.9) });
    chain.events.set(12, [eventRecord({ section: 'priceIndex', method: 'NewIndex', data: {} })]);
    chain.advance(12, 0n, 0n, 12);
    await buys.refresh(chain.watch.finalizedBlockHeader);
    expect(buys.data.positions[0].liquidRepayments[0].observedRValueHighWater?.toNumber()).toBe(0.9);

    visible = false;
    chain.framePrices.set(12, { firstTick: 10n, endTick: 13n, rValue: BigNumber(0.95) });
    chain.events.set(13, [eventRecord({ section: 'priceIndex', method: 'NewIndex', data: {} })]);
    chain.advance(13, 0n, 0n, 12);
    await buys.refresh(chain.watch.finalizedBlockHeader);
    expect(buys.data.positions[0].liquidRepayments[0].observedRValueHighWater?.toNumber()).toBe(0.9);

    chain.advance(14, 0n, 0n, 13);
    await buys.refresh(chain.watch.finalizedBlockHeader);
    expect(buys.data.positions[0].liquidRepayments[0].observedRValueHighWater?.toNumber()).toBe(0.95);
    expect(buys.heldPrincipal).toBe(100_000_000n);
    expect(buys.data.error).toBeUndefined();
  });

  it('rechecks a desktop bid notice against a newly finalized frame before resolving it', async () => {
    chain.market.price = BigNumber(0.9);
    chain.market.biddingOpen = true;
    chain.market.competingBasis = 1_000_000_000n;

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

      const frameRead = vi
        .spyOn(chain.rawApi.query.miningSlot, 'nextFrameId')
        .mockRejectedValue(new Error('The finalized header already identifies the frame.'));
      vi.spyOn(chain.watch, 'getLatestFinalizedSnapshot').mockResolvedValue({
        block: { ...block(11), frameId: 14 },
        api: runtimeClient(await chain.watch.getApi(block(11))),
      });
      expect(chain.watch.finalizedBlockHeader.blockNumber).toBe(10);
      expect(await alerts.resolveNotice(notice.key)).toBeUndefined();
      expect(buys.data.currentFrameId).toBe(14);
      expect(buys.data.blockNumber).toBe(11);
      expect(alerts.getNotice(notice.key)).toBeUndefined();
      expect(frameRead).not.toHaveBeenCalled();
    } finally {
      await alerts.close();
    }
  });

  it('keeps a reward-only claim visible while recovering its missing award after principal was released', async () => {
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
    chain.maturingKeys.push(chain.pendingAuctionKey);

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
  });

  it('does not attribute an earlier same-block payout to a newly admitted purchase when older history is missing', async () => {
    chain.events.get(10)!.unshift({
      event: {
        section: 'stabilizerBuys',
        method: 'PayoutCompleted',
        data: { account: chain.accountId, principal: 100_000_000n, reward: 0n },
      },
      phase: { type: 'Initialization' },
      topics: [],
    });

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
  });

  it('defers later payouts until missing older history is repaired, including across restart', async () => {
    const olderKey = { args: [chain.accountId, toHex(9n, { size: 8 })] } as const;
    const olderPrincipal = {
      pendingLiquidRepays: 0n,
      liquidRepaymentRewardRate: null,
      principal: 100_000_000n,
      capturedDiscount: 40_000_000n,
      bidRate: BigNumber(0),
      positiveBidCount: 0,
    };
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
  });

  it('keeps allocation unknown when a current held frame has no recovered purchase history', async () => {
    chain.advance(13, 100_000_000n, 0n);

    await buys.load();
    await buys.refresh(block(13));
    expect(buys.data.buys).toEqual([]);
    expect(buys.heldPrincipal).toBe(100_000_000n);
    expect(buys.data.frameRewards[0].awardedReward).toBeUndefined();
    expect((await db.stabilizerBuysTable.fetchAll(chain.accountId)).frameRewards[0].awardedReward).toBeUndefined();

    const scans = vi
      .spyOn(chain.rawApi.query.stabilizerBuys.buysByAccountAndFrame, 'entries')
      .mockRejectedValue(new Error('An unchanged held purchase does not need another account scan.'));
    chain.events.delete(14);
    chain.advance(14, 100_000_000n, 0n);
    chain.watch.events.emit('finalized', [block(13), block(14)]);
    await vi.waitFor(() => expect(buys.data.blockNumber).toBe(14));

    expect(buys.heldPrincipal).toBe(100_000_000n);
    expect(buys.data.frameRewards[0].awardedReward).toBeUndefined();
    expect(await db.syncStateTable.get(SyncStateKeys.StabilizerBuys)).toMatchObject({ throughBlock: 14 });
    scans.mockRestore();
  });

  it('resolves a zero award only after coherent history and native allocation completion', async () => {
    let awaitingAllocation = true;
    vi.spyOn(chain.rawApi.query.stabilizerBuys.buysByAccountAndFrame, 'entries').mockImplementation(async () => {
      if (!awaitingAllocation) return [];
      return [[{ args: [chain.accountId, toHex(12n, { size: 8 })] }, { ...chain.nativePurchase }]];
    });
    chain.events.delete(12);
    chain.events.set(14, [
      eventRecord({
        section: 'stabilizerBuys',
        method: 'PayoutCompleted',
        data: { account: chain.accountId, principal: 100_000_000n, reward: 0n },
      }),
    ]);
    chain.advance(14, 0n, 0n);
    chain.maturingKeys.push(chain.pendingAuctionKey);
    vi.spyOn(chain.rawApi.query.stabilizerBuys, 'auctions').mockImplementation(async () => ({
      matchingRate: BigNumber(0.5),
      totalMatchingBasis: 200_000_000n,
      budget: 40_000_000n,
      remainingBudget: 0n,
      remainingMatchingBasis: 0n,
      maturesAtFrame: 42,
    }));

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
    awaitingAllocation = false;
    chain.advance(15, 0n, 0n);
    await buys.refresh(block(15));
    expect(buys.data.positions).toEqual([]);
    expect(buys.data.frameRewards[0]).toMatchObject({ awardedReward: 0n, maturesAtFrame: 42, paidReward: 0n });
    expect((await db.stabilizerBuysTable.fetchAll(chain.accountId)).frameRewards[0].awardedReward).toBe(0n);
    expect(buys.data.buys[0]).toMatchObject({ principal: 100_000_000n, purchaseArgonReleaseBlockNumber: 14 });
    expect(createStabilizerBuyFinancialPositions(buys.snapshot)[0]).toMatchObject({
      lifecycle: 'completed',
      endedAt: block(14).blockTime,
    });
  });

  it('keeps a reward unknown when a coalesced batch has a gap in finalized history', async () => {
    chain.events.set(13, []);
    const award = chain.events.get(12)![0].event;
    const payout = chain.events.get(14)![0].event;
    chain.events.set(12, []);
    chain.events.set(14, [
      eventRecord(award, { type: 'Initialization' }),
      eventRecord(payout, { type: 'Initialization' }),
    ]);
    chain.maturingKeys.push(chain.pendingAuctionKey);
    chain.advance(11, 100_000_000n, 0n);

    let release!: () => void;
    const waiting = new Promise<void>(resolve => (release = resolve));
    try {
      await buys.load();
      await buys.recoverHistory(11);
      const findActivity = vi.mocked(findAddressActivity).getMockImplementation()!;
      vi.mocked(findAddressActivity).mockRejectedValue(new Error('The indexer is unavailable.'));

      let started!: () => void;
      const writing = new Promise<void>(resolve => (started = resolve));
      const transaction = db.transaction.bind(db);
      vi.spyOn(db, 'transaction').mockImplementationOnce(async callback => {
        started();
        await waiting;
        return transaction(callback);
      });
      chain.advance(12, 100_000_000n, 0n);
      const inFlight = buys.refresh(block(12));
      await writing;
      chain.advance(16, 0n, 0n);
      chain.maturingKeys.length = 0;
      chain.watch.events.emit('finalized', [block(13)]);
      const newest = buys.refresh(block(16));
      release();
      await inFlight;
      await newest;

      await vi.waitFor(() => expect(buys.data.blockNumber).toBe(16));
      expect(buys.data.frameRewards[0].awardedReward).toBeUndefined();
      expect((await db.stabilizerBuysTable.fetchAll(chain.accountId)).frameRewards[0].awardedReward).toBeUndefined();
      expect(buys.heldPrincipal).toBe(0n);
      expect(await db.syncStateTable.get(SyncStateKeys.StabilizerBuys)).toMatchObject({ throughBlock: 13 });

      vi.mocked(findAddressActivity).mockImplementation(findActivity);
      await buys.recoverHistory(16, 13);
      expect(buys.data.buys[0].status).toBe(StabilizerBuyStatus.Complete);
      expect(buys.data.frameRewards[0]).toMatchObject({ awardedReward: 5_000_000n, paidReward: 5_000_000n });
      expect(await db.syncStateTable.get(SyncStateKeys.StabilizerBuys)).toMatchObject({ throughBlock: 16 });
    } finally {
      release();
    }
  });

  it('does not present a composite command fee as an exact purchase cost', async () => {
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
  });

  it('keeps imported returns incomplete until purchase costs are recorded, and preserves those costs across backfill and restart', async () => {
    buys.data = reactive(buys.data) as StabilizerBuys['data'];
    const visibleReturn = computed(() => calculatePositionReturn(createStabilizerBuyFinancialPositions(buys.snapshot)));
    const visiblePrincipal = computed(() => createStabilizerBuyFinancialPositions(buys.snapshot)[0]?.currentValue);
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
    expect(walletPositions.reduce((sum, entry) => sum + (entry.currentValue ?? 0n), 0n) + position.currentValue!).toBe(
      110_000_000n,
    );
    chain.advance(12, 100_000_000n, 5_000_000n);
    await expect(buys.readAccountSnapshot(account, block(12))).rejects.toThrow('finalized');
    await buys.refresh(block(12));
    await buys.recoverHistory(12);
    const scan = vi
      .spyOn(chain.rawApi.query.stabilizerBuys.buysByAccountAndFrame, 'entries')
      .mockRejectedValue(new Error('Financial validation must not enumerate the account again.'));
    const snapshot = (await buys.readAccountSnapshot(account, block(12)))!;
    expect(createStabilizerBuyFinancialPositions(snapshot)[0].currentValue).toBe(105_000_000n);
    scan.mockRestore();
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
    expect(createStabilizerBuyFinancialPositions(buys.snapshot)[0].investedCost).toBe(44_127_500n);
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
  });

  it.each(['ineligible', 'admission failure'])('keeps %s as completed direct credit across restart', async producer => {
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
    chain.liquidRepayments.set(7n, {
      liquidId: 3,
      admissionFrame: 12,
      microgons: 100_000_000n,
      purchaseTick: 10,
      eligibleRewardPercent: BigNumber(0),
      microgonsAtTargetPerBtc: BigNumber(0),
      purchaseRValue: BigNumber(0),
      priceWindow: { nextFrame: null, nextTick: 0n, rValueHighWater: BigNumber(0) },
    });
    chain.advance(11, scenario.ordinary, 0n);

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
    expect(createStabilizerBuyFinancialPositions(buys.snapshot)[0].currentValue).toBe(100_000_000n + scenario.ordinary);
    const account: IArgonAccountBalance = {
      address: chain.accountId,
      wallet: new WalletForArgon('argon', chain.accountId, Promise.resolve(db)),
      availableMicrogons: 0n,
      availableMicronots: 0n,
      reservedMicrogons: buys.heldPrincipal,
      reservedMicronots: 0n,
      microgonHolds: [
        { id: { type: 'StabilizerBuys', value: { type: 'PurchasePrincipal' } }, amount: buys.heldPrincipal },
      ],
      micronotHolds: [],
    };
    const snapshot = (await buys.readAccountSnapshot(account, block(11)))!;
    expect(snapshot.positions[0].heldPrincipal).toBe(100_000_000n + scenario.ordinary);

    chain.advance(12, scenario.ordinary, scenario.award);
    await buys.refresh(block(12));
    chain.liquidRepayments.clear();
    chain.advance(14, 0n, 0n);
    // Even if the supplied total hold is unchanged, missing known claims cannot pass validation.
    await expect(buys.readAccountSnapshot(account, block(14))).rejects.toThrow('finalized');
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
  });

  it('coalesces slow reads and retries payout publication without losing finalized events', async () => {
    chain.events.set(12, [eventRecord(chain.events.get(12)![0].event, { type: 'Initialization' })]);
    chain.events.set(14, [eventRecord(chain.events.get(14)![0].event, { type: 'Initialization' })]);

    let release!: () => void;
    const waiting = new Promise<void>(resolve => (release = resolve));
    try {
      await buys.load();
      expect(buys.heldPrincipal).toBe(100_000_000n);
      vi.mocked(findAddressActivity).mockRejectedValue(new Error('The indexer is unavailable.'));

      let started!: () => void;
      const writing = new Promise<void>(resolve => (started = resolve));
      const transaction = db.transaction.bind(db);
      vi.spyOn(db, 'transaction')
        .mockImplementationOnce(async callback => {
          started();
          await waiting;
          return transaction(callback);
        })
        .mockRejectedValueOnce(new Error('Payout publication was interrupted.'));
      chain.advance(11, 100_000_000n, 0n);
      const inFlight = buys.refresh(block(11));
      await writing;

      // Finalized events remain readable while superseded current-state snapshots are unavailable.
      const getApi = chain.watch.getApi.bind(chain.watch);
      vi.spyOn(chain.watch, 'getApi').mockImplementation(async header => {
        if (header.blockNumber >= 12 && header.blockNumber < 15)
          throw new Error('The superseded current snapshot is unavailable.');
        return getApi(header);
      });
      chain.advance(15, 0n, 0n);
      chain.watch.events.emit('finalized', [block(12), block(13), block(14), block(15)]);
      release();
      await inFlight;

      await vi.waitFor(() => expect(buys.data.error).toBe('Payout publication was interrupted.'));
      expect(buys.data.blockNumber).toBe(11);
      expect(buys.heldPrincipal).toBe(100_000_000n);
      expect((await db.stabilizerBuysTable.fetchAll(chain.accountId)).buys[0].status).toBe(
        StabilizerBuyStatus.WaitingForPrincipalReleaseOnArgon,
      );

      chain.advance(16, 0n, 0n);
      chain.watch.events.emit('finalized', [block(16)]);
      await vi.waitFor(() => {
        expect(buys.data.blockNumber).toBe(16);
        expect(buys.data.buys[0].status).toBe(StabilizerBuyStatus.Complete);
      });
      const saved = await db.stabilizerBuysTable.fetchAll(chain.accountId);
      expect(saved.buys[0]).toMatchObject({
        principal: 100_000_000n,
        releasedPrincipal: 100_000_000n,
        purchaseArgonReleaseBlockNumber: 14,
      });
      expect(saved.frameRewards[0]).toMatchObject({
        awardedReward: 5_000_000n,
        paidReward: 5_000_000n,
      });
      expect(buys.heldPrincipal).toBe(0n);
      expect(buys.data.positions).toEqual([]);
      expect(await db.syncStateTable.get(SyncStateKeys.StabilizerBuys)).toMatchObject({ throughBlock: 16 });
    } finally {
      release();
    }
  });

  it('credits a declined Liquid paydown as an ordinary purchase in the same frame, including after restart', async () => {
    const secondPurchase = {
      ...chain.purchase,
      data: {
        ...chain.purchase.data,
        transfer: { ...chain.purchase.data.transfer, gatewayActivityNonce: 8n, amount: 50_000_000n },
        purchaseTick: 11,
        purchase: {
          ...chain.purchase.data.purchase,
          repayLiquidId: 3,
          usdcSpent: 45_000_000n,
          argonBought: 50n * 10n ** 18n,
        },
      },
    };
    chain.events.get(11)!.push(
      eventRecord({
        section: 'stabilizerBuys',
        method: 'LiquidRepaymentInvalid',
        data: { account: chain.accountId, gatewayActivityNonce: 8n, liquidId: 3 },
      }),
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

    await buys.load();
    await buys.recoverHistory(11);
    expect(buys.data.frameRewards[0]).toMatchObject({ bidCount: 1, latestBid: 25, requestedReward: 7_500_000n });

    for (const [nonce, spent, fee] of [
      [7n, 90_000_000n, 1_000_000n],
      [8n, 45_000_000n, 0n],
    ] as const) {
      const buy = buys.data.buys.find(buy => buy.argonPurchaseEvent?.transfer.gatewayActivityNonce === nonce)!;
      await buys.recordPurchase(buy.id, {
        ethereumTxHash: toHex(nonce, { size: 32 }),
        purchasedAt: new Date(block(10).blockTime),
        spentMicrogons: spent,
        ethereumFeeMicrogons: fee,
        usdcApprovalFeeMicrogons: 0n,
      });
    }
    chain.advance(14, 0n, 0n);
    await buys.refresh(block(14));
    await buys.recoverHistory(14);
    await buys.close();
    buys = new StabilizerBuys(chain.watch, chain.accountId, Promise.resolve(db));
    await buys.load();

    const saved = await db.stabilizerBuysTable.fetchAll(chain.accountId);
    expect(saved.buys).toHaveLength(2);
    for (const buy of saved.buys)
      expect(buy).toMatchObject({ status: StabilizerBuyStatus.Complete, purchaseArgonReleaseBlockNumber: 14 });
    const declined = saved.buys.find(buy => buy.argonPurchaseEvent?.transfer.gatewayActivityNonce === 8n)!;
    expect(declined.repayLiquidId).toBeUndefined();
    expect(StabilizerBuys.getRequestedLiquidId(declined)).toBe(3);
    expect(declined.releasedPrincipal).toBe(50_000_000n);
    expect(saved.frameRewards).toHaveLength(1);
    expect(saved.frameRewards[0]).toMatchObject({
      requestedReward: 7_500_000n,
      awardedReward: 5_000_000n,
      paidReward: 5_000_000n,
    });

    const positions = createStabilizerBuyFinancialPositions(buys.snapshot);
    expect(positions).toHaveLength(1);
    expect(positions[0]).toMatchObject({
      currentValue: 0n,
      settledPrincipalValue: 150_000_000n,
      paidIncome: 5_000_000n,
      investedCost: 136_001_000n,
      lifecycle: 'completed',
      returnIsComplete: true,
    });
    expect(calculatePositionReturn(positions)).toMatchObject({ availability: 'available', returnAmount: 18_999_000n });
  });

  it('preserves mounted history on failed backfill and merges an older replay with a newer live payout atomically', async () => {
    buys.data = reactive(buys.data) as StabilizerBuys['data'];
    const paidIncome = computed(() => createStabilizerBuyFinancialPositions(buys.snapshot)[0]?.paidIncome);
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
    const quote = chain.quote;
    await buys.createPurchase({ id: 'pending-local-buy', ethereumQuote: quote, ethereumMaxFeeWei: 100n });
    await buys.recordPurchase('pending-local-buy', {
      status: StabilizerBuyStatus.ConfirmingPurchaseOnEthereum,
      ethereumTxHash: toHex(55, { size: 32 }),
    });
    await buys.recordPurchase('pending-local-buy', {
      status: StabilizerBuyStatus.WaitingForArgonRecognition,
      ethereumConfirmedAt: new Date(block(10).blockTime),
      ethereumGatewayActivity: chain.ethereumGatewayActivity,
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
  });

  it.each(['live', 'restart'])('observes a relayed local buy and payout: %s', async mode => {
    chain.advance(mode === 'live' ? 5 : 20, 0n, 0n);

    const quote = chain.quote;
    await buys.createPurchase({ id: 'cold-local-buy', ethereumQuote: quote, ethereumMaxFeeWei: 100n });
    await buys.recordPurchase('cold-local-buy', {
      status: StabilizerBuyStatus.WaitingForArgonRecognition,
      ethereumTxHash: toHex(55, { size: 32 }),
      spentMicrogons: 90_000_000n,
      ethereumFeeMicrogons: 100n,
      usdcApprovalFeeMicrogons: 0n,
      purchaseEthereumBlockNumber: 5_000,
      ethereumConfirmedAt: new Date(block(9).blockTime),
      ethereumGatewayActivity: chain.ethereumGatewayActivity,
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
    const ethereumVerifier = {
      latestExecutionHeaderAnchorBlockHash: async () => toHex(anchor, { size: 32 }),
      executionHeaderAnchors: async () => {
        if (anchorUnavailable) throw new Error('Ethereum anchor RPC unavailable');
        return { blockNumber: anchor };
      },
    };
    Object.assign(chain.rawApi.query, { ethereumVerifier });
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

      // Quiet blocks reuse finalized progress while provisional inclusion stays live.
      const anchorRead = vi.spyOn(ethereumVerifier, 'executionHeaderAnchors');
      anchorUnavailable = true;
      proofIncluded = true;
      chain.advance(6, 0n, 0n);
      await buys.refresh(chain.watch.finalizedBlockHeader);
      expect(visibleProgress.value.currentStep).toBe(3);
      expect(visibleProgress.value.overallProgressPct).toBeCloseTo(200 / 3);
      expect(visibleStatus.value).toBe(StabilizerBuyStatus.WaitingForArgonRecognition);

      // Best-chain proof evidence can disappear; it cannot establish durable completion.
      proofIncluded = false;
      chain.advance(7, 0n, 0n);
      await buys.refresh(chain.watch.finalizedBlockHeader);
      expect(visibleProgress.value.currentStep).toBe(2);
      expect(visibleProgress.value.currentStepDetail).toBe('Waiting for Argon proof of 4,000 Ethereum blocks');
      expect(anchorRead).not.toHaveBeenCalled();

      anchor = 5_000n;
      chain.events.set(8, [
        eventRecord({
          section: 'ethereumVerifier',
          method: 'ExecutionHeaderAnchorImported',
          data: { blockHash: toHex(anchor, { size: 32 }), blockNumber: anchor },
        }),
      ]);
      chain.advance(8, 0n, 0n);
      proofIncluded = true;
      await buys.refresh(chain.watch.finalizedBlockHeader);
      expect(anchorRead).toHaveBeenCalledOnce();
      expect(visibleProgress.value.currentStep).toBe(3);

      // A failed finalized read retries on a quiet block without losing the last valid progress.
      anchorUnavailable = false;
      proofIncluded = false;
      chain.advance(9, 0n, 0n);
      await buys.refresh(chain.watch.finalizedBlockHeader);
      expect(visibleProgress.value.currentStep).toBe(2);
      expect(visibleProgress.value.currentStepDetail).toBe('Waiting for the gateway proof on Argon.');
      expect(anchorRead).toHaveBeenCalledTimes(2);

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

    expect(await db.transactionsTable.fetchAll()).toEqual([]);
    expect(buys.data.frameRewards[0].paidReward).toBe(5_000_000n);
  });
});

function chainHistory() {
  const registry = getOfflineRegistry();
  const metadata = new Metadata(registry, { metadata: { V16: registry.metadata } });
  const calls = decorateExtrinsics(registry, metadata.asLatest, metadata.version);
  const account = registry.createType('AccountId32', new Uint8Array(32).fill(17));
  const accountId = account.toString();
  const key = { args: [accountId, toHex(12n, { size: 8 })] } as const;
  const pendingAuctionKey = {
    args: [{ ascendingRank: toHex(15, { size: 8 }), orderedId: toHex(12, { size: 8 }) }],
  } as const;
  const maturingKeys: (typeof pendingAuctionKey)[] = [];
  const liquidRepayments = new Map<bigint, LiveQueryRecord<'stabilizerBuys', 'liquidRepaysByAccountAndGatewayNonce'>>();
  const framePrices = new Map<number, LiveQueryRecord<'bitcoinFissions', 'rValueHighWaterByFrame'>>();
  const nativePurchase = {
    principal: 100_000_000n,
    capturedDiscount: 40_000_000n,
    bidRate: BigNumber(0.25),
    positiveBidCount: 1,
    liquidRepaymentRewardRate: null,
    pendingLiquidRepays: 0n,
  } satisfies StabilizerBuy['purchase'];
  const market = { price: undefined as BigNumber | undefined, biddingOpen: false, competingBasis: 0n };
  let payableReward = 0n;
  let head = block(10);
  const headers = new Map([[head.blockNumber, head]]);
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
            principal: nativePurchase.principal,
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
          data: { account: accountId, principal: nativePurchase.principal, reward: 5_000_000n },
        }),
      ],
    ],
  ]);
  const quote: IStabilizerBuyQuote = {
    ...buyOpportunity.quote,
    chainId: 1,
    sourceAddress: buyer,
    gatewayAddress: gateway,
    adapterAddress: gateway,
    quoterAddress: gateway,
    poolId,
    poolManager: gateway,
    usdcToken: token,
    poolKey: { currency0: token, currency1: gateway, fee: 0, tickSpacing: 60, hooks: gateway },
    request: {
      ...buyOpportunity.quote.request,
      argonAccountId: toArgonAccountIdHex(accountId),
      maxUsdcIn: 90_000_000n,
      minMicrogonsOut: 100_000_000n,
    },
    quotedMicrogonsOut: 100_000_000n,
    sqrtPriceX96After: 2n,
  };
  const ethereumGatewayActivity: NonNullable<IStabilizerBuyRecord['ethereumGatewayActivity']> = {
    token,
    amount: purchase.data.transfer.amount,
    purchase: {
      ...purchase.data.purchase,
      repayLiquidId: 0n,
      repaySignature: '0x',
      usdcToken: token,
      poolManager: gateway,
      poolId,
      timestamp: 10n,
      buyer,
      argonAccountId: quote.request.argonAccountId,
    },
    gatewayState: { gatewayActivityNonce: 7n, argonApprovalsNonce: 1n, argonCirculation: 0n, argonotCirculation: 0n },
  };
  const rawApi = {
    registry,
    queryMulti: async (
      calls: readonly ((() => unknown) | readonly [(...args: unknown[]) => unknown, ...unknown[]])[],
    ) => Promise.all(calls.map(call => (typeof call === 'function' ? call() : call[0](...call.slice(1))))),
    consts: {
      bitcoinLocks: { argonTicksPerDay: 1440 },
      priceIndex: { maxDowntimeTicksBeforeReset: 10 },
      stabilizerBuys: {
        auctionInclusionPercent: BigNumber(0.9),
        maxPositiveBids: 4,
        purchaseHoldFrames: 30,
        maxPriceAgeTicks: 10,
      },
    },
    query: {
      bitcoinFissions: {
        rValueHighWaterByFrame: {
          multi: async (keys: readonly string[]) => keys.map(key => framePrices.get(Number(BigInt(key))) ?? null),
        },
      },
      crosschainTransfer: {
        gatewayStateBySourceChain: async () => {
          if (head.blockNumber < 10) return null;
          return { gatewayActivityNonce: 7n, argonApprovalsNonce: 1n, argonCirculation: 0n, argonotCirculation: 0n };
        },
      },
      priceIndex: {
        current: async () =>
          market.price && { argonUsdPrice: market.price, argonUsdTargetPrice: BigNumber(1), tick: head.tick },
      },
      miningSlot: {
        nextFrameId: async (): Promise<number> => head.frameId! + 1,
        frameRewardTicksRemaining: async () => 1,
      },
      stabilizerBuys: {
        bidsByAuction: {
          entries: async () => {
            const bids = [
              [
                {
                  args: [
                    12n,
                    [
                      nativePurchase.bidRate,
                      { descendingAmount: toHex(maxUint128 - 20_000_000n, { size: 16 }), orderedId: account.toHex() },
                    ],
                  ],
                },
                null,
              ],
            ];
            if (market.competingBasis > 0n)
              bids.push([
                {
                  args: [
                    12n,
                    [
                      BigNumber(0.1),
                      {
                        descendingAmount: toHex(maxUint128 - market.competingBasis, { size: 16 }),
                        orderedId: `0x${'22'.repeat(32)}`,
                      },
                    ],
                  ],
                },
                null,
              ]);
            return bids;
          },
        },
        matchingRate: async () => BigNumber(0.5),
        auctionAllocationQueue: { keys: async () => maturingKeys },
        approvedPool: async () =>
          market.price && { poolId, poolManager: gateway, usdcToken: token, chainId: 1n, argonIsToken0: true },
        buysByAccountAndFrame: {
          multi: async (keys: readonly (readonly [string, string])[]) =>
            keys.map(([, frame]) => {
              if (BigInt(frame) !== 12n || (nativePurchase.principal === 0n && liquidRepayments.size === 0))
                return null;
              return { ...nativePurchase, pendingLiquidRepays: BigInt(liquidRepayments.size) };
            }),
          entries: async () => {
            if (nativePurchase.principal === 0n && liquidRepayments.size === 0) return [];
            return [[key, { ...nativePurchase, pendingLiquidRepays: BigInt(liquidRepayments.size) }]];
          },
        },
        auctions: async () => ({
          matchingRate: BigNumber(0.5),
          totalMatchingBasis: 1_020_000_000n,
          budget: 50_000_000n,
          remainingBudget: market.biddingOpen ? 50_000_000n : 45_000_000n,
          remainingMatchingBasis: market.biddingOpen ? 918_000_000n : 898_000_000n,
          maturesAtFrame: 42,
        }),
        liquidRepaysByAccountAndGatewayNonce: {
          multi: async (keys: readonly (readonly [string, string])[]) =>
            keys.map(([, nonce]) => liquidRepayments.get(BigInt(nonce)) ?? null),
          entries: async () =>
            [...liquidRepayments].map(([nonce, repayment]) => [
              { args: [accountId, toHex(nonce, { size: 8 })] },
              repayment,
            ]),
        },
        payoutStateByAccount: async () => ({ payableReward, nextPayoutFrame: 42 }),
      },
    },
  };
  const api = runtimeClient(rawApi);
  const watch = {
    start: async () => undefined,
    latestHeaders: [head],
    get finalizedBlockHeader() {
      return head;
    },
    events: createTypedEventEmitter<{ finalized: (blocks: [IBlockHeaderInfo]) => void }>(),
    getApi: async () => api,
    getLatestFinalizedSnapshot: async () => ({ block: head, api }),
    getHeader: async (height: number) => headers.get(height) ?? block(height),
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
    purchase,
    quote,
    ethereumGatewayActivity,
    events,
    registry,
    api,
    rawApi,
    maturingKeys,
    pendingAuctionKey,
    nativePurchase,
    market,
    liquidRepayments,
    framePrices,
    advance(height: number, held: bigint, reward: bigint, frameId?: number) {
      head = block(height);
      if (frameId !== undefined) head.frameId = frameId;
      headers.set(height, head);
      watch.latestHeaders = [head];
      nativePurchase.principal = held;
      payableReward = reward;
      for (const [blockNumber, records] of events) {
        if (blockNumber > height) continue;
        for (const { event } of records) {
          if (event.section === 'stabilizerBuys' && event.method === 'BidSubmitted') {
            nativePurchase.bidRate = event.data.rewardRate;
            nativePurchase.positiveBidCount = event.data.positiveBidCount;
          }
        }
      }
    },
  };
}
