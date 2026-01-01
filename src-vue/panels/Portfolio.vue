<!-- prettier-ignore -->
<template>
  <DialogRoot class="absolute inset-0 z-10" :open="isOpen">
    <DialogPortal>
      <DialogOverlay asChild>
        <BgOverlay @close="closePanel" />
      </DialogOverlay>

      <DialogContent @escapeKeyDown="closePanel" :aria-describedby="undefined">
        <div
          class="Portfolio Panel inner-input-shadow bg-argon-menu-bg absolute top-[50px] right-2 bottom-2 left-2 z-20 flex flex-col rounded-md border border-black/30 text-left transition-all focus:outline-none"
          style="
            box-shadow:
              0 -1px 2px 0 rgba(0, 0, 0, 0.1),
              inset 0 2px 0 rgba(255, 255, 255, 1);
          "
        >
          <div class="mx-1 flex flex-row border-b border-slate-300 pt-4 pb-3 pl-5">
            <DialogTitle class="text-2xl font-bold text-slate-800/70 relative z-50">
              Portfolio <PortfolioPanelSwitcher :tab="tab" @change="changeTab" />
            </DialogTitle>
            <div
              @click="closePanel"
              class="absolute top-[18px] right-5 z-50 flex h-[30px] w-[30px] cursor-pointer items-center justify-center rounded-md border border-slate-400/60 text-sm/6 font-semibold hover:border-slate-500/70 hover:bg-[#D6D9DF] focus:outline-none">
              <XMarkIcon class="h-5 w-5 stroke-4 text-[#B74CBA]" />
            </div>
          </div>

          <AssetBreakdown @changeTab="changeTab" v-if="tab === PortfolioTab.AssetBreakdown" />
          <ProfitAnalysis @changeTab="changeTab" v-if="tab === PortfolioTab.ProfitAnalysis" />
          <GrowthProjections @changeTab="changeTab" v-if="tab === PortfolioTab.GrowthProjections" />
          <TransactionHistory @changeTab="changeTab" v-if="tab === PortfolioTab.TransactionHistory" />
        </div>
      </DialogContent>
    </DialogPortal>
  </DialogRoot>
</template>

<script setup lang="ts">
import * as Vue from 'vue';
import BgOverlay from '../components/BgOverlay.vue';
import { DialogContent, DialogOverlay, DialogPortal, DialogRoot, DialogTitle } from 'reka-ui';
import basicEmitter from '../emitters/basicEmitter.ts';
import { XMarkIcon } from '@heroicons/vue/24/outline';
import PortfolioPanelSwitcher from './components/PortfolioPanelSwitcher.vue';
import AssetBreakdown from './portfolio/AssetBreakdown.vue';
import { PortfolioTab } from './interfaces/IPortfolioTab.ts';
import ProfitAnalysis from './portfolio/ProfitAnalysis.vue';
import GrowthProjections from './portfolio/GrowthProjections.vue';
import TransactionHistory from './portfolio/TransactionHistory.vue';

const isOpen = Vue.ref(false);
const isLoaded = Vue.ref(false);
const tab = Vue.ref<PortfolioTab>(PortfolioTab.AssetBreakdown);

function closePanel() {
  isOpen.value = false;
}

function changeTab(newTab: PortfolioTab) {
  tab.value = newTab;
}

basicEmitter.on('openPortfolioPanel', async (newTab: PortfolioTab) => {
  if (isOpen.value) return;
  isLoaded.value = false;

  tab.value = newTab;

  isLoaded.value = true;
  isOpen.value = true;
});
</script>
