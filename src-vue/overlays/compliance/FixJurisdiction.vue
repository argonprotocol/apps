<!-- prettier-ignore -->
<template>
  <div class="flex flex-col gap-2 px-3 pb-3">
    <p class="text-slate-800 text-md">As a fully decentralized application, no one is in charge of you except you. We have no centralized servers, 
      databases, or other capabilities to verify your location. We only ask that you stay true to yourself and in full compliance of all local laws.
    </p>

    <label class="text-slate-800/60 text-md font-bold mt-2">Select Your Country of Residence</label>
    <InputMenu v-model="countryCode" :options="Countries.all" />
    <button @click="saveChanges" class="w-full mt-5 bg-argon-600/80 cursor-pointer hover:bg-argon-600 border border-argon-900/10 inner-button-shadow text-white px-4 py-1 rounded-lg focus:outline-none">
      Save New Jurisdiction
    </button>
  </div>
</template>

<script setup lang="ts">
import * as Vue from 'vue';
import InputMenu from '../../components/InputMenu.vue';
import { getConfig } from '../../stores/config';
import Countries from '../../lib/Countries';

const emit = defineEmits(['close', 'goTo']);

const config = getConfig();
const countryCode = Vue.ref(config.userJurisdiction.countryCode);

async function saveChanges() {
  const country = Countries.byISOCode(countryCode.value);
  if (!country) return;

  if (config.userJurisdiction.countryCode === country.value) {
    emit('goTo', 'overview');
    return;
  }

  config.userJurisdiction = {
    ipAddress: config.userJurisdiction.ipAddress,
    city: '',
    region: '',
    countryName: country?.name || '',
    countryCode: country?.value || '',
    latitude: '',
    longitude: '',
  };
  await config.save();
  emit('goTo', 'overview');
}
</script>
