<template>
  <div class="flex min-h-0 grow flex-col">
    <section class="mt-5 flex flex-row items-end gap-x-2 px-9 text-center">
      <div class="w-1/3 border-b border-slate-400/30 py-5">
        <div class="text-argon-600 inline-flex text-5xl font-bold">
          <span>{{ currency.symbol }}</span>
          <FormattedMoney :value="totalLiquidSatoshis" :unitOfMeasurement="UnitOfMeasurement.Satoshi" />
        </div>
        <div class="font-light text-slate-900/70">Market Value of Liquid BTC</div>
      </div>
      <div class="relative h-full w-px bg-slate-400/30">
        <div
          class="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 bg-white pt-1 pb-3 text-6xl leading-5 text-slate-500/80"
        >
          =
        </div>
      </div>
      <div class="w-1/3 border-b border-slate-400/30 py-5">
        <div class="text-argon-600 text-5xl font-bold">
          <template v-if="financials.liquidPerformanceReturn !== undefined">
            {{ numeral(financials.liquidPerformanceReturn).format('0,0.[00]') }}%
          </template>
          <template v-else>&mdash;</template>
        </div>
        <div class="font-light text-slate-900/70">Liquid Returns</div>
      </div>
      <div class="relative h-full w-px bg-slate-400/30">
        <div
          class="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 bg-white pt-2 pb-4 text-4xl leading-5 font-semibold text-slate-500/80"
        >
          vs
        </div>
      </div>
      <div class="w-1/3 border-b border-slate-400/30 py-5">
        <div class="text-argon-600 text-5xl font-bold">
          <template v-if="financials.liquidHodlingReturn !== undefined">
            {{ numeral(financials.liquidHodlingReturn).format('0,0.[00]') }}%
          </template>
          <template v-else>&mdash;</template>
        </div>
        <div class="font-light text-slate-900/70">Hodling Returns</div>
      </div>
    </section>

    <div class="relative flex min-h-0 grow flex-col">
      <div class="flex min-h-0 grow flex-col overflow-y-auto pt-10">
        <div class="flex flex-row items-center px-9 text-slate-800/70">
          <span class="grow">
            You have {{ activeLiquidRows.length }} active Bitcoin Liquid{{ activeLiquidRows.length === 1 ? '' : 's' }}
            <template v-if="pendingLiquidRows.length">· {{ pendingLiquidRows.length }} creating</template>
          </span>
          <div class="flex flex-row items-stretch gap-x-3">
            <button
              data-testid="Dashboard.openCreateLiquid()"
              class="text-argon-600 relative cursor-pointer"
              @click="basicEmitter.emit('openBitcoinLiquidCreationOverlay', undefined)"
            >
              Create Liquid · {{ numeral(currency.convertSatToBtc(totalUnallocatedSatoshis)).format('0,0.[00000000]') }}
              BTC Available
            </button>
            <div class="w-px bg-slate-400/50" />
            <a
              class="text-argon-600 cursor-pointer whitespace-nowrap"
              :href="`${NetworkConfig.websiteHost}/docs/assets-and-entities/bitcoin-locks`"
              target="_blank"
            >
              View Docs
            </a>
          </div>
        </div>

        <section class="mt-4 flex grow flex-col gap-y-3 px-9 pb-10">
          <article
            v-for="liquid in pendingLiquidRows"
            :key="liquid.liquidId"
            :data-testid="`PendingBitcoinLiquid-${liquid.liquidId}`"
            class="flex cursor-pointer flex-row items-center gap-2.5 rounded border-[1.5px] border-dashed border-slate-900/30 bg-white px-3.5 py-2 hover:bg-slate-50/50"
            @click="openPendingLiquidDetails(liquid)"
          >
            <BitcoinIcon class="text-argon-600/60 w-20 animate-spin opacity-50" />
            <div class="grow pl-2">
              <div class="flex flex-row items-center gap-1 pt-3 pb-2 text-slate-800">
                <span class="grow text-lg font-semibold">
                  {{ satToBtcNm(liquid.satoshis).format('0,0.[0000]') }} BTC Liquid Is Being Created
                </span>
                <button
                  class="border-argon-800/50 text-argon-600 hover:bg-argon-700 cursor-pointer rounded-md border px-4 py-0.5 font-semibold whitespace-nowrap hover:text-white hover:shadow-lg"
                  @click.stop="openPendingLiquidDetails(liquid)"
                >
                  View Progress
                </button>
              </div>
              <div class="border-t border-slate-400/30 pt-3 pb-3">
                <ProgressBar :progress="liquid.progressPct" class="h-8" />
              </div>
            </div>
          </article>

          <article
            v-for="liquid in activeLiquidRows"
            :key="liquid.model.liquidId"
            class="flex cursor-pointer flex-row items-center gap-2.5 rounded border border-slate-900/30 bg-white px-3.5 py-2 shadow hover:bg-slate-50"
            @click="openLiquidDetails(liquid)"
          >
            <BitcoinIcon class="text-argon-600/60 w-20" />
            <div class="grow pl-2">
              <div class="flex flex-row items-center gap-1 pt-3 pb-2 text-slate-800">
                <span class="text-lg font-semibold">
                  {{ satToBtcNm(liquid.model.satoshis).format('0,0.[0000]') }} BTC Liquid
                </span>
                <span v-if="liquid.model.history[0]?.blockTime" class="font-light">
                  created {{ dayjs().diff(dayjs(liquid.model.history[0].blockTime), 'days') }} days ago
                </span>
                <div class="flex grow flex-row items-center justify-end gap-x-2 text-right">
                  <span v-if="isRatchetPending(liquid.model.liquidId)" class="font-semibold text-slate-500">
                    Ratcheting...
                  </span>
                  <span v-else-if="liquid.ratchet.isAvailable" class="text-argon-600 font-semibold">
                    Ratchet {{ liquid.ratchet.percent > 0 ? '+' : ''
                    }}{{ numeral(liquid.ratchet.percent).format('0,0.[00]') }}% available
                  </span>
                  <span class="font-semibold whitespace-nowrap text-slate-500">
                    {{ currency.symbol }}{{ microgonToMoneyNm(liquid.repaymentAmount).format('0,0.00') }} to close
                  </span>
                </div>
              </div>
              <div
                class="flex flex-row items-stretch border-t border-slate-400/30 pt-3 pb-3 whitespace-nowrap text-slate-500"
              >
                <span>
                  {{ currency.symbol
                  }}{{ microgonToMoneyNm(liquid.model.liquidityPromised).format('0,0.00') }} liquidity
                  <span v-if="liquid.model.pendingLiquidity" class="ml-1 text-slate-400">
                    ({{ currency.symbol
                    }}{{ microgonToMoneyNm(liquid.model.pendingLiquidity).format('0,0.00') }} pending mint)
                  </span>
                </span>
                <div class="flex grow flex-row items-stretch justify-center">
                  <span class="h-full w-px bg-slate-400/50" />
                </div>
                <span>
                  <template v-if="liquid.position?.totalFees !== undefined">
                    {{ currency.symbol }}{{ microgonToMoneyNm(liquid.position.totalFees).format('0,0.00') }} fees
                  </template>
                  <template v-else>&mdash; fees</template>
                </span>
                <div class="flex grow flex-row items-stretch justify-center">
                  <span class="h-full w-px bg-slate-400/50" />
                </div>
                <span class="pr-1">
                  <template v-if="liquid.position?.totalReturn !== undefined">
                    {{ numeral(liquid.position.totalReturn).format('0,0.[00]') }}% return
                  </template>
                  <template v-else>&mdash; return</template>
                </span>
              </div>
            </div>
          </article>

          <div
            v-if="!activeLiquidRows.length && !pendingLiquidRows.length"
            class="rounded-lg border border-dashed border-slate-300 px-6 py-12 text-center"
          >
            <div class="text-lg font-semibold text-slate-700">
              {{ closedLiquidRows.length ? 'No active Bitcoin Liquids' : 'No Bitcoin Liquids yet' }}
            </div>
            <div class="mt-1 text-slate-500">Create a Liquid from unallocated Bitcoin in your wallet.</div>
          </div>

          <section v-if="closedLiquidRows.length" class="mt-5 flex flex-col gap-y-3">
            <h2 class="px-1 text-slate-400">
              {{ closedLiquidRows.length }} Bitcoin Liquid{{ closedLiquidRows.length === 1 ? '' : 's' }}
              {{ closedLiquidRows.length === 1 ? 'has' : 'have' }} been archived
            </h2>
            <article
              v-for="liquid in closedLiquidRows"
              :key="liquid.model.liquidId"
              class="flex cursor-pointer flex-row items-center gap-2.5 rounded border border-slate-900/20 bg-slate-50 px-3.5 py-2 opacity-60 hover:opacity-80"
              @click="openLiquidDetails(liquid)"
            >
              <BitcoinIcon class="text-argon-600/60 w-20" />
              <div class="grow pl-2">
                <div class="flex flex-row items-center gap-1 pt-3 pb-2 text-slate-800">
                  <span class="text-lg font-semibold">
                    {{ satToBtcNm(liquid.model.satoshis).format('0,0.[0000]') }} BTC Liquid
                  </span>
                  <span v-if="liquid.model.closedAt" class="font-light">
                    closed {{ dayjs().diff(dayjs(liquid.model.closedAt), 'days') }} days ago
                  </span>
                  <span class="ml-auto font-semibold text-slate-500">Archived</span>
                </div>
                <div
                  class="flex flex-row items-stretch border-t border-slate-400/30 pt-3 pb-3 whitespace-nowrap text-slate-500"
                >
                  <!-- prettier-ignore -->
                  <span
                  v-if="liquid.position?.performanceEndingCapital !== undefined && liquid.position.investedCost !== undefined"
                  class="tabular-nums"
                >
                  {{ currency.symbol
                  }}{{
                    microgonToMoneyNm(
                      liquid.position.performanceEndingCapital - liquid.position.investedCost,
                    ).format('0,0.00')
                  }}
                  profit
                </span>
                  <span v-else>Profit unavailable</span>
                  <div class="flex grow flex-row items-stretch justify-center">
                    <span class="h-full w-px bg-slate-400/50" />
                  </div>
                  <span class="tabular-nums">
                    <template v-if="liquid.position?.insuranceCost !== undefined">
                      {{ currency.symbol
                      }}{{ microgonToMoneyNm(liquid.position.insuranceCost).format('0,0.00') }} insurance fees
                    </template>
                    <template v-else>Insurance fees unavailable</template>
                  </span>
                  <div class="flex grow flex-row items-stretch justify-center">
                    <span class="h-full w-px bg-slate-400/50" />
                  </div>
                  <span class="tabular-nums">
                    <template v-if="liquid.position?.transactionFees !== undefined">
                      {{ currency.symbol }}{{ microgonToMoneyNm(liquid.position.transactionFees).format('0,0.00') }}
                      transaction fees
                    </template>
                    <template v-else>Transaction fees unavailable</template>
                  </span>
                  <div class="flex grow flex-row items-stretch justify-center">
                    <span class="h-full w-px bg-slate-400/50" />
                  </div>
                  <span v-if="liquid.position?.totalReturn !== undefined" class="pr-1 tabular-nums">
                    {{ numeral(liquid.position.totalReturn).format('0,0.[00]') }}% return
                  </span>
                  <span v-else class="pr-1">Return unavailable</span>
                </div>
              </div>
            </article>
          </section>

          <div v-if="remainingFeeWaiver" class="self-end text-right text-sm text-slate-600">
            Your fee waiver from {{ remainingFeeWaiver.provider }} has {{ remainingFeeWaiver.amount }} remaining ·
            expires in {{ remainingFeeWaiver.timeRemaining }}
          </div>
        </section>

        <div class="relative px-0.5 pb-0.5">
          <img src="/treasury-footers/bitcoin-locks.png" class="w-full opacity-50" />
        </div>
      </div>
      <div class="absolute top-0 left-0 h-10 w-full bg-linear-to-b from-white to-transparent" />
    </div>
  </div>

  <BitcoinLiquidDetailOverlay v-if="selectedLiquid" :liquid="selectedLiquid" @close="selectedLiquidId = undefined" />
</template>

<script setup lang="ts">
import * as Vue from 'vue';
import dayjs from 'dayjs';
import relativeTime from 'dayjs/plugin/relativeTime';
import { bigIntMax, NetworkConfig, SATOSHIS_PER_BITCOIN, UnitOfMeasurement } from '@argonprotocol/apps-core';

import BitcoinIcon from '../../assets/wallets/bitcoin.svg?component';
import FormattedMoney from '../../components/FormattedMoney.vue';
import ProgressBar from '../../components/ProgressBar.vue';
import basicEmitter from '../../emitters/basicEmitter.ts';
import numeral, { createNumeralHelpers } from '../../lib/numeral.ts';
import type { BitcoinLiquid } from '../../lib/BitcoinLiquid.ts';
import { BitcoinLockStatus, type IBitcoinLockRecord } from '../../interfaces/IBitcoinLockRecord.ts';
import type { IBitcoinLockSummary } from '../../interfaces/IBitcoinLockSummary.ts';
import type { IBitcoinLiquidFinancialPosition } from '../../interfaces/IFinancialPosition.ts';
import {
  getBitcoinFissions,
  getBitcoinLockCoupons,
  getBitcoinLocks,
  getBitcoinTransactionOperations,
} from '../../stores/bitcoin.ts';
import { getConfig } from '../../stores/config.ts';
import { getCurrency } from '../../stores/currency.ts';
import { useFinancials } from '../../stores/financials.ts';
import BitcoinLiquidDetailOverlay from '../../overlays/BitcoinLiquidDetailOverlay.vue';

type LiquidDisplay = {
  model: BitcoinLiquid;
  position?: IBitcoinLiquidFinancialPosition;
  repaymentAmount: bigint;
  ratchet: ReturnType<BitcoinLiquid['getRatchetStatus']>;
  lockSummaries: IBitcoinLockSummary[];
};

type PendingLiquidDisplay = {
  liquidId: number;
  satoshis: bigint;
  progressPct: number;
};

dayjs.extend(relativeTime);

const currency = getCurrency();
const config = getConfig();
const financials = useFinancials();
const bitcoinLocks = getBitcoinLocks();
const bitcoinFissions = getBitcoinFissions();
const { bitcoinLiquidCreate, bitcoinLiquidRatchet } = getBitcoinTransactionOperations();
const selectedLiquidId = Vue.ref<number>();
const bitcoinLockCoupons = getBitcoinLockCoupons();
const { microgonToArgonNm, microgonToMoneyNm, satToBtcNm } = createNumeralHelpers(currency);

const now = Vue.ref(Date.now());

const activeFissions = Vue.computed(() => bitcoinFissions.getAll());
const pendingLiquidCreateTxInfos = Vue.computed(() => bitcoinLiquidCreate.getPendingLiquidTxInfos());
const activeLocks = Vue.computed(() =>
  bitcoinLocks.getAllLocks().filter(lock => lock.status === BitcoinLockStatus.LockFunded),
);

const allocatedSatoshisByUtxoId = Vue.computed(() => {
  const byUtxoId = new Map<IBitcoinLockRecord['utxoId'], bigint>();
  const allocatedFissionIds = new Set<number>();
  for (const fission of activeFissions.value) {
    byUtxoId.set(fission.utxoId, (byUtxoId.get(fission.utxoId) ?? 0n) + fission.satoshis);
    allocatedFissionIds.add(fission.fissionId);
  }
  for (const txInfo of pendingLiquidCreateTxInfos.value) {
    for (const fission of txInfo.tx.metadataJson.fissions) {
      if (allocatedFissionIds.has(fission.fissionId)) continue;
      byUtxoId.set(fission.utxoId, (byUtxoId.get(fission.utxoId) ?? 0n) + fission.satoshis);
      allocatedFissionIds.add(fission.fissionId);
    }
  }
  return byUtxoId;
});

const lockAvailability = Vue.computed(() =>
  activeLocks.value.map(lock => {
    const allocatedSatoshis = allocatedSatoshisByUtxoId.value.get(lock.utxoId) ?? 0n;
    const unallocatedSatoshis = bigIntMax(lock.fundedSatoshis - allocatedSatoshis, 0n);
    return {
      unallocatedSatoshis,
    };
  }),
);

const totalUnallocatedSatoshis = Vue.computed(() =>
  lockAvailability.value.reduce((total, lock) => total + lock.unallocatedSatoshis, 0n),
);
const totalLiquidSatoshis = Vue.computed(() =>
  activeFissions.value.reduce((total, fission) => total + fission.satoshis, 0n),
);

const liquidRows = Vue.computed<LiquidDisplay[]>(() =>
  bitcoinFissions.getLiquids().map(liquid => {
    const financialPosition = financials.financialPositionAggregate.groupSummaries.bitcoin.positions.find(
      (position): position is IBitcoinLiquidFinancialPosition =>
        position.kind === 'bitcoin-liquid' && position.liquidId === liquid.liquidId,
    );
    const lockSummaries: IBitcoinLockSummary[] = [];
    const includedLockIds = new Set<number>();
    const currentRate = currency.priceIndex.btcUsdPrice
      ? currency.priceIndex.getSatoshiPriceInTargetMicrogons(SATOSHIS_PER_BITCOIN)
      : undefined;

    for (const fission of liquid.fissions) {
      const lockSummary = financials.bitcoinLockDisplayRecords.find(summary => summary.utxoId === fission.utxoId);
      if (!lockSummary?.satoshis) continue;

      if (!includedLockIds.has(fission.utxoId)) {
        lockSummaries.push(lockSummary);
        includedLockIds.add(fission.utxoId);
      }
    }

    return {
      model: liquid,
      position: financialPosition,
      repaymentAmount: liquid.getRepaymentAmount(currency.priceIndex),
      ratchet:
        currentRate === undefined
          ? { percent: 0, isAvailable: false }
          : liquid.getRatchetStatus({
              microgonsAtTargetPerBtc: currentRate,
              minimumRatchetPercent: bitcoinFissions.data.minimumRatchetPercent,
            }),
      lockSummaries,
    };
  }),
);
const activeLiquidRows = Vue.computed(() => liquidRows.value.filter(liquid => !liquid.model.isClosed));
const closedLiquidRows = Vue.computed(() => liquidRows.value.filter(liquid => liquid.model.isClosed));
const pendingLiquidRows = Vue.computed<PendingLiquidDisplay[]>(() => {
  const finalizedLiquidIds = new Set(liquidRows.value.map(liquid => liquid.model.liquidId));
  const pendingLiquidIds = new Set<number>();
  const rows: PendingLiquidDisplay[] = [];

  for (const txInfo of pendingLiquidCreateTxInfos.value) {
    const { liquidId, fissions } = txInfo.tx.metadataJson;
    if (finalizedLiquidIds.has(liquidId) || pendingLiquidIds.has(liquidId)) continue;
    pendingLiquidIds.add(liquidId);

    const satoshis = fissions.reduce((total, fission) => total + fission.satoshis, 0n);
    rows.push({
      liquidId,
      satoshis,
      progressPct: txInfo.getStatus().progressPct,
    });
  }

  return rows;
});
const selectedLiquid = Vue.computed(
  () => liquidRows.value.find(liquid => liquid.model.liquidId === selectedLiquidId.value)?.model,
);

const remainingFeeWaiver = Vue.computed(() => {
  const coupon = bitcoinLockCoupons.currentCoupon;
  const remainingMicrogons = coupon?.remainingFeeCreditMicrogons;
  const expiresAt = coupon?.expiresAt ? new Date(coupon.expiresAt).getTime() : 0;
  if (!remainingMicrogons || remainingMicrogons <= 0n || expiresAt <= now.value) return;

  return {
    amount: `${currency.recordsByKey[UnitOfMeasurement.ARGN].symbol}${microgonToArgonNm(remainingMicrogons).format('0,0.00')}`,
    provider: config.upstreamOperator?.name || 'your upstream operator',
    timeRemaining: dayjs(expiresAt).from(now.value, true),
  };
});

function openLiquidDetails(liquid: LiquidDisplay): void {
  selectedLiquidId.value = liquid.model.liquidId;
}

function openPendingLiquidDetails(liquid: PendingLiquidDisplay): void {
  basicEmitter.emit('openBitcoinLiquidCreationOverlay', { liquidId: liquid.liquidId });
}

function isRatchetPending(liquidId: number): boolean {
  return !!bitcoinLiquidRatchet.getPendingRatchetTxInfo(liquidId);
}

let feeWaiverCountdownInterval: ReturnType<typeof setInterval> | undefined;

Vue.onMounted(() => {
  feeWaiverCountdownInterval = setInterval(() => {
    now.value = Date.now();
  }, 60e3);
  void bitcoinLockCoupons.refresh().catch(error => {
    console.error('Unable to refresh Bitcoin lock coupons', error);
  });
  void bitcoinFissions.refreshCurrent().catch(error => {
    console.error('Unable to refresh current Bitcoin Liquid state', error);
  });
});

Vue.onUnmounted(() => {
  clearInterval(feeWaiverCountdownInterval);
});
</script>
