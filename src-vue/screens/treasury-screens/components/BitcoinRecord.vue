<template>
  <div class="BitcoinRecord Component flex flex-col">
    <section
      RecoveryRecord
      v-if="lockSummary.record.isHistoryRecoveryPending"
      :class="isHistoryRecoveryPaused ? 'cursor-default' : 'cursor-wait'"
    >
      <BitcoinAlertIcon v-if="isHistoryRecoveryPaused" MainIcon />
      <BitcoinIcon v-else MainIcon class="bitcoin-spin" />
      <div ContentWrapper>
        <div FirstRow>
          <header>{{ satToBtcNm(lockSummary.satoshis).format('0,0.[00000000]') }} of BTC</header>
          <span v-if="isHistoryRecoveryPaused" class="font-semibold text-red-600">History unavailable</span>
          <span v-else class="inline-flex items-center gap-2 font-semibold text-slate-500">
            <Spinner class="h-4 w-4" />
            Checking history...
          </span>
        </div>
        <div SecondRow>
          <template v-if="isHistoryRecoveryPaused">
            This saved Bitcoin lock could not be verified. Open the RTD menu to retry.
          </template>
          <template v-else>Verifying this saved Bitcoin lock against chain history.</template>
        </div>
      </div>
    </section>

    <section PendingRecord v-else-if="lockSummary.status === BitcoinLockStatus.LockIsProcessingOnArgon">
      <BitcoinIcon MainIcon class="bitcoin-spin" />
      <div ContentWrapper>
        <div FirstRow>
          <header>{{ satToBtcNm(lockSummary.satoshis).format('0,0.[00000000]') }} of BTC Is Processing On Argon</header>
          <button SecondaryButton>View Details</button>
        </div>
        <div SecondRow>
          <div v-if="lockSummary.lockProcessingError" class="mt-2 text-sm font-semibold text-red-600">
            {{ lockSummary.lockProcessingError }}
          </div>
          <ProgressBar
            v-else
            :progress="lockSummary.lockProcessingDetails.progressPct"
            :showLabel="false"
            class="h-8"
          />
        </div>
      </div>
    </section>

    <section PendingRecord v-else-if="lockSummary.status === BitcoinLockStatus.LockFailed">
      <BitcoinAlertIcon MainIcon />
      <div ContentWrapper>
        <div FirstRow>
          <header>{{ satToBtcNm(lockSummary.satoshis).format('0,0.[00000000]') }} of BTC Failed to Lock</header>
          <button SecondaryButton>Clear From List</button>
        </div>
        <div SecondRow>
          <div class="mt-2 text-sm font-semibold text-red-600">
            {{
              lockSummary.lockProcessingError || 'The Argon transaction failed before this Bitcoin lock was created.'
            }}
          </div>
        </div>
      </div>
    </section>

    <section
      PendingRecord
      v-else-if="
        lockSummary.status === BitcoinLockStatus.LockPendingFunding && lockSummary.statusDetails.showReadyForBitcoin
      "
    >
      <BitcoinIcon MainIcon class="fade-in-out" />
      <div ContentWrapper>
        <div FirstRow>
          <header class="fade-in-out">
            {{ satToBtcNm(lockSummary.satoshis).format('0,0.[00000000]') }} of BTC Is Ready to Lock
          </header>
          <button PrimaryButton>Finish Locking</button>
        </div>
        <div SecondRow>
          <div class="fade-in-out text-argon-900/60 text-md pointer-events-none font-bold">
            <CountdownClock :time="fundingExpirationTime" v-slot="{ days, hours, minutes, seconds, isFinished }">
              <template v-if="isFinished">The time to complete this step has expired.</template>
              <template v-else>
                You have {{ formatTimeRemaining(days, hours, minutes, seconds) }} to complete this step.
              </template>
            </CountdownClock>
          </div>
        </div>
      </div>
    </section>

    <section PendingRecord v-else-if="lockSummary.status === BitcoinLockStatus.LockPendingFunding">
      <BitcoinIcon
        MainIcon
        :class="lockSummary.statusDetails.isFundingSeenInMempoolOnly ? 'fade-in-out' : 'bitcoin-spin'"
      />
      <div ContentWrapper>
        <div FirstRow :class="lockSummary.statusDetails.isFundingSeenInMempoolOnly ? 'fade-in-out' : ''">
          <header>{{ satToBtcNm(lockSummary.satoshis).format('0,0.[00000000]') }} of BTC Is Now Locking</header>
        </div>
        <div SecondRow>
          <div v-if="lockSummary.statusDetails.isFundingSeenInMempoolOnly" class="fade-in-out text-slate-800/60">
            <span>Found In Mempool... Waiting for First Bitcoin Block</span>
          </div>
          <ProgressBar v-else :progress="lockSummary.lockProcessingDetails.progressPct" class="h-8" />
        </div>
      </div>
    </section>

    <section PendingRecord v-else-if="lockSummary.status === BitcoinLockStatus.Releasing">
      <BitcoinIcon MainIcon class="bitcoin-spin" />
      <div ContentWrapper>
        <div FirstRow>
          <header>{{ satToBtcNm(lockSummary.satoshis).format('0,0.[00000000]') }} of BTC Is Being Released</header>
          <button PrimaryButton @click.stop="openUnlockingOverlay($event, lockSummary.record)">View Progress</button>
        </div>
        <div SecondRow>
          <template v-if="releaseState.isWaitingForVaultCosign">
            Waiting for the vault to cosign the Bitcoin release.
          </template>
          <template v-else-if="releaseState.isBitcoinReleaseProcessing">
            The release is processing on the Bitcoin network.
          </template>
          <template v-else-if="releaseState.isArgonSubmitting">The release request is processing on Argon.</template>
          <template v-else>Preparing the Bitcoin release.</template>
        </div>
      </div>
    </section>

    <section
      ActiveRecord
      v-else-if="lockSummary.status === BitcoinLockStatus.LockFunded"
      :class="isActionHovered ? '' : 'hover:bg-slate-50'"
    >
      <BitcoinIcon MainIcon />
      <div ContentWrapper>
        <div FirstRow>
          <span class="font-semibold">{{ satToBtcNm(lockSummary.satoshis).format('0,0.[0000]') }} of Locked BTC</span>
          <span class="font-light">
            expires in {{ expirationDate(lockSummary.record).diff(dayjs.utc(), 'days') }} days
          </span>
          <div
            class="text-md flex grow flex-row items-center justify-end gap-x-2 text-right"
            @mouseenter="isActionHovered = true"
            @mouseleave="isActionHovered = false"
          >
            <button
              v-if="liquidId !== undefined"
              RatchetButton
              @click.stop="openRatchetingOverlay($event, lockSummary, liquidId)"
              :class="[
                displayedRatchetPercent || isRatchetPending
                  ? 'bg-argon-600 border-argon-800 hover:bg-argon-700 text-white hover:shadow-lg'
                  : 'border-slate-800/20 text-slate-600/40',
              ]"
              class="inline-flex items-center gap-2"
            >
              <template v-if="isRatchetPending">
                <Spinner class="Inverse" />
                Ratcheting...
              </template>
              <span v-else-if="displayedRatchetPercent">
                Ratchet {{ displayedRatchetPercent > 0 ? '+' : ''
                }}{{ numeral(displayedRatchetPercent).format('0,0.[00]') }}%
              </span>
              <template v-else>Price Is at Par</template>
            </button>
            <button PrimaryButton @click.stop="openUnlockingOverlay($event, lockSummary.record)">Unlock</button>
          </div>
        </div>
        <div SecondRow>
          <span>{{ currency.symbol }}{{ satToMoneyNm(lockSummary.satoshis).format('0,0.00') }} locked BTC</span>
          <div class="flex grow flex-row items-stretch justify-center">
            <span class="h-full w-px bg-slate-400/50"></span>
          </div>
          <span>
            {{ currency.symbol }}{{ microgonToMoneyNm(lockSummary.receivedLiquidity).format('0,0.00') }} received
            <template v-if="lockSummary.pendingLiquidity">
              · {{ currency.symbol }}{{ microgonToMoneyNm(lockSummary.pendingLiquidity).format('0,0.00') }} pending
            </template>
          </span>
          <div class="flex grow flex-row items-stretch justify-center">
            <span class="h-full w-px bg-slate-400/50"></span>
          </div>
          <span>{{ currency.symbol }}{{ microgonToMoneyNm(lockSummary.unlockAmount).format('0,0.00') }} debt</span>
          <div class="flex grow flex-row items-stretch justify-center">
            <span class="h-full w-px bg-slate-400/50"></span>
          </div>
          <span>{{ currency.symbol }}{{ microgonToMoneyNm(lockSummary.totalFees).format('0,0.00') }} fees</span>
          <div class="flex grow flex-row items-stretch justify-center">
            <span class="h-full w-px bg-slate-400/50"></span>
          </div>
          <span class="pr-1">
            {{ numeral(Math.round(lockSummary.totalReturn * 100) / 100).format('0,0.[00]') }}% return
          </span>
        </div>
      </div>
    </section>
  </div>
</template>

<script setup lang="ts">
import * as Vue from 'vue';
import dayjs from 'dayjs';
import utc from 'dayjs/plugin/utc.js';
import { BitcoinLockStatus, IBitcoinLockRecord } from '../../../lib/db/BitcoinLocksTable.ts';
import BitcoinIcon from '../../../assets/wallets/bitcoin.svg?component';
import BitcoinAlertIcon from '../../../assets/wallets/bitcoin-alert.svg?component';
import type { IBitcoinLockSummary } from '../../../interfaces/IBitcoinLockSummary.ts';
import numeral, { createNumeralHelpers } from '../../../lib/numeral.ts';
import { getCurrency } from '../../../stores/currency.ts';
import { getBitcoinFissions, getBitcoinLocks, getBitcoinTransactionOperations } from '../../../stores/bitcoin.ts';
import { useFinancialHistory } from '../../../stores/financialHistory.ts';
import ProgressBar from '../../../components/ProgressBar.vue';
import Spinner from '../../../components/Spinner.vue';
import CountdownClock from '../../../components/CountdownClock.vue';

dayjs.extend(utc);

const currency = getCurrency();
const bitcoinLocks = getBitcoinLocks();
const bitcoinFissions = getBitcoinFissions();
const { bitcoinLiquidRatchet } = getBitcoinTransactionOperations();
const financialHistory = useFinancialHistory();

const { microgonToMoneyNm, satToBtcNm, satToMoneyNm } = createNumeralHelpers(currency);

const props = withDefaults(
  defineProps<{
    isRatchetPreparing?: boolean;
    lockSummary: IBitcoinLockSummary;
  }>(),
  {
    isRatchetPreparing: false,
  },
);

const emit = defineEmits<{
  ratchet: [event: MouseEvent, lock: IBitcoinLockSummary, liquidId: number];
  unlock: [event: MouseEvent, lock: IBitcoinLockRecord];
}>();

const isActionHovered = Vue.ref(false);
const lockRecord = Vue.computed(() => props.lockSummary.record);
const liquidId = Vue.computed(() => {
  if (props.lockSummary.utxoId === undefined) return;
  const liquidIds = bitcoinFissions.getLiquidIdsForLock(props.lockSummary.utxoId);
  if (liquidIds.length === 1) return liquidIds[0];
});
const fundingExpirationTime = Vue.computed(() => dayjs.utc(bitcoinLocks.verifyExpirationTime(lockRecord.value)));
const isHistoryRecoveryPaused = Vue.computed(() => financialHistory.historyRecoveryByDomain.bitcoin.state === 'error');
const isRatchetPending = Vue.ref(false);
const displayedRatchetPercent = Vue.computed(() => Math.round(props.lockSummary.ratchetPercent * 100) / 100);
const releaseState = Vue.computed(() => bitcoinLocks.getLockUnlockReleaseState(lockRecord.value));
Vue.watchEffect(onCleanup => {
  const pendingRatchet =
    liquidId.value === undefined ? undefined : bitcoinLiquidRatchet.getPendingRatchetTxInfo(liquidId.value);
  isRatchetPending.value = props.isRatchetPreparing || !!pendingRatchet;
  if (!pendingRatchet) return;

  const unsubscribe = pendingRatchet.subscribeToProgress(() => {
    isRatchetPending.value = props.isRatchetPreparing || !pendingRatchet.isPostProcessed;
  });
  onCleanup(unsubscribe);
});

function expirationDate(lock: IBitcoinLockRecord) {
  const expirationMillis = bitcoinLocks.unlockDeadlineTime(lock);
  return dayjs.utc(expirationMillis);
}

function formatTimeRemaining(days: number, hours: number, minutes: number, seconds: number): string {
  const totalHours = days * 24 + hours;
  const parts = [totalHours ? `${totalHours}h` : '', minutes ? `${minutes}m` : '', `${seconds}s`].filter(Boolean);
  return parts.length > 1 ? `${parts.slice(0, -1).join(', ')} and ${parts.at(-1)}` : parts[0];
}

function openRatchetingOverlay(event: MouseEvent, lock: IBitcoinLockSummary, selectedLiquidId: number) {
  emit('ratchet', event, lock, selectedLiquidId);
}

function openUnlockingOverlay(event: MouseEvent, lock: IBitcoinLockRecord) {
  emit('unlock', event, lock);
}
</script>

<style>
@reference "../../../main.css";

.BitcoinRecord.Component {
  section[RecoveryRecord] {
    @apply flex flex-row items-center gap-2.5 rounded border border-slate-900/20 bg-slate-100 px-3.5 py-2 opacity-60;
  }

  section[PendingRecord] {
    @apply flex cursor-pointer flex-row items-center gap-2.5 rounded border-[1.5px] border-dashed border-slate-900/30 bg-white px-3.5 py-2 hover:bg-slate-50/50;
    [MainIcon] {
      @apply opacity-50;
    }
  }

  section[ActiveRecord] {
    @apply flex cursor-pointer flex-row items-center gap-2.5 rounded border border-slate-900/30 bg-white px-3.5 py-2 shadow hover:bg-slate-50;
  }

  [ContentWrapper] {
    @apply grow pl-2;

    button[PrimaryButton],
    button[RatchetButton] {
      @apply text-md cursor-pointer rounded-md border px-4 py-0.5 font-semibold whitespace-nowrap;
    }

    button[PrimaryButton] {
      @apply bg-argon-600 border-argon-800 hover:bg-argon-700 text-white hover:shadow-lg;
    }

    button[RatchetButton] .Spinner {
      @apply static m-0 h-4 min-h-4 w-4 min-w-4 border-4;
    }

    button[SecondaryButton] {
      @apply border-argon-800/50 text-md text-argon-600 hover:bg-argon-700 cursor-pointer rounded-md border px-4 py-0.5 font-semibold whitespace-nowrap hover:text-white hover:shadow-lg;
    }

    [FirstRow] {
      @apply flex flex-row items-center gap-1 pt-3 pb-2 text-lg text-slate-800;
      header {
        @apply relative top-1 grow text-lg font-bold;
      }
    }

    [SecondRow] {
      @apply flex flex-row items-stretch border-t border-slate-400/30 pt-3 pb-3 whitespace-nowrap text-slate-500;
    }
  }

  [MainIcon] {
    @apply text-argon-600/60 w-20;
  }
  /* relative top-px mr-7 inline-block w-18 -rotate-24 opacity-60 */

  .fade-in-out {
    animation: fadeInOut 1s ease-in-out infinite;
  }

  .fade-in-out:hover {
    animation: none;
  }

  .bitcoin-spin {
    animation: bitcoinSpin 2s ease-in-out infinite;
    transform-box: fill-box;
    transform-origin: center;
  }
}

@keyframes fadeInOut {
  0%,
  100% {
    opacity: 0.35;
  }
  50% {
    opacity: 0.85;
  }
}

@keyframes bitcoinSpin {
  0% {
    rotate: 0deg;
  }
  90% {
    rotate: 360deg;
  }
  100% {
    rotate: 360deg;
  }
}
</style>
