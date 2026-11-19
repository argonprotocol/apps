import { computed, shallowRef, watch } from 'vue';
import { defineStore } from 'pinia';
import { getStabilizerBuyBidNotice } from '../lib/Alerts.ts';
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
    useAttention().acknowledgeStabilizerBuy(current.key);
    if (current.type === 'buy') {
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

/** Stabilizer notices only; other domain alerts remain in their existing screens and alert bars. */
export const useAttention = defineStore('attention', () => {
  const buys = getStabilizerBuys();

  const acknowledgedKeys = shallowRef(new Set<string>());
  const bidNotice = computed(() => getStabilizerBuyBidNotice(buys));
  const buyNotice = computed(() => getStabilizerBuyAlerts()?.buyNotice);
  const stabilizerBid = computed(() => {
    const notice = bidNotice.value;
    if (notice && !acknowledgedKeys.value.has(notice.key)) return notice;
  });
  const stabilizerBuyOpportunity = computed(() => {
    const notice = buyNotice.value;
    if (notice && !acknowledgedKeys.value.has(notice.key)) return notice;
  });

  watch(
    [bidNotice, buyNotice],
    notices => {
      const keys = notices.map(notice => notice?.key);
      acknowledgedKeys.value = new Set([...acknowledgedKeys.value].filter(key => keys.includes(key)));
    },
    { flush: 'sync' },
  );

  function acknowledgeStabilizerBuy(key: string): void {
    if (bidNotice.value?.key !== key && buyNotice.value?.key !== key) return;
    acknowledgedKeys.value = new Set([...acknowledgedKeys.value, key]);
  }

  const count = computed(() => (stabilizerBid.value ? 1 : 0) + (stabilizerBuyOpportunity.value ? 1 : 0));

  // Refreshing amounts does not create a new action or restart the bell.
  const actionKeys = computed(() => {
    const keys: string[] = [];
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
    stabilizerBid,
    stabilizerBuyOpportunity,
    count,
    actionKeys,
    hasUnseenActions,
    markViewed,
    acknowledgeStabilizerBuy,
  };
});
