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
            You Are About to Remove This Server
            <XMarkIcon class="w-6 h-6 text-slate-800/70 cursor-pointer absolute top-6 right-6" @click="closeOverlay" />
          </h2>

          <p>
            You are about to remove your mining machine from Argon Investor Console. This action will not stop any active
            processes that are running on the server nor will it delete the server from your cloud provider.
          </p>

          <p class="mt-2">
            After clicking Confirm, you should probably log into your provider and delete this server. Otherwise you
            will continue to be charged for the resource.
          </p>

          <div class="flex flex-row justify-end gap-4 mt-6 border-t border-slate-300 pt-4">
            <button
              @click="closeOverlay"
              class="border border-argon-button bg-argon-button/5 inner-button-shadow text-argon-button hover:text-argon-button-hover hover:border-argon-button-hover px-6 py-2 rounded-md cursor-pointer"
            >
              Cancel
            </button>
            <button
              @click="removeServer"
              :disabled="isRemoving"
              :class="{ 'opacity-50 cursor-normal': isRemoving }"
              class="bg-argon-button border border-argon-button-hover hover:bg-argon-button-hover text-white font-bold inner-button-shadow px-6 py-2 rounded-md cursor-pointer"
            >
              {{ isRemoving ? 'Removing...' : 'Confirm Remove Server' }}
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
import { XMarkIcon } from '@heroicons/vue/24/outline';
import BgOverlay from '../components/BgOverlay.vue';
import { useConfig } from '../stores/config';
import { Config } from '../lib/Config';
import { type IConfigInstallDetails, ServerType } from '../interfaces/IConfig';
import { SSH } from '../lib/SSH';
import { invokeWithTimeout } from '../lib/tauriApi.ts';
import { LocalMachine } from '../lib/LocalMachine.ts';

const config = useConfig();

const isOpen = Vue.ref(false);
const isLoaded = Vue.ref(false);
const isRemoving = Vue.ref(false);

basicEmitter.on('openServerRemoveOverlay', async (data: any) => {
  isOpen.value = true;
  isLoaded.value = true;
});

const closeOverlay = () => {
  if (isRemoving.value) return;
  isOpen.value = false;
  isLoaded.value = false;
};

async function removeServer() {
  if (isRemoving.value) return;
  isRemoving.value = true;

  const isLocalDocker = config.serverDetails.type === ServerType.LocalComputer;
  config.isMinerReadyToInstall = false;
  config.isMinerInstalled = false;
  config.isMinerInstalling = false;
  config.serverDetails = { ...config.serverDetails, ipAddress: '', port: undefined };
  config.installDetails = Config.getDefault('installDetails') as IConfigInstallDetails;
  await config.save();
  if (isLocalDocker) {
    try {
      await LocalMachine.remove();
    } catch (e) {
      console.error('Error removing local docker machine:', e);
    }
  }

  await SSH.closeConnection();

  isRemoving.value = false;
  isOpen.value = false;
  isLoaded.value = false;
}
</script>
