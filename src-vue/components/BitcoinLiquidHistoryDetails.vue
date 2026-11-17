<template>
  <h3 v-if="props.showHeading" class="border-b border-slate-200 pb-2 font-bold text-slate-700">
    <template v-if="entry.kind === 'paydown'">Liquid Paydown details</template>
    <template v-else>{{ entry.kind === 'created' ? 'Liquid creation' : 'Ratchet' }} details</template>
  </h3>
  <dl
    class="grid gap-x-6 gap-y-2"
    :class="[props.inline ? 'grid-cols-3' : 'grid-cols-[1fr_auto]', props.showHeading ? 'mt-3' : '']"
  >
    <template v-if="entry.kind === 'paydown'">
      <div :class="props.inline ? '' : 'contents'">
        <dt class="text-slate-500">Status</dt>
        <dd :class="props.inline ? 'mt-0.5 font-semibold text-slate-700' : 'text-right'">
          <template v-if="entry.paydown.buy.liquidRepaymentEvent">Confirmed</template>
          <template v-else>Pending estimate</template>
        </dd>
      </div>
      <div :class="props.inline ? '' : 'contents'">
        <dt class="text-slate-500">ARGN applied</dt>
        <dd :class="props.inline ? 'mt-0.5 font-semibold text-slate-700' : 'text-right'">
          <template v-if="entry.paydown.buy.liquidRepaymentEvent">
            {{ argonSymbol
            }}{{ microgonToArgonNm(entry.paydown.buy.liquidRepaymentEvent.microgonsBurned).format('0,0.00') }}
          </template>
          <template v-else-if="entry.paydown.estimate">
            {{ argonSymbol }}{{ microgonToArgonNm(entry.paydown.estimate.burnedMicrogons).format('0,0.00') }}
          </template>
          <template v-else>Unavailable</template>
        </dd>
      </div>
      <div :class="props.inline ? '' : 'contents'">
        <dt class="text-slate-500">ARGN to your wallet</dt>
        <dd :class="props.inline ? 'mt-0.5 font-semibold text-slate-700' : 'text-right'">
          <template v-if="entry.paydown.buy.liquidRepaymentEvent && entry.paydown.buy.releasedPrincipal !== undefined">
            {{ argonSymbol }}{{ microgonToArgonNm(entry.paydown.buy.releasedPrincipal).format('0,0.00') }}
          </template>
          <template v-else-if="!entry.paydown.buy.liquidRepaymentEvent && entry.paydown.estimate">
            {{ argonSymbol }}{{ microgonToArgonNm(entry.paydown.estimate.returnedMicrogons).format('0,0.00') }}
          </template>
          <template v-else>Unavailable</template>
        </dd>
      </div>
      <div :class="props.inline ? '' : 'contents'">
        <dt class="text-slate-500">BTC to your wallet</dt>
        <dd :class="props.inline ? 'mt-0.5 font-semibold text-slate-700' : 'text-right'">
          <template v-if="entry.paydown.returnedSatoshis !== undefined">
            {{ satToBtcNm(entry.paydown.returnedSatoshis).format('0,0.[00000000]') }} BTC
          </template>
          <template
            v-else-if="!entry.paydown.buy.liquidRepaymentEvent && entry.paydown.estimate?.repaidSatoshis !== undefined"
          >
            {{ satToBtcNm(entry.paydown.estimate.repaidSatoshis).format('0,0.[00000000]') }} BTC
          </template>
          <template v-else>Unavailable</template>
        </dd>
      </div>
      <div v-if="!entry.paydown.buy.liquidRepaymentEvent && entry.confirmsAt" :class="props.inline ? '' : 'contents'">
        <dt class="text-slate-500">Confirmation</dt>
        <dd :class="props.inline ? 'mt-0.5 font-semibold text-slate-700' : 'text-right'">
          {{ dayjs(entry.confirmsAt).format('MMM D, YYYY') }}
        </dd>
      </div>
    </template>
    <template v-else>
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
            {{ argonSymbol }}{{ microgonToArgonNm(entry.transactionFee).format('0,0.00[0000]') }}
          </template>
          <template v-else>Unavailable</template>
        </dd>
      </div>
      <div :class="props.inline ? '' : 'contents'">
        <dt class="text-slate-500">Securitization fee</dt>
        <dd :class="props.inline ? 'mt-0.5 font-semibold text-slate-700' : 'text-right'">
          <template v-if="entry.securityFee !== undefined">
            {{ argonSymbol }}{{ microgonToArgonNm(entry.securityFee).format('0,0.00') }}
          </template>
          <template v-else>Unavailable</template>
        </dd>
      </div>
    </template>
  </dl>
</template>

<script setup lang="ts">
import { UnitOfMeasurement } from '@argonprotocol/apps-core';
import dayjs from 'dayjs';

import type { IBitcoinLiquidHistoryEntry } from '../lib/BitcoinLiquid.ts';
import type { BitcoinLiquidPaydownHistoryEntry } from './BitcoinLiquidHistoryRow.vue';
import { createNumeralHelpers } from '../lib/numeral.ts';
import { getCurrency } from '../stores/currency.ts';

const props = withDefaults(
  defineProps<{
    entry: IBitcoinLiquidHistoryEntry | BitcoinLiquidPaydownHistoryEntry;
    inline?: boolean;
    showHeading?: boolean;
  }>(),
  { inline: false, showHeading: false },
);

const currency = getCurrency();
const { microgonToArgonNm, satToBtcNm } = createNumeralHelpers(currency);
const argonSymbol = currency.recordsByKey[UnitOfMeasurement.ARGN].symbol;
</script>
