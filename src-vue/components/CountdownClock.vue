<!-- prettier-ignore -->
<template>
  <slot :hours="hours" :minutes="minutes" :seconds="seconds" :days="days" :isFinished="isFinished"></slot>
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

const isFinished = Vue.ref(false);
const hours = Vue.ref(0);
const minutes = Vue.ref(0);
const seconds = Vue.ref(0);
const days = Vue.ref(0);
let timeoutId: ReturnType<typeof setTimeout> | null = null;

function clearTimer() {
  if (timeoutId) {
    clearTimeout(timeoutId);
    timeoutId = null;
  }
}

function updateTime() {
  clearTimer();
  const now = dayjs.utc();
  if (props.time < now) {
    hours.value = 0;
    minutes.value = 0;
    seconds.value = 0;
    days.value = 0;
    isFinished.value = true;
    emit('update:tick', 0);
    return;
  }

  isFinished.value = false;
  const totalDays = props.time.diff(now, 'days');
  days.value = totalDays > 0 ? totalDays : 0;

  const totalSeconds = props.time.diff(now, 'seconds') - totalDays * 86400;
  hours.value = Math.floor(totalSeconds / 3600);
  minutes.value = Math.floor((totalSeconds % 3600) / 60);
  seconds.value = totalSeconds % 60;

  emit('update:tick', totalSeconds);

  if (totalSeconds > 0) {
    timeoutId = setTimeout(updateTime, 1000);
  } else {
    isFinished.value = true;
  }
}
Vue.watch(
  () => props.time,
  () => {
    clearTimer();
    updateTime();
  },
);
Vue.onMounted(updateTime);
Vue.onUnmounted(clearTimer);
</script>
