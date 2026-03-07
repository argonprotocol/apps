<!-- prettier-ignore -->
<template>
  <div>
    <div v-if="!isOpen && !controller.hideBonusTip && config.bootstrapDetails" class="z-50 absolute top-6 right-[46px] pt-[12px]">
      <MenuArrow
        class="absolute top-0 right-6"
        :width="24"
        :height="14"
        fill="white"
      />
      <MenuArrow
        class="absolute top-0 right-6"
        :width="24"
        :height="14"
        fill="color-mix(in oklab, var(--color-argon-600) 5%, transparent)"
      />
      <div class="bg-white border border-argon-400/50 rounded shadow-xl pt-0.5 pl-0.5">
        <div class="relative bg-argon-600/5 w-108 rounded px-5 pb-5 pt-3" style="text-shadow: 1px 1px 0 white">
          <div class="flex items-center justify-between border-b border-argon-300/20 pb-2 mb-2">
            <div class="font-bold text-argon-600 text-xl">Collect Your Treasury Bonus</div>
            <button
              @click="controller.hideBonusTip = true"
              class="cursor-pointer rounded-full p-1 text-argon-600/70 hover:bg-white/70 hover:text-argon-800"
              aria-label="Close tooltip"
            >
              <XMarkIcon class="h-5 w-5 stroke-[2.5]" />
            </button>
          </div>
          <p class="text-argon-600 mt-1">
            A bonus of ₳500 has been set aside in Argon's Treasury for your benefit. It will be released once your account
            becomes fully operational. Open the menu above to learn more.
          </p>
        </div>
      </div>
    </div>
    <div ref="rootRef" @mouseenter="onMouseEnter" @mouseleave="onMouseLeave">
      <DropdownMenuRoot :openDelay="0" :closeDelay="0" class="relative pointer-events-auto" v-model:open="isOpen">
        <DropdownMenuTrigger
          Trigger
          class="flex flex-row items-center justify-center text-[16.5px] font-semibold font-mono overflow-hidden text-argon-600/70 cursor-pointer border rounded-md hover:bg-slate-400/10 h-[30px] focus:outline-none hover:border-slate-400/50"
          :class="[isOpen ? 'border-slate-400/60 bg-slate-400/10' : 'border-slate-400/50']"
        >
          <div class="relative flex flex-row items-center pl-2.5 pr-3 pt-px">
            <RocketIcon class="h-[17px] relative top-[2px] mr-[5px] -rotate-45" aria-hidden="true" />
            1/6
          </div>
        </DropdownMenuTrigger>

        <DropdownMenuPortal>
          <DropdownMenuContent
            @mouseenter="onMouseEnter"
            @mouseleave="onMouseLeave"
            @pointerDownOutside="clickOutside"
            :align="'end'"
            :alignOffset="0"
            :sideOffset="-3"
            class="data-[side=bottom]:animate-slideUpAndFade data-[side=right]:animate-slideLeftAndFade data-[side=left]:animate-slideRightAndFade data-[side=top]:animate-slideDownAndFad z-50 data-[state=open]:transition-all"
          >
            <div class="relative">
              <div class="w-fit bg-argon-menu-bg flex shrink flex-col rounded p-1 text-gray-900 shadow-lg ring-1 ring-gray-900/20">
                <div class="max-w-160 pt-4 pb-2">
                  <p class="font-light px-5 ">
                    Complete the following six steps, and you'll earn
                    (along with your sponsor) a ₳500 bonus from the Argon Treasury.
                  </p>
                  <ul class="flex flex-col mt-3 mb-1 text-base font-semibold divide-y divide-slate-600/15 whitespace-nowrap">
                    <li
                      v-for="[stepId, step] of Object.entries(operationalSteps)"
                      @click="openOverlay(stepId as OperationalStepId, $event)"
                      class="flex flex-row items-center gap-x-2 py-3 pl-5 pr-2 cursor-pointer"
                      :class="controller.isCertificationStepUnlocked(stepId as OperationalStepId) ? 'hover:bg-argon-600/5' : 'bg-slate-50/80 text-slate-500'"
                    >
                      <Spinner v-if="controller.activeGuideId === stepId" />
                      <Checkbox v-else :size="7" :isChecked="controller.isCertificationStepComplete(stepId as OperationalStepId)" />
                      <span class="grow">{{ step.title }}</span>
                      <span
                        v-if="controller.getCertificationBlocker(stepId as OperationalStepId)"
                        class="rounded-full border border-slate-300 bg-white px-2 py-1 text-xs font-medium text-slate-500"
                      >
                        Requires: {{ controller.getCertificationBlocker(stepId as OperationalStepId)?.title }}
                      </span>
                      <a :href="step.documentationLink" target="_blank" class="px-3 text-right text-argon-600 font-light hover:bg-white hover:text-argon-700! rounded-full">Open Docs</a>
                    </li>
                  </ul>
                  <div class="pt-4 pb-2 px-5 border-t border-slate-500/30">
                    <a href="https://argon.network/docs/operator-certification" target="_blank" class="text-argon-600 hover:text-argon-700! font-light">
                      Learn more about the Argon's Operator Certification.
                    </a>
                  </div>
                </div>
              </div>
            </div>
            <DropdownMenuArrow :width="18" :height="10" class="mt-[0px] fill-white stroke-gray-300" />
          </DropdownMenuContent>
        </DropdownMenuPortal>
      </DropdownMenuRoot>
    </div>
  </div>
</template>

<script setup lang="ts">
import * as Vue from 'vue';
import {
  DropdownMenuArrow,
  DropdownMenuContent,
  DropdownMenuPortal,
  DropdownMenuRoot,
  DropdownMenuTrigger,
  PointerDownOutsideEvent,
} from 'reka-ui';
import { XMarkIcon } from '@heroicons/vue/24/outline';
import RocketIcon from '../assets/rocket.svg?component';
import basicEmitter from '../emitters/basicEmitter';
import dayjs from 'dayjs';
import utc from 'dayjs/plugin/utc';
import relativeTime from 'dayjs/plugin/relativeTime';
import { getConfig } from '../stores/config.ts';
import Checkbox from '../components/Checkbox.vue';
import MenuArrow from '../components/MenuArrow.vue';
import { useOperationsController, operationalSteps, OperationalStepId } from '../stores/operationsController.ts';
import Spinner from '../components/Spinner.vue';

dayjs.extend(relativeTime);
dayjs.extend(utc);

const config = getConfig();
const controller = useOperationsController();

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

function openOverlay(stepId: OperationalStepId, event: MouseEvent) {
  const clickTarget = event.target;
  if (clickTarget instanceof HTMLElement && clickTarget.closest('a')) {
    return;
  }

  openOperationalOverlay(stepId);
}

function openOperationalOverlay(stepId: OperationalStepId) {
  isOpen.value = false;
  controller.hideBonusTip = true;
  basicEmitter.emit('openOperationalOverlay', stepId);
}
</script>

<style scoped>
@reference "../main.css";

[data-reka-collection-item] {
  @apply cursor-pointer pr-3 text-right focus:outline-none;

  &[data-disabled] {
    opacity: 0.3;
    pointer-events: none;
  }
  [ItemWrapper] {
    @apply font-bold whitespace-nowrap text-gray-900;
  }
}
</style>
