<template>
  <RuntimeCompatibilityScreen v-if="shouldShowCompatibilityScreen" />
  <CapitalApp v-else-if="IS_CAPITAL_APP" />
  <OperationsApp v-else />
</template>

<script setup lang="ts">
import { storeToRefs } from 'pinia';
import CapitalApp from './CapitalApp.vue';
import OperationsApp from './OperationsApp.vue';
import RuntimeCompatibilityScreen from './screens-shared/RuntimeCompatibilityScreen.vue';
import { IS_CAPITAL_APP } from './lib/Env.ts';
import { useAppUpdater } from './stores/appUpdater.ts';
import { useRuntimeCompatibility } from './stores/runtimeCompatibility.ts';

const updater = useAppUpdater();
const runtimeCompatibility = useRuntimeCompatibility();
const { shouldShowCompatibilityScreen } = storeToRefs(runtimeCompatibility);

updater.start();
runtimeCompatibility.start();
</script>
