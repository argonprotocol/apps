<template>
  <ul v-if="props.tokens.length">
    <li
      v-for="token in props.tokens"
      :key="token.symbol"
      class="flex flex-row gap-x-2 border-t border-slate-400/50 py-2"
    >
      <div class="grow">{{ otherTokenNm(token).format('0,0.[000000]') }} {{ token.symbol }}</div>
      <div>{{ currency.symbol }}{{ otherTokenToMoneyNm(token).format('0,0.00') }}</div>
    </li>
  </ul>
</template>

<script setup lang="ts">
import { getCurrency } from '../../../stores/currency.ts';
import { createNumeralHelpers } from '../../../lib/numeral.ts';
import type { IOtherToken } from '../../../lib/Wallet.ts';

const currency = getCurrency();

const { otherTokenNm, otherTokenToMoneyNm } = createNumeralHelpers(currency);

const props = withDefaults(
  defineProps<{
    tokens?: IOtherToken[];
  }>(),
  {
    tokens: () => [],
  },
);
</script>
