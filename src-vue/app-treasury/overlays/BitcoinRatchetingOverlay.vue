<!-- prettier-ignore -->
<template>
  <OverlayBase :isOpen="true" @close="emit('close')" @pressEsc="emit('close')" class="w-5/12">
    <template #title>
      <div class="grow text-2xl font-bold">Ratchet Your
        {{ numeral(currency.convertSatToBtc(personalLock.satoshis)).format('0,0.[00000000]') }} BTC
      </div>
    </template>

    <div v-if="isLoadingPreview" class="min-h-20">
      Loading...
    </div>
    <div v-else-if="ratchetPreview" class="min-h-20 space-y-3 text-md px-5 pt-5">
      <div class="grid grid-cols-2 gap-x-4 gap-y-1">
        <div class="text-slate-500">Vault security available</div>
        <div class="text-right font-semibold">
          {{ currency.symbol }}{{ microgonToMoneyNm(ratchetPreview.availableVaultFunds).format('0,0.00') }}
        </div>

        <div class="text-slate-500">Vault security required</div>
        <div class="text-right font-semibold">
          {{ currency.symbol }}{{ microgonToMoneyNm(ratchetPreview.requiredVaultFunds).format('0,0.00') }}
        </div>

        <div class="text-slate-500">New liquidity</div>
        <div class="text-right">
          {{ currency.symbol }}{{ microgonToMoneyNm(ratchetPreview.additionalLiquidityToMint).format('0,0.00') }}
        </div>

        <div class="text-slate-500">Ratchet fee</div>
        <div class="text-right">
          {{ currency.symbol }}{{ microgonToMoneyNm(ratchetPreview.ratchetingFee).format('0,0.00') }}
        </div>
      </div>

      <div v-if="ratchetPreview.shortfall > 0n" class="rounded border border-red-200 bg-red-50 px-3 py-2 text-red-700">
        This vault needs {{ currency.symbol }}{{ microgonToMoneyNm(ratchetPreview.shortfall).format('0,0.00') }} more
        security before it can ratchet this Bitcoin lock.
      </div>
      <div v-else-if="!ratchetPreview.canRatchet" class="rounded border border-amber-200 bg-amber-50 px-3 py-2 text-amber-700">
        No ratchet is currently available for this Bitcoin lock.
      </div>
    </div>

    <div class="px-5 py-5">
      <button
        @click="submitRatchet"
        :disabled="isSubmitting || isLoadingPreview || !ratchetPreview?.canRatchet"
        class="bg-argon-600 px-5 py-1 text-white border border-argon-800 rounded disabled:opacity-50 cursor-pointer"
      >
        {{ isSubmitting ? 'Ratchet pending...' : 'Finish Ratchet' }}
      </button>
      <div v-if="errorMessage" class="mt-3 text-sm text-red-600">{{ errorMessage }}</div>
    </div>

  </OverlayBase>
</template>

<script setup lang="ts">
import * as Vue from 'vue';
import OverlayBase from '../../app-shared/overlays/OverlayBase.vue';
import { getWalletKeys } from '../../stores/wallets.ts';
import { IBitcoinLockRecord } from '../../lib/db/BitcoinLocksTable.ts';
import numeral, { createNumeralHelpers } from '../../lib/numeral.ts';
import { getCurrency } from '../../stores/currency.ts';
import { getBitcoinLocks } from '../../stores/bitcoin.ts';
import type { IBitcoinRatchetPreview } from '../../lib/BitcoinLocks.ts';

const currency = getCurrency();
const bitcoinLocks = getBitcoinLocks();
const walletKeys = getWalletKeys();
const { microgonToMoneyNm } = createNumeralHelpers(currency);
const isSubmitting = Vue.ref(false);
const isLoadingPreview = Vue.ref(true);
const errorMessage = Vue.ref('');
const ratchetPreview = Vue.ref<IBitcoinRatchetPreview>();

const props = defineProps<{
  personalLock: IBitcoinLockRecord;
}>();

const emit = defineEmits<{
  (e: 'close'): void;
  (e: 'submitted'): void;
}>();

async function loadRatchetPreview() {
  isLoadingPreview.value = true;
  errorMessage.value = '';

  try {
    ratchetPreview.value = await bitcoinLocks.getRatchetPreview(props.personalLock);
  } catch (error) {
    ratchetPreview.value = undefined;
    errorMessage.value = error instanceof Error ? error.message : 'Unable to load ratchet details.';
  } finally {
    isLoadingPreview.value = false;
  }
}

async function submitRatchet() {
  if (isSubmitting.value || !ratchetPreview.value?.canRatchet) return;

  isSubmitting.value = true;
  errorMessage.value = '';

  try {
    const txSigner = await walletKeys.getLiquidLockingKeypair();
    await bitcoinLocks.ratchet(props.personalLock, txSigner);
    emit('submitted');
    emit('close');
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : 'Unable to ratchet this Bitcoin lock.';
  } finally {
    isSubmitting.value = false;
  }
}

Vue.onMounted(() => {
  void loadRatchetPreview();
});
</script>
