<!-- prettier-ignore -->
<template>
  <OverlayBase :isOpen="true" @close="emit('close')" @esc="emit('close')" class="w-5/12">
    <template #title>
      <div class="grow text-2xl font-bold">Buy Bonds</div>
    </template>

    <div class="space-y-5 px-6 py-5">
      <template v-if="txInfo">
        <div class="space-y-3">
          <div class="text-sm font-medium text-slate-600">Buying bonds...</div>
          <ProgressBar :progress="progressPct" :hasError="!!progressError" />
          <div class="text-xs text-slate-500">{{ progressMessage }}</div>
          <div v-if="progressError" class="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
            {{ progressError }}
          </div>
        </div>

        <div v-if="progressError" class="flex flex-row justify-end gap-3 pt-1">
          <button
            type="button"
            class="rounded border border-slate-300 px-4 py-2 text-sm text-slate-600 hover:bg-slate-50"
            @click="resetProgress">
            Try Again
          </button>
        </div>
      </template>

      <template v-else>
        <div>
          <label class="mb-1.5 block text-sm font-medium text-slate-600">
            Amount to buy
          </label>
          <InputMoney
            v-model="purchaseAmount"
            :min="0n"
            :max="maxPurchaseAmount"
            :dragBy="10n * MICROGONS_PER_ARGON_BIGINT"
            :dragByMin="MICROGONS_PER_ARGON_BIGINT"
            :minDecimals="0"
            :maxDecimals="0"
          />
          <div class="mt-1 text-xs text-slate-400">
            Wallet: {{ currency.symbol }}{{ microgonToMoneyNm(props.walletBalance).format('0,0.00') }}
            <template v-if="props.availableVaultSpace < props.walletBalance">
              · Available to buy: {{ currency.symbol }}{{ microgonToMoneyNm(maxPurchaseAmount).format('0,0') }}
            </template>
          </div>
        </div>

        <div v-if="errorMessage" class="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
          {{ errorMessage }}
        </div>

        <div class="flex flex-row justify-end gap-3 pt-1">
          <button
            type="button"
            class="rounded border border-slate-300 px-4 py-2 text-sm text-slate-600 hover:bg-slate-50"
            @click="emit('close')">
            Cancel
          </button>
          <button
            type="button"
            :disabled="isSubmitting || purchaseAmount <= 0n"
            class="bg-argon-button hover:bg-argon-button-hover rounded px-5 py-2 text-sm font-semibold text-white disabled:opacity-40"
            @click="submit">
            {{ isSubmitting ? 'Submitting...' : 'Buy Bonds' }}
          </button>
        </div>
      </template>
    </div>
  </OverlayBase>
</template>

<script setup lang="ts">
import * as Vue from 'vue';
import { MICROGONS_PER_ARGON, TreasuryBonds } from '@argonprotocol/apps-core';
import OverlayBase from './OverlayBase.vue';
import InputMoney from '../../components/InputMoney.vue';
import ProgressBar from '../../components/ProgressBar.vue';
import { type TransactionInfo } from '../../lib/TransactionInfo.ts';
import { ExtrinsicType } from '../../lib/db/TransactionsTable.ts';
import { createNumeralHelpers } from '../../lib/numeral.ts';
import { generateProgressLabel } from '../../lib/Utils.ts';
import { getCurrency } from '../../stores/currency.ts';
import { getMainchainClient } from '../../stores/mainchain.ts';
import { getTransactionTracker } from '../../stores/transactions.ts';
import { getWalletKeys } from '../../stores/wallets.ts';

const MICROGONS_PER_ARGON_BIGINT = BigInt(MICROGONS_PER_ARGON);

const props = defineProps<{
  vaultId: number;
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

const purchaseAmount = Vue.ref<bigint>(0n);
const isSubmitting = Vue.ref(false);
const errorMessage = Vue.ref('');

const txInfo = Vue.ref<TransactionInfo>();
const progressPct = Vue.ref(0);
const progressMessage = Vue.ref('');
const progressError = Vue.ref('');

let unsubProgress: (() => void) | undefined;

const maxPurchaseAmount = Vue.computed(() => {
  const max = props.walletBalance < props.availableVaultSpace ? props.walletBalance : props.availableVaultSpace;
  return max - (max % MICROGONS_PER_ARGON_BIGINT);
});

function resetProgress() {
  unsubProgress?.();
  unsubProgress = undefined;
  txInfo.value = undefined;
  progressPct.value = 0;
  progressMessage.value = '';
  progressError.value = '';
  isSubmitting.value = false;
}

async function submit() {
  if (isSubmitting.value) return;

  errorMessage.value = '';
  isSubmitting.value = true;

  try {
    const client = await getMainchainClient(false);
    const signer = await walletKeys.getTreasuryKeypair();
    const tx = await TreasuryBonds.buildBuyBondTx({
      client,
      vaultId: props.vaultId,
      accountId: walletKeys.treasuryAddress,
      bondPurchaseMicrogons: purchaseAmount.value,
    });

    const info = await transactionTracker.submitAndWatch({
      tx,
      txSigner: signer,
      extrinsicType: ExtrinsicType.TreasuryBuyBonds,
      metadata: {
        vaultId: props.vaultId,
        bondPurchaseMicrogons: purchaseAmount.value,
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
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : 'Transaction failed. Please try again.';
    isSubmitting.value = false;
  }
}

Vue.onUnmounted(() => {
  unsubProgress?.();
});
</script>
