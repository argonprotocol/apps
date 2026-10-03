<template>
  <div class="pl-2">
    <p class="text-md leading-7">
      ARGN can be purchased through decentralized exchanges like Uniswap on Ethereum. You'll need to add
      {{ microgonToArgonNm(props.minimumTransferMicrogons).format('0,0.[000000]') }} ARGN to your wallet to complete the
      Treasury certification steps.
    </p>
    <p class="text-md mt-4 leading-7">
      When you start this task, we'll guide you to connect your Ethereum wallet and transfer ARGN into your Internal App
      Wallet.
    </p>
  </div>
</template>

<script setup lang="ts">
import { createNumeralHelpers } from '../../lib/numeral.ts';
import { getCurrency } from '../../stores/currency.ts';

const props = defineProps<{ minimumTransferMicrogons: bigint }>();
const { microgonToArgonNm } = createNumeralHelpers(getCurrency());
</script>
