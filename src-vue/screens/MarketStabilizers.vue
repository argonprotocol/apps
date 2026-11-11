<template>
  <div class="flex min-h-0 grow flex-col">
    <Dashboard
      @editAlert="editAlert"
      @openRewards="openRewards"
      @openPurchase="openPurchase"
      @reviewPurchase="reviewPurchase"
    />
    <StabilizerPurchaseOverlay
      v-if="reviewedOpportunity || selectedPurchase"
      :key="selectedPurchaseId ?? reviewSession"
      :buyId="selectedPurchaseId"
      :opportunity="reviewedOpportunity"
      @bid="openRewards"
      @purchased="openPurchase"
      @expired="expireOpportunity"
      @close="closeOverlays"
    />
    <StabilizerBuyAlertOverlay v-if="isEditingAlert" @close="closeOverlays" />
    <StabilizerBuyDetailOverlay
      v-if="selectedRewards"
      :key="selectedRewardFrame"
      :admissionFrame="selectedRewardFrame!"
      @close="closeOverlays"
    />
  </div>
</template>

<script setup lang="ts">
import { computed, onScopeDispose, ref, shallowRef, watch } from 'vue';
import Dashboard from './market-stabilizers-screen/Dashboard.vue';
import StabilizerPurchaseOverlay from '../overlays/StabilizerPurchaseOverlay.vue';
import StabilizerBuyAlertOverlay from '../overlays/StabilizerBuyAlertOverlay.vue';
import StabilizerBuyDetailOverlay from '../overlays/StabilizerBuyDetailOverlay.vue';
import { useMarketStabilizers } from '../stores/marketStabilizers.ts';
import { getStabilizerBuyAlerts, useStabilizerBuyNavigation } from '../stores/stabilizerBuys.ts';
import { useAttention } from '../stores/attention.ts';
import type { IStabilizerBuyOpportunity } from '../interfaces/IStabilizerBuyPurchase.ts';

const market = useMarketStabilizers();
const navigation = useStabilizerBuyNavigation();
const reviewedOpportunity = shallowRef<Extract<IStabilizerBuyOpportunity, { type: 'buy' }>>();
const reviewSession = ref(0);
const isEditingAlert = ref(false);
const selectedPurchaseId = ref<string>();
const selectedPurchase = computed(() => market.data.buys.find(buy => buy.id === selectedPurchaseId.value));
const selectedRewardFrame = ref<number>();
const selectedRewards = computed(() =>
  market.data.frameRewards.find(rewards => rewards.admissionFrame === selectedRewardFrame.value),
);

function reviewPurchase() {
  closeOverlays();
  if (!market.hasAccess) return;

  if (!market.opportunity || market.opportunity.expiresAt <= Date.now()) {
    navigation.noticeError = 'This buying opportunity has expired. Watching for the next one.';
    return;
  }
  reviewSession.value++;
  reviewedOpportunity.value = market.opportunity;
  useAttention().acknowledgeStabilizerBuy(reviewedOpportunity.value.key);
}

function expireOpportunity(opportunity: Extract<IStabilizerBuyOpportunity, { type: 'buy' }>) {
  closeOverlays();
  getStabilizerBuyAlerts()?.expireOpportunity(opportunity);
  navigation.noticeError = 'This buying opportunity has expired. Watching for the next one.';
}

function closeOverlays() {
  navigation.cancelPendingNotice();
  clearOverlaySelection();
}

function clearOverlaySelection() {
  reviewedOpportunity.value = undefined;
  isEditingAlert.value = false;
  selectedPurchaseId.value = undefined;
  selectedRewardFrame.value = undefined;
}

async function editAlert() {
  closeOverlays();
  try {
    if (await market.activate()) isEditingAlert.value = true;
  } catch (error) {
    navigation.noticeError = 'Unable to save setup. Please try again.';
    console.error('[MarketStabilizers] Unable to activate Stabilizer Buys', error);
  }
}

function openPurchase(id: string) {
  closeOverlays();
  selectedPurchaseId.value = id;
}

function openRewards(admissionFrame: number) {
  closeOverlays();
  selectedRewardFrame.value = admissionFrame;
}

watch(
  () => navigation.buyId,
  id => {
    if (!id) return;
    openPurchase(id);
    navigation.buyId = undefined;
  },
  { immediate: true },
);

watch(
  () => navigation.reviewBuy,
  open => {
    if (!open) return;
    reviewPurchase();
    navigation.reviewBuy = false;
  },
  { immediate: true },
);

watch(
  () => navigation.admissionFrame,
  frame => {
    if (frame === undefined) return;
    openRewards(frame);
    navigation.admissionFrame = undefined;
  },
  { immediate: true },
);

watch(
  () => navigation.noticeError,
  error => {
    if (error) clearOverlaySelection();
  },
);
watch(selectedPurchase, (purchase, previous) => {
  if (selectedPurchaseId.value === undefined) return;
  if (!purchase && previous) clearOverlaySelection();
});
watch(selectedRewards, (rewards, previous) => {
  if (selectedRewardFrame.value === undefined) return;
  if (!rewards && previous) clearOverlaySelection();
});
onScopeDispose(() => navigation.cancelPendingNotice());
</script>
