<template>
  <InputNumber
    v-bind="$attrs"
    format="number"
    :prefix="prefix"
    :dragBy="dragBy"
    :dragByMin="dragByMin"
    :disabled="props.disabled"
    :min="min"
    :max="max"
    :minDecimals="props.minDecimals"
    :maxDecimals="props.maxDecimals"
    :options="props.options"
    :model-value="modelValue"
    @update:model-value="handleUpdate" />
</template>

<script setup lang="ts">
import * as Vue from 'vue';
import BigNumber from 'bignumber.js';
import { useCurrency } from '../stores/currency';
import InputNumber from './InputNumber.vue';
import { bigNumberToBigInt, MICROGONS_PER_ARGON } from '@argonprotocol/apps-core';

const currency = useCurrency();

const props = withDefaults(
  defineProps<{
    modelValue: bigint;
    max?: bigint;
    min?: bigint;
    options?: any[];
    dragBy?: bigint;
    dragByMin?: bigint;
    disabled?: boolean;
    minDecimals?: number;
    maxDecimals?: number;
    prefix?: string;
  }>(),
  {
    options: () => [],
    dragBy: () => 1n * BigInt(MICROGONS_PER_ARGON),
    dragByMin: () => BigInt(Math.floor(0.01 * MICROGONS_PER_ARGON)),
    disabled: false,
    minDecimals: 2,
    maxDecimals: 2,
    prefix: '',
  },
);

const prefix = Vue.computed(() => {
  return (props.prefix || '') + currency.symbol;
});

const modelValue = Vue.computed(() => {
  return BigNumber(props.modelValue).dividedBy(MICROGONS_PER_ARGON).toNumber();
});

const min = Vue.computed<number | undefined>(() => {
  if (props.min === undefined) return undefined;
  return BigNumber(props.min).dividedBy(MICROGONS_PER_ARGON).toNumber();
});

const max = Vue.computed<number | undefined>(() => {
  if (props.max === undefined) return undefined;
  return BigNumber(props.max).dividedBy(MICROGONS_PER_ARGON).toNumber();
});

const dragBy = Vue.computed<number | undefined>(() => {
  if (!props.dragBy) return undefined;
  return BigNumber(props.dragBy).dividedBy(MICROGONS_PER_ARGON).toNumber();
});

const dragByMin = Vue.computed<number | undefined>(() => {
  if (!props.dragByMin) return undefined;
  return BigNumber(props.dragByMin).dividedBy(MICROGONS_PER_ARGON).toNumber();
});

const emit = defineEmits(['update:modelValue']);

const handleUpdate = (value: number) => {
  const valueBn = BigNumber(value).multipliedBy(MICROGONS_PER_ARGON);
  emit('update:modelValue', bigNumberToBigInt(valueBn));
};
</script>
