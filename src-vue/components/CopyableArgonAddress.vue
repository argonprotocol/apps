<template>
  <span class="inline-flex max-w-full min-w-0 items-center gap-x-1.5">
    <span :title="address" class="min-w-0 truncate font-mono select-all">
      {{ address }}
    </span>
    <CopyToClipboard
      :content="address"
      class="relative flex h-5 w-5 shrink-0 cursor-pointer items-center justify-center rounded text-slate-400 hover:bg-slate-200/70 hover:text-slate-600"
      title="Copy full Argon address"
    >
      <CopyIcon class="h-3.5 w-3.5" />
      <template #copying><CheckIcon class="h-3.5 w-3.5 text-green-600" /></template>
    </CopyToClipboard>
  </span>
</template>

<script setup lang="ts">
import { CheckIcon } from '@heroicons/vue/24/outline';
import CopyIcon from '../assets/copy.svg';
import CopyToClipboard from './CopyToClipboard.vue';

defineProps<{ address: string }>();
</script>
