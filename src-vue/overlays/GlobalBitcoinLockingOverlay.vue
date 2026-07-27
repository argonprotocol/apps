<template>
  <BitcoinLockingOverlay
    v-if="isOpen"
    :coupon="bitcoinLockCoupons.currentCoupon"
    :currentTick="currentTick"
    :personalLock="personalLock"
    :vault="defaultVault"
    @close="closeOverlay"
  />
</template>

<script setup lang="ts">
import * as Vue from 'vue';
import type { IBitcoinLockRecord } from '../lib/db/BitcoinLocksTable.ts';
import BitcoinLockingOverlay from './BitcoinLockingOverlay.vue';
import basicEmitter from '../emitters/basicEmitter.ts';
import { getBitcoinLockCoupons } from '../stores/bitcoin.ts';
import { getMiningFrames } from '../stores/mainchain.ts';
import { getMyVault, getVaults } from '../stores/vaults.ts';

const bitcoinLockCoupons = getBitcoinLockCoupons();
const miningFrames = getMiningFrames();
const myVault = getMyVault();
const vaults = getVaults();
const isOpen = Vue.ref(false);
const currentTick = Vue.ref(0);
const personalLock = Vue.ref<IBitcoinLockRecord>();
const defaultVault = Vue.computed(() => {
  const vaultId = myVault.vaultId;
  if (vaultId) return myVault.createdVault ?? vaults.vaultsById[vaultId];

  const couponVaultId = bitcoinLockCoupons.currentCoupon?.coupon.vaultId;
  return couponVaultId ? vaults.vaultsById[couponVaultId] : undefined;
});

function openOverlay(args?: { lock?: IBitcoinLockRecord }) {
  personalLock.value = args?.lock;
  isOpen.value = true;
}

function closeOverlay(shouldStartNewLocking: boolean) {
  isOpen.value = false;
  personalLock.value = undefined;
  if (shouldStartNewLocking) Vue.nextTick(() => openOverlay());
}

function closeFromGlobalRequest() {
  closeOverlay(false);
}

let unsubscribeTicks: (() => void) | undefined;

Vue.onMounted(async () => {
  basicEmitter.on('openBitcoinLock', openOverlay);
  basicEmitter.on('closeAllOverlays', closeFromGlobalRequest);
  void bitcoinLockCoupons.refresh().catch(error => {
    console.error('Unable to refresh Bitcoin lock coupons', error);
  });
  await miningFrames.load();
  currentTick.value = miningFrames.currentTick;
  unsubscribeTicks = miningFrames.onTick(() => {
    currentTick.value = miningFrames.currentTick;
  }).unsubscribe;
});

Vue.onUnmounted(() => {
  basicEmitter.off('openBitcoinLock', openOverlay);
  basicEmitter.off('closeAllOverlays', closeFromGlobalRequest);
  unsubscribeTicks?.();
});
</script>
