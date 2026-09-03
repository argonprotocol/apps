<template>
  <article class="border-t border-slate-200 py-3 first:border-t-0">
    <div class="flex items-start gap-x-5">
      <div class="min-w-0 grow">
        <div v-if="entry.kind === 'closed'" class="flex items-baseline gap-x-2">
          <strong v-if="entry.repaymentAmount !== undefined" class="text-slate-700">
            {{ argonSymbol }}{{ microgonToArgonNm(entry.repaymentAmount).format('0,0.00') }} repaid
          </strong>
          <strong v-else class="text-slate-500">Repayment unavailable</strong>
          <span class="text-sm text-slate-400">
            {{ entry.blockTime ? dayjs(entry.blockTime).format('MMM D, YYYY') : `Block ${entry.blockNumber}` }}
          </span>
        </div>
        <div v-else class="flex items-baseline gap-x-2">
          <strong class="text-slate-700">
            {{ argonSymbol }}{{ microgonToArgonNm(entry.liabilityAfter).format('0,0.00') }}
          </strong>
          <span v-if="liquidityChangePercent !== undefined" class="text-sm text-slate-400">
            ({{ liquidityChangePercent > 0 ? '+' : '' }}{{ numeral(liquidityChangePercent).format('0,0.[00]') }}%)
          </span>
          <span class="text-sm text-slate-400">
            {{ entry.blockTime ? dayjs(entry.blockTime).format('MMM D, YYYY') : `Block ${entry.blockNumber}` }}
          </span>
        </div>
        <div
          v-if="entry.kind !== 'closed' && entry.affectedFissionCount < totalFissionCount"
          class="mt-0.5 text-sm text-slate-500"
        >
          {{ entry.affectedFissionCount }} of {{ totalFissionCount }} locked Bitcoin allocations
        </div>
      </div>

      <div v-if="entry.kind === 'closed'" class="text-right text-sm font-normal text-slate-500">
        <template v-if="entry.transactionFee !== undefined">
          {{ argonSymbol }}{{ microgonToArgonNm(entry.transactionFee).format('0,0.00') }} fees
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
        Total close cost was {{ argonSymbol }}{{ microgonToArgonNm(entry.totalCloseCost).format('0,0.00') }}, including
        transaction fees.
      </template>
      <template v-else>This Liquid closed; its total close cost is unavailable.</template>
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

<script setup lang="ts">
import { UnitOfMeasurement } from '@argonprotocol/apps-core';
import { ChevronDownIcon } from '@heroicons/vue/24/outline';
import dayjs from 'dayjs';
import { HoverCardArrow, HoverCardContent, HoverCardPortal, HoverCardRoot, HoverCardTrigger } from 'reka-ui';
import * as Vue from 'vue';

import type { BitcoinLiquidHistoryRowEntry } from '../lib/BitcoinLiquid.ts';
import numeral, { createNumeralHelpers } from '../lib/numeral.ts';
import { getCurrency } from '../stores/currency.ts';
import BitcoinLiquidHistoryDetails from './BitcoinLiquidHistoryDetails.vue';

const props = withDefaults(
  defineProps<{
    entry: BitcoinLiquidHistoryRowEntry;
    totalFissionCount: number;
    zIndex?: number;
    detailsMode?: 'hover' | 'inline';
  }>(),
  { detailsMode: 'hover' },
);

const currency = getCurrency();
const { microgonToArgonNm } = createNumeralHelpers(currency);
const argonSymbol = currency.recordsByKey[UnitOfMeasurement.ARGN].symbol;
const inlineDetailsOpen = Vue.ref(false);
const liquidityChangePercent = Vue.computed(() => {
  if (props.entry.kind === 'closed' || props.entry.kind === 'created' || !props.entry.liabilityBefore) return;

  return (
    Number(((props.entry.liabilityAfter - props.entry.liabilityBefore) * 10_000n) / props.entry.liabilityBefore) / 100
  );
});
</script>
