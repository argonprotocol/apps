<!-- prettier-ignore -->
<template>
  <div ref="rootRef">
    <NavigationMenuItem class="pointer-events-auto">
      <NavigationMenuTrigger
        Trigger
        class="flex h-[30px] cursor-pointer flex-row items-center justify-center overflow-hidden rounded-md border border-slate-400/50 text-[16.4px] font-semibold text-argon-600/70 hover:border-slate-400/50 hover:bg-slate-400/10 focus:outline-none data-[state=open]:border-slate-400/60 data-[state=open]:bg-slate-400/10"
      >
        <div
          class="group pointer-events-auto flex h-[30px] cursor-pointer flex-row items-center rounded-md border border-slate-400/50 px-3 font-semibold hover:border-slate-400/50 hover:bg-slate-400/10 focus:outline-none"
        >
          <div v-if="config.upstreamOperator" class="text-argon-600/70 whitespace-nowrap">
            Sponsored<span class="TopBarOptionalLabel"> by {{ upstreamOperatorName }}</span>
          </div>
          <div v-else class="group-hover:text-argon-600 text-slate-900/70">Connect a Vault</div>
        </div>
      </NavigationMenuTrigger>

      <NavigationMenuContent
        class="data-[motion=from-start]:animate-enterFromLeft data-[motion=from-end]:animate-enterFromRight data-[motion=to-start]:animate-exitToLeft data-[motion=to-end]:animate-exitToRight absolute top-0 left-0 w-full sm:w-auto"
      >
        <div class="w-120 bg-argon-menu-bg flex shrink flex-col rounded p-1 text-base text-gray-900 shadow-lg ring-1 ring-gray-900/20">
          <div class="p-4 font-light">
            The Treasury features of Argon require an invite from someone who is an operator
            of the network.


            <div class="mt-3 text-center font-light rounded-md bg-argon-100/20 py-3">
              <div class="font-bold text-argon-700/50 mb-1 text-sm tracking-wider">YOU WERE INVITED BY</div>
              <div class="font-bold">{{ upstreamOperatorName }}</div>
              <div>{{ abbreviateAddress(config.upstreamOperator?.accountId!) }}</div>
            </div>

            <button @click="openSponsorOverlay" class="w-full mt-3 cursor-pointer border border-argon-600 rounded px-3 py-1.5 text-argon-600 hover:bg-argon-100/20">
              View Sponsor Details
            </button>
          </div>
        </div>
      </NavigationMenuContent>
    </NavigationMenuItem>
  </div>
</template>

<script setup lang="ts">
import * as Vue from 'vue';
import { NavigationMenuContent, NavigationMenuItem, NavigationMenuTrigger } from 'reka-ui';
import basicEmitter from '../emitters/basicEmitter.ts';
import { getConfig } from '../stores/config.ts';
import { abbreviateAddress } from '../lib/Utils.ts';

const config = getConfig();

const rootRef = Vue.ref<HTMLElement>();

const upstreamOperatorName = Vue.computed(() => {
  const upstreamOperator = config.upstreamOperator;
  return upstreamOperator?.name || 'Unnamed';
});
// Expose the root element to parent components
defineExpose({
  $el: rootRef,
});

function openSponsorOverlay() {
  basicEmitter.emit('openSponsorOverlay');
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
