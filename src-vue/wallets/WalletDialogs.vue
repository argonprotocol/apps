<template>
  <div
    v-if="snapPreviewStyle"
    class="border-argon-500/70 pointer-events-none fixed rounded-xl border-2 shadow-[0_0_0_4px_rgba(183,76,186,0.18),0_0_28px_rgba(183,76,186,0.45)]"
    :style="snapPreviewStyle"
  />
  <WalletDialog
    v-for="wallet in openWallets"
    :key="wallet.id"
    :walletType="wallet.walletType"
    :pairedWalletType="wallet.pairedWalletType"
    :showGuidance="wallet.showGuidance"
    :guidanceContext="wallet.guidanceContext"
    :showBackdrop="wallet.showBackdrop"
    :zIndex="wallet.zIndex"
    :position="wallet.position"
    @focus="focusWallet(wallet.id)"
    @pair="pairWallet(wallet.id, $event)"
    @unpair="unpairWallet(wallet.id)"
    @positionChange="updateWalletGeometry(wallet.id, $event)"
    @dragMove="handleDragMove(wallet.id, $event)"
    @dragEnd="handleDragEnd(wallet.id, $event)"
    @close="closeWallet(wallet.id)"
  />
</template>

<script lang="ts">
import { ref } from 'vue';

export const openWalletOverlayCount = ref(0);
</script>

<script setup lang="ts">
import * as Vue from 'vue';
import basicEmitter, { type IWalletGuidanceContext } from '../emitters/basicEmitter.ts';
import { WalletType } from '../lib/Wallet.ts';
import { useBasics } from '../stores/basics.ts';
import { TopTab } from '../interfaces/IConfig.ts';
import { useCertificationController } from '../stores/certificationController.ts';
import { useWallets } from '../stores/wallets.ts';
import { releaseOverlayZIndex, reserveOverlayZIndex } from '../overlays/helpers/OverlayZIndex.ts';
import WalletDialog from './WalletDialog.vue';

type IOpenWallet = {
  id: number;
  walletType: WalletType.defaultArgon | WalletType.ethereum;
  pairedWalletType?: WalletType.defaultArgon | WalletType.ethereum;
  showGuidance: boolean;
  guidanceContext?: IWalletGuidanceContext;
  showBackdrop: boolean;
  zIndex: number;
  position: { x: number; y: number };
  rect?: DOMRectReadOnly;
};

const basics = useBasics();
const walletStore = useWallets();
const openWallets = Vue.ref<IOpenWallet[]>([]);
const snapPreview = Vue.ref<{
  draggedWalletId: number;
  targetWalletId: number;
  bounds: { top: number; left: number; width: number; height: number };
}>();
let nextWalletId = 1;

const certificationController = useCertificationController();
const isWalletScreenOpen = Vue.computed(() => certificationController?.selectedTab === TopTab.Dashboard);

function syncOverlayState() {
  basics.overlayIsOpen = openWallets.value.some(wallet => wallet.showBackdrop);
}

function focusWallet(id: number) {
  const wallet = openWallets.value.find(x => x.id === id);
  if (!wallet) return;
  wallet.zIndex = reserveOverlayZIndex(wallet.zIndex);
}

function closeWallet(id: number) {
  const wallet = openWallets.value.find(x => x.id === id);
  if (wallet) {
    releaseOverlayZIndex(wallet.zIndex);
  }

  openWallets.value = openWallets.value.filter(wallet => wallet.id !== id);
  if (snapPreview.value?.draggedWalletId === id || snapPreview.value?.targetWalletId === id) {
    snapPreview.value = undefined;
  }
  syncOverlayState();
}

function pairWallet(id: number, pairedWalletType: WalletType.defaultArgon | WalletType.ethereum) {
  const wallet = openWallets.value.find(x => x.id === id);
  if (!wallet || wallet.pairedWalletType) return;
  wallet.pairedWalletType = pairedWalletType;
  wallet.zIndex = reserveOverlayZIndex(wallet.zIndex);
}

function unpairWallet(id: number) {
  const wallet = openWallets.value.find(x => x.id === id);
  if (!wallet?.pairedWalletType) return;

  const pairedWalletType = wallet.pairedWalletType;
  const originalPosition = { ...wallet.position };
  const singleWalletWidth = (wallet.rect?.width ?? window.innerWidth * (8 / 12)) * (5 / 8);
  const centerOffset = (singleWalletWidth + 15) / 2;
  wallet.pairedWalletType = undefined;
  wallet.zIndex = reserveOverlayZIndex(wallet.zIndex);
  wallet.position = {
    x: originalPosition.x + centerOffset,
    y: originalPosition.y,
  };

  openWallets.value.push({
    id: nextWalletId++,
    walletType: pairedWalletType,
    showGuidance: false,
    showBackdrop: wallet.showBackdrop,
    zIndex: reserveOverlayZIndex(),
    position: {
      x: originalPosition.x - centerOffset,
      y: originalPosition.y,
    },
  });
  syncOverlayState();
}

function updateWalletGeometry(id: number, payload: { position: { x: number; y: number }; rect: DOMRectReadOnly }) {
  const wallet = openWallets.value.find(x => x.id === id);
  if (!wallet) return;

  wallet.position = payload.position;
  wallet.rect = payload.rect;
}

function handleDragMove(id: number, payload: { position: { x: number; y: number }; rect: DOMRectReadOnly }) {
  updateWalletGeometry(id, payload);

  const draggedWallet = openWallets.value.find(wallet => wallet.id === id);
  if (!draggedWallet || draggedWallet.pairedWalletType) {
    snapPreview.value = undefined;
    return;
  }

  const targetWallet = findSnapTarget(draggedWallet);
  if (!targetWallet?.rect || !draggedWallet.rect) {
    snapPreview.value = undefined;
    return;
  }

  snapPreview.value = {
    draggedWalletId: draggedWallet.id,
    targetWalletId: targetWallet.id,
    bounds: getCombinedBounds(draggedWallet.rect, targetWallet.rect),
  };
}

function handleDragEnd(id: number, payload: { position: { x: number; y: number }; rect: DOMRectReadOnly }) {
  updateWalletGeometry(id, payload);

  const draggedWallet = openWallets.value.find(wallet => wallet.id === id);
  if (!draggedWallet || draggedWallet.pairedWalletType) {
    snapPreview.value = undefined;
    return;
  }

  const previewTargetId = snapPreview.value?.draggedWalletId === id ? snapPreview.value.targetWalletId : undefined;
  const targetWallet = previewTargetId
    ? openWallets.value.find(wallet => wallet.id === previewTargetId)
    : findSnapTarget(draggedWallet);
  snapPreview.value = undefined;
  if (!targetWallet || !targetWallet.rect) return;

  const draggedIsLeft = payload.rect.left < targetWallet.rect.left;
  const primaryWalletType = draggedIsLeft ? targetWallet.walletType : draggedWallet.walletType;
  const pairedWalletType = draggedIsLeft ? draggedWallet.walletType : targetWallet.walletType;
  const primaryShowGuidance = draggedIsLeft ? targetWallet.showGuidance : draggedWallet.showGuidance;

  releaseOverlayZIndex(draggedWallet.zIndex);
  releaseOverlayZIndex(targetWallet.zIndex);
  openWallets.value = openWallets.value.filter(
    wallet => wallet.id !== draggedWallet.id && wallet.id !== targetWallet.id,
  );
  openWallets.value.push({
    id: draggedWallet.id,
    walletType: primaryWalletType,
    pairedWalletType,
    showGuidance: primaryShowGuidance,
    showBackdrop: draggedWallet.showBackdrop || targetWallet.showBackdrop,
    zIndex: reserveOverlayZIndex(),
    position: {
      x: (draggedWallet.position.x + targetWallet.position.x) / 2,
      y: (draggedWallet.position.y + targetWallet.position.y) / 2,
    },
  });
  syncOverlayState();
}

const snapPreviewStyle = Vue.computed(() => {
  if (!snapPreview.value) return;

  const padding = 8;
  const bounds = snapPreview.value.bounds;
  return {
    top: `${bounds.top - padding}px`,
    left: `${bounds.left - padding}px`,
    width: `${bounds.width + padding * 2}px`,
    height: `${bounds.height + padding * 2}px`,
    zIndex: Math.max(...openWallets.value.map(wallet => wallet.zIndex), 0) + 1,
  };
});

function getNextPosition() {
  const offset = (openWallets.value.length % 5) * 32;
  return { x: offset, y: offset };
}

function findSnapTarget(draggedWallet: IOpenWallet) {
  if (!draggedWallet.rect) return;

  return openWallets.value.find(candidate => {
    if (candidate.id === draggedWallet.id || candidate.pairedWalletType || !candidate.rect) return false;
    if (!canPairWallets(draggedWallet.walletType, candidate.walletType)) return false;

    const verticalDistance = Math.abs(getRectCenterY(draggedWallet.rect!) - getRectCenterY(candidate.rect));
    if (verticalDistance > 120) return false;

    const draggedIsLeft = draggedWallet.rect!.left < candidate.rect.left;
    const horizontalGap = draggedIsLeft
      ? candidate.rect.left - draggedWallet.rect!.right
      : draggedWallet.rect!.left - candidate.rect.right;

    return horizontalGap >= -10 && horizontalGap <= 10;
  });
}

function getRectCenterY(rect: DOMRectReadOnly) {
  return rect.top + rect.height / 2;
}

function getCombinedBounds(first: DOMRectReadOnly, second: DOMRectReadOnly) {
  const top = Math.min(first.top, second.top);
  const left = Math.min(first.left, second.left);
  const right = Math.max(first.right, second.right);
  const bottom = Math.max(first.bottom, second.bottom);

  return {
    top,
    left,
    width: right - left,
    height: bottom - top,
  };
}

function canPairWallets(
  first: WalletType.defaultArgon | WalletType.ethereum,
  second: WalletType.defaultArgon | WalletType.ethereum,
) {
  return isArgonWalletType(first) !== isArgonWalletType(second);
}

function isArgonWalletType(walletType: WalletType) {
  return walletType === WalletType.defaultArgon;
}

const openWalletOverlay = async (payload: {
  walletType: WalletType.defaultArgon | WalletType.ethereum;
  showGuidance?: boolean;
  guidanceContext?: IWalletGuidanceContext;
}) => {
  try {
    await walletStore.load();
  } catch (error) {
    console.error('Failed to refresh wallet balances before opening wallet overlay', error);
  }

  const existingWallet = openWallets.value.find(
    wallet =>
      !wallet.pairedWalletType &&
      wallet.walletType === payload.walletType &&
      wallet.showBackdrop === !isWalletScreenOpen.value,
  );
  if (existingWallet) {
    existingWallet.showGuidance = payload.showGuidance || false;
    existingWallet.guidanceContext = payload.guidanceContext;
    focusWallet(existingWallet.id);
    syncOverlayState();
    return;
  }

  openWallets.value.push({
    id: nextWalletId++,
    walletType: payload.walletType,
    showGuidance: payload.showGuidance || false,
    guidanceContext: payload.guidanceContext,
    showBackdrop: !isWalletScreenOpen.value,
    zIndex: reserveOverlayZIndex(),
    position: getNextPosition(),
  });
  syncOverlayState();
};

basicEmitter.on('openWalletOverlay', openWalletOverlay);

Vue.watch(isWalletScreenOpen, () => {
  syncOverlayState();
});

Vue.watch(
  () => openWallets.value.length,
  count => {
    openWalletOverlayCount.value = count;
  },
  { immediate: true },
);

Vue.onUnmounted(() => {
  basicEmitter.off('openWalletOverlay', openWalletOverlay);
  openWallets.value.forEach(wallet => releaseOverlayZIndex(wallet.zIndex));
  openWalletOverlayCount.value = 0;
});
</script>
