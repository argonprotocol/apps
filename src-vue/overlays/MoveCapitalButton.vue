<!-- prettier-ignore -->
<template>
  <PopoverRoot v-model:open="isOpen">
    <PopoverTrigger :asChild="true">
      <slot>
        <button :class="twMerge('border-argon-600/50 text-argon-600/80 cursor-pointer rounded border px-3 font-bold', props.class)">
          Move
        </button>
      </slot>
    </PopoverTrigger>
    <PopoverPortal>
      <PopoverContent
        :sideOffset="-5"
        :side="props.side"
        class="border-argon-600/30 z-50 min-w-md rounded-md border bg-white px-6 py-4 text-sm font-medium text-gray-700 shadow-2xl"
      >
        <MoveCapitalCore
          :isOpen="isOpen"
          :class="props.class"
          :moveFrom="moveFrom"
          :moveTo="moveTo"
          :moveToken="moveToken"
          @close="close"
        />
        <PopoverArrow :width="26" :height="12" class="stroke-argon-600/15 -mt-px fill-white" />
      </PopoverContent>
    </PopoverPortal>
  </PopoverRoot>
</template>

<script setup lang="ts">
import * as Vue from 'vue';
import { twMerge } from 'tailwind-merge';
import { PopoverArrow, PopoverContent, PopoverPortal, PopoverRoot, PopoverTrigger } from 'reka-ui';
import MoveCapitalCore from './move-capital/MoveCapitalCore.vue';
import { MoveFrom, MoveTo, MoveToken } from '@argonprotocol/apps-core';

const props = withDefaults(
  defineProps<{
    class?: string;
    moveFrom?: MoveFrom;
    moveTo?: MoveTo;
    moveToken?: MoveToken;
    side?: 'top' | 'right' | 'bottom' | 'left';
  }>(),
  {
    moveFrom: MoveFrom.MiningHold,
  },
);

const emit = defineEmits<{
  (e: 'updatedOpen', value: boolean): void;
}>();

const isOpen = Vue.ref(false);

function close() {
  isOpen.value = false;
}

Vue.watch(isOpen, (value: boolean) => {
  emit('updatedOpen', value);
});
</script>
