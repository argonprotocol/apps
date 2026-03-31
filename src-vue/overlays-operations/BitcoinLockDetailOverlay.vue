<template>
  <OverlayBase
    :isOpen="true"
    data-testid="BitcoinLockDetailOverlay"
    @close="emit('close')"
    @esc="emit('close')"
    class="BitcoinLockDetailOverlay min-h-60 w-240">
    <template #title>
      <div class="mr-6 flex grow flex-row items-center gap-2">
        <span class="text-xl font-bold text-slate-800/80">Bitcoin Lock Details</span>
        <span v-if="isLocalLock" class="bg-argon-600 inline-block rounded px-1.5 pb-px align-middle text-sm text-white">
          YOURS
        </span>
        <span v-else class="inline-block rounded bg-slate-500 px-1.5 pb-px align-middle text-sm text-white">
          EXTERNAL
        </span>
      </div>
    </template>

    <LockDetail :lock="lock" :pendingCosign="pendingCosign" @unlock="emit('unlock', lock)" />
  </OverlayBase>
</template>

<script setup lang="ts">
import * as Vue from 'vue';
import numeral from '../lib/numeral.ts';
import OverlayBase from '../overlays-shared/OverlayBase.vue';
import type { IBitcoinLockRecord } from '../lib/db/BitcoinLocksTable.ts';
import { getCurrency } from '../stores/currency.ts';
import { getMyVault } from '../stores/vaults.ts';
import BitcoinIcon from '../assets/wallets/bitcoin.svg?component';
import LockDetail from './bitcoin-locking/LockDetail.vue';

const currency = getCurrency();
const myVault = getMyVault();

const props = defineProps<{
  lock: IBitcoinLockRecord;
}>();

const emit = defineEmits<{
  (e: 'close'): void;
  (e: 'unlock', lock: IBitcoinLockRecord): void;
}>();

const isLocalLock = props.lock.uuid != null;

const pendingCosign = Vue.computed(() => {
  const utxoId = props.lock.utxoId;
  if (utxoId == null) return undefined;
  const cosign = myVault.data.pendingCosignUtxosById.get(utxoId);
  if (!cosign) return undefined;
  return { dueFrame: cosign.dueFrame };
});
</script>
