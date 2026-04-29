<template>
  <div
    v-if="isFailure"
    class="diagnostic-step-failure font-md mt-1 cursor-text pr-10 font-light text-slate-800/50 select-auto"
  >
    <slot :error="error" />
  </div>
</template>

<script setup lang="ts">
import * as Vue from 'vue';

const error = Vue.inject('diagnosticError') as Vue.Ref<Error | null>;
const isFailure = Vue.inject('diagnosticIsFailure') as Vue.Ref<boolean>;
</script>
