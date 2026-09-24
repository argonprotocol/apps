<!-- prettier-ignore -->
<template>
  {{ integer }}<template v-if="!isLoaded || decimals">.<span :class="[isLoaded ? 'opacity-40' : '']">{{ decimals }}</span></template>
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
    hideDecimalsWhenMoreThan?: number;
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

  const showDecimals = !props.hideDecimalsWhenMoreThan || props.value <= props.hideDecimalsWhenMoreThan;
  const money = convertToMoney(props.value, showDecimals);
  return money.split('.')[0];
});

const decimals = Vue.computed(() => {
  if (!props.isLoaded) return '--';

  const showDecimals = !props.hideDecimalsWhenMoreThan || props.value <= props.hideDecimalsWhenMoreThan;
  const money = convertToMoney(props.value, showDecimals);
  return money.split('.')[1];
});

function convertToMoney(value: bigint, showDecimals = false): string {
  const isSats = props.unitOfMeasurement === UnitOfMeasurement.Satoshi;
  const money = isSats ? satToMoneyNm(value) : microgonToMoneyNm(value);
  if (!showDecimals) money.set(Math.floor(money.value() ?? 0));
  return money.format(showDecimals ? '0,0.00' : '0,0');
}
</script>
