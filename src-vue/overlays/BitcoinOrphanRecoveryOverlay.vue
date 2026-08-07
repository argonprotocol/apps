<template>
  <OverlayBase
    :isOpen="true"
    data-testid="BitcoinOrphanRecoveryOverlay"
    @close="emit('close')"
    @pressEsc="emit('close')"
    class="w-5/12"
  >
    <template #title>
      <div class="text-xl font-bold text-slate-800/80">Return Orphaned Bitcoin</div>
    </template>

    <div class="space-y-5 px-7 py-6">
      <div class="rounded-lg bg-slate-50 px-4 py-4 ring-1 ring-slate-200">
        <div class="text-sm font-semibold tracking-wide text-slate-500 uppercase">
          {{ isAdditionalDeposit ? 'Additional Bitcoin received' : 'Deposit mismatch' }}
        </div>
        <div class="mt-3 grid grid-cols-2 divide-x divide-slate-200">
          <div class="pr-4">
            <div class="text-sm text-slate-500">Received</div>
            <div class="mt-0.5 text-lg font-semibold text-slate-900">{{ bitcoinAmount }} BTC</div>
          </div>
          <div class="pl-4">
            <div class="text-sm text-slate-500">
              {{ isAdditionalDeposit ? 'Already funded with' : 'Expected for lock' }}
            </div>
            <div class="mt-0.5 text-lg font-semibold text-slate-900">{{ comparisonBitcoinAmount }} BTC</div>
          </div>
        </div>
        <div class="mt-3 flex items-center justify-between border-t border-slate-200 pt-3 text-sm">
          <span class="text-slate-500">Received {{ receivedAt }}</span>
          <a
            :href="mempool.txUrl(record.txid)"
            target="_blank"
            rel="noopener noreferrer"
            class="text-argon-600 inline-flex items-center gap-1 hover:underline"
          >
            View transaction
            <ArrowTopRightOnSquareIcon class="h-4 w-4" />
          </a>
        </div>
      </div>

      <div v-if="record.status === BitcoinUtxoStatus.Orphaned" class="space-y-5">
        <p v-if="isAdditionalDeposit" class="text-sm text-slate-700">
          This lock was already funded before this Bitcoin arrived. Choose an address you control and return the
          additional payment.
        </p>
        <p v-else class="text-sm text-slate-700">
          This Bitcoin cannot fund a lock. Choose an address you control and request its return.
        </p>

        <div>
          <label class="mb-2 block font-medium text-gray-700">Return destination address</label>
          <input
            v-model="destinationAddress"
            data-testid="BitcoinOrphanRecoveryOverlay.returnDestination"
            type="text"
            placeholder="bc1q..."
            :class="destinationError ? 'border-red-400 text-red-900' : 'border-slate-700/50'"
            class="focus:ring-argon-500 w-full rounded-md border px-3 py-3 focus:border-transparent focus:ring-2"
          />
          <p class="mt-2 text-sm" :class="destinationError ? 'font-semibold text-red-700' : 'text-slate-500'">
            {{ destinationError || `Use a ${bitcoinNetworkName} address you control.` }}
          </p>
        </div>

        <BitcoinFeeRateInput v-model="feeRatePerSatVb" dataTestid="BitcoinOrphanRecoveryOverlay.feeRate" />

        <button
          data-testid="BitcoinOrphanRecoveryOverlay.requestReturn()"
          :disabled="!canSubmit"
          @click="requestReturn"
          class="bg-argon-600 hover:bg-argon-700 w-full cursor-pointer rounded-lg px-6 py-2.5 font-bold text-white disabled:cursor-not-allowed disabled:opacity-50"
        >
          {{ isSubmitting ? 'Requesting Return...' : 'Return Bitcoin' }}
        </button>
        <p v-if="isCheckingArgonFee" class="text-sm text-slate-500">
          Checking the Internal App Wallet transaction fee...
        </p>
        <p v-else-if="argonFeeQuote && !argonFeeQuote.canAfford" class="text-sm text-red-700">
          Add
          <span class="font-mono font-semibold">{{ formatArgon(argonFeeShortfall) }}</span>
          to the Internal App Wallet to cover the Argon transaction fee.
        </p>
        <p v-else-if="argonFeeQuote" class="text-sm text-slate-500">
          Argon transaction fee: approximately {{ formatArgon(argonFeeQuote.txFee) }}.
        </p>
        <p v-else-if="argonFeeQuoteError" class="text-sm text-red-700">{{ argonFeeQuoteError }}</p>
      </div>

      <div v-else class="space-y-4">
        <template v-if="isArgonRequestInProgress">
          <div class="mt-6">
            <div class="fade-progress text-center text-5xl font-bold">
              {{ numeral(argonRequestProgressPct).format('0.00') }}%
            </div>
          </div>

          <ProgressBar :progress="argonRequestProgressPct" :showLabel="false" class="h-4" />

          <div class="mt-1 text-center font-light text-gray-500">{{ argonRequestProgressLabel }}</div>
        </template>

        <div v-else class="border-argon-100 bg-argon-50 space-y-2 rounded-lg border px-4 py-3">
          <template
            v-if="
              record.status === BitcoinUtxoStatus.ReleaseComplete ||
              record.status === BitcoinUtxoStatus.ReleaseCompleteAcknowledged
            "
          >
            <div class="font-semibold text-slate-800">Bitcoin returned</div>
            <p class="text-sm text-slate-600">The Bitcoin was returned to the requested destination.</p>
          </template>
          <template v-else-if="record.status === BitcoinUtxoStatus.ReleaseIsProcessingOnBitcoin">
            <div class="font-semibold text-slate-800">Returning on Bitcoin</div>
            <p class="text-sm text-slate-600">
              The return transaction was broadcast and is waiting for Bitcoin confirmations.
            </p>
          </template>
          <template v-else-if="record.releaseCosignVaultSignature">
            <div class="font-semibold text-slate-800">Preparing Bitcoin return</div>
            <p class="text-sm text-slate-600">The vault signed the return. Preparing the Bitcoin transaction.</p>
          </template>
          <template v-else>
            <div class="font-semibold text-slate-800">Awaiting vault signature</div>
            <p class="text-sm text-slate-600">
              The vault operator has been asked to sign this return. You can close this screen and come back later.
            </p>
          </template>
          <ProgressBar
            v-if="record.status === BitcoinUtxoStatus.ReleaseIsProcessingOnBitcoin"
            :progress="releaseProgress.progressPct"
            :showLabel="false"
            class="h-4"
          />
        </div>

        <div class="space-y-3 rounded-lg border border-slate-200 px-4 py-4">
          <div class="text-sm font-semibold tracking-wide text-slate-500 uppercase">Return request details</div>
          <dl class="space-y-3 text-sm">
            <div>
              <dt class="text-slate-500">Destination</dt>
              <dd class="mt-0.5 font-mono text-sm break-all text-slate-800">{{ releaseDestinationAddress }}</dd>
            </div>
            <div v-if="record.releaseBitcoinNetworkFee != null">
              <dt class="text-slate-500">Bitcoin network fee</dt>
              <dd class="mt-0.5 text-slate-800">
                <span v-if="releaseFeeRate != null">{{ releaseFeeRate }} sats/vbyte ·</span>
                {{ numeral(record.releaseBitcoinNetworkFee).format('0,0') }} sats total
              </dd>
            </div>
            <div>
              <dt class="text-slate-500">Request sent</dt>
              <dd class="mt-0.5 text-slate-800">
                {{ releaseRequestedAt || 'Waiting for Argon confirmation' }}
              </dd>
            </div>
          </dl>
          <a
            v-if="record.releaseTxid"
            :href="mempool.txUrl(record.releaseTxid)"
            target="_blank"
            rel="noopener noreferrer"
            class="text-argon-600 inline-flex items-center gap-1 text-sm hover:underline"
          >
            View return transaction
            <ArrowTopRightOnSquareIcon class="h-4 w-4" />
          </a>
        </div>
      </div>

      <p v-if="record.statusError || requestError" class="text-sm font-semibold text-red-700">
        {{ requestError || record.statusError }}
      </p>
    </div>
  </OverlayBase>
</template>

<script setup lang="ts">
import * as Vue from 'vue';
import dayjs from 'dayjs';
import utc from 'dayjs/plugin/utc';
import { CosignScript } from '@argonprotocol/bitcoin';
import { MiningFrames } from '@argonprotocol/apps-core';
import { ArrowTopRightOnSquareIcon } from '@heroicons/vue/24/outline';
import numeral, { createNumeralHelpers } from '../lib/numeral.ts';
import OverlayBase from './OverlayBase.vue';
import ProgressBar from '../components/ProgressBar.vue';
import BitcoinFeeRateInput from './bitcoin-locking/components/BitcoinFeeRateInput.vue';
import { getBitcoinNetworkName, validateBitcoinAddressForNetwork } from '../lib/BitcoinAddressValidation.ts';
import { getBitcoinLocks } from '../stores/bitcoin.ts';
import { getCurrency } from '../stores/currency.ts';
import { useWallets } from '../stores/wallets.ts';
import type { IBitcoinLockRecord } from '../lib/db/BitcoinLocksTable.ts';
import { BitcoinUtxoStatus, type IBitcoinUtxoRecord } from '../lib/db/BitcoinUtxosTable.ts';
import { TransactionStatus } from '../lib/db/TransactionsTable.ts';
import BitcoinLocks from '../lib/BitcoinLocks.ts';
import BitcoinMempool from '../lib/BitcoinMempool.ts';
import { ESPLORA_HOST } from '../lib/Env.ts';
import { generateProgressLabel } from '../lib/Utils.ts';

dayjs.extend(utc);

const props = defineProps<{
  lock: IBitcoinLockRecord;
  record: IBitcoinUtxoRecord;
}>();
const emit = defineEmits<{ close: [] }>();
const bitcoinLocks = getBitcoinLocks();
const currency = getCurrency();
const wallets = useWallets();
const { microgonToArgonNm } = createNumeralHelpers(currency);
const mempool = new BitcoinMempool(ESPLORA_HOST);

const destinationAddress = Vue.ref('');
const feeRatePerSatVb = Vue.ref(5n);
const isSubmitting = Vue.ref(false);
const requestError = Vue.ref('');
const argonFeeQuote = Vue.ref<{ canAfford: boolean; availableBalance: bigint; txFee: bigint }>();
const argonFeeQuoteError = Vue.ref('');
const isCheckingArgonFee = Vue.ref(false);
const argonRequestProgressPct = Vue.ref(0);
const argonRequestConfirmations = Vue.ref(-1);
const argonRequestExpectedConfirmations = Vue.ref(0);
const isArgonRequestInProgress = Vue.ref(false);

const bitcoinAmount = Vue.computed(() =>
  numeral(currency.convertSatToBtc(props.record.satoshis)).format('0,0.[00000000]'),
);
const acceptedFundingRecord = Vue.computed(() => bitcoinLocks.getAcceptedFundingRecord(props.lock));
const isAdditionalDeposit = Vue.computed(() => {
  const fundingRecord = acceptedFundingRecord.value;
  if (!fundingRecord || fundingRecord.id === props.record.id) return false;

  const fundingHeight = fundingRecord.firstSeenBitcoinHeight;
  const receivedHeight = props.record.firstSeenBitcoinHeight;
  if (fundingHeight > 0 && receivedHeight > 0 && fundingHeight !== receivedHeight) {
    return fundingHeight < receivedHeight;
  }

  return fundingRecord.firstSeenAt.getTime() < props.record.firstSeenAt.getTime();
});
const comparisonBitcoinAmount = Vue.computed(() => {
  const satoshis = isAdditionalDeposit.value
    ? (acceptedFundingRecord.value?.satoshis ?? props.lock.satoshis)
    : props.lock.satoshis;
  return numeral(currency.convertSatToBtc(satoshis)).format('0,0.[00000000]');
});
const receivedAt = Vue.computed(() => {
  const transactionBlockTime = props.record.mempoolObservation?.transactionBlockTime;
  const receivedDate = transactionBlockTime ? dayjs.unix(transactionBlockTime) : dayjs(props.record.firstSeenAt);
  return receivedDate.local().format('MMM D, YYYY [at] h:mm A');
});

const trimmedDestination = Vue.computed(() => destinationAddress.value.trim());
const currentLockAddress = Vue.computed(() => {
  try {
    return bitcoinLocks.formatP2wshAddress(props.lock.lockDetails.p2wshScriptHashHex);
  } catch {
    return '';
  }
});
const destinationError = Vue.computed(() =>
  validateBitcoinAddressForNetwork(trimmedDestination.value, bitcoinLocks.bitcoinNetwork, {
    disallowAddress: currentLockAddress.value,
  }),
);
const bitcoinNetworkName = Vue.computed(() => getBitcoinNetworkName(bitcoinLocks.bitcoinNetwork));

const releaseDestinationAddress = Vue.computed(() => {
  if (!props.record.releaseToDestinationAddress) return '';
  try {
    return BitcoinLocks.formatAddressBytes(props.record.releaseToDestinationAddress, bitcoinLocks.bitcoinNetwork);
  } catch {
    return props.record.releaseToDestinationAddress;
  }
});
const releaseRequestedAt = Vue.computed(() => {
  if (props.record.requestedReleaseAtTick == null) return '';
  return dayjs
    .utc(MiningFrames.getTickDate(props.record.requestedReleaseAtTick))
    .local()
    .format('MMM D, YYYY [at] h:mm A');
});
const releaseFeeRate = Vue.computed(() => {
  const networkFee = props.record.releaseBitcoinNetworkFee;
  const destination = props.record.releaseToDestinationAddress;
  if (networkFee == null || !destination) return;

  try {
    const cosignScript = new CosignScript(props.lock.lockDetails, bitcoinLocks.bitcoinNetwork);
    const oneSatFee = cosignScript.calculateFee(1n, destination);
    const feeRate = (networkFee + oneSatFee / 2n) / oneSatFee;
    if (cosignScript.calculateFee(feeRate, destination) === networkFee) return feeRate;
  } catch {
    return;
  }
});

const canSubmit = Vue.computed(
  () =>
    trimmedDestination.value.length > 0 &&
    !destinationError.value &&
    argonFeeQuote.value?.canAfford === true &&
    !isSubmitting.value,
);
const argonFeeShortfall = Vue.computed(() => {
  if (!argonFeeQuote.value) return 0n;
  const shortfall = argonFeeQuote.value.txFee - argonFeeQuote.value.availableBalance;
  return shortfall > 0n ? shortfall : 0n;
});
const releaseProgress = Vue.computed(() => bitcoinLocks.utxoTracking.getReleaseLifecycleProgress(props.record));
const argonRequestProgressLabel = Vue.computed(() => {
  return generateProgressLabel(argonRequestConfirmations.value, argonRequestExpectedConfirmations.value, {
    blockType: 'Argon',
  });
});

let feeQuoteTimeout: ReturnType<typeof setTimeout> | undefined;
let feeQuoteRunId = 0;
let stopArgonRequestProgress: (() => void) | undefined;

Vue.watch(
  [trimmedDestination, feeRatePerSatVb, () => wallets.liquidLockingWallet.availableMicrogons],
  () => {
    if (feeQuoteTimeout) clearTimeout(feeQuoteTimeout);
    const runId = ++feeQuoteRunId;
    argonFeeQuote.value = undefined;
    argonFeeQuoteError.value = '';
    requestError.value = '';
    if (!trimmedDestination.value || destinationError.value) {
      isCheckingArgonFee.value = false;
      return;
    }

    isCheckingArgonFee.value = true;
    feeQuoteTimeout = setTimeout(() => void refreshArgonFeeQuote(runId), 200);
  },
  { immediate: true },
);

Vue.onUnmounted(() => {
  if (feeQuoteTimeout) clearTimeout(feeQuoteTimeout);
  stopArgonRequestProgress?.();
});

Vue.onMounted(() => trackArgonRequestProgress());

async function requestReturn(): Promise<void> {
  if (!canSubmit.value) return;
  isSubmitting.value = true;
  isArgonRequestInProgress.value = true;
  requestError.value = '';

  try {
    const txInfo = await bitcoinLocks.orphanReleases.requestOrphanReturn({
      lock: props.lock,
      record: props.record,
      toScriptPubkey: trimmedDestination.value,
      feeRatePerSatVb: feeRatePerSatVb.value,
    });
    trackArgonRequestProgress(txInfo);
  } catch (error) {
    isArgonRequestInProgress.value = false;
    requestError.value = error instanceof Error ? error.message : String(error);
  } finally {
    isSubmitting.value = false;
  }
}

function trackArgonRequestProgress(
  txInfo = bitcoinLocks.orphanReleases.getTransactionInfo(props.record.lockUtxoId, props.record),
): void {
  if (!txInfo) return;

  isArgonRequestInProgress.value = [TransactionStatus.Submitted, TransactionStatus.InBlock].includes(txInfo.tx.status);
  stopArgonRequestProgress?.();
  stopArgonRequestProgress = txInfo.subscribeToProgress((progress, error) => {
    argonRequestProgressPct.value = progress.progressPct;
    argonRequestConfirmations.value = progress.confirmations;
    argonRequestExpectedConfirmations.value = progress.expectedConfirmations;
    isArgonRequestInProgress.value = progress.progressPct < 100 && !error;
    if (error) requestError.value = error.message;
  });
}

async function refreshArgonFeeQuote(runId: number): Promise<void> {
  try {
    const quote = await bitcoinLocks.orphanReleases.getOrphanReturnFeeQuote({
      lock: props.lock,
      record: props.record,
      toScriptPubkey: trimmedDestination.value,
      feeRatePerSatVb: feeRatePerSatVb.value,
    });
    if (runId !== feeQuoteRunId) return;
    argonFeeQuote.value = quote;
  } catch {
    if (runId !== feeQuoteRunId) return;
    argonFeeQuoteError.value = 'Unable to check the Argon transaction fee. Please try again.';
  } finally {
    if (runId === feeQuoteRunId) isCheckingArgonFee.value = false;
  }
}

function formatArgon(microgons: bigint): string {
  const value = Math.abs(microgonToArgonNm(microgons)._value);
  return `${currency.symbol}${microgonToArgonNm(microgons).format(value > 0 && value < 0.01 ? '0,0.[000000]' : '0,0.00')}`;
}
</script>
