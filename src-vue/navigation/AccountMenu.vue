<template>
  <div ref="rootRef" @mouseenter="onMouseEnter" @mouseleave="onMouseLeave">
    <DropdownMenuRoot :openDelay="0" :closeDelay="0" class="pointer-events-auto relative" v-model:open="isOpen">
      <DropdownMenuTrigger
        Trigger
        class="text-argon-600/60 flex h-[30px] w-[38px] cursor-pointer flex-row items-center justify-center rounded-md border text-sm/6 font-semibold hover:border-slate-400/50 hover:bg-slate-400/10 focus:outline-none"
        :class="[isOpen ? 'border-slate-400/60 bg-slate-400/10' : 'border-slate-400/50']">
        <ConfigIcon class="h-5 w-5" />
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
            <DropdownMenuItem @click="() => openAboutOverlay()" class="pt-1 pb-2">
              <header>About This App</header>
            </DropdownMenuItem>
            <DropdownMenuSeparator divider class="my-1 h-[1px] w-full bg-slate-400/30" />
            <DropdownMenuItem @click="() => openFinancialsOverlay()" class="py-2">
              <header>Financials Panel</header>
            </DropdownMenuItem>
            <DropdownMenuSeparator divider class="my-1 h-[1px] w-full bg-slate-400/30" />
            <DropdownMenuItem @click="() => openSecuritySettingsOverlay()" class="py-2">
              <header>Security and Recovery</header>
            </DropdownMenuItem>
            <DropdownMenuSeparator divider class="my-1 h-[1px] w-full bg-slate-400/30" />
            <DropdownMenuItem @click="() => openComplianceOverlay()" class="py-2">
              <header>Jurisdictional Compliance</header>
            </DropdownMenuItem>
            <DropdownMenuSeparator divider class="my-1 h-[1px] w-full bg-slate-400/30" />
            <DropdownMenuSub>
              <DropdownMenuSubTrigger class="relative py-2">
                <ChevronLeftIcon class="absolute top-1/2 left-0.5 h-5 w-5 -translate-y-1/2 text-gray-400" />
                <header>Help Options</header>
              </DropdownMenuSubTrigger>
              <DropdownMenuSubContent class="relative -top-1 min-w-50">
                <div
                  class="bg-argon-menu-bg flex shrink flex-col rounded p-1 text-sm/6 font-semibold text-gray-900 shadow-lg ring-1 ring-gray-900/20">
                  <DropdownMenuItem class="py-2" @click="() => openTroubleshooting()">
                    <header>Troubleshooting</header>
                  </DropdownMenuItem>
                  <DropdownMenuSeparator divider class="my-1 h-[1px] w-full bg-slate-400/30" />
                  <DropdownMenuItem class="py-2" @click="() => void openLink('https://argon.network/docs')">
                    <header>Documentation</header>
                  </DropdownMenuItem>
                  <DropdownMenuItem class="py-2" @click="() => void openLink('https://argon.network/faq')">
                    <header>Frequently Asked Questions</header>
                  </DropdownMenuItem>
                  <DropdownMenuItem class="py-2" @click="() => takeTheTour()" :disabled="tour.isDisabled">
                    <header>Take the Welcome Tour</header>
                  </DropdownMenuItem>
                  <DropdownMenuSeparator divider class="my-1 h-[1px] w-full bg-slate-400/30" />
                  <DropdownMenuItem class="py-2" @click="() => void openLink('https://discord.gg/xDwwDgCYr9')">
                    <header>Discord User Community</header>
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    class="py-2"
                    @click="() => void openLink('https://github.com/argonprotocol/apps/issues')">
                    <header>GitHub Developer Community</header>
                  </DropdownMenuItem>
                  <DropdownMenuSeparator divider class="my-1 h-[1px] w-full bg-slate-400/30" />
                  <DropdownMenuItem class="py-2" @click="() => checkForUpdates()">
                    <header>Check for Updates</header>
                  </DropdownMenuItem>
                </div>
              </DropdownMenuSubContent>
            </DropdownMenuSub>
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
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubTrigger,
  DropdownMenuSubContent,
  DropdownMenuPortal,
  DropdownMenuRoot,
  DropdownMenuTrigger,
  PointerDownOutsideEvent,
} from 'reka-ui';
import ConfigIcon from '../assets/config.svg?component';
import basicEmitter from '../emitters/basicEmitter';
import { ChevronLeftIcon } from '@heroicons/vue/24/outline';
import { useTour } from '../stores/tour';
import { open as tauriOpenUrl } from '@tauri-apps/plugin-shell';

const tour = useTour();

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

function openLink(url: string) {
  void tauriOpenUrl(url);
  isOpen.value = false;
}

function checkForUpdates() {
  basicEmitter.emit('openCheckForAppUpdatesOverlay');
  isOpen.value = false;
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

function openSecuritySettingsOverlay() {
  basicEmitter.emit('openSecuritySettingsOverlay');
  isOpen.value = false;
}

function openFinancialsOverlay() {
  basicEmitter.emit('openFinancialsOverlay');
  isOpen.value = false;
}

function openAboutOverlay() {
  basicEmitter.emit('openAboutOverlay');
  isOpen.value = false;
}

function openComplianceOverlay() {
  basicEmitter.emit('openComplianceOverlay');
  isOpen.value = false;
}

function openTroubleshooting() {
  basicEmitter.emit('openTroubleshootingOverlay', { screen: 'overview' });
  isOpen.value = false;
}

function takeTheTour() {
  tour.start();
  isOpen.value = false;
}
</script>

<style scoped>
@reference "../main.css";

[data-reka-collection-item] {
  @apply focus:bg-argon-menu-hover cursor-pointer px-4 focus:outline-none;

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
