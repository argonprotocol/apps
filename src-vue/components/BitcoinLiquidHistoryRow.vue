<template>
  <article class="border-t border-slate-200 py-3 first:border-t-0">
    <div class="flex items-start gap-x-5">
      <div class="min-w-0 grow">
        <div v-if="entry.kind === 'closed'" class="flex items-baseline gap-x-2">
          <strong v-if="entry.repaymentAmount !== undefined" class="text-slate-700">
            {{ argonSymbol }}{{ microgonToArgonNm(entry.repaymentAmount).format('0,0.00[0000]') }} repaid
          </strong>
          <strong v-else class="text-slate-500">Repayment unavailable</strong>
          <span class="text-sm text-slate-400">
            {{ entry.blockTime ? dayjs(entry.blockTime).format('MMM D, YYYY') : `Block ${entry.blockNumber}` }}
          </span>
        </div>
        <div v-else class="flex items-baseline gap-x-2">
          <strong v-if="liquidityState?.liabilityAfter !== undefined" class="text-slate-700">
            {{ argonSymbol }}{{ microgonToArgonNm(liquidityState.liabilityAfter).format('0,0.00') }}
          </strong>
          <strong v-else class="text-slate-500">Amount unavailable</strong>
          <span v-if="liquidityChangePercent !== undefined" class="text-sm text-slate-400">
            <template v-if="entry.kind === 'paydown'">
              ({{ numeral(liquidityChangePercent).format(Math.abs(liquidityChangePercent) < 10 ? '0,0.[0]' : '0,0') }}%)
            </template>
            <template v-else>
              ({{ liquidityChangePercent > 0 ? '+' : '' }}{{ numeral(liquidityChangePercent).format('0,0.[00]') }}%)
            </template>
          </span>
          <span class="text-sm text-slate-400">
            {{ entry.blockTime ? dayjs(entry.blockTime).format('MMM D, YYYY') : `Block ${entry.blockNumber}` }}
          </span>
        </div>
        <div
          v-if="entry.kind !== 'closed' && entry.kind !== 'paydown' && entry.affectedFissionCount < totalFissionCount"
          class="mt-0.5 text-sm text-slate-500"
        >
          {{ entry.affectedFissionCount }} of {{ totalFissionCount }} locked Bitcoin allocations
        </div>
      </div>

      <div v-if="entry.kind === 'closed'" class="text-right text-sm font-normal text-slate-500">
        <template v-if="entry.transactionFee !== undefined">
          {{ argonSymbol }}{{ microgonToArgonNm(entry.transactionFee).format('0,0.00[0000]') }} fees
        </template>
        <template v-else>Fees unavailable</template>
      </div>
      <HoverCardRoot
        v-else
        :open="props.detailsMode === 'hover' ? undefined : false"
        :openDelay="150"
        :closeDelay="150"
      >
        <HoverCardTrigger as-child>
          <button
            class="cursor-pointer text-right text-sm focus:outline-none"
            :aria-expanded="props.detailsMode === 'inline' ? inlineDetailsOpen : undefined"
            @click="props.detailsMode === 'inline' && (inlineDetailsOpen = !inlineDetailsOpen)"
          >
            <div class="flex justify-end gap-x-2 font-semibold">
              <span v-if="entry.kind === 'paydown'" class="text-argon-700">
                <template v-if="entry.paydown.repaymentState?.liquidityRepaid !== undefined">
                  −{{ argonSymbol
                  }}{{ microgonToArgonNm(entry.paydown.repaymentState.liquidityRepaid).format('0,0.00') }}
                  paydown
                </template>
                <template v-else>Paydown unavailable</template>
              </span>
              <template v-else>
                <span v-if="entry.kind !== 'created' && entry.liquidityUnlocked">
                  <span class="text-argon-700">
                    +{{ argonSymbol }}{{ microgonToArgonNm(entry.liquidityUnlocked).format('0,0.00') }} unlocked
                  </span>
                </span>
                <span v-if="entry.pocketed">
                  <span class="text-argon-700">
                    {{ argonSymbol }}{{ microgonToArgonNm(entry.pocketed).format('0,0.00') }} pocketed
                  </span>
                </span>
                <span
                  v-if="entry.kind !== 'created' && (entry.liquidityUnlocked || entry.pocketed)"
                  class="text-slate-400"
                >
                  &middot;
                </span>
                <span class="font-normal text-slate-500">
                  <template v-if="entry.actionFees !== undefined">
                    {{ argonSymbol }}{{ microgonToArgonNm(entry.actionFees).format('0,0.00') }} fees
                  </template>
                  <template v-else>Fees unavailable</template>
                </span>
              </template>
              <ChevronDownIcon
                v-if="props.detailsMode === 'inline'"
                class="size-4 self-center text-slate-400 transition-transform"
                :class="inlineDetailsOpen ? 'rotate-180' : ''"
              />
            </div>
          </button>
        </HoverCardTrigger>
        <HoverCardPortal>
          <HoverCardContent
            side="top"
            align="end"
            :sideOffset="8"
            :collisionPadding="24"
            :style="zIndex === undefined ? undefined : { zIndex }"
            class="w-96 rounded-md border border-gray-800/20 bg-white px-5 py-4 text-left text-sm text-slate-600 shadow-xl"
          >
            <BitcoinLiquidHistoryDetails :entry="entry" showHeading />
            <HoverCardArrow :width="24" :height="12" class="-mt-px fill-white stroke-gray-400/30" />
          </HoverCardContent>
        </HoverCardPortal>
      </HoverCardRoot>
    </div>

    <div
      v-if="entry.kind !== 'closed' && props.detailsMode === 'inline' && inlineDetailsOpen"
      class="border-argon-600/25 mt-3 border-l-2 bg-slate-50 px-4 py-3 text-sm text-slate-600"
    >
      <BitcoinLiquidHistoryDetails :entry="entry" inline />
    </div>

    <p v-if="entry.kind === 'closed'" class="mt-1 text-sm text-slate-500">
      <template v-if="entry.totalCloseCost !== undefined">
        Total close cost was {{ argonSymbol }}{{ microgonToArgonNm(entry.totalCloseCost).format('0,0.00[0000]') }},
        including transaction fees.
      </template>
      <template v-else>This Liquid closed; its total close cost is unavailable.</template>
    </p>
    <p v-else-if="entry.kind === 'paydown'" class="mt-1 text-sm text-slate-500">
      <template v-if="entry.paydown.buy.liquidRepaymentEvent">Stabilizer Buy paid down this Liquid.</template>
      <template v-else>Pending Stabilizer Buy paydown.</template>
      <button
        v-if="entry.paydown.buy.admissionFrame !== undefined"
        type="button"
        class="text-argon-600 ml-1 cursor-pointer hover:underline"
        @click="emit('viewPaydown', entry.paydown.buy.admissionFrame)"
      >
        <template v-if="entry.paydown.buy.liquidRepaymentEvent">View Paydown &raquo;</template>
        <template v-else>View Pending Paydown &raquo;</template>
      </button>
    </p>
    <p v-else-if="entry.kind === 'created'" class="mt-1 text-sm text-slate-500">
      This Liquid opened at the initial Bitcoin price target.
      <template v-if="entry.liquidityPending">
        {{ argonSymbol }}{{ microgonToArgonNm(entry.liquidityPending).format('0,0.00') }} is still minting.
      </template>
    </p>
    <p v-else-if="entry.liquidityUnlocked && entry.pocketed" class="mt-1 text-sm text-slate-500">
      Some locked Bitcoin unlocked more liquidity while other allocations reset to the lower floor.
    </p>
    <p v-else-if="entry.liquidityUnlocked" class="mt-1 text-sm text-slate-500">
      Bitcoin's higher price unlocked more liquidity; the Liquid amount increased by
      {{ argonSymbol }}{{ microgonToArgonNm(entry.liabilityAfter - entry.liabilityBefore).format('0,0.00') }}.
    </p>
    <p v-else-if="entry.pocketed" class="mt-1 text-sm text-slate-500">
      The lower floor made {{ argonSymbol }}{{ microgonToArgonNm(entry.pocketed).format('0,0.00') }} yours to keep and
      restored room for a future upward ratchet.
    </p>
  </article>
</template>

<script lang="ts">
import type { useMarketStabilizers } from '../stores/marketStabilizers.ts';
import type { BitcoinLiquidHistoryRowEntry } from '../lib/BitcoinLiquid.ts';

export type BitcoinLiquidPaydownHistoryEntry = {
  kind: 'paydown';
  key: string;
  blockNumber: number;
  blockTime?: Date;
  confirmsAt?: Date;
  paydown: ReturnType<typeof useMarketStabilizers>['liquidPaydowns'][number];
};
export type BitcoinLiquidActivity = BitcoinLiquidHistoryRowEntry | BitcoinLiquidPaydownHistoryEntry;
</script>

<script setup lang="ts">
import { getPercent, UnitOfMeasurement } from '@argonprotocol/apps-core';
import { ChevronDownIcon } from '@heroicons/vue/24/outline';
import dayjs from 'dayjs';
import { HoverCardArrow, HoverCardContent, HoverCardPortal, HoverCardRoot, HoverCardTrigger } from 'reka-ui';
import * as Vue from 'vue';

import numeral, { createNumeralHelpers } from '../lib/numeral.ts';
import { getCurrency } from '../stores/currency.ts';
import BitcoinLiquidHistoryDetails from './BitcoinLiquidHistoryDetails.vue';

const props = withDefaults(
  defineProps<{
    entry: BitcoinLiquidActivity;
    totalFissionCount: number;
    zIndex?: number;
    detailsMode?: 'hover' | 'inline';
  }>(),
  { detailsMode: 'hover' },
);
const emit = defineEmits<{ viewPaydown: [admissionFrame: number] }>();

const currency = getCurrency();
const { microgonToArgonNm } = createNumeralHelpers(currency);
const argonSymbol = currency.recordsByKey[UnitOfMeasurement.ARGN].symbol;
const inlineDetailsOpen = Vue.ref(false);
const liquidityState = Vue.computed(() => {
  if (props.entry.kind === 'closed') return;
  if (props.entry.kind === 'paydown') return props.entry.paydown.repaymentState;
  return props.entry;
});
const liquidityChangePercent = Vue.computed(() => {
  const state = liquidityState.value;
  if (props.entry.kind === 'created' || !state?.liabilityBefore || state.liabilityAfter === undefined) return;

  return getPercent(state.liabilityAfter - state.liabilityBefore, state.liabilityBefore);
});
</script>
