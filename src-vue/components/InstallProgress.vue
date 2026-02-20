<!-- prettier-ignore -->
<template>
  <div class="Component InstallProgress flex flex-col grow relative h-full">
    <ul class="flex flex-col grow relative h-full">
      <template v-for="(stepLabel, index) in stepLabels" :key="stepLabel.key">
        <InstallProgressStep
          :stepLabel="stepLabel"
          :stepIndex="index"
          :stepsCount="stepLabels.length"
          :isCompact="isCompact"
          :class="index ? '' : 'border-t-transparent'"
        />
      </template>
    </ul>
  </div>
</template>

<script setup lang="ts">
import { stepLabels } from '../lib/InstallerStep';
import InstallProgressStep from './InstallProgressStep.vue';

const props = defineProps<{
  isCompact?: boolean;
}>();
</script>

<style>
@reference "../main.css";
</style>
