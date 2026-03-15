<template>
  <div data-testid="LockFundingMismatch" class="space-y-3 px-8 pt-4 pb-6">
    <div hidden>
      <CountdownClock :time="fundingExpirationTime" @update:tick="fundingTimeRemainingSeconds = $event" />
    </div>

    <section class="space-y-2.5">
      <div>
        <h2 class="text-xl font-semibold text-slate-900">{{ panelTitle }}</h2>
      </div>

      <div v-if="isReturnedMismatchState" class="rounded-lg border border-slate-300 bg-white px-4 py-3 text-sm">
        <div class="text-xs font-light tracking-wide text-slate-500 uppercase">Returned Deposit</div>
        <div class="mt-1 font-mono font-semibold text-slate-900">{{ receivedBtcLabel }} BTC</div>
      </div>
      <div v-else class="rounded-lg border border-slate-300 bg-white px-4 py-3 text-sm">
        <div class="flex flex-wrap items-baseline gap-x-2 gap-y-1 text-slate-700">
          <span>Expected</span>
          <span class="font-mono font-semibold text-slate-900">{{ expectedBtcLabel }} BTC</span>
          <span class="text-slate-400">,</span>
          <span>received</span>
          <span class="font-mono font-semibold text-slate-900">{{ receivedBtcLabel }} BTC</span>
        </div>
        <div class="text-argon-700 mt-1 font-mono font-semibold">{{ differenceSatsLabel }}</div>
        <p v-if="mismatchCandidateCount > 1" class="text-argon-700 mt-2 text-xs font-semibold">
          More than one possible Bitcoin deposit was found ({{ mismatchCandidateCount }}). Return any deposits you do
          not want before locking one.
        </p>
      </div>

      <p
        v-if="globalNoticeText"
        data-testid="LockFundingMismatch.actionError"
        class="text-sm font-semibold"
        :class="globalNoticeClass">
        {{ globalNoticeText }}
      </p>
      <p v-else-if="!showReturnCompleteState" class="text-sm text-slate-700">{{ introGuidanceText }}</p>
    </section>

    <template v-if="showOrphanProgress">
      <div class="mt-6">
        <div class="fade-progress text-center text-5xl font-bold">
          {{ numeral(orphanProgress.progressPct).format('0.00') }}%
        </div>
      </div>

      <ProgressBar :progress="orphanProgress.progressPct" :showLabel="false" class="h-4" />

      <div class="mt-1 text-center font-light text-gray-500">{{ orphanProgress.label }}</div>
    </template>

    <template v-else-if="showResumeFundingState">
      <div>
        <button
          @click="resumeFunding"
          :disabled="isSubmitting"
          class="bg-argon-600 hover:bg-argon-700 cursor-pointer rounded-md px-6 py-2 text-lg font-bold text-white disabled:bg-slate-400">
          Resume Lock Funding
        </button>
      </div>
    </template>

    <template v-else-if="showReturnCompleteState">
      <div class="text-sm text-slate-700">{{ introGuidanceText }}</div>
    </template>

    <template v-else-if="acceptInProgress">
      <div class="mt-6">
        <div class="fade-progress text-center text-5xl font-bold">{{ numeral(acceptProgressPct).format('0.00') }}%</div>
      </div>

      <ProgressBar :progress="acceptProgressPct" :showLabel="false" class="h-4" />
      <div class="mt-1 text-center font-light text-gray-500">{{ acceptProgressLabel }}</div>
    </template>

    <template v-else-if="acceptCompleted">
      <div class="mt-6">
        <div class="fade-progress text-center text-5xl font-bold">{{ numeral(acceptProgressPct).format('0.00') }}%</div>
      </div>

      <ProgressBar :progress="acceptProgressPct" :showLabel="false" class="h-4" />
      <div class="mt-1 text-center font-light text-gray-500">Waiting for Argon to update the lock...</div>
    </template>

    <template v-else-if="showOptionCards">
      <div class="grid grid-cols-1 gap-3 lg:grid-cols-2">
        <section
          :class="acceptRecommended ? 'border-argon-400 bg-argon-50/25' : 'border-slate-300 bg-white'"
          class="flex h-full flex-col rounded-lg border p-3.5">
          <div class="mb-1 flex items-center gap-2">
            <p class="text-xs font-light tracking-wide text-slate-400 uppercase">Option 1</p>
            <span
              v-if="acceptRecommended"
              class="bg-argon-100 text-argon-700 rounded-full px-2 py-0.5 text-[11px] font-semibold tracking-wide uppercase">
              Recommended
            </span>
          </div>

          <h3 class="text-lg font-semibold text-slate-900">{{ acceptActionLabel }}</h3>

          <p class="mt-2 text-sm text-slate-700">{{ acceptSummaryText }}</p>

          <div class="mt-3 space-y-2.5">
            <div v-if="acceptImpactCard" :class="acceptImpactCard.containerClass" class="rounded-md border p-2.5">
              <div :class="acceptImpactCard.eyebrowClass" class="text-xs font-light tracking-wide uppercase">
                {{ acceptImpactCard.title }}
              </div>
              <div :class="acceptImpactCard.valueClass" class="mt-1 font-mono font-semibold">
                {{ acceptImpactCard.value }}
              </div>
              <p class="mt-1 text-xs text-slate-600">{{ acceptImpactCard.description }}</p>
            </div>

            <div class="rounded-md border border-slate-300 bg-white p-2.5">
              <div class="text-xs font-light tracking-wide text-slate-500 uppercase">Argon You Receive</div>
              <div class="text-argon-700 mt-1 font-mono font-semibold">{{ formatArgon(acceptedMintMicrogons) }}</div>
              <p v-if="acceptDeltaLabel" class="mt-1 text-xs text-slate-600">{{ acceptDeltaLabel }}</p>
            </div>
          </div>

          <div class="mt-auto pt-3">
            <template v-if="isFundingExpired">
              <div class="rounded-md border border-slate-300 bg-slate-50 px-4 py-3 text-sm text-slate-600">
                This funding window expired before Argon could accept the adjusted amount.
              </div>
            </template>
            <template v-else>
              <button
                @click="acceptMismatch"
                :disabled="isSubmitting || !canAcceptMismatch || !canAffordAccept"
                :class="
                  acceptRecommended
                    ? 'border-argon-600 bg-argon-600 hover:bg-argon-700 text-white'
                    : 'border-argon-600/50 text-argon-700 hover:bg-argon-50 bg-white'
                "
                class="w-full cursor-pointer rounded-md border px-5 py-2 text-sm font-bold disabled:cursor-not-allowed disabled:opacity-50">
                {{ acceptActionLabel }}
              </button>
              <p v-if="!canAffordAccept" class="mt-1 text-xs text-red-700">
                Add
                <span class="font-mono font-semibold">{{ formatArgon(acceptFeeShortfallMicrogons) }}</span>
                to cover the transaction fee for this option.
              </p>
              <p v-else-if="acceptActionError" class="mt-1 text-xs text-red-700">{{ acceptActionError }}</p>
            </template>
          </div>
        </section>

        <section
          :class="returnRecommended ? 'border-argon-400 bg-argon-50/25' : 'border-slate-300 bg-white'"
          class="flex h-full flex-col rounded-lg border p-3.5">
          <div class="mb-1 flex items-center gap-2">
            <p class="text-xs font-light tracking-wide text-slate-400 uppercase">Option 2</p>
            <span
              v-if="returnRecommended"
              class="bg-argon-100 text-argon-700 rounded-full px-2 py-0.5 text-[11px] font-semibold tracking-wide uppercase">
              Recommended
            </span>
          </div>

          <h3 class="text-lg font-semibold text-slate-900">Return This Deposit</h3>

          <p class="mt-2 text-sm text-slate-700">{{ returnSummaryText }}</p>

          <div class="mt-3 space-y-2.5">
            <div>
              <label class="mb-1.5 block font-medium text-gray-700">Return Destination Address</label>
              <input
                data-testid="LockFundingMismatch.returnDestination"
                v-model="returnDestination"
                type="text"
                placeholder="bc1q..."
                :class="
                  returnDestinationError
                    ? 'border-red-400 bg-white text-red-900 placeholder:text-red-300'
                    : 'border-slate-700/50 bg-white text-slate-900 placeholder:text-slate-400'
                "
                class="focus:ring-argon-500 w-full rounded-md border px-3 py-2.5 focus:border-transparent focus:ring-2" />
              <p
                class="mt-1.5 text-xs"
                :class="returnDestinationError ? 'font-semibold text-red-700' : 'text-slate-500'">
                {{ returnDestinationError || returnDestinationHelper }}
              </p>
            </div>

            <BitcoinFeeRateInput v-model="selectedFeeRatePerSatVb" dataTestid="LockFundingMismatch.feeRate" />
          </div>

          <p v-if="!isFundingExpired" class="mt-2 text-sm text-slate-600">
            This lock expires in
            <CountdownClock :time="fundingExpirationTime" v-slot="{ hours, minutes, days }">
              <template v-if="days > 0">{{ days }} day{{ days === 1 ? '' : 's' }}</template>
              <template v-else>{{ hours }}h {{ minutes }}m</template>
            </CountdownClock>
            if the funding amount is not resolved first.
          </p>
          <p v-else class="mt-3 text-sm text-slate-600">
            This funding request has already expired, so returning the Bitcoin is the remaining recovery path.
          </p>

          <div class="mt-auto pt-3">
            <button
              @click="returnMismatch"
              :disabled="!isReturnDestinationValid || isSubmitting || !canReturnMismatch || !canAffordReturn"
              :class="
                returnRecommended
                  ? 'border-argon-600 bg-argon-600 hover:bg-argon-700 text-white'
                  : 'border-argon-600/50 text-argon-700 hover:bg-argon-50 bg-white'
              "
              class="w-full cursor-pointer rounded-md border px-5 py-2 text-sm font-bold disabled:cursor-not-allowed disabled:opacity-50">
              {{ isSubmittingReturn ? 'Submitting Return...' : 'Return Bitcoin' }}
            </button>
            <p v-if="!canAffordReturn" class="mt-1 text-xs text-red-700">
              Add
              <span class="font-mono font-semibold">{{ formatArgon(returnFeeShortfallMicrogons) }}</span>
              to cover the transaction fee for this option.
            </p>
            <p v-else-if="isSubmittingReturn" class="mt-1 text-xs text-slate-500">Submitting this return on Argon...</p>
            <p v-else-if="returnActionError" class="mt-1 text-xs text-red-700">{{ returnActionError }}</p>
          </div>
        </section>
      </div>
    </template>

    <template v-else>
      <div v-if="confirmationState.showProgress" class="mt-4">
        <div class="fade-progress text-center text-4xl font-bold">
          {{ numeral(confirmationProgressPct).format('0.00') }}%
        </div>
      </div>
      <div v-else class="mt-4 flex items-center justify-center gap-2 text-slate-500">
        <Spinner class="h-5 w-5" />
        <span>{{ confirmationState.label }}</span>
      </div>

      <ProgressBar
        v-if="confirmationState.showProgress"
        :progress="confirmationProgressPct"
        :showLabel="false"
        class="h-4" />
      <div v-if="confirmationState.showProgress" class="mt-1 text-center font-light text-gray-500">
        {{ confirmationState.label }}
      </div>
    </template>
  </div>
</template>

<script setup lang="ts">
import * as Vue from 'vue';
import dayjs from 'dayjs';
import utc from 'dayjs/plugin/utc';
import { getBitcoinNetworkName, validateBitcoinAddressForNetwork } from '../../lib/BitcoinAddressValidation.ts';
import numeral, { createNumeralHelpers } from '../../lib/numeral';
import { BitcoinLockStatus, type IBitcoinLockRecord } from '../../lib/db/BitcoinLocksTable.ts';
import { BitcoinUtxoStatus } from '../../lib/db/BitcoinUtxosTable.ts';
import { TransactionStatus } from '../../lib/db/TransactionsTable.ts';
import { getCurrency } from '../../stores/currency.ts';
import { getBitcoinLocks } from '../../stores/bitcoin.ts';
import { getVaults } from '../../stores/vaults.ts';
import { getWalletKeys, useWallets } from '../../stores/wallets.ts';
import ProgressBar from '../../components/ProgressBar.vue';
import CountdownClock from '../../components/CountdownClock.vue';
import { generateProgressLabel } from '../../lib/Utils.ts';
import { useBitcoinLockProgress } from '../../stores/bitcoinLockProgress.ts';
import BitcoinFeeRateInput from './components/BitcoinFeeRateInput.vue';
import Spinner from '../../components/Spinner.vue';

dayjs.extend(utc);

const props = defineProps<{
  personalLock: IBitcoinLockRecord;
}>();

const bitcoinLocks = getBitcoinLocks();
const vaults = getVaults();
const currency = getCurrency();
const wallets = useWallets();
const vaultingAddress = getWalletKeys().vaultingAddress;
const { microgonToArgonNm } = createNumeralHelpers(currency);
const bitcoinLockProgress = useBitcoinLockProgress();
const TRANSACTION_FEE_BUFFER_MICROGONS = 25_000n;

const actionError = Vue.ref('');
const isSubmitting = Vue.ref(false);
const lastAction = Vue.ref<'accept' | 'return' | 'resume' | null>(null);

const returnDestination = Vue.ref('');
const selectedFeeRatePerSatVb = Vue.ref(5n);
const fundingTimeRemainingSeconds = Vue.ref(0);

const acceptArgonTxFeeMicrogons = Vue.ref<bigint | null>(null);
const returnArgonTxFeeMicrogons = Vue.ref<bigint | null>(null);

const currentLock = Vue.computed(() => {
  const utxoId = props.personalLock.utxoId;
  if (!utxoId) return props.personalLock;
  return bitcoinLocks.getLockByUtxoId(utxoId) ?? props.personalLock;
});

const mismatchView = Vue.computed(() => bitcoinLocks.getMismatchViewState(currentLock.value));
const mismatchCandidates = Vue.computed(() => mismatchView.value.candidates);
const nextCandidate = Vue.computed(() => mismatchView.value.nextCandidate);
const mismatchCandidateCount = Vue.computed(() => mismatchView.value.candidateCount);

const orphanedRecord = Vue.computed(() => nextCandidate.value?.returnRecord);
const candidateForDisplay = Vue.computed(
  () => nextCandidate.value?.record ?? mismatchCandidates.value[0]?.record ?? orphanedRecord.value,
);

const satoshisObserved = Vue.computed(() => {
  return (
    nextCandidate.value?.observedSatoshis ??
    candidateForDisplay.value?.satoshis ??
    bitcoinLocks.getReceivedFundingSatoshis(currentLock.value) ??
    0n
  );
});

const observedSatoshis = Vue.computed(() => satoshisObserved.value ?? 0n);
const differenceSatoshis = Vue.computed(
  () => nextCandidate.value?.differenceSatoshis ?? observedSatoshis.value - currentLock.value.satoshis,
);

const expectedBtcLabel = Vue.computed(() => formatCompactBtc(currentLock.value.satoshis));
const receivedBtcLabel = Vue.computed(() => formatCompactBtc(observedSatoshis.value));
const differenceSatsLabel = Vue.computed(() => formatSatsDifference(differenceSatoshis.value));

const isFundingExpired = Vue.computed(() => mismatchView.value.isFundingExpired);
const isFundingReadyToResume = Vue.computed(() => mismatchView.value.phase === 'readyToResume');

const canReturnMismatch = Vue.computed(() => nextCandidate.value?.canReturn ?? false);

const canAcceptMismatch = Vue.computed(() => nextCandidate.value?.canAccept ?? false);

const acceptTxInfo = Vue.computed(() => {
  const candidate = nextCandidate.value;
  if (candidate) return candidate.acceptTx;

  const utxoId = currentLock.value.utxoId;
  if (!utxoId) return undefined;
  return bitcoinLocks.getLatestMismatchAcceptTxInfo(utxoId);
});

const acceptInProgress = Vue.computed(() => {
  const status = acceptTxInfo.value?.tx.status;
  return status === TransactionStatus.Submitted || status === TransactionStatus.InBlock;
});
const acceptCompleted = Vue.computed(() => {
  const status = acceptTxInfo.value?.tx.status;
  return status === TransactionStatus.Finalized && !acceptProgressError.value;
});

const acceptProgressPct = Vue.computed(() => bitcoinLockProgress.mismatchAcceptArgon.progressPct);
const acceptProgressError = Vue.computed(() => bitcoinLockProgress.mismatchAcceptArgon.error);
const acceptProgressLabel = Vue.computed(() => {
  return generateProgressLabel(
    bitcoinLockProgress.mismatchAcceptArgon.confirmations,
    bitcoinLockProgress.mismatchAcceptArgon.expectedConfirmations,
    { blockType: 'Argon' },
  );
});

const orphanProgress = Vue.computed(() => {
  if (orphanedRecord.value?.status === BitcoinUtxoStatus.ReleaseIsProcessingOnArgon) {
    return {
      progressPct: bitcoinLockProgress.orphanedReturnArgon.progressPct,
      label: generateProgressLabel(
        bitcoinLockProgress.orphanedReturnArgon.confirmations,
        bitcoinLockProgress.orphanedReturnArgon.expectedConfirmations,
        { blockType: 'Argon' },
      ),
      error: bitcoinLockProgress.orphanedReturnArgon.error,
    };
  }

  if (orphanedRecord.value?.status === BitcoinUtxoStatus.ReleaseIsProcessingOnBitcoin) {
    return {
      progressPct: bitcoinLockProgress.orphanedReturnBitcoin.progressPct,
      label: generateProgressLabel(
        bitcoinLockProgress.orphanedReturnBitcoin.confirmations,
        bitcoinLockProgress.orphanedReturnBitcoin.expectedConfirmations,
        { blockType: 'Bitcoin' },
      ),
      error: bitcoinLockProgress.orphanedReturnBitcoin.error,
    };
  }

  return { progressPct: 0, label: '', error: '' };
});

const showOrphanProgress = Vue.computed(() => {
  return !!orphanedRecord.value && orphanedRecord.value.status !== BitcoinUtxoStatus.ReleaseComplete;
});
const hasCompletedMismatchReturn = Vue.computed(
  () => orphanedRecord.value?.status === BitcoinUtxoStatus.ReleaseComplete,
);
const showResumeFundingState = Vue.computed(() => hasCompletedMismatchReturn.value && isFundingReadyToResume.value);
const showReturnCompleteState = Vue.computed(() => hasCompletedMismatchReturn.value && !showResumeFundingState.value);
const isReturnedMismatchState = Vue.computed(() => hasCompletedMismatchReturn.value);
const showOptionCards = Vue.computed(() => {
  return (
    mismatchView.value.phase === 'review' &&
    (canAcceptMismatch.value || canReturnMismatch.value || mismatchCandidateCount.value > 1 || isFundingExpired.value)
  );
});

const confirmationProgressPct = Vue.computed(() => bitcoinLockProgress.lockProcessing.progressPct);
const confirmationState = Vue.computed(() => {
  const candidate = candidateForDisplay.value;
  if (!candidate) {
    return {
      showProgress: false,
      label: 'Waiting for the Bitcoin deposit to appear...',
    };
  }

  if (bitcoinLockProgress.lockProcessing.confirmations < 0) {
    if (candidate.firstSeenBitcoinHeight > 0 || candidate.mempoolObservation?.isConfirmed === true) {
      return {
        showProgress: false,
        label: 'Waiting for this Bitcoin deposit to be recognized...',
      };
    }

    return {
      showProgress: false,
      label: 'Waiting for the first Bitcoin block...',
    };
  }

  return {
    showProgress: true,
    label: generateProgressLabel(
      bitcoinLockProgress.lockProcessing.confirmations,
      bitcoinLockProgress.lockProcessing.expectedConfirmations,
      { blockType: 'Bitcoin' },
    ),
  };
});

const reservedMicrogons = Vue.computed(() => currentLock.value.liquidityPromised ?? 0n);
const isLessThanReserved = Vue.computed(() => observedSatoshis.value < currentLock.value.satoshis);
const isMoreThanReserved = Vue.computed(() => observedSatoshis.value > currentLock.value.satoshis);

const underSecuritizedMicrogons = Vue.computed<bigint | null>(() => {
  const candidate = nextCandidate.value?.record;
  if (!candidate) return null;
  return bitcoinLocks.getUnderSecuritizedMicrogons(currentLock.value, candidate);
});

const increaseSecuritizationMicrogons = Vue.computed<bigint | null>(() => {
  const candidate = nextCandidate.value?.record;
  if (!candidate) return null;
  return bitcoinLocks.getIncreaseSecuritizationMicrogons(currentLock.value, candidate);
});

const acceptedMintMicrogons = Vue.computed(() => {
  const reservedSatoshis = currentLock.value.satoshis;
  if (reservedSatoshis <= 0n || reservedMicrogons.value <= 0n) return 0n;

  if (observedSatoshis.value <= reservedSatoshis) {
    return (reservedMicrogons.value * observedSatoshis.value) / reservedSatoshis;
  }

  const securitizationIncrease = increaseSecuritizationMicrogons.value ?? 0n;
  return reservedMicrogons.value + (securitizationIncrease > 0n ? securitizationIncrease : 0n);
});

const acceptDeltaMicrogons = Vue.computed(() => acceptedMintMicrogons.value - reservedMicrogons.value);
const isUnderSecuritized = Vue.computed(() => (underSecuritizedMicrogons.value ?? 0n) > 0n);

const acceptTransactionFeeMicrogons = Vue.computed(
  () => acceptArgonTxFeeMicrogons.value ?? TRANSACTION_FEE_BUFFER_MICROGONS,
);
const returnTransactionFeeMicrogons = Vue.computed(
  () => returnArgonTxFeeMicrogons.value ?? TRANSACTION_FEE_BUFFER_MICROGONS,
);

const acceptAdditionalSecuritizationFeeMicrogons = Vue.computed(() => {
  const increasedLiquidity = increaseSecuritizationMicrogons.value ?? 0n;
  if (increasedLiquidity <= 0n) return 0n;

  const vault = vaults.vaultsById[currentLock.value.vaultId];
  if (!vault) return 0n;
  if (currentLock.value.lockDetails?.ownerAccount === vault.operatorAccountId) return 0n;
  return vault.calculateBitcoinFee(increasedLiquidity);
});

const acceptTotalFeeMicrogons = Vue.computed(() => {
  return acceptTransactionFeeMicrogons.value + acceptAdditionalSecuritizationFeeMicrogons.value;
});

const availableMicrogons = Vue.computed(() => wallets.vaultingWallet.availableMicrogons ?? 0n);
const canAffordAccept = Vue.computed(() => availableMicrogons.value >= acceptTotalFeeMicrogons.value);
const canAffordReturn = Vue.computed(() => availableMicrogons.value >= returnTransactionFeeMicrogons.value);
const isSubmittingReturn = Vue.computed(() => isSubmitting.value && lastAction.value === 'return');

const acceptFeeShortfallMicrogons = Vue.computed(() => {
  const shortfall = acceptTotalFeeMicrogons.value - availableMicrogons.value;
  return shortfall > 0n ? shortfall : 0n;
});
const returnFeeShortfallMicrogons = Vue.computed(() => {
  const shortfall = returnTransactionFeeMicrogons.value - availableMicrogons.value;
  return shortfall > 0n ? shortfall : 0n;
});

const persistentMismatchError = Vue.computed(() => mismatchView.value.error ?? '');

const acceptRecommended = Vue.computed(() => {
  return isLessThanReserved.value && mismatchCandidateCount.value <= 1 && !isFundingExpired.value;
});
const returnRecommended = Vue.computed(() => {
  return (
    isFundingExpired.value || mismatchCandidateCount.value > 1 || (isMoreThanReserved.value && isUnderSecuritized.value)
  );
});

const panelTitle = Vue.computed(() => {
  if (showResumeFundingState.value || showReturnCompleteState.value) return 'Mismatch Bitcoin Deposit Returned';
  if (showOrphanProgress.value) return 'Returning this Bitcoin deposit.';
  if (acceptInProgress.value) return 'Updating your lock on Argon.';
  if (acceptCompleted.value) return 'Finalizing your updated lock.';
  if (showOptionCards.value) {
    if (mismatchCandidateCount.value > 1) return 'Return extra Bitcoin deposits.';
    if (isFundingExpired.value) return 'Choose how to recover this Bitcoin deposit.';
    return 'Choose whether to keep or return this Bitcoin deposit.';
  }
  if (isFundingExpired.value) return 'Funding window expired.';
  return "Bitcoin amount doesn't match your lock request.";
});

const globalNoticeText = Vue.computed(() => {
  if (persistentMismatchError.value) return persistentMismatchError.value;
  if (orphanProgress.value.error) return orphanProgress.value.error;
  if (acceptProgressError.value) return `Lock update failed: ${acceptProgressError.value}`;
  if (lastAction.value === 'resume' && actionError.value) return actionError.value;
  return '';
});
const globalNoticeClass = Vue.computed(() => {
  return persistentMismatchError.value || orphanProgress.value.error || acceptProgressError.value || actionError.value
    ? 'text-red-600'
    : 'text-slate-700';
});

const optionsIntroText = Vue.computed(() => {
  if (mismatchCandidateCount.value > 1) {
    return 'Only one Bitcoin deposit can be locked for this request. Return any extra deposits you do not want.';
  }
  if (acceptRecommended.value) {
    return 'Keeping the amount that arrived is the fastest way to continue.';
  }
  if (isMoreThanReserved.value && isUnderSecuritized.value) {
    return 'Returning is recommended because the extra Bitcoin would need more Bitcoin Security than this vault can add right now.';
  }
  if (returnRecommended.value) {
    return 'Returning this Bitcoin deposit is the safer option for this lock.';
  }
  if (isMoreThanReserved.value) {
    return 'You can keep the amount that arrived or send it back and fund again.';
  }
  return 'Choose whether to keep this Bitcoin deposit locked or return it and fund again.';
});

const introGuidanceText = Vue.computed(() => {
  if (showResumeFundingState.value) {
    return 'Your mismatch Bitcoin deposit was returned. Resume funding when you are ready.';
  }
  if (showReturnCompleteState.value) {
    return 'Your mismatch Bitcoin deposit was returned. This funding request expired, so start a new Bitcoin lock when you are ready.';
  }
  if (showOrphanProgress.value) {
    return 'We’re processing this Bitcoin return.';
  }
  if (acceptInProgress.value) {
    return 'We’re updating your lock on Argon.';
  }
  if (acceptCompleted.value) {
    return 'Your lock update is confirmed on Argon. Finalizing your locked amount now.';
  }
  if (showOptionCards.value) {
    return optionsIntroText.value;
  }
  if (isFundingExpired.value) {
    return 'This funding window has expired. We’re finishing the remaining checks.';
  }
  return 'Bitcoin confirmations are still in progress. Once they finish, you can choose whether to keep this deposit or return it.';
});

const acceptActionLabel = Vue.computed(() => 'Lock Received Amount');
const acceptSummaryText = Vue.computed(() => {
  if (isLessThanReserved.value) {
    return 'Keep the Bitcoin that arrived and continue without sending another deposit.';
  }
  if (isMoreThanReserved.value && isUnderSecuritized.value) {
    return 'Keep the full deposit, but some of the extra Bitcoin would not be fully securitized.';
  }
  if (isMoreThanReserved.value) {
    return 'Keep the full deposit that arrived and continue with the updated amount.';
  }
  return 'Keep the Bitcoin that arrived and continue with this lock.';
});
const acceptDeltaLabel = Vue.computed(() => {
  if (acceptDeltaMicrogons.value < 0n) {
    return `${formatArgon(-acceptDeltaMicrogons.value)} less than your original reservation.`;
  }
  if (acceptDeltaMicrogons.value > 0n) {
    return `${formatArgon(acceptDeltaMicrogons.value)} more than your original reservation.`;
  }
  return '';
});
const acceptImpactCard = Vue.computed(() => {
  const addedSecurity = increaseSecuritizationMicrogons.value ?? 0n;
  const missingSecurity = underSecuritizedMicrogons.value ?? 0n;

  if (isMoreThanReserved.value && missingSecurity > 0n) {
    return {
      title: 'Under Securitized',
      value: formatArgon(missingSecurity),
      description: `We can add ${formatArgon(addedSecurity)} of Bitcoin Security, but ${formatArgon(
        missingSecurity,
      )} more would still be needed to fully securitize the extra Bitcoin.`,
      containerClass: 'border-rose-300 bg-rose-50/60',
      eyebrowClass: 'text-rose-700',
      valueClass: 'text-rose-700 text-xl',
    };
  }

  if (isMoreThanReserved.value && addedSecurity > 0n) {
    return {
      title: 'Additional Bitcoin Security',
      value: formatArgon(addedSecurity),
      description: 'This fully securitizes the extra Bitcoin that arrived.',
      containerClass: 'border-slate-300 bg-white',
      eyebrowClass: 'text-slate-500',
      valueClass: 'text-argon-700',
    };
  }
  return null;
});
const returnSummaryText = Vue.computed(() => {
  if (isFundingExpired.value) {
    return 'Send this Bitcoin back to an address you control. After the return completes, you can start over with a new lock.';
  }
  if (mismatchCandidateCount.value > 1) {
    return 'Send back any deposits you do not want before accepting the one you do.';
  }
  if (isMoreThanReserved.value) {
    return 'Send this Bitcoin deposit back if you do not want to lock the extra Bitcoin that arrived.';
  }
  return 'Send this Bitcoin deposit back if you would rather fund the lock again from scratch.';
});
const acceptActionError = Vue.computed(() => (lastAction.value === 'accept' ? actionError.value : ''));
const returnActionError = Vue.computed(() => (lastAction.value === 'return' ? actionError.value : ''));

const fundingExpirationTime = Vue.computed(() => {
  try {
    return dayjs.utc(bitcoinLocks.verifyExpirationTime(currentLock.value));
  } catch {
    return dayjs.utc();
  }
});

const trimmedReturnDestination = Vue.computed(() => returnDestination.value.trim());
const currentLockAddress = Vue.computed(() => {
  try {
    return bitcoinLocks.formatP2wshAddress(currentLock.value.lockDetails.p2wshScriptHashHex);
  } catch {
    return '';
  }
});

const returnDestinationError = Vue.computed(() => {
  return validateBitcoinAddressForNetwork(trimmedReturnDestination.value, bitcoinLocks.bitcoinNetwork, {
    disallowAddress: currentLockAddress.value,
  });
});
const isReturnDestinationValid = Vue.computed(() => {
  return trimmedReturnDestination.value.length > 0 && !returnDestinationError.value;
});
const returnDestinationHelper = Vue.computed(() => {
  const networkName = getBitcoinNetworkName(bitcoinLocks.bitcoinNetwork);
  if (isReturnDestinationValid.value) {
    return `Returned funds will be sent exactly to this address on ${networkName}. Make sure you control it.`;
  }
  return `Use a ${networkName} address you control. Returned funds will be sent exactly to this address.`;
});

const returnFeeEstimateDestination = Vue.computed(() => {
  const destination = trimmedReturnDestination.value;
  if (destination) return isReturnDestinationValid.value ? destination : '';

  try {
    return bitcoinLocks.formatP2wshAddress(currentLock.value.lockDetails.p2wshScriptHashHex);
  } catch {
    return '';
  }
});

function formatCompactBtc(satoshis: bigint): string {
  const btc = currency.convertSatToBtc(satoshis);
  const absBtc = Math.abs(btc);
  const format = absBtc >= 0.1 ? '0,0.[000]' : absBtc >= 0.001 ? '0,0.[000000]' : '0,0.[00000000]';
  return numeral(btc).format(format);
}

function formatSatsDifference(satoshis: bigint): string {
  const absoluteSatoshis = satoshis < 0n ? -satoshis : satoshis;
  const formatted = absoluteSatoshis.toLocaleString('en-US');
  if (satoshis > 0n) return `Over by ${formatted} sats`;
  if (satoshis < 0n) return `Short by ${formatted} sats`;
  return 'Matches your requested amount';
}

function formatArgon(microgons: bigint): string {
  const isNegative = microgons < 0n;
  const absoluteMicrogons = isNegative ? -microgons : microgons;
  const numericValue = Math.abs(microgonToArgonNm(absoluteMicrogons)._value);
  const format = numericValue > 0 && numericValue < 0.01 ? '0,0.[000000]' : '0,0.00';
  const amount = microgonToArgonNm(absoluteMicrogons).format(format);
  return `${isNegative ? '-' : ''}${currency.symbol}${amount}`;
}

let refreshFeeEstimateTimeout: ReturnType<typeof setTimeout> | undefined;
let feeEstimateRunId = 0;

function queueFeeEstimateRefresh() {
  if (refreshFeeEstimateTimeout) clearTimeout(refreshFeeEstimateTimeout);
  refreshFeeEstimateTimeout = setTimeout(() => {
    void refreshEstimatedOptionFees();
  }, 200);
}

async function refreshEstimatedOptionFees() {
  const runId = ++feeEstimateRunId;
  const candidate = nextCandidate.value?.record;
  if (!candidate || !currentLock.value.utxoId) {
    if (runId !== feeEstimateRunId) return;
    acceptArgonTxFeeMicrogons.value = null;
    returnArgonTxFeeMicrogons.value = null;
    return;
  }

  let acceptFee: bigint | null = null;
  if (canAcceptMismatch.value) {
    acceptFee = await bitcoinLocks
      .estimatedMismatchAcceptArgonTxFee({
        lock: currentLock.value,
        candidateRecord: candidate,
        vaultingAddress,
      })
      .catch(() => null);
  }

  let returnFee: bigint | null = null;
  const destination = returnFeeEstimateDestination.value;
  if (destination && canReturnMismatch.value) {
    returnFee = await bitcoinLocks
      .estimatedMismatchReturnArgonTxFee({
        lock: currentLock.value,
        candidateRecord: candidate,
        vaultingAddress,
        toScriptPubkey: destination,
        feeRatePerSatVb: selectedFeeRatePerSatVb.value,
      })
      .catch(() => null);
  }

  if (runId !== feeEstimateRunId) return;
  acceptArgonTxFeeMicrogons.value = acceptFee;
  returnArgonTxFeeMicrogons.value = returnFee;
}

async function resumeFunding() {
  if (isSubmitting.value) return;

  lastAction.value = 'resume';
  actionError.value = '';
  isSubmitting.value = true;

  try {
    await bitcoinLocks.resumeWaitingForFunding(currentLock.value);
  } catch (err) {
    actionError.value = (err as Error).message;
  } finally {
    isSubmitting.value = false;
  }
}

async function acceptMismatch() {
  if (isSubmitting.value) return;

  lastAction.value = 'accept';
  actionError.value = '';

  if (isFundingExpired.value) {
    actionError.value = 'This funding window expired before Argon could accept the adjusted amount.';
    return;
  }
  if (!canAffordAccept.value) return;
  if (mismatchCandidateCount.value > 1) {
    actionError.value = 'Return any mismatch candidates you do not want to lock before accepting funding.';
    return;
  }
  if (!canAcceptMismatch.value) {
    actionError.value = 'Waiting for Argon to confirm this funding before this option is available.';
    return;
  }

  const candidate = nextCandidate.value?.record;
  if (!candidate) {
    actionError.value = 'Unable to locate an actionable mismatch candidate for this lock.';
    return;
  }

  isSubmitting.value = true;
  try {
    await bitcoinLocks.acceptMismatchedFunding(currentLock.value, candidate);
  } catch (err) {
    actionError.value = (err as Error).message;
  } finally {
    isSubmitting.value = false;
  }
}

async function returnMismatch() {
  if (isSubmitting.value) return;

  lastAction.value = 'return';
  actionError.value = '';

  const destination = trimmedReturnDestination.value;
  if (!destination) {
    actionError.value = 'Enter a Bitcoin address for the returned funds.';
    return;
  }
  if (returnDestinationError.value) {
    actionError.value = returnDestinationError.value;
    return;
  }
  if (!canAffordReturn.value) return;
  if (!canReturnMismatch.value) {
    actionError.value = 'Waiting for Argon to confirm this funding before this option is available.';
    return;
  }

  const candidate = nextCandidate.value?.record;
  if (!candidate) {
    actionError.value = 'Unable to locate an actionable mismatch candidate for this lock.';
    return;
  }

  isSubmitting.value = true;
  try {
    await bitcoinLocks.requestMismatchOrphanReturnOnArgon({
      lock: currentLock.value,
      candidateRecord: candidate,
      toScriptPubkey: destination,
      feeRatePerSatVb: selectedFeeRatePerSatVb.value,
    });
  } catch (err) {
    actionError.value = (err as Error).message;
  } finally {
    isSubmitting.value = false;
  }
}

let stopLockProgressTracking: (() => void) | undefined;

Vue.watch(
  () => currentLock.value,
  () => {
    bitcoinLockProgress.updateLock(currentLock.value);
    queueFeeEstimateRefresh();
  },
  { deep: true },
);

Vue.watch(
  () => fundingExpirationTime.value.valueOf(),
  () => {
    const secondsLeft = fundingExpirationTime.value.diff(dayjs.utc(), 'second');
    fundingTimeRemainingSeconds.value = secondsLeft > 0 ? secondsLeft : 0;
  },
  { immediate: true },
);

Vue.watch(
  [
    () => nextCandidate.value?.record.id,
    () => returnFeeEstimateDestination.value,
    () => selectedFeeRatePerSatVb.value,
    () => canAcceptMismatch.value,
    () => canReturnMismatch.value,
  ],
  () => {
    queueFeeEstimateRefresh();
  },
  { immediate: true },
);

Vue.onMounted(async () => {
  await bitcoinLocks.load();
  await vaults.load(true).catch(() => undefined);
  stopLockProgressTracking = bitcoinLockProgress.trackLock(currentLock.value);
  queueFeeEstimateRefresh();
});

Vue.onUnmounted(() => {
  if (refreshFeeEstimateTimeout) clearTimeout(refreshFeeEstimateTimeout);
  stopLockProgressTracking?.();
  stopLockProgressTracking = undefined;
});
</script>

<style scoped>
@reference "../../main.css";

@keyframes fade-progress {
  0%,
  100% {
    color: oklch(0.48 0.24 320 / 0.3);
  }
  50% {
    color: oklch(0.48 0.24 320 / 0.7);
  }
}

.fade-progress {
  animation: fade-progress 1s ease-in-out infinite;
}
</style>
