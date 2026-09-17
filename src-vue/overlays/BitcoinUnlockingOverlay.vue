<template>
  <OverlayBase
    :isOpen="true"
    data-testid="BitcoinUnlockingOverlay"
    :data-e2e-state="releaseE2eState"
    class="w-120"
    @close="closeOverlay"
    @pressEsc="closeOverlay"
  >
    <template #title>
      <div class="text-xl font-bold text-slate-800/80">Send Bitcoin</div>
    </template>

    <div class="px-6 py-5">
      <BitcoinSend
        v-if="personalLock && !releaseState.isReleaseStatus && !releaseState.isReleaseComplete"
        :personalLock="personalLock"
        :externalError="myVault.data.finalizeMyBitcoinError?.error"
        @done="closeOverlay"
      />
      <div v-else class="rounded-md bg-amber-50 px-4 py-3 text-sm text-amber-800">
        This Bitcoin channel is no longer available.
      </div>
    </div>
  </OverlayBase>
</template>

<script setup lang="ts">
import * as Vue from 'vue';

import OverlayBase from './OverlayBase.vue';
import BitcoinSend from '../wallets/components/BitcoinSend.vue';
import type { IBitcoinLockRecord } from '../interfaces/IBitcoinLockRecord.ts';
import { getBitcoinLocks } from '../stores/bitcoin.ts';
import { getMyVault } from '../stores/vaults.ts';

const props = defineProps<{
  personalLock?: IBitcoinLockRecord;
}>();

const emit = defineEmits<{
  (event: 'close', shouldFinishLocking: boolean): void;
}>();

const bitcoinLocks = getBitcoinLocks();
const myVault = getMyVault();
const openedLock = Vue.ref(props.personalLock);

const personalLock = Vue.computed<IBitcoinLockRecord | undefined>(() => {
  const uuid = props.personalLock?.uuid;
  if (!uuid) return props.personalLock;

  const found = bitcoinLocks.getAllLocks().find(lock => lock.uuid === uuid);
  if (found) {
    openedLock.value = found;
    return found;
  }
  return openedLock.value;
});
const releaseState = Vue.computed(() => bitcoinLocks.getLockUnlockReleaseState(personalLock.value));
const releaseE2eState = Vue.computed(() => {
  if (!personalLock.value || releaseState.value.isReleaseStatus || releaseState.value.isReleaseComplete) {
    return 'Unavailable';
  }
  return 'Send';
});

function closeOverlay(): void {
  emit('close', false);
}
</script>
