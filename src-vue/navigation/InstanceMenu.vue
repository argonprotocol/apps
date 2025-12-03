<!-- prettier-ignore -->
<template>
  <div ref="rootRef" class="inline-block relative pointer-events-auto" @mouseenter="onMouseEnter" @mouseleave="onMouseLeave">
    <DropdownMenuRoot :openDelay="0" :closeDelay="0" v-model:open="isOpen">
      <DropdownMenuTrigger
        Trigger
        class="font-light inline-block text-md border border-slate-600/30 rounded-md text-slate-800/80 px-3 py-px ml-1 focus:outline-none"
        :class="[isOpen ? 'border-slate-400/60 bg-slate-400/10' : 'border-slate-400/50']"
      >
        <template v-if="networkName !== 'mainnet'">{{ networkName }}:</template>{{ INSTANCE_NAME?.slice(0, 10) }}<template v-if="INSTANCE_NAME.length > 10">...</template>
      </DropdownMenuTrigger>

      <DropdownMenuPortal>
        <DropdownMenuContent
          @mouseenter="onMouseEnter"
          @mouseleave="onMouseLeave"
          @pointerDownOutside="clickOutside"
          :align="'start'"
          :alignOffset="0"
          :sideOffset="-3"
          class="z-50 data-[side=bottom]:animate-slideUpAndFade data-[side=right]:animate-slideLeftAndFade data-[side=left]:animate-slideRightAndFade data-[side=top]:animate-slideDownAndFad data-[state=open]:transition-all"
        >
          <div class="min-w-40 bg-argon-menu-bg flex shrink flex-col rounded p-1 text-sm/6 font-semibold text-gray-900 shadow-lg ring-1 ring-gray-900/20">
            <template v-for="instance in props.instances" :key="instance.name">
              <DropdownMenuItem @click="() => openInstance(instance)" class="flex flex-row py-2 items-center">
                <div ItemWrapper>{{ instance.name }}</div>
                <span v-if="instance.isSelected">
                  <CheckIcon class="size-5" aria-hidden="true" />
                </span>
              </DropdownMenuItem>
              <DropdownMenuSeparator divider class="my-1 h-[1px] w-full bg-slate-400/30" />
            </template>
          </div>

          <DropdownMenuArrow :width="18" :height="10" class="mt-[0px] fill-white stroke-gray-300" />
        </DropdownMenuContent>
      </DropdownMenuPortal>
    </DropdownMenuRoot>
  </div>
</template>

<script lang="ts">
export interface IInstance {
  name: string;
  isSelected: boolean;
}
</script>

<script setup lang="ts">
import * as Vue from 'vue';
import {
  DropdownMenuArrow,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuPortal,
  DropdownMenuRoot,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  PointerDownOutsideEvent,
} from 'reka-ui';
import { INSTANCE_NAME, NETWORK_NAME } from '../lib/Env.ts';
import { invokeWithTimeout } from '../lib/tauriApi.ts';
import { useConfig } from '../stores/config.ts';
import { CheckIcon } from '@heroicons/vue/20/solid';

const config = useConfig();

const isOpen = Vue.ref(false);
const rootRef = Vue.ref<HTMLElement>();

const props = defineProps<{
  instances: IInstance[];
}>();

// Expose the root element to parent components
defineExpose({
  $el: rootRef,
});

const networkName = NETWORK_NAME.replace('dev-docker', 'docknet');

let mouseLeaveTimeoutId: ReturnType<typeof setTimeout> | undefined = undefined;

function onMouseEnter() {
  if (mouseLeaveTimeoutId) {
    clearTimeout(mouseLeaveTimeoutId);
  }
  mouseLeaveTimeoutId = undefined;
  if (props.instances.length === 1) return;

  isOpen.value = true;
}

function onMouseLeave() {
  if (mouseLeaveTimeoutId) {
    clearTimeout(mouseLeaveTimeoutId);
  }
  mouseLeaveTimeoutId = setTimeout(() => {
    isOpen.value = false;
  }, 100);
}

function clickOutside(e: PointerDownOutsideEvent) {
  const isChildOfTrigger = !!(e.target as HTMLElement)?.closest('[Trigger]');
  if (!isChildOfTrigger) return;
  if (props.instances.length === 1) return;

  isOpen.value = true;
  setTimeout(() => {
    isOpen.value = true;
  }, 200);
  e.detail.originalEvent.stopPropagation();
  e.detail.originalEvent.preventDefault();
  e.stopPropagation();
  e.preventDefault();
  return false;
}

async function openInstance(instance: IInstance) {
  await config.save();
  await invokeWithTimeout('load_instance', { name: instance.name }, 10000);
  isOpen.value = false;
}
</script>

<style scoped>
@reference "../main.css";

[data-reka-collection-item] {
  @apply focus:bg-argon-menu-hover cursor-pointer px-3 focus:!text-indigo-600 focus:outline-none;

  &[data-disabled] {
    opacity: 0.3;
    pointer-events: none;
  }
  [ItemWrapper] {
    @apply grow text-left font-bold whitespace-nowrap text-gray-900;
  }
}

[divider]:last-child {
  display: none;
}
</style>
