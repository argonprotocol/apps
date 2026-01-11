<!-- prettier-ignore -->
<template>
  <Overlay :isOpen="isOpen" :showCloseIcon="false" title="Welcome to the Argonot Operator" class="w-7/12">
    <div class="mx-2 pl-5 pr-10 pt-5 space-y-3 font-light leading-6">
      <p>
        You might already be familiar with Argon, but in case you're not: Argon is the first crypto asset
        designed to remain truly stable. It achieves this with zero off-chain collateral and zero centralized control. Argon is a
        breakthrough in the quest for a global currency that's free from inflation and the debt-ridden nature of fiat money.
      </p>

      <p>
        This app is built for a select group of early insiders who want to participate in running Argon's blockchain -- whether by
        mining new blocks or by vaulting to help stabilize the currency. We'll guide you through setting up operations, handling
        governance, and monitoring your capital flows. We recommend starting with the quick tour to get familiar.
      </p>
    </div>
    <div class="flex flex-row justify-end items-center border-t border-slate-300 py-5 px-5 mt-5 space-x-2 mx-2">
      <button @click="closeOverlay" tabindex="-1" class="bg-white border border-argon-600/50 hover:bg-argon-600/10 text-argon-600 font-bold inner-button-shadow px-12 py-2 rounded-md cursor-pointer focus:outline-none">
        Close Overlay
      </button>
      <button @click="startTour" tabindex="0" class="flex flex-row items-center space-x-2 bg-argon-button border border-argon-button-hover hover:bg-argon-button-hover text-white font-bold inner-button-shadow px-12 py-2 rounded-md cursor-pointer focus:outline-none">
        <span>Take the Welcome Tour</span>
        <ChevronDoubleRightIcon class="size-5 relative top-px text-white" />
      </button>
    </div>
  </Overlay>
</template>

<script setup lang="ts">
import * as Vue from 'vue';
import { ChevronDoubleRightIcon } from '@heroicons/vue/24/outline';
import Overlay from './Overlay.vue';
import { getConfig } from '../stores/config';
import { useTour } from '../stores/tour';

const config = getConfig();
const tour = useTour();

const isOpen = Vue.ref(config.showWelcomeOverlay);

function closeOverlay() {
  config.showWelcomeOverlay = false;
}

function startTour() {
  tour.start();
}
</script>
