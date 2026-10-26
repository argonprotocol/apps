<template>
  <span :title="uncappedPercentTitle">
    <template v-if="percent !== undefined">
      {{
        numeral(percent).formatIfElseCapped(
          Math.abs(percent) < 100,
          Math.abs(percent) < 10 ? '0,0.[00]' : '0,0.[0]',
          '0,0',
          9_999,
        )
      }}%
    </template>
    <template v-else>--</template>
    <template v-if="showLabel">{{ ` ${selectedMetric}` }}</template>
  </span>
</template>

<script setup lang="ts">
import * as Vue from 'vue';
import { getConfig } from '../stores/config.ts';
import numeral from '../lib/numeral.ts';
import type { IFinancialReturnSummary } from '../interfaces/IFinancialPosition.ts';
import type { IConfig } from '../interfaces/IConfig.ts';

const props = withDefaults(
  defineProps<{
    returns?: Pick<IFinancialReturnSummary, 'percent' | 'apr' | 'apy'>;
    showLabel?: boolean;
    metric?: IConfig['returnMetric'];
  }>(),
  { showLabel: true },
);

const config = getConfig();
const selectedMetric = Vue.computed(() => props.metric ?? config.returnMetric);
const percent = Vue.computed(() => {
  if (selectedMetric.value === 'APR') return props.returns?.apr;
  if (selectedMetric.value === 'APY') return props.returns?.apy;
  return props.returns?.percent;
});

const uncappedPercentTitle = Vue.computed(() => {
  const value = percent.value;
  if (value === undefined || !Number.isFinite(value)) return undefined;
  if (value <= 9_999) return undefined;

  if (value >= 1e21) return `${value}%`;
  return `${value.toLocaleString('en-US', { maximumFractionDigits: 0 })}%`;
});
</script>
