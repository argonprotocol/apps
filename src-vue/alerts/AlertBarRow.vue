<!-- prettier-ignore -->
<template>
  <section
    :data-tone="tone"
    :data-testid="dataTestid"
    :class="rootClasses">
    <slot v-if="$slots.icon || showDefaultIcon" name="icon">
      <AlertIcon class="relative left-1 inline-block h-4 w-4 text-white" />
    </slot>

    <div class="grow min-w-0">
      <slot />
    </div>

    <div v-if="$slots.action" class="alert-action">
      <slot name="action" />
    </div>
  </section>
</template>

<script setup lang="ts">
import * as Vue from 'vue';
import AlertIcon from '../assets/alert.svg?component';

const props = withDefaults(
  defineProps<{
    tone: 'error' | 'warn' | 'info';
    dataTestid?: string;
    showDefaultIcon?: boolean;
  }>(),
  {
    dataTestid: undefined,
    showDefaultIcon: false,
  },
);

const rootClasses = Vue.computed(() => {
  const base = 'group flex flex-row items-center gap-x-3 border-b px-3.5 py-2 text-white';

  if (props.tone === 'error') {
    return `${base} border-argon-error-darkest bg-argon-error hover:bg-argon-error-darker`;
  }

  if (props.tone === 'info') {
    return `${base} border-lime-700 bg-lime-700/90 hover:bg-lime-700`;
  }

  return `${base} border-argon-700 bg-argon-500 hover:bg-argon-600`;
});
</script>

<style scoped>
@reference "../main.css";

section {
  box-shadow: inset 0 2px 2px rgba(0, 0, 0, 0.1);
}

.alert-action :deep(button) {
  @apply inline-block cursor-pointer rounded-full px-3 font-bold;
}

section[data-tone='error'] .alert-action :deep(button) {
  @apply bg-argon-error-darkest/60 group-hover:bg-argon-error-darkest text-white hover:bg-black/80;
}

section[data-tone='info'] .alert-action :deep(button) {
  @apply bg-lime-700/60 text-white group-hover:bg-lime-800 hover:bg-black/80;
}

section[data-tone='warn'] .alert-action :deep(button) {
  @apply bg-argon-700/60 group-hover:border-argon-700 text-white hover:bg-black/80;
}
</style>
