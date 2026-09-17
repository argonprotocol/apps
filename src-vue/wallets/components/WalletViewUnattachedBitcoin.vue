<template>
  <div data-testid="WalletViewUnattachedBitcoin" class="flex h-full grow flex-col text-black/90">
    <WalletHeader
      name="Return Bitcoin"
      :showHome="props.showBack"
      :isDragging="props.isDragging"
      @dragStart="emit('dragStart', $event)"
      @goto="emit('goto', $event)"
      @close="emit('close')"
    />

    <div class="min-h-0 grow space-y-5 overflow-y-auto px-5 py-4 text-sm text-slate-700">
      <div class="rounded-lg bg-slate-50/50 px-4 py-4 ring-1 ring-slate-200">
        <div class="flex items-start justify-between gap-4">
          <div>
            <div class="text-sm text-slate-500">Amount received</div>
            <div class="mt-0.5 text-lg font-semibold text-slate-900">{{ bitcoinAmount }} BTC</div>
          </div>
          <div class="text-right">
            <div class="text-sm text-slate-500">Cosigner</div>
            <div class="mt-0.5 text-lg font-semibold text-slate-800">{{ vaultName }}</div>
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

      <div v-if="canRequestReturn" class="space-y-5">
        <p>
          This Bitcoin could not be added to your wallet because a return was already in progress or the account had
          reached its UTXO limit. Choose an address you control to return it.
        </p>

        <div>
          <label class="mb-1 block font-bold text-gray-500/80">Return To</label>
          <input
            v-model="destinationAddress"
            data-testid="WalletViewUnattachedBitcoin.returnDestination"
            type="text"
            autocomplete="off"
            spellcheck="false"
            placeholder="bc1q..."
            :class="destinationError ? 'border-red-400 text-red-900' : 'border-slate-700/50'"
            class="h-[30px] w-full rounded-md border bg-white px-2 font-mono text-sm outline-none placeholder:text-gray-400"
          />
          <p class="mt-2 text-sm" :class="destinationError ? 'font-semibold text-red-700' : 'text-slate-500'">
            {{ destinationError || `Use a ${bitcoinNetworkName} address you control.` }}
          </p>
        </div>

        <BitcoinFeeRateInput v-model="feeRatePerSatVb" dataTestid="WalletViewUnattachedBitcoin.feeRate" />

        <div
          v-if="trimmedDestination && !destinationError"
          data-testid="WalletViewUnattachedBitcoin.cost"
          class="flex flex-col gap-x-3"
        >
          <label class="mb-1 font-bold text-gray-500/80">Cost of Return</label>
          <div class="border-b border-gray-300 text-sm">
            <div class="flex flex-row border-t border-gray-300 py-2">
              <div class="grow">
                <Tooltip
                  :asChild="true"
                  content="The Bitcoin network fee is deducted from this deposit before it is returned."
                >
                  <span class="inline-flex cursor-help items-center gap-1">
                    Bitcoin Network
                    <InformationCircleIcon class="size-3.5 text-gray-400" />
                  </span>
                </Tooltip>
              </div>
              <div class="relative ml-4 text-right">
                <span :class="{ 'opacity-20': isCheckingArgonFee }">
                  {{ satToBtcNm(argonFeeQuote?.bitcoinNetworkFee ?? 0n).format('0,0.[00000000]') }} BTC ({{
                    currency.symbol
                  }}{{
                    microgonToMoneyNm(currency.convertSatToMicrogon(argonFeeQuote?.bitcoinNetworkFee ?? 0n)).format(
                      '0,0.000',
                    )
                  }})
                </span>
                <span
                  v-if="isCheckingArgonFee"
                  class="border-t-argon-600 absolute top-1/2 right-0 size-3 -translate-y-1/2 animate-spin rounded-full border-2 border-slate-300"
                />
              </div>
            </div>
            <div class="flex flex-row border-t border-gray-300 py-2">
              <div class="grow">Argon Network</div>
              <div class="relative ml-4 text-right">
                <span :class="{ 'opacity-20': isCheckingArgonFee }">
                  {{ formatArgon(argonFeeQuote?.txFee ?? 0n) }}
                </span>
              </div>
            </div>
          </div>
        </div>

        <p v-if="argonFeeQuote && !argonFeeQuote.canAfford" class="text-sm text-red-700">
          Add
          <span class="font-mono font-semibold">{{ formatArgon(argonFeeShortfall) }}</span>
          to the Internal App Wallet to cover the Argon transaction fee.
        </p>
        <div v-else-if="argonFeeQuoteError" class="flex items-center justify-between gap-3 text-sm text-red-700">
          <p>{{ argonFeeQuoteError }}</p>
          <button
            type="button"
            data-testid="WalletViewUnattachedBitcoin.retryArgonFeeQuote()"
            class="text-argon-600 shrink-0 cursor-pointer font-semibold hover:underline"
            @click="queueArgonFeeQuote"
          >
            Try again
          </button>
        </div>

        <button
          data-testid="WalletViewUnattachedBitcoin.requestReturn()"
          :disabled="!canSubmit"
          @click="requestReturn"
          class="border-argon-700 bg-argon-600 hover:bg-argon-700 w-full cursor-pointer rounded-lg border px-5 py-2 font-semibold text-white disabled:cursor-not-allowed disabled:border-gray-400 disabled:bg-gray-300 disabled:text-gray-500"
        >
          {{ isSubmitting ? 'Requesting Return...' : 'Return Bitcoin' }}
        </button>
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
          <template v-if="release?.status === BitcoinReleaseStatus.Complete">
            <div class="font-semibold text-slate-800">Bitcoin returned</div>
            <p class="text-sm text-slate-600">The Bitcoin was returned to the requested destination.</p>
          </template>
          <template
            v-else-if="
              release?.status === BitcoinReleaseStatus.ConfirmingOnBitcoin ||
              release?.status === BitcoinReleaseStatus.WaitingForArgonRecognition
            "
          >
            <div class="font-semibold text-slate-800">Returning on Bitcoin</div>
            <p class="text-sm text-slate-600">
              The return transaction was broadcast and is waiting for Bitcoin confirmations.
            </p>
          </template>
          <template v-else-if="release?.vaultSignatures.length">
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
            v-if="release?.status === BitcoinReleaseStatus.ConfirmingOnBitcoin"
            :progress="releaseProgress.progressPct"
            :showLabel="false"
            class="h-4"
          />
        </div>

        <div class="space-y-3 rounded-lg border border-slate-200 px-4 py-4">
          <div class="font-bold text-gray-500/80">Return request details</div>
          <dl class="space-y-3 text-sm">
            <div>
              <dt class="text-slate-500">Destination</dt>
              <dd class="mt-0.5 font-mono text-sm break-all text-slate-800">{{ releaseDestinationAddress }}</dd>
            </div>
            <div v-if="release">
              <dt class="text-slate-500">Bitcoin network fee</dt>
              <dd class="mt-0.5 text-slate-800">
                <span v-if="releaseFeeRate != null">{{ releaseFeeRate }} sats/vbyte ·</span>
                {{ numeral(release.bitcoinNetworkFee).format('0,0') }} sats total
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
            v-if="release?.bitcoinTxid"
            :href="mempool.txUrl(release.bitcoinTxid)"
            target="_blank"
            rel="noopener noreferrer"
            class="text-argon-600 inline-flex items-center gap-1 text-sm hover:underline"
          >
            View return transaction
            <ArrowTopRightOnSquareIcon class="h-4 w-4" />
          </a>
        </div>
      </div>

      <p v-if="release?.statusError || record.statusError || requestError" class="text-sm font-semibold text-red-700">
        {{ requestError || release?.statusError || record.statusError }}
      </p>
    </div>
  </div>
</template>

<script setup lang="ts">
import * as Vue from 'vue';
import dayjs from 'dayjs';
import utc from 'dayjs/plugin/utc';
import { MiningFrames } from '@argonprotocol/apps-core';
import { ArrowTopRightOnSquareIcon, InformationCircleIcon } from '@heroicons/vue/24/outline';
import Tooltip from '../../components/Tooltip.vue';
import ProgressBar from '../../components/ProgressBar.vue';
import { BitcoinReleaseStatus } from '../../interfaces/IBitcoinReleaseRecord.ts';
import { getBitcoinNetworkName, validateBitcoinAddressForNetwork } from '../../lib/BitcoinAddressValidation.ts';
import BitcoinLocks from '../../lib/BitcoinLocks.ts';
import BitcoinMempool from '../../lib/BitcoinMempool.ts';
import type { IBitcoinLockRecord } from '../../lib/db/BitcoinLocksTable.ts';
import { TransactionStatus } from '../../lib/db/TransactionsTable.ts';
import { BitcoinUtxoStatus, type IBitcoinUtxoRecord } from '../../lib/db/BitcoinUtxosTable.ts';
import { ESPLORA_HOST } from '../../lib/Env.ts';
import numeral, { createNumeralHelpers } from '../../lib/numeral.ts';
import { generateProgressLabel } from '../../lib/Utils.ts';
import BitcoinFeeRateInput from '../../overlays/bitcoin-locking/components/BitcoinFeeRateInput.vue';
import { getBitcoinLocks, getBitcoinTransactionOperations } from '../../stores/bitcoin.ts';
import { getConfig } from '../../stores/config.ts';
import { getCurrency } from '../../stores/currency.ts';
import { getMyVault, getVaults } from '../../stores/vaults.ts';
import { getWalletKeys, useWallets } from '../../stores/wallets.ts';
import type { IWalletView } from '../walletOverlayState.ts';
import WalletHeader from './WalletHeader.vue';

dayjs.extend(utc);

const props = defineProps<{
  lock: IBitcoinLockRecord;
  record: IBitcoinUtxoRecord;
  isDragging: boolean;
  showBack: boolean;
}>();
const emit = defineEmits<{
  (event: 'dragStart', mouseEvent: MouseEvent): void;
  (event: 'goto', view: IWalletView): void;
  (event: 'close'): void;
}>();
const bitcoinLocks = getBitcoinLocks();
const { bitcoinOrphanRelease } = getBitcoinTransactionOperations();
const config = getConfig();
const currency = getCurrency();
const myVault = getMyVault();
const vaults = getVaults();
const wallets = useWallets();
const { microgonToArgonNm, microgonToMoneyNm, satToBtcNm } = createNumeralHelpers(currency);
const mempool = new BitcoinMempool(ESPLORA_HOST);

const destinationAddress = Vue.ref('');
const feeRatePerSatVb = Vue.ref(5n);
const isSubmitting = Vue.ref(false);
const requestError = Vue.ref('');
const argonFeeQuote = Vue.ref<{
  canAfford: boolean;
  availableBalance: bigint;
  bitcoinNetworkFee: bigint;
  txFee: bigint;
}>();
const argonFeeQuoteError = Vue.ref('');
const isCheckingArgonFee = Vue.ref(false);
const argonRequestProgressPct = Vue.ref(0);
const argonRequestConfirmations = Vue.ref(-1);
const argonRequestExpectedConfirmations = Vue.ref(0);
const isArgonRequestInProgress = Vue.ref(false);
const release = Vue.computed(
  () => bitcoinLocks.releases.getActiveForUtxo(props.record) ?? bitcoinLocks.releases.getLatestForUtxo(props.record),
);
const canRequestReturn = Vue.computed(
  () =>
    props.record.status === BitcoinUtxoStatus.Orphaned &&
    (!release.value ||
      release.value.status === BitcoinReleaseStatus.Cancelled ||
      release.value.status === BitcoinReleaseStatus.Failed ||
      release.value.status === BitcoinReleaseStatus.FailedAcknowledged),
);

const bitcoinAmount = Vue.computed(() =>
  numeral(currency.convertSatToBtc(props.record.satoshis)).format('0,0.[00000000]'),
);
const vaultName = Vue.computed(() => {
  if (props.lock.vaultId === (myVault.createdVault?.vaultId ?? myVault.vaultId)) return 'My Vault';
  const operatorName =
    vaults.operatorNamesByVaultId[props.lock.vaultId] ??
    (config.upstreamOperator?.vaultId === props.lock.vaultId ? config.upstreamOperator.name : undefined);
  return operatorName ? `${operatorName} Vault` : 'Vault';
});
const receivedAt = Vue.computed(() => {
  const transactionBlockTime = props.record.mempoolObservation?.transactionBlockTime;
  const receivedDate = transactionBlockTime ? dayjs.unix(transactionBlockTime) : dayjs(props.record.firstSeenAt);
  return receivedDate.local().format('MMM D, YYYY [at] h:mm A');
});

const trimmedDestination = Vue.computed(() => destinationAddress.value.trim());
const currentLockAddress = Vue.computed(() => {
  try {
    const scriptHash = props.lock.scriptDetails?.p2wshScriptHashHex;
    return scriptHash ? bitcoinLocks.formatP2wshAddress(scriptHash) : '';
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
  const destination = release.value?.toScriptPubkey;
  if (!destination) return '';
  try {
    return BitcoinLocks.formatAddressBytes(destination, bitcoinLocks.bitcoinNetwork);
  } catch {
    return destination;
  }
});
const releaseRequestedAt = Vue.computed(() => {
  const requestedAtTick = release.value?.requestedReleaseAtTick;
  if (requestedAtTick == null) return '';
  return dayjs.utc(MiningFrames.getTickDate(requestedAtTick)).local().format('MMM D, YYYY [at] h:mm A');
});
const releaseFeeRate = Vue.computed(() => {
  const networkFee = release.value?.bitcoinNetworkFee;
  const destination = release.value?.toScriptPubkey;
  if (networkFee == null || !destination) return;

  try {
    const cosignScript = bitcoinLocks.createCosignScript({
      lock: props.lock,
      fundedSatoshis: props.record.satoshis,
    });
    const oneSatFee = cosignScript.calculateFee(1n, 1, destination, false);
    const feeRate = (networkFee + oneSatFee / 2n) / oneSatFee;
    if (cosignScript.calculateFee(feeRate, 1, destination, false) === networkFee) return feeRate;
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
const releaseProgress = Vue.computed(() =>
  release.value
    ? bitcoinLocks.getReleaseProcessingDetails(release.value)
    : { progressPct: 0, confirmations: -1, expectedConfirmations: 6 },
);
const argonRequestProgressLabel = Vue.computed(() => {
  return generateProgressLabel(argonRequestConfirmations.value, argonRequestExpectedConfirmations.value, {
    blockType: 'Argon',
  });
});

let feeQuoteTimeout: ReturnType<typeof setTimeout> | undefined;
let feeQuoteRunId = 0;
let stopArgonRequestProgress: (() => void) | undefined;
let isDisposed = false;

Vue.watch([trimmedDestination, feeRatePerSatVb], queueArgonFeeQuote, { immediate: true });
Vue.watch(
  () => wallets.defaultArgonWallet.availableMicrogons,
  availableBalance => {
    if (!argonFeeQuote.value) return;
    argonFeeQuote.value = {
      ...argonFeeQuote.value,
      availableBalance,
      canAfford: availableBalance >= argonFeeQuote.value.txFee,
    };
  },
);

Vue.onUnmounted(() => {
  isDisposed = true;
  if (feeQuoteTimeout) clearTimeout(feeQuoteTimeout);
  stopArgonRequestProgress?.();
});

Vue.onMounted(() => trackArgonRequestProgress());

function queueArgonFeeQuote(): void {
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
  feeQuoteTimeout = setTimeout(() => {
    feeQuoteTimeout = undefined;
    void refreshArgonFeeQuote(runId);
  }, 200);
}

async function requestReturn(): Promise<void> {
  if (!canSubmit.value) return;
  isSubmitting.value = true;
  isArgonRequestInProgress.value = true;
  requestError.value = '';

  try {
    const txInfo = await bitcoinOrphanRelease.submit({
      lock: props.lock,
      record: props.record,
      toScriptPubkey: trimmedDestination.value,
      feeRatePerSatVb: feeRatePerSatVb.value,
      txSigner: await getWalletKeys().getLiquidLockingKeypair(),
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
  txInfo = bitcoinOrphanRelease.getPendingReleaseTxInfo(props.record.lockId, props.record),
): void {
  // The request can resolve after this overlay instance is disposed; teardown cannot remove a later subscription.
  if (!txInfo || isDisposed) return;

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
    const prepared = await bitcoinOrphanRelease.prepare({
      lock: props.lock,
      record: props.record,
      toScriptPubkey: trimmedDestination.value,
      feeRatePerSatVb: feeRatePerSatVb.value,
      txSigner: await getWalletKeys().getLiquidLockingKeypair(),
    });
    if (runId !== feeQuoteRunId) return;
    argonFeeQuote.value = {
      canAfford: prepared.canAfford,
      availableBalance: prepared.availableBalance,
      bitcoinNetworkFee: prepared.metadata.bitcoinNetworkFee ?? 0n,
      txFee: prepared.txFeePlusTip,
    };
  } catch (error) {
    if (runId !== feeQuoteRunId) return;
    console.warn('[WalletViewUnattachedBitcoin] Unable to check the Argon transaction fee', error);
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
