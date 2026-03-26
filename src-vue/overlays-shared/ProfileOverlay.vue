<!-- prettier-ignore -->
<template>
  <OverlayBase :isOpen="isOpen" @close="closeOverlay" @esc="closeOverlay" class="w-6/12">
    <template #title>
      <div class="text-2xl font-bold inline-block relative">
        Your Profile
      </div>
    </template>
    <div class="flex flex-col w-full pt-3 pb-5 px-5 gap-x-5">
      <div v-if="!isLoaded">
        Loading...
      </div>
      <div v-else-if="!hasServer" class="text-center my-16 text-slate-700/50">
        You must <a @click="openServer" class="cursor-pointer">add a cloud machine</a> before<br />
        setting up your profile.
      </div>
      <div v-else class="pt-2">
        <p class="text-base font-light text-slate-900">
          This app is completely anonymous, and the name below is not saved on the
          blockchain or 3rd-party database. It's only used to personalize the invites you send to family and friends.
        </p>
        <div class="mt-3">
          <input
            v-model="name"
            type="text"
            placeholder="Your Name"
            class="inner-input-shadow w-full rounded-lg border border-slate-400/70 bg-white px-2.5 py-1.5 text-lg font-normal text-slate-700 placeholder:text-slate-300 outline-none transition focus:border-argon-500 focus:ring-2 focus:ring-argon-500/15"
          />
        </div>
        <div class="mt-5 flex justify-end gap-3">
          <button
            @click="closeOverlay"
            class="cursor-pointer rounded-md border border-argon-600/20 bg-white px-6 py-2 font-bold text-argon-600 inner-button-shadow hover:bg-argon-600/10 focus:outline-none"
          >
            Cancel
          </button>
          <button
            @click="saveProfile"
            :disabled="isSaving"
            class="cursor-pointer rounded-md border border-argon-button-hover bg-argon-button px-6 py-2 font-bold text-white inner-button-shadow hover:bg-argon-button-hover focus:outline-none disabled:cursor-default disabled:opacity-60"
          >
            {{ isSaving ? 'Saving...' : 'Save' }}
          </button>
        </div>
      </div>
    </div>
  </OverlayBase>
</template>

<script setup lang="ts">
import * as Vue from 'vue';
import OverlayBase from '../overlays-shared/OverlayBase.vue';
import basicEmitter from '../emitters/basicEmitter';
import { SERVER_ENV_VARS } from '../lib/Env.ts';
import { getConfig } from '../stores/config.ts';
import { useBasics } from '../stores/basics.ts';

const config = getConfig();
const basics = useBasics();

const isOpen = Vue.ref(false);
const isLoaded = Vue.ref(false);
const hasServer = Vue.ref(true);
const isSaving = Vue.ref(false);

const name = Vue.ref('');

async function load() {
  await config.load();
  const { ipAddress } = config.serverDetails;
  if (!config.isServerInstalled || !ipAddress) {
    hasServer.value = false;
    return;
  }

  const response = await fetch(`http://${ipAddress}:${SERVER_ENV_VARS.ROUTER_PORT}/profile`);
  const { profile } = await response.json();

  hasServer.value = true;
  name.value = profile.name;
}

async function saveProfile() {
  if (isSaving.value) return;

  const cleanName = name.value?.trim();
  isSaving.value = true;

  try {
    const { ipAddress } = config.serverDetails;
    await fetch(`http://${ipAddress}:${SERVER_ENV_VARS.ROUTER_PORT}/profile`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        name: cleanName,
      }),
    });

    config.hasProfileName = !!cleanName;
    closeOverlay();
  } finally {
    isSaving.value = false;
  }
}

function closeOverlay() {
  isOpen.value = false;
  basics.overlayIsOpen = false;
}

function openServer() {
  closeOverlay();
  if (config.isServerInstalling || config.isServerInstalled) {
    basicEmitter.emit('openServerOverlay');
  } else {
    basicEmitter.emit('openServerConnectPanel');
  }
}

basicEmitter.on('openProfileOverlay', async data => {
  await load();
  isOpen.value = true;
  isLoaded.value = true;
  basics.overlayIsOpen = true;
});
</script>

<style scoped>
@reference "../main.css";

table {
  @apply text-md mt-6 font-mono;
  thead {
    @apply font-bold uppercase;
  }
  td {
    @apply border-b border-slate-400/30 py-3;
  }
}

span[tag] {
  @apply ml-1 rounded-full px-2 text-xs font-bold text-white uppercase;
}

.fade-in-out {
  animation: fadeInOut 1s ease-in-out infinite;
  animation-delay: 0s;
}

@keyframes fadeInOut {
  0% {
    opacity: 0.3;
  }
  50% {
    opacity: 1;
  }
  100% {
    opacity: 0.3;
  }
}
</style>
