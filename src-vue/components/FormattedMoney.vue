<!-- prettier-ignore -->
<template>
  {{ integer }}.<span :class="[isLoaded ? 'opacity-40' : '']">{{ decimal }}</span>
</template>

<script setup lang="ts">
import * as Vue from 'vue';
import { getCurrency } from '../stores/currency.ts';
import { createNumeralHelpers } from '../lib/numeral.ts';
import { UnitOfMeasurement } from '@argonprotocol/apps-core';

const props = withDefaults(
  defineProps<{
    isLoaded?: boolean;
    unitOfMeasurement?: UnitOfMeasurement;
    value: bigint;
  }>(),
  {
    isLoaded: true,
  },
);

const currency = getCurrency();

const { microgonToMoneyNm, satToMoneyNm } = createNumeralHelpers(currency);

const integer = Vue.computed(() => {
  if (!props.isLoaded) return '--';

  const value = convertToMoney(props.value);
  return value.split('.')[0];
});

const decimal = Vue.computed(() => {
  if (!props.isLoaded) return '--';

  const value = convertToMoney(props.value);
  return value.split('.')[1];
});

function convertToMoney(value: bigint): string {
  if (props.unitOfMeasurement === UnitOfMeasurement.Satoshi) {
    return satToMoneyNm(value).format('0,0.00');
  } else {
    return microgonToMoneyNm(value).format('0,0.00');
  }
}
</script>
