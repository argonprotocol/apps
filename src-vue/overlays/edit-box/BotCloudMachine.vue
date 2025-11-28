<!-- prettier-ignore -->
<template>
  <div v-if="config.isMinerInstalled">
    <p>Your mining machine is already set up. You cannot change the IP address at this time.</p>
  </div>
  <div v-else>
    <RadioGroupRoot
      v-model="setupType"
      class="flex flex-row gap-2.5"
      :class="[isImporting ? 'opacity-50' : '']"
      default-value="new"
      :disabled="isImporting"
    >
      <div class="flex items-center">
        <RadioGroupItem
          id="r1"
          class="bg-white w-[1.125rem] h-[1.125rem] rounded-full border data-[active=true]:border-stone-700 data-[active=true]:bg-stone-700  shadow-sm focus:shadow-[0_0_0_2px] focus:shadow-stone-700 outline-none cursor-default"
          value="new"
        >
          <RadioGroupIndicator
              class="flex items-center justify-center w-full h-full relative after:content-[''] after:block after:w-2 after:h-2 after:rounded-[50%] after:bg-stone-700"
          />
        </RadioGroupItem>
        <label
          class="text-mdleading-none pl-[10px]"
          for="r1"
        >
          Setup New Server
        </label>
      </div>
      <div class="flex items-center">
        <RadioGroupItem
          id="r2"
          class="bg-white w-[1.125rem] h-[1.125rem] rounded-full border data-[active=true]:border-stone-700 data-[active=true]:bg-stone-700 shadow-sm focus:shadow-[0_0_0_2px] focus:shadow-stone-700 outline-none cursor-default"
          value="existing"
        >
          <RadioGroupIndicator
            class="flex items-center justify-center w-full h-full relative after:content-[''] after:block after:w-2 after:h-2 after:rounded-[50%] after:bg-stone-700"
          />
        </RadioGroupItem>
        <label
          class="text-md leading-none pl-[10px]"
          for="r2"
        >
          Import Existing
        </label>
      </div>
    </RadioGroupRoot>
    
    <p v-if="setupType === 'new'" class="text-md mb-3 mt-5">
      In the next step, we'll guide you through the process of setting up a new mining machine. It's very easy, don't worry!
    </p>
    <div v-else class="mt-5">
      <p class="mb-4">
        This will overwrite your current settings with data from the server located at the IP address below. This server will
        also be used to run your bot, and it must be accessible through the same SSH creditionals listed in this app.
      </p>
      <div class="pr-5">
        <div v-if="importError" class="flex flex-row bg-red-50/80 border border-red-600/10 border-b-0 text-red-600 text-md px-3 py-2 rounded-md">
          <ArrowTurnLeftDownIcon class="w-5 h-5 inline-block mr-1 relative top-1.5" />
          <span>{{ importError }}</span>
        </div>
        <input v-model="importIpAddress" type="text" class="w-full border border-gray-300 rounded-md px-3 py-2 mb-4" placeholder="0.0.0.0" />
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import * as Vue from 'vue';
import { RadioGroupIndicator, RadioGroupItem, RadioGroupRoot } from 'reka-ui';
import Importer from '../../lib/Importer';
import type { Config } from '../../lib/Config';
import { useConfig } from '../../stores/config';
import { getDbPromise } from '../../stores/helpers/dbPromise';
import { IEditBoxChildExposed } from '../EditBoxOverlay.vue';
import { ArrowTurnLeftDownIcon } from '@heroicons/vue/24/solid';
import { useWalletKeys } from '../../stores/wallets.ts';

const config = useConfig();
const walletKeys = useWalletKeys();
const dbPromise = getDbPromise();

const setupType = Vue.ref<'new' | 'existing'>('new');

const importIpAddress = Vue.ref('');
const importError = Vue.ref<string | null>(null);
const isImporting = Vue.ref(false);

const saveButtonLabel = Vue.ref('Save');
const shouldHideSaveButton = Vue.ref(config.isMinerInstalled);

Vue.watch(setupType, value => {
  saveButtonLabel.value = value === 'new' ? 'Save' : 'Import Config';
});

async function beforeSave(stopSaveFn: () => void) {
  if (setupType.value === 'new') return;

  saveButtonLabel.value = 'Importing Config...';
  isImporting.value = true;
  importError.value = null;

  if (!importIpAddress.value) {
    isImporting.value = true;
    importError.value = 'You must enter an IP address';
    saveButtonLabel.value = 'Import Config';
    stopSaveFn();
    return;
  }

  try {
    const importer = new Importer(config as Config, walletKeys, dbPromise);
    await importer.importFromServer(importIpAddress.value);
  } catch (error) {
    isImporting.value = false;
    importError.value = error instanceof Error ? error.message : 'An unknown error occurred';
  }

  saveButtonLabel.value = 'Import Config';
  isImporting.value = false;
}

function beforeCancel(stopCancelFn: () => void) {
  if (setupType.value === 'new') return;

  if (isImporting.value) {
    stopCancelFn();
  }
}

defineExpose<IEditBoxChildExposed>({ beforeSave, beforeCancel, saveButtonLabel, shouldHideSaveButton });
</script>
