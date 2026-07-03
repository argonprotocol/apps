<template>
  <section PendingRecord>
    <BitcoinIcon MainIcon :class="mismatchCanAct ? 'fade-in-out opacity-80' : 'opacity-65'" />
    <div ContentWrapper>
      <div FirstRow>
        <header>
          <template v-if="showFundingReadyToResume || mismatchDepositReturned">
            {{ satToBtcNm(mismatchObservedSatoshis).format('0,0.[00000000]') }} of Mismatched BTC Was Returned
          </template>
          <template v-else-if="showMismatchReturnProgress">
            {{ satToBtcNm(mismatchObservedSatoshis).format('0,0.[00000000]') }} of Mismatched BTC Is Being Returned
          </template>
          <template v-else>
            {{ satToBtcNm(mismatchObservedSatoshis).format('0,0.[00000000]') }} of Mismatched BTC Found
          </template>
        </header>
        <button PrimaryButton>
          <template v-if="showFundingReadyToResume">Resume Funding</template>
          <template v-else-if="mismatchDepositReturned && mismatchView.isFundingExpired">Clear from List</template>
          <template v-else-if="mismatchDepositReturned">Open Details</template>
          <template v-else-if="showMismatchReturnProgress">View Status</template>
          <template v-else-if="mismatchCanAct">Review Options</template>
          <template v-else>View Details</template>
        </button>
      </div>
      <div SecondRow>
        <div v-if="mismatchView.error" class="mt-1 text-sm font-semibold text-red-700">
          {{ mismatchView.error }}
        </div>
        <div v-else-if="mismatchReturnProgress.error" class="mt-1 text-xs font-semibold text-red-700">
          {{ mismatchReturnProgress.error }}
        </div>
        <div v-else-if="showMismatchReturnProgress" class="mt-2 w-full pr-5">
          <ProgressBar :progress="mismatchReturnProgress.progressPct" :showLabel="false" class="h-3.5" />
        </div>
        <div v-else-if="mismatchDepositReturned" class="mt-1 text-sm text-slate-600">
          <template v-if="showFundingReadyToResume">Resume lock funding when you are ready.</template>
          <template v-else-if="mismatchView.isFundingExpired">Clear this notice when you are ready.</template>
          <template v-else>Review the completed return details.</template>
        </div>
        <div v-else-if="hasPendingMismatch" class="mt-1 text-sm text-slate-600">
          <template v-if="mismatchView.isFundingExpired && mismatchCanAct">Click to view recovery options.</template>
          <template v-if="mismatchView.isFundingExpired && !mismatchCanAct">
            We're preparing some recovery options for you.
          </template>
          <template v-else-if="mismatchCanAct">Choose whether to keep this Bitcoin deposit or return it.</template>
          <template v-else>Once Bitcoin confirmations finish, you can return it or keep it.</template>
        </div>
        <div
          v-else-if="
            !mismatchCanAct &&
            !showFundingReadyToResume &&
            !mismatchDepositReturned &&
            mismatchConfirmationState.showProgress
          "
        >
          <ProgressBar :progress="lockSummary.lockProcessingDetails.progressPct" :showLabel="false" class="h-3.5" />
        </div>
        <div v-else>
          <span>{{ mismatchConfirmationState.label || 'Unknown state' }}</span>
        </div>
      </div>
    </div>
  </section>
</template>

<script setup lang="ts">
import * as Vue from 'vue';
import { createNumeralHelpers } from '../../../lib/numeral.ts';
import BitcoinIcon from '../../../assets/wallets/bitcoin.svg?component';
import ProgressBar from '../../../components/ProgressBar.vue';
import { generateProgressLabel } from '../../../lib/Utils.ts';
import { getBitcoinLocks } from '../../../stores/bitcoin.ts';
import { getCurrency } from '../../../stores/currency.ts';
import type { ILockSummary } from '../../../stores/financials.ts';

const bitcoinLocks = getBitcoinLocks();
const currency = getCurrency();

const { satToBtcNm } = createNumeralHelpers(currency);

const props = defineProps<{
  lockSummary: ILockSummary;
}>();

const lockRecord = Vue.computed(() => props.lockSummary.record);
const mismatchView = Vue.computed(() => bitcoinLocks.getMismatchViewState(lockRecord.value));

const showFundingReadyToResume = Vue.computed(() => mismatchView.value.phase === 'readyToResume');
const nextMismatchCandidate = Vue.computed(() => mismatchView.value.nextCandidate);
const mismatchCandidateForDisplay = Vue.computed(
  () =>
    nextMismatchCandidate.value?.record ??
    mismatchView.value.candidates[0]?.record ??
    nextMismatchCandidate.value?.returnRecord,
);
const mismatchDepositReturned = Vue.computed(
  () => mismatchView.value.phase === 'returned' || mismatchView.value.phase === 'readyToResume',
);
const mismatchObservedSatoshis = Vue.computed(() => {
  return (
    nextMismatchCandidate.value?.observedSatoshis ??
    mismatchCandidateForDisplay.value?.satoshis ??
    bitcoinLocks.getReceivedFundingSatoshis(lockRecord.value) ??
    0n
  );
});
const mismatchCanAct = Vue.computed(() => {
  return (
    !!nextMismatchCandidate.value && (nextMismatchCandidate.value.canAccept || nextMismatchCandidate.value.canReturn)
  );
});
const isMismatchReturningOnArgon = Vue.computed(() => mismatchView.value.phase === 'returningOnArgon');
const isMismatchReturningOnBitcoin = Vue.computed(() => mismatchView.value.phase === 'returningOnBitcoin');
const showMismatchReturnProgress = Vue.computed(() => {
  return isMismatchReturningOnArgon.value || isMismatchReturningOnBitcoin.value;
});

const mismatchReturnProgress = Vue.computed(() => {
  const returnRecord = nextMismatchCandidate.value?.returnRecord;
  if (isMismatchReturningOnArgon.value && lockRecord.value.utxoId && returnRecord) {
    const txStatus = bitcoinLocks.getOrphanedReturnTxInfoForRecord(lockRecord.value.utxoId, returnRecord)?.getStatus();
    return {
      progressPct: txStatus?.progressPct ?? 0,
      label: generateProgressLabel(txStatus?.confirmations ?? -1, txStatus?.expectedConfirmations ?? 0, {
        blockType: 'Argon',
      }),
      error: '',
    };
  }

  if (isMismatchReturningOnBitcoin.value && returnRecord) {
    const progress = bitcoinLocks.getReleaseLifecycleProgress(returnRecord);
    return {
      progressPct: progress.progressPct,
      label: generateProgressLabel(progress.confirmations, progress.expectedConfirmations, {
        blockType: 'Bitcoin',
      }),
      error: progress.error ?? '',
    };
  }

  return {
    progressPct: 0,
    label: '',
    error: '',
  };
});
const mismatchConfirmationState = Vue.computed(() => {
  const candidate = mismatchCandidateForDisplay.value;
  if (!candidate) {
    return {
      showProgress: false,
      label: 'Waiting for the Bitcoin deposit to finish processing.',
    };
  }
  if (props.lockSummary.lockProcessingDetails.confirmations < 0) {
    if (
      candidate.mempoolObservation &&
      !candidate.mempoolObservation.isConfirmed &&
      candidate.firstSeenBitcoinHeight <= 0
    ) {
      return {
        showProgress: false,
        label: 'Waiting for the first Bitcoin block...',
      };
    }
    if (candidate.firstSeenBitcoinHeight > 0 || candidate.mempoolObservation?.isConfirmed === true) {
      return {
        showProgress: false,
        label: 'Waiting for this Bitcoin deposit to be recognized.',
      };
    }
    return {
      showProgress: false,
      label: 'Waiting for the first Bitcoin block.',
    };
  }
  return {
    showProgress: true,
    label: generateProgressLabel(
      props.lockSummary.lockProcessingDetails.confirmations,
      props.lockSummary.lockProcessingDetails.expectedConfirmations,
      {
        blockType: 'Bitcoin',
      },
    ),
  };
});

const hasPendingMismatch = Vue.computed(() => {
  return !!nextMismatchCandidate.value?.differenceSatoshis;
});

function formatSatsDifference(satoshis: bigint): string {
  const absoluteSatoshis = satoshis < 0n ? -satoshis : satoshis;
  const formatted = absoluteSatoshis.toLocaleString('en-US');
  if (satoshis > 0n) return `Over by ${formatted} sats`;
  if (satoshis < 0n) return `Short by ${formatted} sats`;
  return 'Matches your requested amount';
}
</script>
