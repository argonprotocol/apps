<!-- prettier-ignore -->
<template>
  <div class="X-AXIS COMPONENT text-sm text-slate-400 border-t border-slate-300 select-none">
    <ul Dates class="flex flex-row justify-around pt-0.5 text-center whitespace-nowrap mb-1">
      <li v-for="month in months" :key="month" class="border-l border-slate-300" :style="`width: ${lengthWidth}%`">
        {{ month }}
      </li>
    </ul>
  </div>
</template>

<script lang="ts">
import dayjs from 'dayjs';
import utc from 'dayjs/plugin/utc';

dayjs.extend(utc);

const currentMonthIndex = dayjs.utc().month(); // Returns 0-11 (0 = January, 11 = December)
const months = Array.from({ length: 12 }, (_, i) => {
  const monthIndex = (currentMonthIndex + i - 10) % 12;
  return getMonthAbbr(monthIndex < 0 ? monthIndex + 12 : monthIndex);
});

export const startDate = dayjs.utc().subtract(11, 'month').startOf('month');
export const endDate = dayjs.utc().add(1, 'month').endOf('month');

function getMonthAbbr(index: number): string {
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return months[index];
}
</script>

<script setup lang="ts">
import * as Vue from 'vue';

let lengths = 12;
let lengthWidth = 100 / lengths;
</script>

<style lang="scss">
.X-AXIS.COMPONENT {
  li::selection {
    color: rgb(148 163 184);
    background: white;
  }
  ul[Dates] li:first-child {
    border-left: none;
  }
}
</style>
