<!-- prettier-ignore -->
<template>
  <TransitionRoot class="absolute inset-0 z-10" :show="isOpen">
    <TransitionChild
      as="template"
      enter="ease-out duration-300"
      enter-from="opacity-0"
      enter-to="opacity-100"
      leave="ease-in duration-200"
      leave-from="opacity-100"
      leave-to="opacity-0"
    >
      <BgOverlay />
    </TransitionChild>

    <div class="absolute inset-0 z-100 overflow-y-auto pt-[1px] flex items-center justify-center pointer-events-none">
      <TransitionChild
        as="template"
        enter="ease-out duration-300"
        enter-from="opacity-0 translate-y-4 sm:translate-y-0 sm:scale-95"
        enter-to="opacity-100 translate-y-0 sm:scale-100"
        leave="ease-in duration-200"
        leave-from="opacity-100 translate-y-0 sm:scale-100"
        leave-to="opacity-0 translate-y-4 sm:translate-y-0 sm:scale-95"
      >
        <div
          class="bg-white border border-black/40 px-7 pt-6 pb-4 rounded-lg pointer-events-auto shadow-xl relative w-160 min-h-60 overflow-scroll"
        >
          <h2 class="text-2xl font-bold text-slate-800/70 border-b border-slate-300 pb-3 mb-6">
            Server Setup Complete!
          </h2>

          <p>
            We verified your server configurations, installed all required software, and double-checked that everything
            is in working order. Click the Let's Go button to get started.
          </p>

          <div class="flex flex-row justify-end gap-4 mt-6 border-t border-slate-300 pt-4">
            <button
              @click="closeOverlay"
              class="bg-argon-button border border-argon-button-hover hover:bg-argon-button-hover text-white font-bold inner-button-shadow px-12 py-2 rounded-md cursor-pointer"
            >
              Let's Go!
            </button>
          </div>
        </div>
      </TransitionChild>
    </div>
  </TransitionRoot>
</template>

<script setup lang="ts">
import * as Vue from 'vue';
import { TransitionChild, TransitionRoot } from '@headlessui/vue';
import basicEmitter from '../emitters/basicEmitter';
import BgOverlay from '../components/BgOverlay.vue';
import { getConfig } from '../stores/config';

const isOpen = Vue.ref(false);
const config = getConfig();

basicEmitter.on('openProvisioningCompleteOverlay', () => {
  isOpen.value = true;
});

const closeOverlay = () => {
  isOpen.value = false;
};
</script>
