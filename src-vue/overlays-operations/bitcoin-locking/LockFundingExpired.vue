<template>
  <div class="space-y-5 px-10 pt-5 pb-5">
    <div class="flex flex-row items-center gap-6">
      <div class="relative w-20 shrink-0">
        <BitcoinIcon class="w-20 -rotate-24 opacity-50" />
        <ClockIcon class="absolute -top-1 -right-1 w-9 rounded-full bg-white p-0.5 text-amber-500" />
      </div>
      <div class="flex grow flex-col">
        <div class="text-xl font-bold opacity-70">{{ formattedBtc }} BTC Lock Expired</div>
        <div class="mt-1 opacity-50">
          {{ currency.symbol }}{{ microgonToMoneyNm(personalLock.liquidityPromised).format('0,0.[00]') }}
          Liquidity Requested
        </div>
      </div>
    </div>

    <p class="text-sm text-slate-600">
      This lock expired before Bitcoin funding was confirmed. No Bitcoin was received for this lock request.
    </p>

    <div class="flex flex-row items-center justify-end border-t border-slate-200 pt-4">
      <button
        data-testid="LockFundingExpired.acknowledge()"
        @click="acknowledge"
        class="cursor-pointer rounded-md border border-slate-400 px-5 py-2 text-base font-semibold text-slate-700 hover:bg-slate-100">
        Acknowledge &amp; Dismiss
      </button>
    </div>
  </div>
</template>

<script setup lang="ts">
import numeral from '../../lib/numeral.ts';
import { createNumeralHelpers } from '../../lib/numeral.ts';
import { getCurrency } from '../../stores/currency.ts';
import { getBitcoinLocks } from '../../stores/bitcoin.ts';
import type { IBitcoinLockRecord } from '../../lib/db/BitcoinLocksTable.ts';
import BitcoinIcon from '../../assets/wallets/bitcoin.svg?component';
import { ClockIcon } from '@heroicons/vue/24/outline';

const currency = getCurrency();
const bitcoinLocks = getBitcoinLocks();
const { microgonToMoneyNm } = createNumeralHelpers(currency);

const props = defineProps<{
  personalLock: IBitcoinLockRecord;
}>();

const emit = defineEmits<{
  (e: 'startNew'): void;
}>();

const formattedBtc = numeral(currency.convertSatToBtc(props.personalLock.satoshis)).format('0,0.[00000000]');

async function acknowledge() {
  await bitcoinLocks.acknowledgeExpiredWaitingForFunding(props.personalLock).catch(() => undefined);
  emit('startNew');
}
</script>
