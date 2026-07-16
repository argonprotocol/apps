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
        <InputNumber
          v-if="props.programType === 'Argonot'"
          v-model="purchaseBonds"
          :min="0"
          :max="maxPurchaseBonds"
          :dragBy="1"
          :dragByMin="1"
          :minDecimals="0"
          :maxDecimals="0"
          suffix=" ARGNOT"
        />
        <InputMoney
          v-else
          v-model="purchaseAmount"
          :min="0n"
          :max="maxPurchaseAmount"
          :dragBy="10n * MICROGONS_PER_ARGON_BIGINT"
          :dragByMin="MICROGONS_PER_ARGON_BIGINT"
          :minDecimals="0"
          :maxDecimals="0"
        />
        <div class="mt-1 text-xs text-slate-400">
          <template v-if="props.programType === 'Argonot'">
            Available to buy: {{ micronotToArgonotNm(maxPurchaseAmount).format('0,0.00') }} ARGNOT
          </template>
          <template v-else>
            Available to buy: {{ currency.symbol }}{{ microgonToMoneyNm(maxPurchaseAmount).format('0,0.00') }}
          </template>
          <template v-if="props.programType === 'Vault' && reserveLimitsPurchase">
            · Keeps {{ currency.symbol }}{{ microgonToMoneyNm(operationalReserveMicrogons).format('0,0.00') }} in wallet for operational reserves
          </template>
          <template v-else-if="props.programType === 'Vault' && vaultCapacityLimitsPurchase">
            · Vault capacity limits this purchase
          </template>
          <template v-else-if="props.programType === 'Argonot' && argonotCapacityLimitsPurchase">
            · Program capacity limits this purchase
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
          <template v-if="isSubmitting">Submitting...</template>
          <template v-else>Buy Argon Bonds</template>
        </button>
      </div>
    </template>
  </div>
</template>

<script setup lang="ts">
import * as Vue from 'vue';
import { type BondLot, MICROGONS_PER_ARGON, MICRONOTS_PER_ARGONOT, TreasuryBonds } from '@argonprotocol/apps-core';
import InputMoney from '../components/InputMoney.vue';
import InputNumber from '../components/InputNumber.vue';
import ProgressBar from '../components/ProgressBar.vue';
import { type TransactionInfo } from '../lib/TransactionInfo.ts';
import { ExtrinsicType, TransactionStatus } from '../lib/db/TransactionsTable.ts';
import { createNumeralHelpers } from '../lib/numeral.ts';
import { generateProgressLabel } from '../lib/Utils.ts';
import { getCurrency } from '../stores/currency.ts';
import { getArgonBonds } from '../stores/argonBonds.ts';
import { getMainchainClient } from '../stores/mainchain.ts';
import { getTransactionTracker } from '../stores/transactions.ts';
import { getVaults } from '../stores/vaults.ts';
import { getWalletKeys } from '../stores/wallets.ts';
import { getSpendableDefaultArgonMicrogons } from '../lib/WalletForArgon.ts';

const MICROGONS_PER_ARGON_BIGINT = BigInt(MICROGONS_PER_ARGON);

const props = withDefaults(
  defineProps<{
    programType?: BondLot['programType'];
    vaultId?: number;
    walletBalance: bigint;
  }>(),
  {
    programType: 'Vault',
  },
);
const unitsPerBond = props.programType === 'Argonot' ? BigInt(MICRONOTS_PER_ARGONOT) : MICROGONS_PER_ARGON_BIGINT;

const emit = defineEmits<{
  (e: 'close'): void;
  (e: 'submitted'): void;
}>();

const currency = getCurrency();
const walletKeys = getWalletKeys();
const transactionTracker = getTransactionTracker();
const argonBonds = getArgonBonds();
const vaults = getVaults();

const { microgonToMoneyNm, micronotToArgonotNm } = createNumeralHelpers(currency);

const vault = Vue.ref(props.vaultId ? vaults.vaultsById[props.vaultId] : undefined);
const argonotBondCapacity = Vue.ref(0n);
const purchaseAmount = Vue.ref<bigint>(0n);
const purchaseBonds = Vue.computed({
  get: () => Number(purchaseAmount.value / unitsPerBond),
  set: value => {
    purchaseAmount.value = BigInt(value) * unitsPerBond;
  },
});
const isSubmitting = Vue.ref(false);
const errorMessage = Vue.ref('');

const txInfo = Vue.ref<TransactionInfo>();
const progressPct = Vue.ref(0);
const progressMessage = Vue.ref('');
const progressError = Vue.ref('');

let unsubProgress: (() => void) | undefined;

const vaultBondState = Vue.computed(() => {
  return props.vaultId ? argonBonds.data.vaultsById[props.vaultId] : undefined;
});

const vaultAvailableCapacity = Vue.computed(() => {
  if (props.programType === 'Argonot') return argonotBondCapacity.value;
  return vault.value?.availableBondSpace(currency.priceIndex, vaultBondState.value?.bondLots ?? [], true) ?? 0n;
});

const spendableWalletBalance = Vue.computed(() => {
  if (props.programType === 'Argonot') return props.walletBalance;
  return getSpendableDefaultArgonMicrogons(props.walletBalance);
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

const argonotCapacityLimitsPurchase = Vue.computed(() => {
  return props.programType === 'Argonot' && argonotBondCapacity.value < props.walletBalance;
});

const maxPurchaseAmount = Vue.computed(() => {
  const max = purchaseCapacity.value;
  return max - (max % unitsPerBond);
});

const maxPurchaseBonds = Vue.computed(() => Number(maxPurchaseAmount.value / unitsPerBond));

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
  let didSavePurchase = false;

  unsubProgress = info.subscribeToProgress(async (args, error) => {
    progressPct.value = args.progressPct;
    progressMessage.value = generateProgressLabel(args.confirmations, args.expectedConfirmations);

    if (error) {
      progressError.value = error.message ?? 'Transaction failed.';
    }

    if (args.progressPct >= 100 && !error && !didSavePurchase) {
      didSavePurchase = true;
      try {
        await argonBonds.saveBondPurchase(info);
      } catch (saveError) {
        console.error('Unable to save finalized bond purchase history', saveError);
      }
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
    const signer = await walletKeys.getDefaultArgonKeypair();
    let tx;
    let extrinsicType;
    let metadata;

    if (props.programType === 'Argonot') {
      tx = client.tx.treasury.buyArgonotBonds(purchaseBonds.value);
      extrinsicType = ExtrinsicType.TreasuryBuyArgonotBonds;
      metadata = { bondPurchaseMicronots: purchaseAmount.value };
    } else {
      if (!props.vaultId) throw new Error('Select a vault before buying bonds.');
      tx = await TreasuryBonds.buildBuyBondTx({
        client,
        vaultId: props.vaultId,
        bondPurchaseMicrogons: purchaseAmount.value,
      });
      extrinsicType = ExtrinsicType.TreasuryBuyBonds;
      metadata = {
        vaultId: props.vaultId,
        bondPurchaseMicrogons: purchaseAmount.value,
      };
    }

    const info = await transactionTracker.submitAndWatch({
      tx,
      txSigner: signer,
      extrinsicType,
      metadata,
    });

    trackTxInfo(info);
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : 'Transaction failed. Please try again.';
    isSubmitting.value = false;
  }
}

let unsubVault: (() => void) | undefined;

Vue.onMounted(async () => {
  if (props.programType === 'Argonot') {
    const client = await getMainchainClient(false);
    const [totalIssuance, totalActiveBonds] = await Promise.all([
      client.query.ownership.totalIssuance(),
      client.query.treasury.totalActiveArgonotBonds(),
    ]);
    argonotBondCapacity.value = TreasuryBonds.getArgonotBondPurchaseCapacity({
      totalIssuanceMicronots: totalIssuance.toBigInt(),
      maxBondedPercent: client.consts.treasury.maxArgonotBondedPercentOfCirculation.toNumber(),
      totalActiveBonds: totalActiveBonds.toNumber(),
    });
  } else if (props.vaultId) {
    vault.value = vaults.vaultsById[props.vaultId];
    unsubVault = await vaults.subscribeToVault(props.vaultId, updatedVault => {
      vault.value = updatedVault;
    });
  }

  await transactionTracker.load();
  const pendingBuyTxInfo = transactionTracker.findLatestTxInfo<{
    vaultId?: number;
    bondPurchaseMicrogons?: bigint;
    bondPurchaseMicronots?: bigint;
  }>(candidate => {
    if (candidate.tx.accountAddress !== walletKeys.defaultArgonAddress) return false;
    if (candidate.tx.submissionErrorJson || candidate.tx.blockExtrinsicErrorJson) return false;

    if (props.programType === 'Argonot') {
      if (candidate.tx.extrinsicType !== ExtrinsicType.TreasuryBuyArgonotBonds) return false;
      if ((candidate.tx.metadataJson?.bondPurchaseMicronots ?? 0n) <= 0n) return false;
    } else {
      if (candidate.tx.extrinsicType !== ExtrinsicType.TreasuryBuyBonds) return false;
      if (candidate.tx.metadataJson?.vaultId !== props.vaultId) return false;
      if ((candidate.tx.metadataJson?.bondPurchaseMicrogons ?? 0n) <= 0n) return false;
    }

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
