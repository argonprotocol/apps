<template>
  <div
    v-if="isSuccess"
    class="diagnostic-step-success font-md mt-1 cursor-text pr-10 font-light text-slate-800/50 select-auto">
    <slot :data="data" />
  </div>
</template>

<script setup lang="ts">
import * as Vue from 'vue';

const data = Vue.inject('diagnosticData') as Vue.Ref<any>;
const isSuccess = Vue.inject('diagnosticIsSuccess') as Vue.Ref<boolean>;
</script>
