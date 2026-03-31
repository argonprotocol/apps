<!-- prettier-ignore -->
<template>
  <OverlayBase :isOpen="true" @close="emit('close')" @esc="emit('close')" class="w-5/12">
    <template #title>
      <div class="grow text-2xl font-bold">{{ isFirstBond ? 'Buy Bonds' : 'Adjust Bonds' }}</div>
    </template>

    <div class="px-6 py-5 space-y-5">
      <!-- Progress view (after submission) -->
      <template v-if="txInfo">
        <div class="space-y-3">
          <div class="text-sm font-medium text-slate-600">
            {{ isReducingToZero ? 'Exiting bond position…' : isDecreasing ? 'Reducing bonds…' : isFirstBond ? 'Buying bonds…' : 'Adjusting bonds…' }}
          </div>
          <ProgressBar
            :progress="progressPct"
            :hasError="!!progressError"
          />
          <div class="text-xs text-slate-500">{{ progressMessage }}</div>
          <div v-if="progressError" class="rounded-md bg-red-50 px-3 py-2 text-sm text-red-700 border border-red-200">
            {{ progressError }}
          </div>
        </div>
        <div v-if="progressError" class="flex flex-row justify-end gap-3 pt-1">
          <button
            @click="resetProgress"
            class="rounded border border-slate-300 px-4 py-2 text-sm text-slate-600 hover:bg-slate-50">
            Try Again
          </button>
        </div>
      </template>

      <!-- Form view (before submission) -->
      <template v-else>
        <div v-if="!isFirstBond" class="flex flex-row items-baseline gap-3 text-sm text-slate-500">
          <span>Current bonds:</span>
          <span class="font-mono font-semibold text-slate-700">
            {{ currency.symbol }}{{ microgonToMoneyNm(props.currentAmount).format('0,0.00') }}
          </span>
        </div>

        <div>
          <label class="mb-1.5 block text-sm font-medium text-slate-600">
            {{ isFirstBond ? 'Amount to buy' : 'New bond total' }}
          </label>
          <InputMoney
            v-model="newAmount"
            :min="0n"
            :max="maxAmount"
            :dragBy="10n * MICROGONS_PER_ARGON_BIGINT"
            :dragByMin="1n * MICROGONS_PER_ARGON_BIGINT"
          />
          <div class="mt-1 text-xs text-slate-400">
            Wallet: {{ currency.symbol }}{{ microgonToMoneyNm(props.walletBalance).format('0,0.00') }}
            <template v-if="props.availableVaultSpace < props.walletBalance">
              · Available Bonds: {{ currency.symbol }}{{ microgonToMoneyNm(props.availableVaultSpace).format('0,0.00') }}
            </template>
          </div>
        </div>

        <div v-if="isReducingToZero" class="rounded-md bg-amber-50 px-3 py-2 text-sm text-amber-700 border border-amber-200">
          Setting to zero will fully exit your bond position.
        </div>

        <div v-if="isDecreasing && !isReducingToZero" class="text-sm text-slate-500">
          Releasing {{ currency.symbol }}{{ microgonToMoneyNm(releaseAmount).format('0,0.00') }} back to your wallet.
        </div>

        <div v-if="errorMessage" class="rounded-md bg-red-50 px-3 py-2 text-sm text-red-700 border border-red-200">
          {{ errorMessage }}
        </div>

        <div class="flex flex-row justify-end gap-3 pt-1">
          <button
            @click="emit('close')"
            class="rounded border border-slate-300 px-4 py-2 text-sm text-slate-600 hover:bg-slate-50">
            Cancel
          </button>
          <button
            @click="submit"
            :disabled="isSubmitting || newAmount === props.currentAmount"
            class="bg-argon-button hover:bg-argon-button-hover rounded px-5 py-2 text-sm font-semibold text-white disabled:opacity-40">
            {{ isSubmitting ? 'Submitting…' : confirmLabel }}
          </button>
        </div>
      </template>
    </div>
  </OverlayBase>
</template>

<script setup lang="ts">
import * as Vue from 'vue';
import OverlayBase from '../overlays-shared/OverlayBase.vue';
import InputMoney from '../components/InputMoney.vue';
import ProgressBar from '../components/ProgressBar.vue';
import { getCurrency } from '../stores/currency.ts';
import { getWalletKeys } from '../stores/wallets.ts';
import { getTransactionTracker } from '../stores/transactions.ts';
import { getMainchainClient } from '../stores/mainchain.ts';
import { createNumeralHelpers } from '../lib/numeral.ts';
import { ExtrinsicType } from '../lib/db/TransactionsTable.ts';
import { type TransactionInfo } from '../lib/TransactionInfo.ts';
import { generateProgressLabel } from '../lib/Utils.ts';
import { MICROGONS_PER_ARGON } from '@argonprotocol/apps-core';

const MICROGONS_PER_ARGON_BIGINT = BigInt(MICROGONS_PER_ARGON);

const props = defineProps<{
  vaultId: number;
  currentAmount: bigint;
  walletBalance: bigint;
  availableVaultSpace: bigint;
}>();

const emit = defineEmits<{
  (e: 'close'): void;
  (e: 'submitted'): void;
}>();

const currency = getCurrency();
const walletKeys = getWalletKeys();
const transactionTracker = getTransactionTracker();
const { microgonToMoneyNm } = createNumeralHelpers(currency);

const newAmount = Vue.ref<bigint>(props.currentAmount);
const isSubmitting = Vue.ref(false);
const errorMessage = Vue.ref<string | null>(null);
const txInfo = Vue.ref<TransactionInfo | null>(null);
const progressPct = Vue.ref(0);
const progressMessage = Vue.ref('');
const progressError = Vue.ref<string | null>(null);
let unsubProgress: (() => void) | undefined;

const isFirstBond = Vue.computed(() => props.currentAmount === 0n);
const isDecreasing = Vue.computed(() => newAmount.value < props.currentAmount);
const isReducingToZero = Vue.computed(() => isDecreasing.value && newAmount.value === 0n);
const releaseAmount = Vue.computed(() => props.currentAmount - newAmount.value);

const maxAmount = Vue.computed(() => {
  const headroom = props.walletBalance < props.availableVaultSpace ? props.walletBalance : props.availableVaultSpace;
  return props.currentAmount + headroom;
});

const confirmLabel = Vue.computed(() => {
  if (isReducingToZero.value) return 'Exit Bond';
  if (isDecreasing.value) return 'Reduce Bond';
  return isFirstBond.value ? 'Buy Bonds' : 'Increase Bond';
});

function resetProgress() {
  unsubProgress?.();
  unsubProgress = undefined;
  txInfo.value = null;
  progressPct.value = 0;
  progressMessage.value = '';
  progressError.value = null;
  isSubmitting.value = false;
}

async function submit() {
  if (isSubmitting.value) return;
  errorMessage.value = null;
  isSubmitting.value = true;

  try {
    const client = await getMainchainClient(false);
    const signer = await walletKeys.getInvestmentKeypair();
    const tx = client.tx.treasury.setAllocation(props.vaultId, newAmount.value);

    const info = await transactionTracker.submitAndWatch({
      tx,
      signer,
      extrinsicType: ExtrinsicType.TreasurySetAllocation,
      metadata: {
        vaultId: props.vaultId,
        newAmount: newAmount.value,
        previousAmount: props.currentAmount,
      },
    });

    txInfo.value = info;
    unsubProgress = info.subscribeToProgress((args, error) => {
      progressPct.value = args.progressPct;
      progressMessage.value = generateProgressLabel(args.confirmations, args.expectedConfirmations);
      if (error) {
        progressError.value = error.message ?? 'Transaction failed.';
      }
      if (args.progressPct >= 100 && !error) {
        emit('submitted');
      }
    });
  } catch (err: any) {
    errorMessage.value = err?.message ?? 'Transaction failed. Please try again.';
    isSubmitting.value = false;
  }
}

Vue.onUnmounted(() => {
  unsubProgress?.();
});
</script>
