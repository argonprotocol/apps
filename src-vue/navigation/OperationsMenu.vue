<template>
  <div ref="rootRef" class="pointer-events-auto relative" @mouseenter="onMouseEnter" @mouseleave="onMouseLeave">
    <DropdownMenuRoot :openDelay="0" :closeDelay="0" v-model:open="isOpen">
      <DropdownMenuTrigger
        Trigger
        data-testid="OperationsMenu.open()"
        class="flex h-7 w-7 flex-row items-center justify-center rounded-md border hover:border-slate-400/50 hover:bg-slate-400/10 focus:outline-none"
        :class="[isOpen ? 'border-slate-400/60 bg-slate-400/10' : 'border-transparent']"
      >
        <ChevronDownIcon class="ml-1 w-4" />
      </DropdownMenuTrigger>

      <DropdownMenuPortal>
        <DropdownMenuContent
          @mouseenter="onMouseEnter"
          @mouseleave="onMouseLeave"
          @pointerDownOutside="clickOutside"
          :align="'end'"
          :alignOffset="-5"
          :sideOffset="-3"
          class="data-[side=bottom]:animate-slideUpAndFade data-[side=right]:animate-slideLeftAndFade data-[side=left]:animate-slideRightAndFade data-[side=top]:animate-slideDownAndFade z-[1000] data-[state=open]:transition-all"
        >
          <div
            class="bg-argon-menu-bg flex shrink flex-col rounded p-1 text-sm/6 font-semibold text-gray-900 shadow-lg ring-1 ring-gray-900/20"
          >
            <DropdownMenuItem
              data-testid="OperationsMenu.goto(OperationsTab.MiningOperations)"
              @click="goto(OperationsTab.MiningOperations)"
              class="py-2"
            >
              <header>Mining Operations</header>
            </DropdownMenuItem>
            <DropdownMenuSeparator divider class="my-1 h-[1px] w-full bg-slate-400/30" />
            <DropdownMenuItem
              data-testid="OperationsMenu.goto(OperationsTab.VaultingOperations)"
              @click="goto(OperationsTab.VaultingOperations)"
              class="py-2"
            >
              <header>Vaulting Operations</header>
            </DropdownMenuItem>
          </div>
          <DropdownMenuArrow :width="22" :height="12" class="mt-[0px] fill-white stroke-gray-300" />
        </DropdownMenuContent>
      </DropdownMenuPortal>
    </DropdownMenuRoot>
  </div>
</template>

<script setup lang="ts">
import * as Vue from 'vue';
import { ChevronDownIcon } from '@heroicons/vue/24/outline';
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
import { OperationsTab, useOperationsController } from '../stores/operationsController.ts';
import { getConfig } from '../stores/config.ts';
import { MiningSetupStatus, VaultingSetupStatus } from '../interfaces/IConfig.ts';

const isOpen = Vue.ref(false);

const controller = useOperationsController();
const config = getConfig();

function goto(tab: OperationsTab) {
  if (controller.backButtonTriggersHome) {
    controller.backButtonTriggersHome = false;
    if (tab === OperationsTab.MiningOperations) {
      config.miningSetupStatus = MiningSetupStatus.None;
    } else if (tab === OperationsTab.VaultingOperations) {
      config.vaultingSetupStatus = VaultingSetupStatus.None;
    }
  }
  controller.setScreenKey(tab);
}

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
  @apply cursor-pointer focus:outline-none;

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

[MenuItem] {
  @apply hover:bg-argon-menu-hover focus:bg-argon-menu-hover block cursor-pointer rounded px-4 py-2 text-right focus:outline-none;
}
</style>
