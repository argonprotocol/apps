<template>
  <ul v-if="props.tokens.length">
    <li
      v-for="token in props.tokens"
      :key="token.symbol"
      class="flex flex-row gap-x-2 border-b border-slate-400/50 py-2"
    >
      <component :is="getTokenLogo(token)" class="h-6 w-6" />
      <div class="grow">{{ otherTokenNm(token).format('0,0.[000000]') }} {{ token.symbol }}</div>
      <div>{{ currency.symbol }}{{ otherTokenToMoneyNm(token).format('0,0.00') }}</div>
    </li>
  </ul>
</template>

<script setup lang="ts">
import * as Vue from 'vue';
import { getCurrency } from '../../stores/currency.ts';
import { createNumeralHelpers } from '../../lib/numeral.ts';
import type { IOtherToken } from '../../lib/Wallet.ts';
import EthIcon from '../../assets/wallets/tokens/ethereum.svg?component';
import UsdcIcon from '../../assets/wallets/tokens/usdc.svg?component';

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

function getTokenLogo(token: IOtherToken) {
  if (token.symbol === 'ETH') {
    return Vue.markRaw(EthIcon);
  } else if (token.symbol === 'USDC') {
    return Vue.markRaw(UsdcIcon);
  }
}
</script>
