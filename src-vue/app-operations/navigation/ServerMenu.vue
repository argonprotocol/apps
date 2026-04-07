<!-- prettier-ignore -->
<template>
  <div ref="rootRef" @mouseenter="onMouseEnter" @mouseleave="onMouseLeave">
    <DropdownMenuRoot :openDelay="0" :closeDelay="0" class="relative pointer-events-auto" v-model:open="isOpen">
      <DropdownMenuTrigger
        Trigger
        class="flex flex-row items-center justify-center font-mono text-[16.4px] font-semibold overflow-hidden text-argon-600/70 cursor-pointer border rounded-md hover:bg-slate-400/10 h-[30px] focus:outline-none hover:border-slate-400/50"
        :class="[isOpen ? 'border-slate-400/60 bg-slate-400/10' : 'border-slate-400/50']"
      >
        <div v-if="!config.isServerAdded" class="relative flex flex-row items-center pl-2.5 pr-3 pt-px" style="word-spacing: -6px">
          <PluginSmallIcon class="h-3.5 relative mr-1.5" />
          Add Node
        </div>
        <div v-else-if="config.isServerInstalling" class="relative -top-px flex flex-row pl-2.5 pr-3 pt-1">
          {{ config.isServerInstalled ? 'Updating' : 'Installing'}}
          <div class="relative ml-px">
            <span class="text-white">...</span>
            <span class="absolute top-0 left-0 h-full w-full text-left connecting-dots" aria-hidden="true">...</span>
          </div>
        </div>
        <div v-else-if="lastUpdatedAt" class="pl-2.5 pr-3 pt-px flex flex-row items-center">
          <CloudServerIcon class="h-4 relative mr-2" aria-hidden="true" />
          <CountupClock
            v-slot="{ hours, minutes, seconds, isNull }"
            :time="lastUpdatedAt"
            as="span"
            class="relative -top-px"
            style="word-spacing: -5px"
          >
            <template v-if="hours">{{ hours }}h, </template>
            <template v-if="minutes || hours">{{ minutes }}m{{ !isNull && !hours ? ', ' : '' }}</template>
            <template v-if="!isNull && !hours">{{ seconds }}s ago</template>
            <template v-else-if="isNull">-- ----</template>
          </CountupClock>
        </div>
        <div v-else class="relative -top-px flex flex-row pl-2.5 pr-3 pt-1">
          Connecting
          <div class="relative ml-px">
            <span class="text-white">...</span>
            <span class="absolute top-0 left-0 h-full w-full text-left connecting-dots" aria-hidden="true">...</span>
          </div>
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
          <div class="w-fit bg-argon-menu-bg flex shrink flex-col rounded p-1 text-sm/6 font-semibold text-gray-900 shadow-lg ring-1 ring-gray-900/20">
            <div v-if="!config.isServerAdded" class="w-80">
              <div class="flex flex-col px-3 font-light py-2 text-md">
                <div class="flex flex-row text-argon-600/50 items-center justify-center my-5">
                  <CloudServerOutlineIcon class="h-10 inline mr-1 " aria-hidden="true" />
                  <PluginIcon class="h-5 plugin-connecting mr-1" />
                  <DesktopIcon class="h-10 ml-1" />
                </div>
                <div class="text-center">You need your own Argon node before you can start mining or vaulting.</div>
              </div>
              <DropdownMenuItem v-if="IS_OPERATIONS_APP" class="pt-3! pb-2.5! px-2! focus:bg-transparent! cursor-default!">
                <button @click="openServerConnectPanel" class="text-base py-2 px-5 text-white bg-argon-600 border border-argon-700 hover:inner-button-shadow hover:bg-argon-700 rounded-md w-full cursor-pointer">
                  Connect a Cloud Machine
                </button>
              </DropdownMenuItem>
            </div>

            <DropdownMenuItem v-else-if="config.isServerInstalling" class="px-3 py-1 w-120 text-black/30 cursor-default!">
              <InstallProgress />
              <div class="border-t border-dashed border-slate-300 py-1">
                <button @click="openServerOverlay" class="mt-2 text-base py-1.5 px-5 text-white bg-argon-600 border border-argon-700 hover:inner-button-shadow hover:bg-argon-700 rounded-md w-full cursor-pointer">
                  Open Server Overlay
                </button>
              </div>
            </DropdownMenuItem>

            <div v-else-if="lastUpdatedAt">
              <DropdownMenuItem @click="openServerOverlay" class="group/item hover:!text-argon-600 hover:bg-argon-menu-hover flex flex-col cursor-pointer border-b border-slate-400/30 py-3 pr-1 pl-3 last:border-b-0">
                <div class="flex flex-row items-stretch px-5 text-center">
                  <div class="flex flex-col gap-x-2 whitespace-nowrap">
                    <div>Last Bitcoin Block</div>
                    <CountupClock as="span" :time="lastBitcoinActivityAt" v-slot="{ hours, minutes, seconds, isNull }" class="font-mono text-lg opacity-50">
                      <template v-if="hours">{{ hours }}h, </template>
                      <template v-if="minutes || hours">{{ minutes }}m{{ !isNull && !hours ? ', ' : '' }}</template>
                      <template v-if="!isNull && !hours">{{ seconds }}s ago</template>
                      <template v-else-if="isNull">-- ----</template>
                    </CountupClock>
                  </div>
                  <div class="w-px self-stretch bg-slate-500/30 mx-7"></div>
                  <div class="flex flex-col gap-x-2 whitespace-nowrap">
                    <div>Last Argon Block</div>
                    <CountupClock as="span" :time="lastArgonActivityAt" v-slot="{ hours, minutes, seconds, isNull }" class="font-mono text-lg opacity-50">
                      <template v-if="hours">{{ hours }}h, </template>
                      <template v-if="minutes || hours">{{ minutes }}m{{ !isNull && !hours ? ', ' : '' }}</template>
                      <template v-if="!isNull && !hours">{{ seconds }}s ago</template>
                      <template v-else-if="isNull">-- ----</template>
                    </CountupClock>
                  </div>
                </div>
                <button
                  type="button"
                  @click="openServerOverlay"
                  class="text-md py-2 px-5 mt-3 text-white bg-argon-600 border border-argon-700 hover:inner-button-shadow rounded-md w-full cursor-pointer"
                >
                  Open Cloud Machine
                </button>
              </DropdownMenuItem>
            </div>

            <div v-else class="min-w-80">
              <div class="flex flex-col font-light pt-7 pb-3 px-5 text-md whitespace-nowrap">
                <div class="flex flex-row text-argon-600/50 items-center justify-center mb-5">
                  <CloudServerOutlineIcon class="h-10 inline mr-1 plugin-connecting" aria-hidden="true" />
                  <PluginIcon class="h-5 plugin-connecting mr-1" />
                  <DesktopIcon class="h-10 ml-1 plugin-connecting" />
                </div>
                We are trying to connect to your cloud machine.
              </div>
            </div>
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
import CloudServerIcon from '../../assets/cloud-server.svg?component';
import CloudServerOutlineIcon from '../../assets/cloud-server-outline.svg?component';
import PluginIcon from '../../assets/plugin.svg?component';
import PluginSmallIcon from '../../assets/plugin-small.svg?component';
import DesktopIcon from '../../assets/desktop.svg?component';
import basicEmitter from '../../emitters/basicEmitter.ts';
import CountupClock from '../../components/CountupClock.vue';
import { getStats } from '../../stores/stats.ts';
import dayjs from 'dayjs';
import utc from 'dayjs/plugin/utc';
import relativeTime from 'dayjs/plugin/relativeTime';
import { IS_OPERATIONS_APP } from '../../lib/Env.ts';
import { getConfig } from '../../stores/config.ts';
import InstallProgress from '../../components/InstallProgress.vue';
import { InstallStepStatus } from '../../interfaces/IConfig.ts';
import { stepLabels } from '../../lib/InstallerStep.ts';
import numeral from '../../lib/numeral.ts';

dayjs.extend(relativeTime);
dayjs.extend(utc);

const config = getConfig();
const stats = getStats();

const isOpen = Vue.ref(false);
const rootRef = Vue.ref<HTMLElement>();

// Expose the root element to parent components
defineExpose({
  $el: rootRef,
});

const lastBitcoinActivityAt = Vue.computed(() => {
  const lastActivity = stats.serverState.bitcoinBlocksLastUpdatedAt;
  return lastActivity ? dayjs.utc(lastActivity).local() : null;
});

const lastArgonActivityAt = Vue.computed(() => {
  const lastActivity = stats.serverState.argonBlocksLastUpdatedAt;
  return lastActivity ? dayjs.utc(lastActivity).local() : null;
});

const lastUpdatedAt = Vue.computed(() => {
  const times = [lastBitcoinActivityAt.value, lastArgonActivityAt.value].filter(Boolean);
  if (times.length === 0) return null;
  return times.reduce((latest, current) => (current && current.isAfter(latest) ? current : latest));
});

const installerProgress = Vue.computed(() => {
  let totalProgress = 0;
  for (const [index, stepLabel] of stepLabels.entries()) {
    let stepStatus = config.serverInstaller[stepLabel.key].status;
    if (stepStatus === InstallStepStatus.Pending && index === 0) {
      stepStatus = InstallStepStatus.Working;
    }
    if (stepStatus === InstallStepStatus.Completed) {
      totalProgress += 100;
    } else if (stepStatus === InstallStepStatus.Pending) {
      totalProgress += 0;
    } else {
      totalProgress += config.serverInstaller[stepLabel.key].progress;
    }
  }
  return totalProgress / stepLabels.length;
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

function openServerOverlay() {
  isOpen.value = false;
  basicEmitter.emit('openServerOverlay');
}

function openServerConnectPanel() {
  basicEmitter.emit('openServerConnectPanel');
}
</script>

<style scoped>
@reference "../../main.css";

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

.plugin-connecting {
  animation: plugin-connecting-fade 1s ease-in-out infinite;
}

@keyframes plugin-connecting-fade {
  0% {
    opacity: 0.25;
  }
  50% {
    opacity: 1;
  }
  100% {
    opacity: 0.25;
  }
}

.connecting-dots {
  display: inline-block;
  overflow: hidden;
  vertical-align: bottom;
  width: 0;
  animation: connecting-dots 1.5s steps(3, end) infinite;
}

@keyframes connecting-dots {
  0% {
    width: 0;
  }
  60% {
    width: 100%;
  }
  100% {
    width: 0;
  }
}
</style>
