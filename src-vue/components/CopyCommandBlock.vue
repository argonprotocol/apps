<template>
  <CopyToClipboard :content="content" class="relative mb-4">
    <textarea
      class="w-full resize-none rounded-md border border-slate-300 bg-white py-3 pr-8 pl-3 font-mono text-xs whitespace-pre focus:outline-none"
      readonly
      :rows="rows"
      >{{ content }}</textarea
    >
    <div class="pointer-events-none absolute top-3 right-3 text-xs text-slate-500">Click to copy</div>
    <template #copied>
      <div class="text-argon-700 absolute top-3 right-3 text-xs font-semibold">Copied</div>
    </template>
  </CopyToClipboard>
</template>

<script setup lang="ts">
import CopyToClipboard from './CopyToClipboard.vue';

const { content, rows } = withDefaults(
  defineProps<{
    content: string;
    rows?: number;
  }>(),
  {
    rows: 6,
  },
);
</script>
