<template>
  <div class="relative flex h-screen w-screen cursor-default flex-col overflow-hidden">
    <div
      class="pointer-events-none absolute top-2 right-3 z-50 rounded-full border px-2.5 py-1 text-xs font-semibold shadow-sm"
      :class="
        interactive
          ? 'border-emerald-500/40 bg-emerald-50 text-emerald-800'
          : 'border-slate-400/40 bg-white/90 text-slate-600'
      "
    >
      {{ interactive ? 'Interactive scenario' : 'Fixed state preview' }}
    </div>
    <div inert>
      <TopBar />
    </div>
    <div class="flex min-h-0 grow flex-row gap-x-2 overflow-scroll pt-2 pb-2 pl-2">
      <div inert class="flex">
        <LeftBar />
      </div>
      <main :inert="!interactive" class="relative flex min-h-0 grow flex-col overflow-hidden">
        <div class="flex min-h-0 grow flex-col overflow-x-hidden overflow-y-auto">
          <slot />
        </div>
      </main>
    </div>
  </div>
</template>

<script setup lang="ts">
import LeftBar from '../../src-vue/navigation/LeftBar.vue';
import TopBar from '../../src-vue/navigation/TopBar.vue';

defineProps<{
  interactive?: boolean;
}>();
</script>

<style scoped>
[inert] :deep(a),
[inert] :deep(button),
[inert] :deep(.cursor-pointer) {
  cursor: default !important;
}
</style>
