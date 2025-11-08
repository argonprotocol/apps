<!-- prettier-ignore -->
<template>
  <slot :hours="hours" :minutes="minutes" :seconds="seconds" :days="days"></slot>
</template>

<script setup lang="ts">
import * as Vue from 'vue';
import dayjs, { type Dayjs } from 'dayjs';

const props = defineProps<{
  time: Dayjs;
}>();

const emit = defineEmits<{
  (e: 'update:tick', time: number): void;
}>();

const hours = Vue.ref(0);
const minutes = Vue.ref(0);
const seconds = Vue.ref(0);
const days = Vue.ref(0);

function updateTime() {
  const now = dayjs.utc();
  if (props.time < now) {
    hours.value = 0;
    minutes.value = 0;
    seconds.value = 0;
    days.value = 0;
    emit('update:tick', 0);
    return;
  }

  let remaining = now;
  const totalDays = props.time.diff(now, 'days');
  if (totalDays > 0) {
    days.value = totalDays;
    remaining = props.time.subtract(totalDays, 'days');
  } else {
    days.value = 0;
  }

  const totalSeconds = props.time.diff(remaining, 'seconds');
  hours.value = Math.floor(totalSeconds / 3600);
  minutes.value = Math.floor((totalSeconds % 3600) / 60);
  seconds.value = totalSeconds % 60;

  emit('update:tick', totalSeconds);

  if (totalSeconds > 0) {
    setTimeout(updateTime, 1000);
  }
}
Vue.watch(
  () => props.time,
  () => {
    updateTime();
  },
);
Vue.onMounted(updateTime);
</script>
