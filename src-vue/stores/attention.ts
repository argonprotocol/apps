import { computed, ref, shallowRef, watch } from 'vue';
import { defineStore } from 'pinia';
import { getBitcoinAlertNotices, getStabilizerBuyBidNotice, type IBitcoinAlert } from '../lib/Alerts.ts';
import { getBitcoinLocks } from './bitcoin.ts';
import { getMyVault } from './vaults.ts';
import { useCertificationController } from './certificationController.ts';
import { getStabilizerBuys, getStabilizerBuyAlerts, useStabilizerBuyNavigation } from './stabilizerBuys.ts';
import type { IStabilizerBuyOpportunity } from '../interfaces/IStabilizerBuyPurchase.ts';
import { TopTab } from '../interfaces/IConfig.ts';
import basicEmitter from '../emitters/basicEmitter.ts';

export async function openStabilizerBuyNotice({
  key,
  expiresAt,
}: Pick<IStabilizerBuyOpportunity, 'key' | 'expiresAt'>): Promise<void> {
  const navigation = useStabilizerBuyNavigation();
  navigation.cancelPendingNotice();
  const requestId = navigation.noticeRequestId;
  const controller = useCertificationController();
  basicEmitter.emit('closeAllOverlays');
  navigation.buyId = undefined;
  navigation.admissionFrame = undefined;
  navigation.reviewBuy = false;
  navigation.noticeError = 'Checking the current Stabilizer Buy opportunity…';
  controller.setTab(TopTab.MarketStabilizers);

  try {
    let current: IStabilizerBuyOpportunity | undefined;
    if (expiresAt === undefined || expiresAt > Date.now()) {
      current = await getStabilizerBuyAlerts()?.resolveNotice(key);
      if (expiresAt !== undefined && expiresAt <= Date.now()) current = undefined;
    }

    if (requestId !== navigation.noticeRequestId) return;
    if (controller.selectedTab !== TopTab.MarketStabilizers) return;

    if (!current) {
      navigation.noticeError =
        'This Stabilizer Buy notice has expired or no longer needs attention. Review the current opportunities below.';
      return;
    }

    navigation.noticeError = undefined;
    if (current.type === 'buy') {
      useAttention().acknowledgeStabilizerBuy(current.key);
      navigation.reviewBuy = true;
    } else navigation.admissionFrame = current.position.admissionFrame;
  } catch (error) {
    if (requestId !== navigation.noticeRequestId) return;
    if (controller.selectedTab !== TopTab.MarketStabilizers) return;
    console.warn('[Stabilizer Buy] Unable to check the current notice', error);
    navigation.noticeError =
      'Unable to check this Stabilizer Buy notice. Review the current opportunities or try again.';
  } finally {
    if (requestId === navigation.noticeRequestId && controller.selectedTab !== TopTab.MarketStabilizers) {
      navigation.noticeError = undefined;
    }
  }
}

/** A projection of unresolved domain actions. Opening the menu does not acknowledge them. */
export const useAttention = defineStore('attention', () => {
  const bitcoinLocks = getBitcoinLocks();
  const myVault = getMyVault();
  const controller = useCertificationController();
  const buys = getStabilizerBuys();

  const vaultAlert = computed(() => myVault.collectBuilder.getNotice());
  const bitcoinAlertGroups = computed(() => {
    const groups = new Map<IBitcoinAlert['kind'], IBitcoinAlert[]>();
    for (const notice of getBitcoinAlertNotices(bitcoinLocks)) {
      const notices = groups.get(notice.kind) ?? [];
      notices.push(notice);
      groups.set(notice.kind, notices);
    }

    return [...groups.values()].map(notices => ({
      notices,
      amountMicrogons: notices.reduce((sum, notice) => sum + notice.amountMicrogons, 0n),
    }));
  });
  const pendingOperationsUpgradeRequests = computed(() =>
    controller.operationalInvites.filter(
      invite => invite.operationsUpgradeRequestedAt && !invite.accessProof && !invite.operationsUpgradedAt,
    ),
  );

  const stabilizerBid = computed(() => getStabilizerBuyBidNotice(buys));

  const acknowledgedBuyKey = ref<string>();
  const buyNotice = computed(() => getStabilizerBuyAlerts()?.buyNotice);
  const stabilizerBuyOpportunity = computed(() => {
    const notice = buyNotice.value;
    if (notice?.key !== acknowledgedBuyKey.value) return notice;
  });

  watch(buyNotice, notice => {
    if (notice?.key !== acknowledgedBuyKey.value) acknowledgedBuyKey.value = undefined;
  });

  function acknowledgeStabilizerBuy(key: string): void {
    if (buyNotice.value?.key === key) acknowledgedBuyKey.value = key;
  }

  const count = computed(
    () =>
      (vaultAlert.value ? 1 : 0) +
      bitcoinAlertGroups.value.length +
      (pendingOperationsUpgradeRequests.value.length ? 1 : 0) +
      (stabilizerBid.value ? 1 : 0) +
      (stabilizerBuyOpportunity.value ? 1 : 0),
  );

  // Refreshing amounts does not create a new action or restart the bell.
  const actionKeys = computed(() => {
    const keys = bitcoinAlertGroups.value.flatMap(group =>
      group.notices.map(notice => `${notice.kind}:${notice.lock.uuid}`),
    );
    if (vaultAlert.value) keys.push('vault');
    for (const invite of pendingOperationsUpgradeRequests.value) keys.push(`upgrade:${invite.inviteCode}`);

    const bid = stabilizerBid.value;
    if (bid) keys.push(bid.key);
    if (stabilizerBuyOpportunity.value) keys.push(stabilizerBuyOpportunity.value.key);
    return keys;
  });
  const viewedActionKeys = shallowRef(new Set<string>());
  const hasUnseenActions = computed(() => actionKeys.value.some(key => !viewedActionKeys.value.has(key)));

  watch(
    actionKeys,
    keys => {
      viewedActionKeys.value = new Set([...viewedActionKeys.value].filter(key => keys.includes(key)));
    },
    { flush: 'sync' },
  );

  function markViewed(): void {
    viewedActionKeys.value = new Set(actionKeys.value);
  }

  return {
    vaultAlert,
    bitcoinAlertGroups,
    pendingOperationsUpgradeRequests,
    stabilizerBid,
    stabilizerBuyOpportunity,
    count,
    actionKeys,
    hasUnseenActions,
    markViewed,
    acknowledgeStabilizerBuy,
  };
});
