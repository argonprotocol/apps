<template>
  <OverlayBase
    :isOpen="true"
    data-testid="BitcoinLockDetailOverlay"
    @close="emit('close')"
    @esc="emit('close')"
    class="BitcoinLockDetailOverlay min-h-60 w-240"
  >
    <template #title>
      <div class="mr-6 flex grow flex-row items-center gap-2">
        <span class="text-xl font-bold text-slate-800/80">Bitcoin Lock Details</span>
        <template v-if="IS_OPERATIONS_APP">
          <span
            v-if="isLocalLock"
            class="bg-argon-600 inline-block rounded px-1.5 pb-px align-middle text-sm text-white"
          >
            YOURS
          </span>
          <span v-else class="inline-block rounded bg-slate-500 px-1.5 pb-px align-middle text-sm text-white">
            EXTERNAL
          </span>
        </template>
      </div>
    </template>

    <LockDetail
      v-if="displayLock"
      :lock="displayLock"
      :pendingCosign="pendingCosign"
      :isReleased="isExternalLockReleased"
      @unlock="localLock && emit('unlock', localLock)"
    />
  </OverlayBase>
</template>

<script setup lang="ts">
import * as Vue from 'vue';
import OverlayBase from '../../app-shared/overlays/OverlayBase.vue';
import type { IBitcoinLockRecord } from '../../lib/db/BitcoinLocksTable.ts';
import { getMyVault } from '../../stores/vaults.ts';
import { getBitcoinLocks } from '../../stores/bitcoin.ts';
import LockDetail from './bitcoin-locking/LockDetail.vue';
import { IS_OPERATIONS_APP } from '../../lib/Env.ts';
import type { IExternalBitcoinLock } from '../../lib/MyVault.ts';

const myVault = getMyVault();
const bitcoinLocks = getBitcoinLocks();

const props = defineProps<{
  lock: IBitcoinLockRecord | IExternalBitcoinLock;
}>();

const emit = defineEmits<{
  (e: 'close'): void;
  (e: 'unlock', lock: IBitcoinLockRecord): void;
}>();

const openedExternalLock = Vue.ref('uuid' in props.lock ? undefined : props.lock);

const localLock = Vue.computed<IBitcoinLockRecord | undefined>(() => {
  if (!('uuid' in props.lock)) return undefined;

  const localLock = props.lock;
  return bitcoinLocks.getAllLocks().find(candidate => candidate.uuid === localLock.uuid) ?? localLock;
});

const isLocalLock = Vue.computed(() => 'uuid' in props.lock);
const externalLock = Vue.computed<IExternalBitcoinLock | undefined>(() => {
  if ('uuid' in props.lock) return undefined;

  const liveExternalLock = myVault.data.externalLocks[props.lock.utxoId];
  if (liveExternalLock) {
    openedExternalLock.value = liveExternalLock;
  }

  return openedExternalLock.value;
});

const displayLock = Vue.computed(() => localLock.value ?? externalLock.value);

const isExternalLockReleased = Vue.computed(() => {
  const utxoId = externalLock.value?.utxoId;
  if (utxoId == null) return false;
  return myVault.data.releasedExternalUtxoIds.has(utxoId);
});

const pendingCosign = Vue.computed(() => {
  const utxoId = localLock.value?.utxoId ?? externalLock.value?.utxoId;
  if (utxoId == null) return undefined;
  const cosign = myVault.data.pendingCosignUtxosById.get(utxoId);
  if (!cosign) return undefined;
  return { dueFrame: cosign.dueFrame };
});
</script>
