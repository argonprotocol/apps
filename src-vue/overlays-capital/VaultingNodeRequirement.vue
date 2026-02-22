<!-- prettier-ignore -->
<template>
  <OverlayBase :isOpen="isOpen" :showCloseIcon="false" title="Connect to a Vault" class="w-5/12">
    <div class="mx-2 pl-5 pr-10 pt-5 space-y-3 font-light leading-6">
      <div>
        <p>
          This app requires you to connect to an Argon Vault. If you know someone who operates a vault, ask them for a link.
          You can also, manually enter their IP address and Usage Code below:
        </p>

        <div class="mt-3">IP Address</div>
        <input type="text" class="w-full mt-2 rounded-md border border-slate-300 focus:ring-0 focus:border-argon-600" placeholder="Vault IP Address" />

        <div class="mt-3">Usage Code</div>
        <input type="text" class="w-full mt-2 rounded-md border border-slate-300 focus:ring-0 focus:border-argon-600" placeholder="Vault IP Address" />
      </div>
    </div>
    <div class="flex flex-row justify-end items-center border-t border-slate-300 py-5 px-5 mt-5 space-x-2 mx-2">
      <button @click="startTour" tabindex="0" class="flex flex-row items-center space-x-2 bg-argon-button border border-argon-button-hover hover:bg-argon-button-hover text-white font-bold inner-button-shadow px-12 py-2 rounded-md cursor-pointer focus:outline-none">
        <span>Connect to Vault</span>
      </button>
    </div>
  </OverlayBase>
</template>

<script setup lang="ts">
import * as Vue from 'vue';
import OverlayBase from '../overlays-shared/OverlayBase.vue';
import { useTour } from '../stores/tour';

const tour = useTour();

const isOpen = Vue.ref(true);

function closeOverlay() {
  isOpen.value = false;
}

function startTour() {
  tour.start();
}
</script>
