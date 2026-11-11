import { beforeEach, expect, it, vi } from 'vitest';
import { computed, nextTick, reactive, shallowRef } from 'vue';
import { createPinia, setActivePinia } from 'pinia';
import { StabilizerBuy } from '@argonprotocol/apps-core';
import BigNumber from 'bignumber.js';
import { useAttention, openStabilizerBuyNotice } from '../stores/attention.ts';
import { getStabilizerBuys, getStabilizerBuyAlerts, useStabilizerBuyNavigation } from '../stores/stabilizerBuys.ts';
import { getBitcoinLocks } from '../stores/bitcoin.ts';
import { getMyVault } from '../stores/vaults.ts';
import { useCertificationController } from '../stores/certificationController.ts';
import { updateAppBadge, notifyStabilizerBuyOpportunity } from '../lib/SystemNotifications.ts';
import { onAction, isPermissionGranted, sendNotification, type Options } from '@tauri-apps/plugin-notification';
import { PluginListener } from '@tauri-apps/api/core';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { TopTab } from '../interfaces/IConfig.ts';
import { BitcoinLockStatus } from '../interfaces/IBitcoinLockRecord.ts';
import { createLock } from './helpers/bitcoin.ts';
import { buyOpportunity } from './helpers/stabilizerBuy.ts';
import basicEmitter from '../emitters/basicEmitter.ts';
import { getStabilizerBuyBidNotice } from '../lib/Alerts.ts';

vi.mock('../stores/stabilizerBuys.ts', async importOriginal => ({
  ...(await importOriginal<typeof import('../stores/stabilizerBuys.ts')>()),
  getStabilizerBuys: vi.fn(),
  getStabilizerBuyAlerts: vi.fn(),
}));
vi.mock('../stores/bitcoin.ts', () => ({ getBitcoinLocks: vi.fn() }));
vi.mock('../stores/vaults.ts', () => ({ getMyVault: vi.fn() }));
vi.mock('../stores/certificationController.ts', () => ({ useCertificationController: vi.fn() }));
vi.mock('@tauri-apps/api/core', async importOriginal => ({
  ...(await importOriginal<typeof import('@tauri-apps/api/core')>()),
  isTauri: () => true,
}));
vi.mock('@tauri-apps/api/window', () => ({ getCurrentWindow: vi.fn() }));
vi.mock('@tauri-apps/plugin-notification', () => ({
  onAction: vi.fn(),
  isPermissionGranted: vi.fn(),
  requestPermission: vi.fn(),
  sendNotification: vi.fn(),
}));

beforeEach(() => {
  setActivePinia(createPinia());
  vi.mocked(getStabilizerBuys).mockReturnValue({
    data: { positions: [] },
  } as unknown as ReturnType<typeof getStabilizerBuys>);
  vi.mocked(getStabilizerBuyAlerts).mockReturnValue(undefined);
  vi.mocked(getBitcoinLocks).mockReturnValue({ getActiveLocks: () => [] } as unknown as ReturnType<
    typeof getBitcoinLocks
  >);
  vi.mocked(getMyVault).mockReturnValue({ collectBuilder: { getNotice: () => undefined } } as unknown as ReturnType<
    typeof getMyVault
  >);
  const controller = reactive({
    operationalInvites: [],
    selectedTab: TopTab.Home,
    setTab: vi.fn((tab: TopTab) => {
      controller.selectedTab = tab;
    }),
  });
  vi.mocked(useCertificationController).mockReturnValue(
    controller as unknown as ReturnType<typeof useCertificationController>,
  );
});

it('removes a reward-bid action when it becomes funded or closes, and keeps deliberate opt-outs quiet', async () => {
  const owner = `0x${'33'.repeat(32)}`;
  const position = new StabilizerBuy(
    12,
    {
      pendingLiquidRepays: 0n,
      liquidRepaymentRewardRate: null,
      principal: 100_000_000n,
      capturedDiscount: 100n,
      bidRate: BigNumber(0.8),
      positiveBidCount: 1,
    },
    {
      matchingRate: BigNumber(1),
      totalMatchingBasis: 200n,
      budget: 180n,
      remainingBudget: 180n,
      remainingMatchingBasis: 180n,
      maturesAtFrame: 42,
    },
  );
  const data = reactive({
    market: { auctionInclusionPercent: BigNumber(0.9) },
    frameRewards: [] as ReturnType<typeof getStabilizerBuys>['data']['frameRewards'],
    positions: [position],
    currentFrameId: 13,
    auctionsByFrame: {
      12: {
        auction: position.auction,
        observedAtFrame: 13,
        bids: [
          { ownerAccount: owner, latestBid: 80, matchingBasis: 100n },
          { ownerAccount: `0x${'11'.repeat(32)}`, latestBid: 40, matchingBasis: 100n },
        ],
      },
    },
  });
  vi.mocked(getStabilizerBuys).mockReturnValue({ accountAddress: owner, data } as unknown as ReturnType<
    typeof getStabilizerBuys
  >);

  const attention = useAttention();
  vi.mocked(getStabilizerBuyAlerts).mockReturnValue({
    resolveNotice: async (key: string) => {
      const notice = getStabilizerBuyBidNotice(vi.mocked(getStabilizerBuys)());
      if (notice?.key === key) return notice;
    },
  } as unknown as ReturnType<typeof getStabilizerBuyAlerts>);
  const visibleCount = computed(() => attention.count);
  expect(attention.stabilizerBid?.position.admissionFrame).toBe(12);
  expect(attention.stabilizerBid?.bid).toMatchObject({ latestBid: 80, requestedReward: 80n, fundingEstimate: 64n });
  expect(visibleCount.value).toBe(1);
  const bidNotice = attention.stabilizerBid!;
  await openStabilizerBuyNotice(bidNotice);
  expect(useStabilizerBuyNavigation().admissionFrame).toBe(12);

  data.auctionsByFrame[12].bids[0].latestBid = 30;
  expect(attention.stabilizerBid).toBeUndefined();
  expect(visibleCount.value).toBe(0);

  data.auctionsByFrame[12].bids[0].latestBid = 80;
  expect(visibleCount.value).toBe(1);
  data.currentFrameId = 14;
  expect(visibleCount.value).toBe(0);
  await openStabilizerBuyNotice(bidNotice);
  expect(useStabilizerBuyNavigation().admissionFrame).toBeUndefined();
  expect(useStabilizerBuyNavigation().noticeError).toContain('expired');

  data.currentFrameId = 13;
  data.positions[0] = new StabilizerBuy(12, { ...position.purchase, bidRate: BigNumber(0) }, position.auction);
  expect(visibleCount.value).toBe(0);
  data.positions[0] = new StabilizerBuy(
    12,
    { ...position.purchase, bidRate: BigNumber(0), positiveBidCount: 0 },
    position.auction,
  );
  expect(visibleCount.value).toBe(1);
  const location = { blockNumber: 10, blockHash: '0x10', blockTime: Date.UTC(2026, 0, 1), eventIndex: 0 };
  data.frameRewards.push({
    ownerAccount: owner,
    admissionFrame: 12,
    latestBid: 0,
    bidCount: 0,
    paidReward: 0n,
    bidFees: [],
    createdAt: new Date(location.blockTime),
    updatedAt: new Date(location.blockTime),
    lastUpdatedArgonBlock: 10,
    bidEvent: { ...location, admissionFrame: 12, rewardRate: BigNumber(0), positiveBidCount: 0 },
  });
  expect(visibleCount.value).toBe(0);
});

it('routes a desktop click through current notice state and does not reopen an expired quote after replacement', async () => {
  let current = buyOpportunity;
  let pendingObservation: Promise<void> | undefined;
  let now = Date.now();
  const clock = vi.spyOn(Date, 'now').mockImplementation(() => now);
  vi.mocked(getStabilizerBuyAlerts).mockReturnValue({
    resolveNotice: async (key: string) => {
      await pendingObservation;
      return current.key === key ? current : undefined;
    },
  } as unknown as ReturnType<typeof getStabilizerBuyAlerts>);
  let click!: Parameters<typeof onAction>[0];
  vi.mocked(onAction).mockImplementation(async callback => {
    click = callback;
    return new PluginListener('notification', 'actionPerformed', 1);
  });
  vi.mocked(isPermissionGranted).mockResolvedValue(true);
  vi.mocked(getCurrentWindow).mockReturnValue({
    unminimize: vi.fn().mockResolvedValue(undefined),
    show: vi.fn().mockResolvedValue(undefined),
    setFocus: vi.fn().mockResolvedValue(undefined),
  } as unknown as ReturnType<typeof getCurrentWindow>);
  basicEmitter.on('openStabilizerBuyNotice', openStabilizerBuyNotice);
  try {
    await notifyStabilizerBuyOpportunity(() => current);
    const notification = vi.mocked(sendNotification).mock.lastCall![0] as Options;
    const event = { actionId: 'tap', inputValue: null, notification: { extra: notification.extra } } as Parameters<
      Parameters<typeof onAction>[0]
    >[0];
    click(event);
    await vi.waitFor(() => expect(useStabilizerBuyNavigation().reviewBuy).toBe(true));

    let finishObservation!: () => void;
    pendingObservation = new Promise<void>(resolve => {
      finishObservation = resolve;
    });
    const opening = openStabilizerBuyNotice(current);
    useCertificationController().setTab(TopTab.Home);
    finishObservation();
    await opening;
    expect(useStabilizerBuyNavigation().reviewBuy).toBe(false);
    expect(useStabilizerBuyNavigation().admissionFrame).toBeUndefined();
    expect(useStabilizerBuyNavigation().noticeError).toBeUndefined();

    pendingObservation = new Promise<void>(resolve => {
      finishObservation = resolve;
    });
    const superseded = openStabilizerBuyNotice(current);
    // Opening or closing a page workflow cancels the older notice intent through this owner.
    useStabilizerBuyNavigation().cancelPendingNotice();
    finishObservation();
    await superseded;
    expect(useStabilizerBuyNavigation().reviewBuy).toBe(false);
    expect(useStabilizerBuyNavigation().admissionFrame).toBeUndefined();
    expect(useStabilizerBuyNavigation().noticeError).toBeUndefined();

    now = buyOpportunity.expiresAt;
    current = { ...buyOpportunity, expiresAt: now + 60_000 };
    click(event);
    await vi.waitFor(() => expect(useStabilizerBuyNavigation().noticeError).toContain('expired'));
    expect(useStabilizerBuyNavigation().reviewBuy).toBe(false);
    expect(useStabilizerBuyNavigation().admissionFrame).toBeUndefined();
  } finally {
    basicEmitter.off('openStabilizerBuyNotice', openStabilizerBuyNotice);
    clock.mockRestore();
  }
});

it('combines same-type Bitcoin notices into one live action with their total amount', () => {
  const locks = reactive([
    createLock({ uuid: 'synthetic-lock-a', status: BitcoinLockStatus.LockFunded, createdAt: '2026-01-01' }),
    createLock({ uuid: 'synthetic-lock-b', status: BitcoinLockStatus.LockFunded, createdAt: '2026-01-01' }),
  ]);
  locks[0].securitizationCoverageMicrogons = 100_000_000n;
  locks[1].securitizationCoverageMicrogons = 200_000_000n;
  vi.mocked(getBitcoinLocks).mockReturnValue({
    getActiveLocks: () => locks,
    releases: { getActiveForLock: () => undefined },
    getLockUnlockReleaseState: () => ({ isReleaseStatus: false }),
    isLockFunded: () => true,
    unlockDeadlineTime: () => Date.now() + 60_000,
  } as unknown as ReturnType<typeof getBitcoinLocks>);

  const attention = useAttention();
  const visibleCount = computed(() => attention.count);
  expect(visibleCount.value).toBe(1);
  expect(attention.bitcoinAlertGroups).toHaveLength(1);
  expect(attention.bitcoinAlertGroups[0].notices).toHaveLength(2);
  expect(attention.bitcoinAlertGroups[0].amountMicrogons).toBe(300_000_000n);
  expect(attention.hasUnseenActions).toBe(true);

  attention.markViewed();
  locks[0].securitizationCoverageMicrogons = 150_000_000n;
  expect(attention.hasUnseenActions).toBe(false);
  expect(visibleCount.value).toBe(1);

  locks.pop();
  expect(visibleCount.value).toBe(1);
  expect(attention.bitcoinAlertGroups[0].amountMicrogons).toBe(150_000_000n);
  expect(attention.hasUnseenActions).toBe(false);

  locks.push(createLock({ uuid: 'synthetic-lock-c', status: BitcoinLockStatus.LockFunded, createdAt: '2026-01-01' }));
  expect(visibleCount.value).toBe(1);
  expect(attention.hasUnseenActions).toBe(true);
  attention.markViewed();
  const returning = locks.pop()!;
  locks.pop();
  expect(visibleCount.value).toBe(0);
  expect(attention.hasUnseenActions).toBe(false);
  locks.push(returning);
  expect(attention.hasUnseenActions).toBe(true);
});

it('acknowledges only the opened buy opportunity and keeps a refreshed quote quiet', async () => {
  const notice = shallowRef<typeof buyOpportunity>();
  notice.value = buyOpportunity;
  vi.mocked(getStabilizerBuyAlerts).mockReturnValue({
    get buyNotice() {
      return notice.value;
    },
    resolveNotice: async (key: string) => (notice.value?.key === key ? notice.value : undefined),
  } as ReturnType<typeof getStabilizerBuyAlerts>);
  const invite = { inviteCode: 'synthetic-invite', operationsUpgradeRequestedAt: new Date() };
  const controller = useCertificationController();
  controller.operationalInvites.push(invite as (typeof controller.operationalInvites)[number]);

  const attention = useAttention();
  expect(attention.count).toBe(2);
  attention.markViewed();
  expect(attention.count).toBe(2);

  await openStabilizerBuyNotice(buyOpportunity);
  expect(useStabilizerBuyNavigation().reviewBuy).toBe(true);
  expect(attention.stabilizerBuyOpportunity).toBeUndefined();
  expect(attention.pendingOperationsUpgradeRequests).toHaveLength(1);
  expect(attention.count).toBe(1);

  notice.value = { ...buyOpportunity, apy: buyOpportunity.apy + 1 };
  expect(attention.stabilizerBuyOpportunity).toBeUndefined();
  expect(attention.count).toBe(1);

  notice.value = { ...buyOpportunity, key: 'buy:new-opportunity' };
  expect(attention.stabilizerBuyOpportunity?.key).toBe('buy:new-opportunity');
  expect(attention.count).toBe(2);
  attention.acknowledgeStabilizerBuy('buy:new-opportunity');
  notice.value = undefined;
  await nextTick();
  notice.value = { ...buyOpportunity, key: 'buy:new-opportunity' };
  expect(attention.count).toBe(2);
});

it('serializes native badge updates so a late platform response cannot restore a resolved action', async () => {
  let nativeCount: number | undefined;
  let finishFirst!: () => void;
  const first = new Promise<void>(resolve => {
    finishFirst = resolve;
  });
  vi.mocked(getCurrentWindow).mockReturnValue({
    setBadgeCount: async (count?: number) => {
      if (count === 2) await first;
      nativeCount = count;
    },
  } as unknown as ReturnType<typeof getCurrentWindow>);

  const pending = updateAppBadge(2);
  const resolved = updateAppBadge(0);
  finishFirst();
  await Promise.all([pending, resolved]);
  expect(nativeCount).toBeUndefined();
});
