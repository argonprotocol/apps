<!-- prettier-ignore -->
<template>
  <OverlayBase :isOpen="true" @close="emit('close')" @pressEsc="emit('close')" class="w-5/12">
    <template #title>
      <div class="grow text-2xl font-bold">Ratchet Your
        {{ numeral(currency.convertSatToBtc(personalLock.satoshis)).format('0,0.[00000000]') }} BTC
      </div>
    </template>

    <div v-if="isLoadingPreview && !ratchetPreview" class="flex min-h-32 items-center justify-center gap-2 text-slate-500">
      <Spinner class="h-5 w-5" />
      <span>Loading ratchet details...</span>
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

      <div
        v-if="ratchetPreview.securitizationToAdd > 0n"
        class="rounded border border-amber-200 bg-amber-50 px-3 py-2 text-amber-800"
      >
        Because this Bitcoin is used as flexible capacity, it must be fully securitized before it can ratchet. This ratchet
        requires {{ currency.symbol
        }}{{ microgonToMoneyNm(ratchetPreview.securitizationToAdd).format('0,0.00') }} more in vault security. That
        amount will be added from your wallet with the ratchet.
      </div>
      <div
        v-else-if="ratchetPreview.shortfall > 0n"
        class="rounded border border-red-200 bg-red-50 px-3 py-2 text-red-700"
      >
        This vault needs {{ currency.symbol }}{{ microgonToMoneyNm(ratchetPreview.shortfall).format('0,0.00') }} more
        security before it can ratchet this Bitcoin lock.
      </div>
      <div v-else-if="!ratchetPreview.canRatchet" class="rounded border border-amber-200 bg-amber-50 px-3 py-2 text-amber-700">
        No ratchet is currently available for this Bitcoin lock.
      </div>
    </div>

    <div class="px-5 py-5">
      <div v-if="txInfo" class="mb-4 space-y-2">
        <ProgressBar :progress="progressPct" :hasError="!!errorMessage" :showLabel="false" class="h-4" />
        <div class="text-sm text-slate-500">{{ progressLabel }}</div>
      </div>
      <button
        @click="submitRatchet"
        :disabled="isSubmitting || isLoadingPreview || !ratchetPreview?.canRatchet || !ratchetRateMicrogonsPerBtc"
        class="bg-argon-600 inline-flex items-center px-5 py-1 text-white border border-argon-800 rounded disabled:opacity-50 cursor-pointer"
      >
        <Spinner v-if="isSubmitting" class="Inverse mr-2 ml-2 h-4 min-h-4 w-4 min-w-4" />
        {{ submitLabel }}
      </button>
      <div v-if="errorMessage" class="mt-3 text-sm text-red-600">{{ errorMessage }}</div>
    </div>

  </OverlayBase>
</template>

<script setup lang="ts">
import * as Vue from 'vue';
import OverlayBase from './OverlayBase.vue';
import { getWalletKeys } from '../stores/wallets.ts';
import { getMainchainClient, getMiningFrames } from '../stores/mainchain.ts';
import { IBitcoinLockRecord } from '../lib/db/BitcoinLocksTable.ts';
import numeral, { createNumeralHelpers } from '../lib/numeral.ts';
import { getCurrency } from '../stores/currency.ts';
import { getBitcoinLocks } from '../stores/bitcoin.ts';
import type { IBitcoinRatchetMetadata, IBitcoinRatchetPreview } from '../lib/BitcoinLocks.ts';
import type { TransactionInfo } from '../lib/TransactionInfo.ts';
import ProgressBar from '../components/ProgressBar.vue';
import Spinner from '../components/Spinner.vue';

const currency = getCurrency();
const bitcoinLocks = getBitcoinLocks();
const walletKeys = getWalletKeys();
const miningFrames = getMiningFrames();
const { microgonToMoneyNm } = createNumeralHelpers(currency);
const isSubmitting = Vue.ref(false);
const isLoadingPreview = Vue.ref(true);
const errorMessage = Vue.ref('');
const ratchetPreview = Vue.ref<IBitcoinRatchetPreview>();
const ratchetRateMicrogonsPerBtc = Vue.ref<bigint>();
const txInfo = Vue.shallowRef<TransactionInfo<IBitcoinRatchetMetadata>>();
const progressPct = Vue.ref(0);
const progressLabel = Vue.ref('');
let unsubscribeProgress: (() => void) | undefined;
let unsubscribeTicks: (() => void) | undefined;
let pendingPreviewLoad: Promise<void> | undefined;
let lastPreviewRefreshTick = 0;
let isDisposed = false;

const props = defineProps<{
  personalLock: IBitcoinLockRecord;
}>();

const emit = defineEmits<{
  (e: 'close'): void;
  (e: 'completed'): void;
  (e: 'preparing', state: { isPreparing: boolean; utxoId?: number }): void;
}>();

const submitLabel = Vue.computed(() => {
  if (isSubmitting.value) return 'Ratchet pending...';
  if (ratchetPreview.value?.securitizationToAdd) return 'Add Security & Ratchet';
  return 'Finish Ratchet';
});

function loadRatchetPreview(): Promise<void> {
  if (pendingPreviewLoad) return pendingPreviewLoad;

  pendingPreviewLoad = (async () => {
    isLoadingPreview.value = true;
    errorMessage.value = '';

    try {
      const quoteClient = await getMainchainClient(false);
      const [, eligibleRates] = await Promise.all([
        currency.fetchMainchainRates(quoteClient, { ignoreCache: true }),
        quoteClient.query.bitcoinLocks.microgonPerBtcHistory(),
      ]);
      const rate = eligibleRates.at(-1)?.[1].toBigInt();
      if (!rate) throw new Error('Network bitcoin pricing is currently unavailable. Please try again later.');

      const preview = await bitcoinLocks.getRatchetPreview(props.personalLock, rate);
      if (isDisposed) return;

      ratchetRateMicrogonsPerBtc.value = rate;
      ratchetPreview.value = preview;
    } catch (error) {
      ratchetRateMicrogonsPerBtc.value = undefined;
      errorMessage.value = error instanceof Error ? error.message : 'Unable to load ratchet details.';
    } finally {
      isLoadingPreview.value = false;
    }
  })().finally(() => {
    pendingPreviewLoad = undefined;
  });

  return pendingPreviewLoad;
}

async function submitRatchet() {
  if (isSubmitting.value || !ratchetPreview.value?.canRatchet) return;

  isSubmitting.value = true;
  setPreparing(true);
  errorMessage.value = '';

  try {
    await loadRatchetPreview();
    if (!ratchetPreview.value?.canRatchet || !ratchetRateMicrogonsPerBtc.value) {
      isSubmitting.value = false;
      setPreparing(false);
      return;
    }

    const txSigner =
      ratchetPreview.value.securitizationToAdd > 0n
        ? await walletKeys.getVaultingKeypair()
        : await walletKeys.getLiquidLockingKeypair();
    // This overlay instance can be disposed while the signer loads; do not start a transaction afterward.
    if (isDisposed) {
      setPreparing(false);
      return;
    }
    const info = await bitcoinLocks.ratchet(props.personalLock, txSigner, ratchetRateMicrogonsPerBtc.value);
    trackTransaction(info);
    setPreparing(false);
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : 'Unable to ratchet this Bitcoin lock.';
    isSubmitting.value = false;
    setPreparing(false);
  }
}

function setPreparing(isPreparing: boolean) {
  emit('preparing', { isPreparing, utxoId: props.personalLock.utxoId });
}

function trackTransaction(info: TransactionInfo<IBitcoinRatchetMetadata>) {
  if (isDisposed) return;
  unsubscribeProgress?.();
  txInfo.value = info;
  isSubmitting.value = true;

  const status = info.getStatus();
  progressPct.value = status.progressPct;
  progressLabel.value = status.isFinalized ? 'Finalizing ratchet details...' : 'Waiting for transaction status...';

  unsubscribeProgress = info.subscribeToProgress((progress, error) => {
    progressPct.value = progress.progressPct;
    progressLabel.value = progress.progressMessage;
    if (error) {
      errorMessage.value = error.message;
    }
  });

  void info.waitForPostProcessing.then(
    () => {
      // Post-processing cannot be cancelled; this disposed instance must not reload the parent dashboard.
      if (isDisposed) return;
      const error = info.getStatus().error;
      if (error) {
        errorMessage.value = error.message;
        isSubmitting.value = false;
        return;
      }

      progressPct.value = 100;
      emit('completed');
    },
    error => {
      errorMessage.value = error instanceof Error ? error.message : 'Unable to save the completed ratchet.';
      isSubmitting.value = false;
    },
  );
}

Vue.onMounted(async () => {
  await Promise.all([bitcoinLocks.load(), miningFrames.load()]);
  // This overlay instance can be disposed while recovered state loads; do not subscribe afterward.
  if (isDisposed) return;
  const pendingTxInfo = bitcoinLocks.getPendingRatchetTxInfo(props.personalLock);
  if (pendingTxInfo) {
    isLoadingPreview.value = false;
    trackTransaction(pendingTxInfo);
    return;
  }

  await loadRatchetPreview();
  if (isDisposed) return;

  lastPreviewRefreshTick = miningFrames.currentTick;
  unsubscribeTicks = miningFrames.onTick(() => {
    if (isSubmitting.value || miningFrames.currentTick - lastPreviewRefreshTick < 10) return;

    lastPreviewRefreshTick = miningFrames.currentTick;
    void loadRatchetPreview();
  }).unsubscribe;
});

Vue.onUnmounted(() => {
  isDisposed = true;
  unsubscribeProgress?.();
  unsubscribeTicks?.();
});
</script>
