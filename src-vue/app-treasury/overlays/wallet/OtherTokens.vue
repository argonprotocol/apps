<template>
  <ul v-if="props.tokens.length">
    <li
      v-for="token in props.tokens"
      :key="token.symbol"
      class="flex flex-row gap-x-2 border-t border-slate-400/50 py-2"
    >
      <div class="grow">{{ token.formatted }} {{ token.symbol }}</div>
      <div>{{ currency.symbol }}0.00</div>
    </li>
  </ul>
</template>

<script setup lang="ts">
import * as Vue from 'vue';
import type { Address } from 'viem';
import { getCurrency } from '../../../stores/currency.ts';

const currency = getCurrency();

type OtherToken = {
  symbol: string;
  address: Address | null;
  formatted: string;
  raw: bigint;
};

const props = withDefaults(
  defineProps<{
    tokens?: OtherToken[];
  }>(),
  {
    tokens: () => [],
  },
);
</script>
