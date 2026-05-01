<template>
  <ul :class="minimizedLines ? '' : 'border-b border-slate-400/50'">
    <li
      :class="[minimizedLines ? '' : 'border-t', showArrows ? 'pr-14' : '']"
      class="relative flex flex-row gap-x-2 border-slate-400/50 py-2"
    >
      <ArgonIcon class="h-6 w-6" />
      <div class="grow">{{ microgonToArgonNm(props.microgons).format('0,0.[00]') }} ARGN</div>
      <div>{{ currency.symbol }}{{ microgonToMoneyNm(props.microgons).format('0,0.00') }}</div>
      <div v-if="showArrows" class="absolute top-1/2 -right-6 h-10 -translate-y-1/2 cursor-pointer">
        <div class="absolute top-0 left-0 h-full w-9/12 bg-gradient-to-r from-white to-transparent" />
        <div class="text-argon-600 absolute top-1/2 right-4 -translate-y-1/2 text-sm font-bold">MOVE</div>
        <MoveArrow class="h-full" />
      </div>
    </li>
    <li :class="[showArrows ? 'pr-14' : '']" class="relative flex flex-row gap-x-2 border-t border-slate-400/50 py-2">
      <ArgonotIcon class="h-6 w-6" />
      <div class="grow">{{ micronotToArgonotNm(props.micronots).format('0,0.[00]') }} ARGNOT</div>
      <div>{{ currency.symbol }}{{ micronotToMoneyNm(props.micronots).format('0,0.00') }}</div>
      <div v-if="showArrows" class="absolute top-1/2 -right-6 h-10 -translate-y-1/2 cursor-pointer">
        <div class="absolute top-0 left-0 h-full w-9/12 bg-gradient-to-r from-white to-transparent" />
        <div class="text-argon-600 absolute top-1/2 right-4 -translate-y-1/2 text-sm font-bold">MOVE</div>
        <MoveArrow class="h-full" />
      </div>
    </li>
  </ul>
</template>
<script setup lang="ts">
import ArgonotIcon from '../../../assets/resources/argonot.svg';
import ArgonIcon from '../../../assets/resources/argon.svg';
import { createNumeralHelpers } from '../../../lib/numeral.ts';
import { getCurrency } from '../../../stores/currency.ts';
import MoveArrow from '../../../assets/move-arrow.svg';

const currency = getCurrency();

const { microgonToMoneyNm, microgonToArgonNm, micronotToMoneyNm, micronotToArgonotNm } = createNumeralHelpers(currency);

const props = withDefaults(
  defineProps<{
    microgons?: bigint;
    micronots?: bigint;
    minimizedLines?: boolean;
    showArrows?: boolean;
  }>(),
  {
    microgons: () => 0n,
    micronots: () => 0n,
    showArrows: false,
  },
);
</script>
