<template>
  <div ref="rootRef" @mouseenter="onMouseEnter" @mouseleave="onMouseLeave">
    <DropdownMenuRoot :openDelay="0" :closeDelay="0" class="pointer-events-auto relative" v-model:open="isOpen">
      <DropdownMenuTrigger
        Trigger
        class="text-argon-600/60 flex h-[30px] cursor-pointer flex-row items-center justify-center rounded-md border px-2 text-base font-bold hover:border-slate-400/50 hover:bg-slate-400/10 focus:outline-none"
        :class="[isOpen ? 'border-slate-400/60 bg-slate-400/10' : 'border-slate-400/50']">
        {{ currency?.record?.key || 'ARGN' }}
      </DropdownMenuTrigger>

      <DropdownMenuPortal>
        <DropdownMenuContent
          @mouseenter="onMouseEnter"
          @mouseleave="onMouseLeave"
          @pointerDownOutside="clickOutside"
          :align="'end'"
          :alignOffset="0"
          :sideOffset="-3"
          class="data-[side=bottom]:animate-slideUpAndFade data-[side=right]:animate-slideLeftAndFade data-[side=left]:animate-slideRightAndFade data-[side=top]:animate-slideDownAndFad z-50 data-[state=open]:transition-all">
          <div
            class="bg-argon-menu-bg flex shrink flex-col rounded p-1 text-sm/6 font-semibold text-gray-900 shadow-lg ring-1 ring-gray-900/20">
            <DropdownMenuItem
              v-for="(record, key) of currency?.recordsByKey"
              :key="key"
              @click="setCurrencyKey(key)"
              :class="currency?.record?.key === key ? '!text-argon-500' : '!text-slate-700'"
              class="group/item hover:!text-argon-600 hover:bg-argon-menu-hover relative flex cursor-pointer flex-row items-center justify-between border-b border-slate-400/30 py-3 pr-1 pl-10 font-bold text-gray-900 last:border-b-0">
              <span v-if="currency?.record?.key === key" class="absolute top-1/2 left-3 -translate-y-1/2">
                <CheckIcon class="size-5" aria-hidden="true" />
              </span>
              <span
                ItemWrapper
                :class="currency?.record?.key === key ? 'opacity-100' : 'opacity-80'"
                class="grow text-right group-hover/item:opacity-100">
                {{ record.name }} ({{ record.key }})
              </span>
              <span class="w-8 text-center" v-html="record.symbol" />
            </DropdownMenuItem>
          </div>
          <DropdownMenuArrow :width="18" :height="10" class="mt-[0px] fill-white stroke-gray-300" />
        </DropdownMenuContent>
      </DropdownMenuPortal>
    </DropdownMenuRoot>
  </div>
</template>

<script setup lang="ts">
import * as Vue from 'vue';
import {
  DropdownMenuArrow,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuPortal,
  DropdownMenuRoot,
  DropdownMenuTrigger,
  PointerDownOutsideEvent,
} from 'reka-ui';
import basicEmitter from '../emitters/basicEmitter';
import { getConfig } from '../stores/config.ts';
import { ICurrencyKey, ICurrencyRecord, UnitOfMeasurement } from '../lib/Currency';
import { CheckIcon } from '@heroicons/vue/20/solid';
import { getCurrency } from '../stores/currency.ts';

const config = getConfig();
const currency = getCurrency();

const isOpen = Vue.ref(false);
const rootRef = Vue.ref<HTMLElement>();

// Expose the root element to parent components
defineExpose({
  $el: rootRef,
});

let mouseLeaveTimeoutId: ReturnType<typeof setTimeout> | undefined = undefined;

function onMouseEnter() {
  if (mouseLeaveTimeoutId) {
    clearTimeout(mouseLeaveTimeoutId);
  }
  mouseLeaveTimeoutId = undefined;
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

function setCurrencyKey(key: ICurrencyKey) {
  if (key === UnitOfMeasurement.ARGN || config.isValidJurisdiction) {
    currency.setKey(key);
  } else {
    basicEmitter.emit('openComplianceOverlay');
  }
}

function clickOutside(e: PointerDownOutsideEvent) {
  const isChildOfTrigger = !!(e.target as HTMLElement)?.closest('[Trigger]');
  if (!isChildOfTrigger) return;

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
</script>

<style scoped>
@reference "../main.css";

[data-reka-collection-item] {
  @apply focus:bg-argon-menu-hover cursor-pointer focus:outline-none;

  &[data-disabled] {
    opacity: 0.3;
    pointer-events: none;
  }
  header {
    @apply text-right font-bold whitespace-nowrap text-gray-900;
  }
  p {
    @apply text-right font-light whitespace-nowrap text-gray-700;
    line-height: 1.4em;
  }
}
</style>
