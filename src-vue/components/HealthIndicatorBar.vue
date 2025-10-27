<template>
  <div
    class="absolute -bottom-2 left-[calc(50%-0px)] flex h-[10px] w-8/12 -translate-x-1/2 translate-y-full flex-row items-center space-x-1 xl:left-[calc(50%-10px)]">
    <div
      v-for="i in 20"
      :key="i"
      class="hidden h-full w-1/20 min-w-1 rounded-full xl:block"
      :class="[i > maxFilled20 ? 'bg-slate-400/40' : colorFill]"></div>
    <div
      v-for="i in 10"
      :key="i"
      class="block h-full w-1/20 min-w-1 rounded-full xl:hidden"
      :class="[i > maxFilled20 ? 'bg-slate-400/40' : colorFill]"></div>
    <div :class="[props.percent < 100 ? 'text-slate-900/30' : 'text-slate-900/50']">
      {{ numeral(percent).format('0') }}%
    </div>
  </div>
</template>

<script setup lang="ts">
import * as Vue from 'vue';
import numeral from 'numeral';

const props = withDefaults(
  defineProps<{
    percent: number;
  }>(),
  {
    percent: 100,
  },
);
const colorTier = {
  high: 'bg-green-800/70',
  medium: 'bg-yellow-800/70',
  low: 'bg-red-800/70',
};
const maxFilled20 = Vue.ref(0);
const colorFill = Vue.ref(colorTier.high);

function updateFilled() {
  maxFilled20.value = Math.round((props.percent / 100) * 20);
  if (props.percent >= 90) {
    colorFill.value = colorTier.high;
  } else if (props.percent >= 50) {
    colorFill.value = colorTier.medium;
  } else {
    colorFill.value = colorTier.low;
  }
}
updateFilled();

Vue.onUpdated(updateFilled);
</script>
