<template>
  <div v-if="isVisible">
    <slot />
  </div>
</template>

<script setup lang="ts">
import * as Vue from 'vue';

const props = defineProps<{
  run: () => Promise<any>;
}>();

const data = Vue.ref<any & { isNotFound?: boolean }>({});
const error = Vue.ref<Error | null>(null);
const isSuccess = Vue.ref(false);
const isFailure = Vue.ref(false);
const isVisible = Vue.ref(false);
const isRunning = Vue.ref(false);
const isNotFound = Vue.computed(() => data.value.isNotFound === true && (isSuccess.value || isFailure.value));

let childIsCompletePromise: Promise<void> | null = null;

// Function to register child components
const registerChild = (promise: Promise<void>) => (childIsCompletePromise = promise);
const unregisterChild = () => (childIsCompletePromise = null);

async function run() {
  const start = Date.now();
  try {
    isVisible.value = true;
    isRunning.value = true;
    try {
      data.value = (await props.run()) || {};
    } finally {
      const elapsed = Date.now() - start;
      if (elapsed < 2000) {
        // Ensure minimum visible time for better UX
        await new Promise(resolve => setTimeout(resolve, 2000 - elapsed));
      }
    }
    await childIsCompletePromise;
    isSuccess.value = true;
  } catch (e: any) {
    console.error('Diagnostic step failed', e);
    error.value = e;
    isFailure.value = true;
  }
  isRunning.value = false;
  return isSuccess.value;
}

defineExpose({ run });

// Provide status and error to child components
Vue.provide('diagnosticData', data);
Vue.provide('diagnosticError', error);
Vue.provide('diagnosticIsSuccess', isSuccess);
Vue.provide('diagnosticIsFailure', isFailure);
Vue.provide('diagnosticIsRunning', isRunning);
Vue.provide('diagnosticIsNotFound', isNotFound);

// Provide registration functions to child components
Vue.provide('registerDiagnosticChild', registerChild);
Vue.provide('unregisterDiagnosticChild', unregisterChild);
</script>
