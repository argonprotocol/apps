<template>
  <section :data-testid="dataTestid" :class="[isLast ? '' : 'mb-3 border-b border-dashed border-slate-400/70 pb-3']">
    <div class="grid grid-cols-[2.75rem_minmax(0,1fr)_11rem] items-start gap-x-3">
      <div class="flex h-10 w-10 items-start justify-center pt-1">
        <slot name="icon" />
      </div>

      <div class="min-w-0 pt-0.5">
        <Tooltip v-if="tooltipContent" :asChild="true" :content="tooltipContent" side="top">
          <button type="button" class="min-w-0 cursor-help text-left">
            <div class="min-w-0 text-lg font-bold text-slate-800/85">
              {{ title }}
            </div>
          </button>
        </Tooltip>

        <div v-else class="min-w-0 text-lg font-bold text-slate-800/85">
          {{ title }}
        </div>

        <div v-if="$slots.subline" :class="sublineClass" class="text-sm leading-snug">
          <slot name="subline" />
        </div>
      </div>

      <div class="flex w-44 shrink-0 justify-end pt-0.5 pl-4">
        <button
          type="button"
          :disabled="buttonDisabled"
          :class="{ 'cursor-default opacity-70 hover:bg-white': buttonDisabled }"
          class="border-argon-700/25 text-argon-700/85 hover:bg-argon-50/80 w-full cursor-pointer rounded-md border bg-white px-4 py-2 text-sm font-bold"
          @click="emit('open')">
          {{ buttonLabel }}
        </button>
      </div>
    </div>
  </section>
</template>

<script setup lang="ts">
import * as Vue from 'vue';
import Tooltip from '../components/Tooltip.vue';

const props = withDefaults(
  defineProps<{
    title: string;
    buttonLabel: string;
    tooltipContent?: string;
    sublineClass?: string;
    buttonDisabled?: boolean;
    dataTestid?: string;
    isLast?: boolean;
  }>(),
  {
    tooltipContent: undefined,
    sublineClass: 'text-slate-500',
    buttonDisabled: false,
    dataTestid: undefined,
    isLast: false,
  },
);

const emit = defineEmits<{
  (e: 'open'): void;
}>();

const { title, buttonLabel, tooltipContent, sublineClass, buttonDisabled, dataTestid } = Vue.toRefs(props);
</script>

<style scoped>
@reference "../main.css";

[box] {
  @apply rounded-lg border border-slate-400/30 bg-white shadow;
}
</style>
