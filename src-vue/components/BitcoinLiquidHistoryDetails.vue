<template>
  <h3 v-if="props.showHeading" class="border-b border-slate-200 pb-2 font-bold text-slate-700">
    {{ entry.kind === 'created' ? 'Liquid creation' : 'Ratchet' }} details
  </h3>
  <dl
    class="grid gap-x-6 gap-y-2"
    :class="[props.inline ? 'grid-cols-3' : 'grid-cols-[1fr_auto]', props.showHeading ? 'mt-3' : '']"
  >
    <div :class="props.inline ? '' : 'contents'">
      <dt class="text-slate-500">Bitcoin price target</dt>
      <dd :class="props.inline ? 'mt-0.5 font-semibold text-slate-700' : 'text-right'">
        {{ argonSymbol }}{{ microgonToArgonNm(entry.microgonsAtTargetPerBtc).format('0,0.00') }}/BTC
      </dd>
    </div>
    <div v-if="entry.liquidityUnlocked" :class="props.inline ? '' : 'contents'">
      <dt class="text-slate-500">Liquidity unlocked</dt>
      <dd :class="props.inline ? 'mt-0.5 font-semibold text-slate-700' : 'text-right'">
        {{ argonSymbol }}{{ microgonToArgonNm(entry.liquidityUnlocked).format('0,0.00') }}
      </dd>
    </div>
    <div v-if="entry.liquidityPending" :class="props.inline ? '' : 'contents'">
      <dt class="text-slate-500">Still minting</dt>
      <dd :class="props.inline ? 'mt-0.5 font-semibold text-slate-700' : 'text-right'">
        {{ argonSymbol }}{{ microgonToArgonNm(entry.liquidityPending).format('0,0.00') }}
      </dd>
    </div>
    <div v-if="entry.mintPending > entry.liquidityPending" :class="props.inline ? '' : 'contents'">
      <dt class="text-slate-500">Replacement still minting</dt>
      <dd :class="props.inline ? 'mt-0.5 font-semibold text-slate-700' : 'text-right'">
        {{ argonSymbol }}{{ microgonToArgonNm(entry.mintPending - entry.liquidityPending).format('0,0.00') }}
      </dd>
    </div>
    <div v-if="entry.pocketed" :class="props.inline ? '' : 'contents'">
      <dt class="text-slate-500">Pocketed</dt>
      <dd :class="props.inline ? 'mt-0.5 font-semibold text-slate-700' : 'text-right'">
        {{ argonSymbol }}{{ microgonToArgonNm(entry.pocketed).format('0,0.00') }}
      </dd>
    </div>
    <div v-if="entry.recycled" :class="props.inline ? '' : 'contents'">
      <dt class="text-slate-500">Recycled through minting</dt>
      <dd :class="props.inline ? 'mt-0.5 font-semibold text-slate-700' : 'text-right'">
        {{ argonSymbol }}{{ microgonToArgonNm(entry.recycled).format('0,0.00') }}
      </dd>
    </div>
    <div :class="props.inline ? '' : 'contents'">
      <dt class="text-slate-500">Transaction fee</dt>
      <dd :class="props.inline ? 'mt-0.5 font-semibold text-slate-700' : 'text-right'">
        <template v-if="entry.transactionFee !== undefined">
          {{ argonSymbol }}{{ microgonToArgonNm(entry.transactionFee).format('0,0.00') }}
        </template>
        <template v-else>Unavailable</template>
      </dd>
    </div>
    <div :class="props.inline ? '' : 'contents'">
      <dt class="text-slate-500">Insurance fee</dt>
      <dd :class="props.inline ? 'mt-0.5 font-semibold text-slate-700' : 'text-right'">
        <template v-if="entry.securityFee !== undefined">
          {{ argonSymbol }}{{ microgonToArgonNm(entry.securityFee).format('0,0.00') }}
        </template>
        <template v-else>Unavailable</template>
      </dd>
    </div>
  </dl>
</template>

<script setup lang="ts">
import { UnitOfMeasurement } from '@argonprotocol/apps-core';

import type { IBitcoinLiquidHistoryEntry } from '../lib/BitcoinLiquid.ts';
import { createNumeralHelpers } from '../lib/numeral.ts';
import { getCurrency } from '../stores/currency.ts';

const props = withDefaults(
  defineProps<{
    entry: IBitcoinLiquidHistoryEntry;
    inline?: boolean;
    showHeading?: boolean;
  }>(),
  { inline: false, showHeading: false },
);

const currency = getCurrency();
const { microgonToArgonNm } = createNumeralHelpers(currency);
const argonSymbol = currency.recordsByKey[UnitOfMeasurement.ARGN].symbol;
</script>
