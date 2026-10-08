<!-- prettier-ignore -->
<template>
  <p class="text-md mb-3">
    Paid to your vault when someone locks Bitcoin. Includes a flat ARGN fee and an annual percentage fee for the duration of the lock.
  </p>

  <div class="mt-3 font-bold opacity-60 mb-0.5">
    Flat Fee
  </div>
  <div class="flex flex-row items-center gap-2 w-full">
    <InputMoney v-model="config.vaultSetup.btcFlatFee" :disabled="isSaving || !!transaction" :min="BigInt(MICROGONS_PER_ARGON)" class="w-full" />
  </div>

  <div class="mt-3 font-bold opacity-60 mb-0.5">
    Percentage Fee
  </div>
  <div class="flex flex-row items-center gap-2 w-full">
    <InputNumber v-model="config.vaultSetup.btcPctFee" :disabled="isSaving || !!transaction" :min="0" :dragBy="1" :dragByMin="0.1" :maxDecimals="1" format="percent" class="w-full" />
  </div>
  <div v-if="isSaving" class="mt-4">
    <ProgressBar :progress="progressPct" />
  </div>
  <p v-if="savingError" role="alert" class="mt-3 text-sm text-red-700">{{ savingError }}</p>
</template>

<script setup lang="ts">
import * as Vue from 'vue';
import BigNumber from 'bignumber.js';
import { getMyVault } from '../../stores/vaults.ts';
import { getTransactionFailureMessage } from '../../lib/TransactionInfo.ts';
import ProgressBar from '../../components/ProgressBar.vue';
import InputNumber from '../../components/InputNumber.vue';
import InputMoney from '../../components/InputMoney.vue';
import { getConfig } from '../../stores/config.ts';
import { MICROGONS_PER_ARGON } from '@argonprotocol/mainchain';

const config = getConfig();
const myVault = getMyVault();
const isSaving = Vue.ref(false);
const savingError = Vue.ref('');
const progressPct = Vue.ref(0);
const saveButtonLabel = Vue.computed(() => (isSaving.value ? 'Saving…' : 'Save'));
const transaction = Vue.shallowRef<Awaited<ReturnType<typeof myVault.updateSettings>>>();

async function beforeSave(stopSave: () => void) {
  if (!myVault.createdVault) return;
  if (isSaving.value) {
    stopSave();
    return;
  }
  isSaving.value = true;
  savingError.value = '';
  let unsubscribe: (() => void) | undefined;
  try {
    if (transaction.value?.getStatus().isFinalized && !getTransactionFailureMessage(transaction.value)) {
      await myVault.recordFinalizedVaultCapital(transaction.value);
    } else {
      transaction.value = await myVault.updateSettings({
        terms: {
          bitcoinBaseFee: config.vaultSetup.btcFlatFee,
          bitcoinAnnualPercentRate: BigNumber(config.vaultSetup.btcPctFee).div(100),
        },
        txProgressCallback: progress => {
          progressPct.value = progress;
        },
      });
      unsubscribe = transaction.value?.subscribeToProgress(progress => {
        progressPct.value = progress.progressPct;
      });
      await transaction.value?.waitForPostProcessing;
    }
    await config.saveVaultSetup();
  } catch (error) {
    savingError.value = error instanceof Error ? error.message : 'Unable to save Bitcoin locking fees.';
    stopSave();
  } finally {
    unsubscribe?.();
    isSaving.value = false;
  }
}

function beforeCancel(stopCancel: () => void) {
  if (isSaving.value) stopCancel();
}

defineExpose({ beforeSave, beforeCancel, saveButtonLabel });
</script>
