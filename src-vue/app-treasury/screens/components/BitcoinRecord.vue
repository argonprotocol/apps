<template>
  <div class="BitcoinRecord Component flex flex-col">
    <section PendingRecord v-if="lockSummary.status === BitcoinLockStatus.LockIsProcessingOnArgon">
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
        lockSummary.status === BitcoinLockStatus.LockPendingFunding && lockSummary.statusDetails.showMismatchAccept
      "
    >
      <BitcoinIcon MainIcon class="bitcoin-spin" />
      <div ContentWrapper>
        <div FirstRow>
          <header>{{ satToBtcNm(lockSummary.satoshis).format('0,0.[00000000]') }} of BTC Is Updating on Argon</header>
          <button PrimaryButton>View Status</button>
        </div>
        <div SecondRow>
          <div v-if="mismatchAcceptProgress.error" class="mt-2 text-sm font-semibold text-red-600">
            {{ mismatchAcceptProgress.error }}
          </div>
          <ProgressBar v-else :progress="mismatchAcceptProgress.progressPct" class="h-8" />
        </div>
      </div>
    </section>

    <BitcoinRecordMismatch
      v-else-if="
        lockSummary.status === BitcoinLockStatus.LockPendingFunding && lockSummary.statusDetails.showFundingMismatch
      "
      :lock-summary="lockSummary"
    />

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
            Monitoring the Bitcoin Network for Your Deposit
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

    <section PendingRecord v-else-if="lockSummary.status === BitcoinLockStatus.LockExpiredWaitingForFunding">
      <BitcoinAlertIcon MainIcon />
      <div ContentWrapper>
        <div FirstRow>
          <header>
            {{ satToBtcNm(lockSummary.satoshis).format('0,0.[0000]') }} of BTC Was Never Received Before Expiration
          </header>
          <button PrimaryButton @click.stop="acknowledgeExpiredNotice">Clear this Notice</button>
        </div>
        <div SecondRow>No Bitcoin was received before this lock expired. You must restart the process.</div>
      </div>
    </section>

    <section PendingRecord v-else-if="lockSummary.status === BitcoinLockStatus.LockFundingReadyToResume">
      <BitcoinIcon MainIcon />
      <div ContentWrapper>
        <div FirstRow>
          <header>{{ satToBtcNm(lockSummary.satoshis).format('0,0.[0000]') }} of BTC Is Ready to Resume Locking</header>
          <button PrimaryButton="">Resume Locking</button>
        </div>
        <div SecondRow>Your mismatched Bitcoin deposit was returned. Locking can now resume.</div>
      </div>
    </section>

    <section
      ActiveRecord
      v-else-if="[BitcoinLockStatus.LockedAndIsMinting, BitcoinLockStatus.LockedAndMinted].includes(lockSummary.status)"
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
              @click.stop="openRatchetingOverlay($event, lockSummary)"
              :class="[
                lockSummary.hodlingReturn
                  ? 'bg-argon-600 border-argon-800 hover:bg-argon-700 text-white hover:shadow-lg'
                  : 'cursor-default border-slate-800/20 text-slate-600/40',
              ]"
              class="cursor-pointer rounded-md border px-2"
            >
              <span v-if="lockSummary.hodlingReturn">
                Ratchet {{ lockSummary.hodlingReturn > 0 ? '+' : ''
                }}{{ numeral(lockSummary.hodlingReturn).format('0,0.[00]') }}%
              </span>
              <template v-else>Price Is at Par</template>
            </button>
            <button PrimaryButton @click.stop="openUnlockingOverlay($event, lockSummary.record)">Unlock</button>
          </div>
        </div>
        <div SecondRow>
          <span>{{ currency.symbol }}{{ satToMoneyNm(lockSummary.satoshis).format('0,0.00') }} market value</span>
          <div class="flex grow flex-row items-stretch justify-center">
            <span class="h-full w-px bg-slate-400/50"></span>
          </div>
          <span>
            {{ currency.symbol
            }}{{ microgonToMoneyNm(bitcoinLocks.getDisplayLiquidityPromised(lockSummary.record)).format('0,0.00') }}
            issued
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
          <span class="pr-1">{{ numeral(lockSummary.totalReturn).format('0,0.[00]') }}% return</span>
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
import { ILockSummary } from '../../stores/financials.ts';
import numeral, { createNumeralHelpers } from '../../../lib/numeral.ts';
import { getCurrency } from '../../../stores/currency.ts';
import { getBitcoinLocks } from '../../../stores/bitcoin.ts';
import ProgressBar from '../../../components/ProgressBar.vue';
import BitcoinRecordMismatch from './BitcoinRecordMismatch.vue';

dayjs.extend(utc);

const currency = getCurrency();
const bitcoinLocks = getBitcoinLocks();

const { microgonToMoneyNm, satToBtcNm, satToMoneyNm } = createNumeralHelpers(currency);

const props = defineProps<{
  lockSummary: ILockSummary;
}>();

const emit = defineEmits<{
  ratchet: [event: MouseEvent, lock: ILockSummary];
  unlock: [event: MouseEvent, lock: IBitcoinLockRecord];
}>();

const isActionHovered = Vue.ref(false);
const lockRecord = Vue.computed(() => props.lockSummary.record);
const mismatchAcceptProgress = Vue.computed(() => {
  if (!lockRecord.value.utxoId) {
    return { progressPct: 0, error: '' };
  }
  const txStatus = bitcoinLocks.getLatestMismatchAcceptTxInfo(lockRecord.value.utxoId)?.getStatus();
  return {
    progressPct: txStatus?.progressPct ?? 0,
    error: '',
  };
});

function expirationDate(lock: IBitcoinLockRecord) {
  const expirationMillis = bitcoinLocks.unlockDeadlineTime(lock);
  return dayjs.utc(expirationMillis);
}

function openRatchetingOverlay(event: MouseEvent, lock: ILockSummary) {
  if (!props.lockSummary.hodlingReturn) return;
  emit('ratchet', event, lock);
}

function openUnlockingOverlay(event: MouseEvent, lock: IBitcoinLockRecord) {
  emit('unlock', event, lock);
}

async function acknowledgeExpiredNotice() {
  await bitcoinLocks.acknowledgeExpiredWaitingForFunding(props.lockSummary.record).catch(() => undefined);
  await bitcoinLocks.load();
}
</script>

<style>
@reference "../../../main.css";

.BitcoinRecord.Component {
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

    button[PrimaryButton] {
      @apply bg-argon-600 border-argon-800 text-md hover:bg-argon-700 cursor-pointer rounded-md border px-4 py-0.5 font-semibold whitespace-nowrap text-white hover:shadow-lg;
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
    @apply w-20 text-slate-400;
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
