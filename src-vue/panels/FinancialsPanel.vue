<template>
  <DialogRoot class="absolute inset-0 z-10" :open="isOpen">
    <DialogPortal>
      <DialogOverlay asChild>
        <BgOverlay @close="closePanel" />
      </DialogOverlay>

      <DialogContent @escapeKeyDown="closePanel" :aria-describedby="undefined">
        <div
          class="inner-input-shadow bg-argon-menu-bg absolute top-[50px] right-2 bottom-2 left-2 z-20 flex flex-col rounded-md border border-black/30 text-left transition-all focus:outline-none"
          style="
            box-shadow:
              0 -1px 2px 0 rgba(0, 0, 0, 0.1),
              inset 0 2px 0 rgba(255, 255, 255, 1);
          ">
          <TabsRoot
            class="flex h-full w-full flex-col"
            :model-value="selectedTab"
            @update:modelValue="selectedTab = $event">
            <div class="mx-1 mb-3 flex flex-row border-b border-slate-300 pt-4 pb-3 pl-5">
              <DialogTitle class="text-2xl font-bold text-slate-800/70">Financials</DialogTitle>
              <TabsList
                class="relative ml-4 flex w-1/3 min-w-fit divide-x divide-slate-400/60 rounded-lg border border-slate-400/60 text-base whitespace-nowrap text-slate-400/80">
                <TabsTrigger
                  class="hover:text-argon-700/60 data-[state=active]:text-argon-600 relative flex flex-1 cursor-pointer items-center justify-center rounded-tl-md px-5 leading-none outline-none select-none data-[state=active]:font-bold"
                  value="assets">
                  <span class="invisible font-bold">Asset Breakdown</span>
                  <span class="absolute top-1/2 left-1/2 block -translate-x-1/2 -translate-y-1/2">Asset Breakdown</span>
                </TabsTrigger>
                <TabsTrigger
                  class="hover:text-argon-700/60 data-[state=active]:text-argon-600 relative flex flex-1 cursor-pointer items-center justify-center rounded-tl-md px-5 leading-none outline-none select-none data-[state=active]:font-bold"
                  value="profits">
                  <span class="invisible font-bold">Profit/Loss</span>
                  <span class="absolute top-1/2 left-1/2 block -translate-x-1/2 -translate-y-1/2">Profit/Loss</span>
                </TabsTrigger>
                <TabsTrigger
                  class="hover:text-argon-700/60 data-[state=active]:text-argon-600 relative flex flex-1 cursor-pointer items-center justify-center rounded-tl-md px-5 leading-none outline-none select-none data-[state=active]:font-bold"
                  value="projections">
                  <span class="invisible font-bold">Personal Projections</span>
                  <span class="absolute top-1/2 left-1/2 block -translate-x-1/2 -translate-y-1/2">Projections</span>
                </TabsTrigger>
              </TabsList>
              <div
                @click="closePanel"
                class="absolute top-[18px] right-5 z-10 flex h-[30px] w-[30px] cursor-pointer items-center justify-center rounded-md border border-slate-400/60 text-sm/6 font-semibold hover:border-slate-500/70 hover:bg-[#D6D9DF] focus:outline-none">
                <XMarkIcon class="h-5 w-5 stroke-4 text-[#B74CBA]" />
              </div>
            </div>

            <TabsContent value="assets" class="mx-5 flex grow flex-col p-3">
              <Assets />
            </TabsContent>
          </TabsRoot>
        </div>
      </DialogContent>
    </DialogPortal>
  </DialogRoot>
</template>
<script setup lang="ts">
import * as Vue from 'vue';
import BgOverlay from '../components/BgOverlay.vue';
import { DialogContent, DialogOverlay, DialogPortal, DialogRoot, DialogTitle } from 'reka-ui';
import { TabsContent, TabsList, TabsRoot, TabsTrigger } from 'reka-ui';
import basicEmitter from '../emitters/basicEmitter.ts';
import { XMarkIcon } from '@heroicons/vue/24/outline';
import Assets from './financials/Assets.vue';

const isOpen = Vue.ref(false);
const isLoaded = Vue.ref(false);

const selectedTab = Vue.ref('assets');

function closePanel() {
  isOpen.value = false;
}

basicEmitter.on('openFinancialsPanel', async () => {
  if (isOpen.value) return;
  isLoaded.value = false;

  isLoaded.value = true;
  isOpen.value = true;
});
</script>
