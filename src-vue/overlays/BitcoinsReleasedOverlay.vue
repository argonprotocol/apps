<template>
  <div class="px-1 text-xs font-medium tracking-wide text-slate-400">
    {{ financials.liquidInvisibleRecords.length }} bitcoin transaction{{
      financials.liquidInvisibleRecords.length === 1 ? '' : 's'
    }}
    {{ financials.liquidInvisibleRecords.length === 1 ? 'has' : 'have' }} been archived
  </div>
  <section
    v-for="lock in financials.liquidInvisibleRecords"
    :key="lock.uuid ?? lock.utxoId"
    @click="openDetail(lock)"
    class="flex cursor-pointer flex-row items-center gap-2.5 rounded border border-slate-900/20 bg-slate-50 px-3.5 py-2 opacity-60 hover:opacity-80"
  >
    <BitcoinIcon class="text-argon-600/60 w-20" />
    <div class="grow pl-2">
      <div class="flex flex-row items-center gap-1 pt-3 pb-2 text-lg text-slate-800">
        <span class="font-semibold">{{ satToBtcNm(lock.satoshis).format('0,0.[0000]') }} of BTC</span>
        <span v-if="lock.record.removalBlockTime" class="font-light">
          {{ removalDateLabel(lock.record) }}
          {{ dayjs().diff(dayjs(lock.record.removalBlockTime), 'days') }} days ago
        </span>
        <span class="ml-auto font-semibold text-slate-500">Archived</span>
      </div>
      <div class="flex flex-row items-stretch border-t border-slate-400/30 pt-3 pb-3 whitespace-nowrap text-slate-500">
        <span v-if="financials.bitcoinLockPerformanceByUuid[lock.uuid]">
          {{ currency.symbol
          }}{{ microgonToMoneyNm(financials.bitcoinLockPerformanceByUuid[lock.uuid]?.profit ?? 0n).format('0,0.[00]') }}
          profit
          <template v-if="lock.pendingLiquidity > 0n">
            · {{ currency.symbol }}{{ microgonToMoneyNm(lock.pendingLiquidity).format('0,0.00') }} pending
          </template>
        </span>
        <span v-else-if="isReturnLoading(lock)">Loading profit...</span>
        <span v-else>Profit unavailable</span>
        <div class="flex grow flex-row items-stretch justify-center">
          <span class="h-full w-px bg-slate-400/50"></span>
        </div>
        <span>{{ currency.symbol }}{{ microgonToMoneyNm(lock.securityFees).format('0,0.00') }} vault fees</span>
        <div class="flex grow flex-row items-stretch justify-center">
          <span class="h-full w-px bg-slate-400/50"></span>
        </div>
        <span>
          {{ currency.symbol
          }}{{ microgonToMoneyNm(lock.historicalTransactionFees ?? lock.transactionFees).format('0,0.00') }}
          {{ hasCompleteTransactionFees(lock.record) ? 'transaction fees' : 'known transaction fees' }}
        </span>
        <div class="flex grow flex-row items-stretch justify-center">
          <span class="h-full w-px bg-slate-400/50"></span>
        </div>
        <span v-if="financials.bitcoinLockPerformanceByUuid[lock.uuid]" class="pr-1">
          {{ numeral(financials.bitcoinLockPerformanceByUuid[lock.uuid]?.percent ?? 0).format('0,0.[00]') }}% return
        </span>
        <span v-else-if="isReturnLoading(lock)" class="pr-1">Loading return...</span>
        <span v-else class="pr-1">Return unavailable</span>
      </div>
    </div>
  </section>
</template>
<script setup lang="ts">
import dayjs from 'dayjs';
import BitcoinIcon from '../assets/wallets/bitcoin.svg?component';
import { getCurrency } from '../stores/currency.ts';
import numeral, { createNumeralHelpers } from '../lib/numeral.ts';
import type { IBitcoinLockSummary } from '../interfaces/IBitcoinLockSummary.ts';
import type { IBitcoinLockRecord } from '../interfaces/IBitcoinLockRecord.ts';
import { useFinancials } from '../stores/financials.ts';

const emit = defineEmits<{
  (e: 'openDetail', lock: IBitcoinLockSummary): void;
}>();

const currency = getCurrency();
const financials = useFinancials();
const { microgonToMoneyNm, satToBtcNm } = createNumeralHelpers(currency);

function openDetail(lock: IBitcoinLockSummary) {
  emit('openDetail', lock);
}

function isReturnLoading(lock: IBitcoinLockSummary) {
  return lock.record.isHistoryRecoveryPending;
}

function removalDateLabel(lock: IBitcoinLockRecord) {
  if (lock.removalReason === 'expired') return 'expired';
  if (lock.removalReason === 'spent') return 'removed';
  return 'released';
}

function hasCompleteTransactionFees(lock: IBitcoinLockRecord) {
  return (
    lock.releaseArgonTxFeeMicrogons !== undefined &&
    lock.fundingUtxo?.releaseBitcoinNetworkFee !== undefined &&
    lock.btcPriceAtRemovalMicrogons !== undefined
  );
}
</script>
