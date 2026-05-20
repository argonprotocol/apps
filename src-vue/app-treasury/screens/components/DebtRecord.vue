<template>
  <div class="BondRecord Component flex flex-col">
    <section ActiveRecord :class="isActionHovered ? '' : 'hover:bg-slate-50'">
      <LoanIcon MainIcon />
      <div ContentWrapper>
        <div FirstRow>
          <span class="font-semibold">
            {{ currency.symbol }}{{ microgonToMoneyNm(lockSummary.unlockAmount).format('0,0') }}
          </span>
          <span class="font-light opacity-60">
            matures on {{ expirationDate(lockSummary.record).format('M/D/YYYY [at] h:mm a') }}
          </span>
        </div>
        <div SecondRow>
          <span>
            Backed by {{ satToBtcNm(lockSummary.satoshis).format('0,0.[000000]') }} of BTC from Josh's Vault, which
            locked on {{ dayjs.utc(lockSummary.createdAt).format('M/D/YYYY [at] h:mm a') }}
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
import { IBitcoinLockRecord } from '../../../lib/db/BitcoinLocksTable.ts';
import LoanIcon from '../../../assets/loan.svg?component';
import { ILockSummary } from '../../stores/financials.ts';
import { createNumeralHelpers } from '../../../lib/numeral.ts';
import { getCurrency } from '../../../stores/currency.ts';
import { getBitcoinLocks } from '../../../stores/bitcoin.ts';
import BigNumber from 'bignumber.js';

dayjs.extend(utc);

const currency = getCurrency();
const bitcoinLocks = getBitcoinLocks();

const { microgonToMoneyNm, satToBtcNm, satToMoneyNm } = createNumeralHelpers(currency);

const props = withDefaults(
  defineProps<{
    lockSummary: ILockSummary;
    isReleasing?: boolean;
  }>(),
  {
    isReleasing: false,
  },
);

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

function returnToDate(investment: bigint, earnings: bigint): number {
  const pctBn = BigNumber(earnings).dividedBy(investment);
  return pctBn.multipliedBy(100).toNumber();
}

function expirationDate(lock: IBitcoinLockRecord) {
  const expirationMillis = bitcoinLocks.unlockDeadlineTime(lock);
  return dayjs.utc(expirationMillis);
}

function openRatchetingOverlay(event: MouseEvent, lock: ILockSummary) {
  emit('ratchet', event, lock);
}

function openUnlockingOverlay(event: MouseEvent, lock: IBitcoinLockRecord) {
  emit('unlock', event, lock);
}
</script>

<style>
@reference "../../../main.css";

.BondRecord.Component {
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
