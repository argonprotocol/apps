<template>
  <RuntimeCompatibilityScreen v-if="shouldShowCompatibilityScreen" />
  <AppTreasury v-else-if="IS_TREASURY_APP" />
  <AppOperations v-else />
</template>

<script setup lang="ts">
import { storeToRefs } from 'pinia';
import AppTreasury from './app-treasury/App.vue';
import AppOperations from './app-operations/App.vue';
import RuntimeCompatibilityScreen from './app-shared/screens/RuntimeCompatibilityScreen.vue';
import { IS_TREASURY_APP } from './lib/Env.ts';
import { useAppUpdater } from './stores/appUpdater.ts';
import { useRuntimeCompatibility } from './stores/runtimeCompatibility.ts';

const updater = useAppUpdater();
const runtimeCompatibility = useRuntimeCompatibility();
const { shouldShowCompatibilityScreen } = storeToRefs(runtimeCompatibility);

updater.start();
runtimeCompatibility.start();
</script>
