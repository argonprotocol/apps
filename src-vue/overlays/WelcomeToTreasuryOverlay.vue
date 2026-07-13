<!-- prettier-ignore -->
<template>
  <OverlayBase :isOpen="isOpen" :showCloseIcon="false" :enableTopBar="true" class="w-6/12">
    <template #title>
      <DialogTitle class="grow pl-3">
        You've Been Upgraded to Treasury!
      </DialogTitle>
    </template>
    <div class="mx-2 py-5 font-light leading-6">
      <div class="pl-5 pr-10 space-y-3">
        <p>
          Congrats! You can now access the
          yield-generating instruments underlying it. Savings, bonds, bitcoin locks, and stable swaps are all available,
          each with different risk and return profiles.
        </p>
      </div>

      <div class="mt-6 flex flex-row items-center justify-between space-x-4 border-t border-slate-300 px-5 py-1">
        <button
          @click="closeOverlay"
          class="mt-5 w-full flex flex-row items-center justify-center space-x-2 bg-argon-button border border-argon-button-hover hover:bg-argon-button-hover text-white font-bold inner-button-shadow px-6 py-2 rounded-md cursor-pointer focus:outline-none"
        >
          Continue
        </button>
      </div>
    </div>
  </OverlayBase>
</template>

<script setup lang="ts">
import * as Vue from 'vue';
import { DialogTitle } from 'reka-ui';
import OverlayBase from './OverlayBase.vue';
import { getConfig } from '../stores/config.ts';

const config = getConfig();

const isTreasuryApp = config.hasExtensionTreasury && !config.hasExtensionOperations;
const isOpen = Vue.ref(isTreasuryApp && config.showWelcomeOverlay);

async function closeOverlay() {
  config.showWelcomeOverlay = false;
  await config.save();
  isOpen.value = false;
}
</script>
