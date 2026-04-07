<!-- prettier-ignore -->
<template>
  <TooltipProvider :disableHoverableContent="true" :disableClosingTrigger="true" :delayDuration="300">
    <section
      ref="toggleRef"
      class="pointer-events-auto relative flex w-fit flex-row rounded border border-[#b8b9bd] bg-[#E9EBF1] text-center text-slate-600"
    >
      <TooltipRoot>
        <TooltipTrigger asChild>
          <div Item
            class="border-r border-slate-400/30"
            @click="goto(OperationsTab.Mining)"
            :class="{ selected: controller.selectedTab === OperationsTab.Mining }">
            <div Wrapper class="relative inline px-2 text-center">
              <div :class="{ invisible: controller.selectedTab === OperationsTab.Mining }">Mining</div>
              <div v-if="controller.selectedTab === OperationsTab.Mining" class="absolute top-0 left-0 h-full w-full font-bold">
                Mining
              </div>
            </div>
          </div>
        </TooltipTrigger>
        <TooltipPortal>
          <TooltipContent
            side="bottom"
            :sideOffset="-5"
            class="w-88 data-[state=delayed-open]:data-[side=top]:animate-slideDownAndFade data-[state=delayed-open]:data-[side=right]:animate-slideLeftAndFade data-[state=delayed-open]:data-[side=left]:animate-slideRightAndFade data-[state=delayed-open]:data-[side=bottom]:animate-slideUpAndFade text-md pointer-events-none z-100 rounded-md border border-gray-800/20 bg-white px-4 py-3 text-left leading-5.5 text-gray-600 shadow-xl will-change-[transform,opacity] select-none"
          >
            Miners are chosen through an open auction process. The winners are given a ten-day mining right, after which, they must reapply.
            <TooltipArrow :width="24" :height="12" class="fill-white stroke-gray-400/30 shadow-xl/50" />
          </TooltipContent>
        </TooltipPortal>
      </TooltipRoot>

      <TooltipRoot>
        <TooltipTrigger asChild>
          <div Item
            class="border-r border-slate-400/30 !px-[14px] !py-0"
            @click="goto(OperationsTab.Home)"
            :class="{ selected: controller.selectedTab === OperationsTab.Home }"
          >
            <div Wrapper class="relative px-5 text-center">
              <div :class="{ invisible: controller.selectedTab === OperationsTab.Home }">
                <ArgonLogo class="relative top-[0.5px] h-[24px] opacity-70" />
              </div>
              <div
                v-if="controller.selectedTab === OperationsTab.Home"
                class="absolute top-1/2 -translate-y-1/2 left-0 w-full text-center font-bold">
                <ArgonLogo class="text-argon-600 relative mx-auto h-[24px]" />
              </div>
            </div>
          </div>
        </TooltipTrigger>
        <TooltipPortal>
          <TooltipContent
            side="bottom"
            :sideOffset="-5"
            class="w-60 data-[state=delayed-open]:data-[side=top]:animate-slideDownAndFade data-[state=delayed-open]:data-[side=right]:animate-slideLeftAndFade data-[state=delayed-open]:data-[side=left]:animate-slideRightAndFade data-[state=delayed-open]:data-[side=bottom]:animate-slideUpAndFade text-md pointer-events-none z-100 rounded-md border border-gray-800/20 bg-white px-4 py-3 text-center leading-5.5 text-gray-600 shadow-xl will-change-[transform,opacity] select-none"
          >
            This is your home screen, a summary of all of all your mining and vaulting activity.
            <TooltipArrow :width="24" :height="12" class="fill-white stroke-gray-400/30 shadow-xl/50" />
          </TooltipContent>
        </TooltipPortal>
      </TooltipRoot>

      <TooltipRoot>
        <TooltipTrigger asChild>
          <div Item
            @click="goto(OperationsTab.Vaulting)"
            :class="{ selected: controller.selectedTab === OperationsTab.Vaulting }"
          >
            <div Wrapper class="relative inline px-1 text-center">
              <div :class="{ invisible: controller.selectedTab === OperationsTab.Vaulting }">Vaulting</div>
              <div v-if="controller.selectedTab === OperationsTab.Vaulting" class="absolute top-0 left-0 h-full w-full font-bold">
                Vaulting
              </div>
            </div>
          </div>
        </TooltipTrigger>
        <TooltipPortal>
          <TooltipContent
            side="bottom"
            :sideOffset="-5"
            class="w-84 data-[state=delayed-open]:data-[side=top]:animate-slideDownAndFade data-[state=delayed-open]:data-[side=right]:animate-slideLeftAndFade data-[state=delayed-open]:data-[side=left]:animate-slideRightAndFade data-[state=delayed-open]:data-[side=bottom]:animate-slideUpAndFade text-md pointer-events-none z-100 rounded-md border border-gray-800/20 bg-white px-4 py-3 text-right leading-5.5 text-gray-600 shadow-xl will-change-[transform,opacity] select-none"
          >
            Vaulting is basically the other side of the mining coin. Vaulters provide services to stabilize the newly mined stablecoins.
            <TooltipArrow :width="24" :height="12" class="fill-white stroke-gray-400/30 shadow-xl/50" />
          </TooltipContent>
        </TooltipPortal>
      </TooltipRoot>

      <ArrowCalloutButton
        v-if="[OperationalStepId.ActivateVault, OperationalStepId.LiquidLock, OperationalStepId.AcquireBonds].includes(controller.activeGuideId!) &&  controller.selectedTab !== OperationsTab.Vaulting"
        class="absolute top-1/2 right-2 -translate-y-1/2 translate-x-full z-50"
        guidance="Click the vaulting tab to begin."
      />
      <ArrowCalloutButton
        v-else-if="[OperationalStepId.FirstMiningSeat, OperationalStepId.MoreMiningSeats].includes(controller.activeGuideId as any) &&  controller.selectedTab !== OperationsTab.Mining"
        class="absolute top-1/2 left-2 -translate-y-1/2 -translate-x-full z-50"
        guidance="Click the mining tab to begin."
        direction="right"
      />
    </section>
  </TooltipProvider>
</template>

<script setup lang="ts">
import * as Vue from 'vue';
import { TooltipArrow, TooltipContent, TooltipPortal, TooltipProvider, TooltipRoot, TooltipTrigger } from 'reka-ui';
import { useOperationsController, OperationsTab, OperationalStepId } from '../../stores/operationsController.ts';
import { ITourPos, useTour } from '../../stores/tour.ts';
import ArgonLogo from '../../assets/resources/argon.svg?component';
import { getConfig } from '../../stores/config.ts';
import { MiningSetupStatus, VaultingSetupStatus } from '../../interfaces/IConfig.ts';
import ArrowCalloutButton from '../../components/ArrowCalloutButton.vue';

const tour = useTour();
const controller = useOperationsController();
const config = getConfig();

const toggleRef = Vue.ref<HTMLElement | null>(null);

function goto(tab: OperationsTab) {
  if (controller.backButtonTriggersHome) {
    controller.backButtonTriggersHome = false;
    if (tab === OperationsTab.Mining) {
      config.miningSetupStatus = MiningSetupStatus.None;
    } else if (tab === OperationsTab.Vaulting) {
      config.vaultingSetupStatus = VaultingSetupStatus.None;
    }
  }
  controller.setScreenKey(tab);
}

tour.registerPositionCheck('miningTab', (): ITourPos => {
  const rect = toggleRef.value?.getBoundingClientRect().toJSON() || { left: 0, right: 0, top: 0, bottom: 0 };
  rect.left -= 20;
  rect.right += 20;
  rect.top -= 10;
  rect.bottom += 10;
  return rect;
});

tour.registerPositionCheck('vaultingTab', () => {
  const rect = toggleRef.value?.getBoundingClientRect().toJSON() || { left: 0, right: 0, top: 0, bottom: 0 };
  rect.left -= 20;
  rect.right += 20;
  rect.top -= 10;
  rect.bottom += 10;
  return rect;
});
</script>

<style scoped>
@reference "../../main.css";

section {
  position: relative;
  box-shadow: inset 1px 1px 2px rgba(0, 0, 0, 0.2);
  white-space: nowrap;
  &[disabled='true'] {
    pointer-events: none;
  }
  &[isRunning='true'] li {
    opacity: 0.5 !important;
  }
  [Item] {
    z-index: 1;
    cursor: pointer;
    padding: 4px 30px;
    transition: opacity 0.3s ease;
    position: relative;
    [Wrapper] {
      @apply flex flex-row items-center justify-center;
      width: 100%;
      height: 100%;
      position: relative;
      z-index: 2;
    }
  }
  [Item].selected {
    @apply text-argon-600;
  }
  [Item].selected:after {
    content: '';
    width: calc(100% + 2px);
    height: calc(100% + 2px);
    position: absolute;
    top: -1px;
    left: -1px;
    background: white;
    border-radius: 5px;
    border: 1px solid #979797;
    box-shadow: 0 1px rgba(0, 0, 0, 0.1);
    cursor: default;
    transition: left 0.3s ease;
    z-index: 1;
  }
  [Item]:not(.selected):hover {
    [Wrapper] {
      @apply text-argon-600 opacity-60;
      svg {
        @apply opacity-100;
      }
    }
  }
  [Item]:not(.selected) {
    [Wrapper] {
      opacity: 0.3;
    }
  }
  [Item]:last-child.selected:after {
    left: -1px;
  }
}
</style>
