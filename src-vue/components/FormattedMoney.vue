<template>
  {{ integer }}.
  <span :class="[isLoaded ? 'opacity-40' : '']">{{ decimal }}</span>
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

const integer = Vue.ref('--');
const decimal = Vue.ref('--');

function convertToMoney(value: bigint): string {
  if (props.unitOfMeasurement === UnitOfMeasurement.Satoshi) {
    return satToMoneyNm(value).format('0,0.00');
  } else {
    return microgonToMoneyNm(value).format('0,0.00');
  }
}

Vue.watch(
  () => [props.isLoaded, props.value],
  () => {
    if (!props.isLoaded) return;

    const value = convertToMoney(props.value);
    const parts = value.split('.');
    integer.value = parts[0];
    decimal.value = parts[1];
  },
  { immediate: true },
);
</script>
