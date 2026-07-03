<!-- prettier-ignore -->
<template>
  <div class="relative z-[2501] mr-3 flex grow flex-row items-center pointer-events-none">
    <section
      ref="toggleRef"
      class="relative flex flex-row items-center pointer-events-auto w-fit gap-x-2 ml-1.5 text-center text-slate-600"
    >
      <div Item FirstItem
        @click="goto(OperationsTab.Wallets)"
        :class="{ selected: controller.selectedTab === OperationsTab.Wallets }"
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
        @click="goto(OperationsTab.Network)"
        :class="{ selected: controller.selectedTab === OperationsTab.Network }"
      >
        <div Wrapper class="relative inline px-1 text-center">
          <div class="font-bold">
            Network
          </div>
        </div>
      </div>

      <div Item
         v-if="config.showTreasuryExtension"
         @click="goto(OperationsTab.Treasury)"
         :class="{ selected: [OperationsTab.Treasury, OperationsTab.TreasuryBonds, OperationsTab.TreasuryLocks].includes(controller.selectedTab) }"
      >
        <div Wrapper class="relative text-center flex flex-row">
          <div class="font-bold">
            Treasury
            <template v-if="controller.selectedTab === OperationsTab.TreasuryBonds">Bonds</template>
            <template v-else-if="controller.selectedTab === OperationsTab.TreasuryLocks">Locks</template>
          </div>
          <TreasuryMenu MenuArrow />
        </div>
      </div>

      <div Item
        v-if="config.showOperationsExtension"
        @click="goto(OperationsTab.Operations)"
        :class="{ selected: [OperationsTab.Operations, OperationsTab.MiningOperations, OperationsTab.VaultingOperations].includes(controller.selectedTab) }"
      >
        <div Wrapper class="relative text-center flex flex-row">
          <div class="font-bold">
            <template v-if="controller.selectedTab === OperationsTab.MiningOperations">Mining</template>
            <template v-else-if="controller.selectedTab === OperationsTab.VaultingOperations">Vaulting</template>
            Operations
          </div>
          <OperationsMenu MenuArrow />
        </div>
      </div>
    </section>
  </div>
</template>

<script setup lang="ts">
import * as Vue from 'vue';
import { useOperationsController, OperationsTab, OperationalStepId } from '../stores/operationsController.ts';
import { ITourPos, useTour } from '../stores/tour.ts';
import { getConfig } from '../stores/config.ts';
import { MiningSetupStatus, VaultingSetupStatus } from '../interfaces/IConfig.ts';
import ArrowCalloutButton from '../components/ArrowCalloutButton.vue';
import OperationsMenu from './OperationsMenu.vue';
import TreasuryMenu from './TreasuryMenu.vue';

const tour = useTour();
const controller = useOperationsController();
const config = getConfig();

const toggleRef = Vue.ref<HTMLElement | null>(null);

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
    @apply border-argon-600/20 h-[30px] rounded-md border px-4;
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
    @apply rounded-l-none! border-l-0!;
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
