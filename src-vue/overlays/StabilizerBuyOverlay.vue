<template>
  <StabilizerPurchaseOverlay
    v-if="currentView.type === 'purchase'"
    :key="history.length"
    :buyId="currentView.buyId"
    :opportunity="currentView.opportunity"
    :initialLiquidId="currentView.liquidId"
    :liquids="market.availableLiquids"
    :repaymentWindows="market.liquidRepaymentWindows"
    :showGoBack="history.length > 0"
    @goBack="goBack"
    @bid="goTo({ type: 'details', admissionFrame: $event })"
    @purchased="currentView = { type: 'purchase', buyId: $event }"
    @expired="getStabilizerBuyAlerts()?.expireOpportunity($event)"
    @close="emit('close')"
  />
  <StabilizerBuyDetailOverlay
    v-else-if="currentView.type === 'details'"
    :admissionFrame="currentView.admissionFrame"
    :liquids="market.liquids"
    :showGoBack="history.length > 0"
    @goBack="goBack"
    @liquid="goTo({ type: 'liquid', liquidId: $event.liquidId })"
    @close="emit('close')"
  />
  <BitcoinLiquidDetailOverlay
    v-else-if="selectedLiquid"
    :liquid="selectedLiquid"
    :canPayDown="!!availableOpportunity && market.liquidRepaymentWindows.get(selectedLiquid.liquidId) === true"
    :showGoBack="history.length > 0"
    @goBack="goBack"
    @paydown="openPaydown"
    @viewPaydown="goTo({ type: 'details', admissionFrame: $event })"
    @close="emit('close')"
  />
</template>

<script lang="ts">
import type { IStabilizerBuyOpportunity } from '../interfaces/IStabilizerBuyPurchase.ts';

export type StabilizerBuyView =
  | {
      type: 'purchase';
      buyId?: string;
      opportunity?: Extract<IStabilizerBuyOpportunity, { type: 'buy' }>;
      liquidId?: number;
    }
  | { type: 'details'; admissionFrame: number }
  | { type: 'liquid'; liquidId: number };
</script>

<script setup lang="ts">
import { computed, shallowRef, watch } from 'vue';
import { useNow } from '@vueuse/core';
import StabilizerPurchaseOverlay from './StabilizerPurchaseOverlay.vue';
import StabilizerBuyDetailOverlay from './StabilizerBuyDetailOverlay.vue';
import BitcoinLiquidDetailOverlay from './BitcoinLiquidDetailOverlay.vue';
import { useMarketStabilizers } from '../stores/marketStabilizers.ts';
import { getStabilizerBuyAlerts, getStabilizerBuys } from '../stores/stabilizerBuys.ts';
import { useAttention } from '../stores/attention.ts';
import type { BitcoinLiquid } from '../lib/BitcoinLiquid.ts';

const props = defineProps<{ initialView: StabilizerBuyView }>();
const emit = defineEmits<{ close: [] }>();
const market = useMarketStabilizers();
const currentView = shallowRef(props.initialView);
const history = shallowRef<StabilizerBuyView[]>([]);
watch(
  () => {
    const view = currentView.value;
    if (view.type !== 'purchase' || view.buyId) return;
    const poolId = view.opportunity?.quote.poolId ?? market.data.market?.approvedPool?.poolId;
    return getStabilizerBuys().pendingEthereumPurchases.find(buy => buy.ethereumQuote.poolId === poolId)?.id;
  },
  buyId => {
    if (buyId) currentView.value = { type: 'purchase', buyId };
  },
  { immediate: true },
);
watch(
  () => props.initialView,
  view => {
    history.value = [];
    currentView.value = view;
  },
);

const now = useNow({ interval: 1_000 });
const availableOpportunity = computed(() => {
  if (!market.hasAccess) return;
  if (!market.opportunity || market.opportunity.expiresAt <= now.value.getTime()) return;
  return market.opportunity;
});
const selectedLiquid = computed(() => {
  const view = currentView.value;
  if (view.type !== 'liquid') return;
  return market.liquids.find(liquid => liquid.liquidId === view.liquidId);
});

watch(
  () => {
    const view = currentView.value;
    if (view.type !== 'purchase' || !view.buyId) return;
    return market.data.buys.find(buy => buy.id === view.buyId)?.admissionFrame;
  },
  admissionFrame => {
    if (admissionFrame !== undefined) currentView.value = { type: 'details', admissionFrame };
  },
  { immediate: true },
);

function goTo(view: StabilizerBuyView) {
  history.value = [...history.value, currentView.value];
  currentView.value = view;
}

function goBack() {
  const previous = history.value.at(-1);
  if (!previous) return;
  history.value = history.value.slice(0, -1);
  currentView.value = previous;
}

function openPaydown(liquid: BitcoinLiquid) {
  const opportunity = market.opportunity;
  if (!market.hasAccess || !opportunity || opportunity.expiresAt <= Date.now()) return;
  if (market.liquidRepaymentWindows.get(liquid.liquidId) !== true) return;
  goTo({ type: 'purchase', opportunity, liquidId: liquid.liquidId });
}

watch(
  currentView,
  view => {
    if (view.type === 'purchase' && view.opportunity) {
      useAttention().acknowledgeStabilizerBuy(view.opportunity.key);
    }
  },
  { immediate: true },
);

watch(
  () => {
    const view = currentView.value;
    if (view.type === 'liquid') return selectedLiquid.value;
    if (view.type === 'details')
      return market.data.frameRewards.find(rewards => rewards.admissionFrame === view.admissionFrame);
    if (view.buyId) return market.data.buys.find(buy => buy.id === view.buyId);
    return view.opportunity;
  },
  (record, previous) => {
    if (!record && previous) emit('close');
  },
);
</script>
