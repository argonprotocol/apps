<!-- prettier-ignore -->
<template>
  <div :style="tabSwitcherZIndex" class="relative mr-3 flex grow flex-row items-center pointer-events-none">
    <section
      ref="toggleRef"
      class="relative flex flex-row items-center pointer-events-auto w-fit gap-x-2 ml-1.5 text-center text-slate-600"
    >
      <div Item FirstItem
        @click="goto(TopTab.Wallets)"
        :class="{ selected: controller.selectedTab === TopTab.Wallets }"
        class="overflow-hidden"
      >
        <div Wrapper class="relative inline text-center">
          <div class="font-bold">
            Wallets
          </div>
        </div>
        <div Circle class="absolute top-1/2 left-1.5 -translate-y-1/2 -translate-x-full w-[44px] h-[44px] bg-white rounded-full" />
      </div>

      <div Item
        @click="goto(TopTab.Network)"
        :class="{ selected: controller.selectedTab === TopTab.Network }"
      >
        <div Wrapper class="relative inline px-1 text-center">
          <div class="font-bold">
            Network
          </div>
        </div>
      </div>

      <div Item
           v-if="config.hasExtensionOperations"
           @click="goto(controller.selectedOperationsTab)"
           :class="{ selected: !!controller.selectedTab && [TopTab.Operations, TopTab.MiningOperations, TopTab.VaultingOperations].includes(controller.selectedTab) }"
           class="pr-0!"
      >
        <div Wrapper class="text-center flex flex-row">
          <div class="font-bold border-r border-slate-400/50 pr-2.5">
            <span>Operations</span>
            <template v-if="controller.selectedOperationsTab === TopTab.MiningOperations"> : Mining</template>
            <template v-else-if="controller.selectedOperationsTab === TopTab.VaultingOperations"> : Vaulting</template>
          </div>
          <OperationsMenu MenuArrow />
        </div>
      </div>

      <div Item
         v-if="config.hasExtensionTreasury"
         @click="goto(controller.selectedTreasuryTab)"
         :class="{ selected: !!controller.selectedTab && [TopTab.Treasury, TopTab.TreasuryBonds, TopTab.TreasuryLocks].includes(controller.selectedTab) }"
         class="pr-0!"
      >
        <div Wrapper class="text-center flex flex-row">
          <div class="font-bold border-r border-slate-400/50 pr-2.5">
            <span>Treasury</span>
            <template v-if="controller.selectedTreasuryTab === TopTab.TreasuryBonds"> : Bonds</template>
            <template v-else-if="controller.selectedTreasuryTab === TopTab.TreasuryLocks"> : Bitcoins</template>
          </div>
          <TreasuryMenu MenuArrow />
        </div>
      </div>

      <div Item
        v-if="!config.hasExtensionTreasury"
      >
        <div Wrapper class="text-center flex flex-row">
          <div class="font-bold">
            <span>Upgrade to Treasury</span>
          </div>
        </div>
      </div>
    </section>
  </div>
</template>

<script setup lang="ts">
import * as Vue from 'vue';
import { TopTab } from '../interfaces/IConfig.ts';
import { useOperationsController, OperationalStepId } from '../stores/operationsController.ts';
import { ITourPos, useTour } from '../stores/tour.ts';
import { getConfig } from '../stores/config.ts';
import { MiningSetupStatus, VaultingSetupStatus } from '../interfaces/IConfig.ts';
import ArrowCalloutButton from '../components/ArrowCalloutButton.vue';
import OperationsMenu from './OperationsMenu.vue';
import TreasuryMenu from './TreasuryMenu.vue';
import { useFloatingZIndex } from '../overlays/helpers/OverlayZIndex.ts';

const tour = useTour();
const controller = useOperationsController();
const config = getConfig();
const tabSwitcherZIndex = useFloatingZIndex();

const toggleRef = Vue.ref<HTMLElement | null>(null);

function goto(tab: TopTab) {
  if (controller.backButtonTriggersHome) {
    controller.backButtonTriggersHome = false;
    if (tab === TopTab.MiningOperations) {
      config.miningSetupStatus = MiningSetupStatus.None;
    } else if (tab === TopTab.VaultingOperations) {
      config.vaultingSetupStatus = VaultingSetupStatus.None;
    }
  }
  controller.setTab(tab);
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
@reference "../main.css";

section {
  position: relative;
  white-space: nowrap;
  &[disabled='true'] {
    pointer-events: none;
  }
  &[isRunning='true'] li {
    opacity: 0.5 !important;
  }
  [Item] {
    @apply border-argon-600/20 h-[30px] rounded-md border px-3;
    z-index: 1;
    cursor: pointer;
    font-size: 16px;
    font-weight: bold;
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
    @apply border-argon-800 bg-argon-700/80 text-white;
    box-shadow: inset 1px 1px 3px rgba(0, 0, 0, 0.3);
    [MenuArrow] {
      @apply text-white;
    }
    [Circle] {
      @apply border-argon-800;
    }
  }
  [FirstItem] {
    @apply rounded-l-none! border-l-0! pl-4;
    [Circle] {
      @apply border-argon-600/20 border;
    }
  }
  /* [Item].selected:after {
    @apply border-b-3 border-argon-600/20;
    content: '';
    width: calc(100% + 2px);
    height: calc(100% + 2px);
    position: absolute;
    top: -1px;
    left: -1px;
    background: white;
    cursor: default;
    transition: left 0.3s ease;
    z-index: 1;
  } */
  [Item]:not(.selected):hover {
    @apply border-argon-600/20;
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
