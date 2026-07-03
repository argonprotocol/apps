<template>
  <div class="px-1 text-xs font-medium tracking-wide text-slate-400 uppercase">Released</div>
  <div
    v-for="lock in financials.liquidInvisibleRecords"
    :key="lock.uuid ?? lock.utxoId"
    @click="openDetail(lock)"
    class="flex cursor-pointer flex-row items-center rounded border border-slate-200/50 bg-white/50 px-4 py-2 opacity-50 hover:opacity-70"
  >
    <BitcoinIcon class="h-14 text-slate-400" />
    <div class="grow">
      <div class="font-mono text-sm font-semibold text-slate-700">
        {{ satToBtcNm(lock.satoshis).format('0,0.[0000]') }} BTC
      </div>
      <div class="text-xs text-slate-400">
        {{ currency.symbol
        }}{{ microgonToMoneyNm(bitcoinLocks.getDisplayLiquidityPromised(lock.record)).format('0,0.00') }}
        liquidity Released
      </div>
    </div>
  </div>
</template>
<script setup lang="ts">
import BitcoinIcon from '../assets/wallets/bitcoin.svg?component';
import { getBitcoinLocks } from '../stores/bitcoin.ts';
import { getCurrency } from '../stores/currency.ts';
import { createNumeralHelpers } from '../lib/numeral.ts';
import { useFinancials, type ILockSummary } from '../stores/financials.ts';

const emit = defineEmits<{
  (e: 'openDetail', lock: ILockSummary): void;
}>();

const bitcoinLocks = getBitcoinLocks();
const currency = getCurrency();
const financials = useFinancials();
const { microgonToMoneyNm, satToBtcNm } = createNumeralHelpers(currency);

function openDetail(lock: ILockSummary) {
  emit('openDetail', lock);
}
</script>
