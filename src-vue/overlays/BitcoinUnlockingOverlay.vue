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
        v-if="personalLock"
        :personalLock="personalLock"
        :cosignerLabel="cosignerLabel"
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
import { getConfig } from '../stores/config.ts';
import { getMyVault, getVaults } from '../stores/vaults.ts';

const props = defineProps<{
  personalLock?: IBitcoinLockRecord;
}>();

const emit = defineEmits<{
  (event: 'close', shouldFinishLocking: boolean): void;
}>();

const bitcoinLocks = getBitcoinLocks();
const config = getConfig();
const myVault = getMyVault();
const vaults = getVaults();
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
  if (!personalLock.value) return 'Unavailable';
  if (releaseState.value.isReleaseComplete) return 'Sent';
  if (releaseState.value.isReleaseStatus) return 'Sending';
  return 'Send';
});
const cosignerLabel = Vue.computed(() => {
  const lock = personalLock.value;
  if (!lock) return undefined;
  if (lock.vaultId === myVault.vaultId) return 'My Vault';
  return vaults.operatorNamesByVaultId[lock.vaultId] ?? config.upstreamOperator?.name ?? `Vault ${lock.vaultId}`;
});

function closeOverlay(): void {
  emit('close', false);
}
</script>
