<!-- prettier-ignore -->
<template>
  <div class="flex flex-col px-3">
    <p class="text-md text-slate-500">
      All your data in this Argon Investor Console app can be entirely recreated from a single account recovery file. Click
      the button below to download. And keep it safe! It contains your account's private key, so don't share it with anyone.
    </p>

    <button
      @click="exportAccount"
      class="bg-argon-600 text-white rounded-md py-2 px-3 mt-5 cursor-pointer"
      :class="{ 'opacity-50 cursor-not-allowed': isSavingExport }"
    >
      {{ isSavingExport ? 'Downloading...' : hasSavedExport ? 'Downloaded' : 'Download' }} Recovery File
    </button>

    <!-- <AnimatePresence>
        <Motion
          v-if="isSavingExport"
          :initial="{ opacity: 0.5 }"
          :animate="{ opacity: 1 }"
          :transition="{ repeat: Infinity, duration: 0.5, ease: 'easeInOut', repeatType: 'reverse' }"
          class="text-xs bg-argon-600 text-white rounded-full px-4 py-1 ml-2"
        >
          SAVING
        </Motion>
        <Motion
          v-else-if="hasSavedExport"
          :initial="{ opacity: 0 }"
          :animate="{ opacity: 1 }"
          :exit="{ opacity: 0 }"
          :transition="{ duration: 1, ease: 'easeIn' }"
          :exit-transition="{ duration: 1, ease: 'easeOut' }"
          class="text-xs bg-argon-600 text-white rounded-full px-4 py-1 ml-2"
        >
          SAVED
        </Motion>
      </AnimatePresence> -->
  </div>
</template>

<script setup lang="ts">
import * as Vue from 'vue';
import { useConfig } from '../../stores/config';
import { save as saveFileOverlay } from '@tauri-apps/plugin-dialog';
import { writeTextFile } from '@tauri-apps/plugin-fs';
import { JsonExt } from '@argonprotocol/commander-core';
import { IRecoveryFile } from '../../interfaces/IRecoveryFile.ts';

const config = useConfig();
const isSavingExport = Vue.ref(false);
const hasSavedExport = Vue.ref(false);

const emit = defineEmits(['close', 'goTo']);

async function exportAccount() {
  const filePath = await saveFileOverlay({
    defaultPath: 'argon-commander-recovery.json',
    filters: [{ name: 'JSON', extensions: ['json'] }],
  });
  if (!filePath) return; // user cancelled

  isSavingExport.value = true;
  const data: IRecoveryFile = {
    security: config.security,
    oldestFrameIdToSync: config.oldestFrameIdToSync,
    biddingRules: config.biddingRules,
    vaultingRules: config.vaultingRules,
    defaultCurrencyKey: config.defaultCurrencyKey,
    requiresPassword: config.requiresPassword,
    serverDetails: config.serverDetails,
    userJurisdiction: config.userJurisdiction,
  };
  const pretty = JsonExt.stringify(data, 2);
  await writeTextFile(filePath, pretty);
  isSavingExport.value = false;
  hasSavedExport.value = true;
  setTimeout(() => {
    hasSavedExport.value = false;
  }, 5_000);
}
</script>
