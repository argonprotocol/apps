<template>
  <div class="flex flex-col gap-2 px-3">
    <p v-if="config.isValidJurisdiction" class="text-md text-slate-800">
      As a residence of Cayman Islands, you're able to use the full-featured version of {{ APP_NAME }}. If you reside in
      another jurisdiction, please fix your country of residence below so that this app can remain compliant.
    </p>
    <p v-else class="text-md text-slate-800">
      Your version of this app has some features disabled. The more advanced capabilities are reserved for residents of
      Cayman Islands. If our geolocation service made a mistake, please fix it below.
    </p>

    <div class="mx-auto mb-1 flex w-8/12 flex-col gap-2 py-5 text-center">
      <span class="border-b border-dashed border-slate-300 pb-2 font-bold">Your Detected Country of Residence</span>
      <div>
        <AlertIcon
          v-if="!config.isValidJurisdiction"
          class="relative -top-0.5 mr-1 inline-block h-5 w-5 text-yellow-700/80" />
        {{ config.userJurisdiction.countryName }}
        <span class="font-light">(</span>
        <span @click="fixJurisdiction" class="text-argon-500 hover:text-argon-600 inline cursor-pointer">
          {{ config.isValidJurisdiction ? 'change' : 'fix' }} jurisdiction
        </span>
        <span class="font-light">)</span>
      </div>
    </div>

    <button
      @click="closeOverlay"
      class="inner-button-shadow w-full cursor-pointer rounded-lg border border-slate-900/10 bg-slate-600/20 px-4 py-1 text-slate-900 hover:bg-slate-600/15 focus:outline-none">
      Close
    </button>
  </div>
</template>

<script setup lang="ts">
import * as Vue from 'vue';
import { getConfig } from '../../stores/config';
import AlertIcon from '../../assets/alert.svg?component';
import { APP_NAME } from '../../lib/Env.ts';

const emit = defineEmits(['close', 'goTo']);

const config = getConfig();

function fixJurisdiction() {
  emit('goTo', 'fixJurisdiction');
}

function closeOverlay() {
  emit('close');
}
</script>
