<!-- prettier-ignore -->
<template>
  <div class="space-y-5">
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
          Available to buy: {{ currency.symbol }}{{ microgonToMoneyNm(maxPurchaseAmount).format('0,0.00') }}
          <template v-if="reserveLimitsPurchase">
            · Keeps {{ currency.symbol }}{{ microgonToMoneyNm(operationalReserveMicrogons).format('0,0.00') }} in wallet for operational reserves
          </template>
          <template v-else-if="vaultCapacityLimitsPurchase">
            · Vault capacity limits this purchase
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
</template>

<script setup lang="ts">
import * as Vue from 'vue';
import { MICROGONS_PER_ARGON, TreasuryBonds } from '@argonprotocol/apps-core';
import InputMoney from '../../components/InputMoney.vue';
import ProgressBar from '../../components/ProgressBar.vue';
import { type TransactionInfo } from '../../lib/TransactionInfo.ts';
import { ExtrinsicType, TransactionStatus } from '../../lib/db/TransactionsTable.ts';
import { createNumeralHelpers } from '../../lib/numeral.ts';
import { generateProgressLabel } from '../../lib/Utils.ts';
import { getCurrency } from '../../stores/currency.ts';
import { getMainchainClient } from '../../stores/mainchain.ts';
import { getTransactionTracker } from '../../stores/transactions.ts';
import { getWalletKeys } from '../../stores/wallets.ts';
import { getBondMarket } from '../../stores/myBonds.ts';
import { getVaults } from '../../stores/vaults.ts';
import { MyVault } from '../../lib/MyVault.ts';
import { getSpendableMicrogons } from '../../lib/WalletForArgon.ts';

const MICROGONS_PER_ARGON_BIGINT = BigInt(MICROGONS_PER_ARGON);

const props = defineProps<{
  vaultId: number;
  walletBalance: bigint;
}>();

const emit = defineEmits<{
  (e: 'close'): void;
  (e: 'submitted'): void;
}>();

const currency = getCurrency();
const walletKeys = getWalletKeys();
const transactionTracker = getTransactionTracker();
const bondMarket = getBondMarket();
const vaults = getVaults();

const { microgonToMoneyNm } = createNumeralHelpers(currency);

const vault = Vue.ref(vaults.vaultsById[props.vaultId]);
const purchaseAmount = Vue.ref<bigint>(0n);
const isSubmitting = Vue.ref(false);
const errorMessage = Vue.ref('');

const txInfo = Vue.ref<TransactionInfo>();
const progressPct = Vue.ref(0);
const progressMessage = Vue.ref('');
const progressError = Vue.ref('');

let unsubProgress: (() => void) | undefined;

const vaultBondState = Vue.computed(() => bondMarket.data.vaultsById[props.vaultId]);

const vaultAvailableCapacity = Vue.computed(() => {
  return vault.value?.availableBondSpace(currency.priceIndex, vaultBondState.value?.bondLots ?? [], true) ?? 0n;
});

const spendableWalletBalance = Vue.computed(() => {
  return getSpendableMicrogons(props.walletBalance, MyVault.OperationalReserves);
});

const operationalReserveMicrogons = Vue.computed(() => {
  return props.walletBalance - spendableWalletBalance.value;
});

const purchaseCapacity = Vue.computed(() => {
  return spendableWalletBalance.value < vaultAvailableCapacity.value
    ? spendableWalletBalance.value
    : vaultAvailableCapacity.value;
});

const reserveLimitsPurchase = Vue.computed(() => {
  return spendableWalletBalance.value < props.walletBalance && purchaseCapacity.value === spendableWalletBalance.value;
});

const vaultCapacityLimitsPurchase = Vue.computed(() => {
  return vaultAvailableCapacity.value < spendableWalletBalance.value;
});

const maxPurchaseAmount = Vue.computed(() => {
  const max = purchaseCapacity.value;
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

function trackTxInfo(info: TransactionInfo) {
  unsubProgress?.();
  txInfo.value = info;
  isSubmitting.value = false;

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

    trackTxInfo(info);
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : 'Transaction failed. Please try again.';
    isSubmitting.value = false;
  }
}

let unsubVault: (() => void) | undefined;

Vue.onMounted(async () => {
  vault.value = vaults.vaultsById[props.vaultId];
  unsubVault = await vaults.subscribeToVault(props.vaultId, updatedVault => {
    vault.value = updatedVault;
  });

  await transactionTracker.load();
  const pendingBuyTxInfo = transactionTracker.findLatestTxInfo<{
    vaultId?: number;
    bondPurchaseMicrogons?: bigint;
  }>(candidate => {
    if (candidate.tx.extrinsicType !== ExtrinsicType.TreasuryBuyBonds) return false;
    if (candidate.tx.accountAddress !== walletKeys.treasuryAddress) return false;
    if (candidate.tx.metadataJson?.vaultId !== props.vaultId) return false;
    if ((candidate.tx.metadataJson?.bondPurchaseMicrogons ?? 0n) <= 0n) return false;
    if (candidate.tx.submissionErrorJson || candidate.tx.blockExtrinsicErrorJson) return false;
    return candidate.tx.status === TransactionStatus.Submitted || candidate.tx.status === TransactionStatus.InBlock;
  });
  if (pendingBuyTxInfo) {
    trackTxInfo(pendingBuyTxInfo);
  }

  purchaseAmount.value = maxPurchaseAmount.value;
});

Vue.onUnmounted(() => {
  unsubVault?.();
  unsubProgress?.();
});
</script>
