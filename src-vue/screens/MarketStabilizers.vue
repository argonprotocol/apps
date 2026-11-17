<template>
  <div class="flex min-h-0 grow flex-col">
    <Dashboard
      @editAlert="editAlert"
      @openRewards="openRewards"
      @openPurchase="openPurchase"
      @reviewPurchase="reviewPurchase"
    />
    <StabilizerBuyOverlay
      v-if="overlayView"
      :initialView="overlayView"
      @expired="expireOpportunity"
      @close="closeOverlays"
    />
    <StabilizerBuyAlertOverlay v-if="isEditingAlert" @close="closeOverlays" />
  </div>
</template>

<script setup lang="ts">
import { onScopeDispose, ref, shallowRef, watch } from 'vue';
import Dashboard from './market-stabilizers-screen/Dashboard.vue';
import StabilizerBuyOverlay, { type StabilizerBuyView } from '../overlays/StabilizerBuyOverlay.vue';
import StabilizerBuyAlertOverlay from '../overlays/StabilizerBuyAlertOverlay.vue';
import { useMarketStabilizers } from '../stores/marketStabilizers.ts';
import { useStabilizerBuyNavigation } from '../stores/stabilizerBuys.ts';

const market = useMarketStabilizers();
const navigation = useStabilizerBuyNavigation();
const overlayView = shallowRef<StabilizerBuyView>();
const isEditingAlert = ref(false);

function reviewPurchase() {
  closeOverlays();
  if (!market.hasAccess) return;

  if (!market.opportunity || market.opportunity.expiresAt <= Date.now()) {
    navigation.noticeError = 'This buying opportunity has expired. Watching for the next one.';
    return;
  }
  overlayView.value = { type: 'purchase', opportunity: market.opportunity };
}

function expireOpportunity() {
  closeOverlays();
  navigation.noticeError = 'This buying opportunity has expired. Watching for the next one.';
}

function closeOverlays() {
  navigation.cancelPendingNotice();
  clearOverlaySelection();
}

function clearOverlaySelection() {
  overlayView.value = undefined;
  isEditingAlert.value = false;
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
  overlayView.value = { type: 'purchase', buyId: id };
}

function openRewards(admissionFrame: number) {
  closeOverlays();
  overlayView.value = { type: 'details', admissionFrame };
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
onScopeDispose(() => navigation.cancelPendingNotice());
</script>
