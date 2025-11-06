<template>
  <ul class="space-y-4 px-4 pt-2 pb-5">
    <li>
      <header>Local Data</header>
      <p>Most of your locally cached data is stored in a sqlite database, which located in the following directory:</p>
      <div class="relative mt-2">
        <input
          v-model="localDataDir"
          disabled
          class="text-md w-full overflow-x-scroll rounded-md border border-black/20 p-1 pr-32 font-mono whitespace-nowrap" />
        <div
          class="absolute top-1 right-1 bottom-1 flex items-center bg-gradient-to-r from-transparent from-0% via-white via-20% to-white pr-2 pl-10">
          <a @click="openDataDir" class="!text-argon-500 cursor-pointer">Open Directory</a>
        </div>
      </div>
    </li>
    <li>
      <header>Local Logs</header>
      <p>All output from your app's runtime logs are stored in the following directory:</p>
      <div class="relative mt-2">
        <input
          v-model="localLogDir"
          disabled
          class="text-md w-full overflow-x-scroll rounded-md border border-black/20 p-1 pr-32 font-mono whitespace-nowrap" />
        <div
          class="absolute top-1 right-1 bottom-1 flex items-center bg-gradient-to-r from-transparent from-0% via-white via-20% to-white pr-2 pl-10">
          <a @click="openLogDir" class="!text-argon-500 cursor-pointer">Open Directory</a>
        </div>
      </div>
    </li>
    <li class="flex flex-col">
      <header>Troubleshoot Server</header>
      <p>Download a troubleshooting package from your mining machine:</p>
      <ProgressBar
        :progress="troubleshootingProgress"
        class="my-2"
        v-if="isCreatingTroubleshootingPackage || troubleshootingProgress > 0" />
      <span v-if="troubleshootingError" class="text-sm text-red-500">
        {{ troubleshootingError }}
      </span>
      <div class="flex flex-row gap-2">
        <div class="pointer-events-none mt-2 flex w-1/2 cursor-pointer flex-row items-center space-x-2 text-gray-800">
          <Checkbox :isChecked="true" :size="5" class="opacity-50" />
          <span class="text-sm font-bold">Include Wallet Mnemonic and Keys</span>
        </div>
        <button
          @click="downloadTroubleshooting"
          :disabled="isCreatingTroubleshootingPackage"
          :class="{
            'opacity-50': isCreatingTroubleshootingPackage,
          }"
          class="bg-argon-button border-argon-600 right align-end mt-5 w-1/2 cursor-pointer rounded-md border px-3 py-1 text-lg text-white">
          Download
        </button>
      </div>
    </li>
  </ul>
  <!-- <div class="flex my-3 mx-4 border-t border-black/20 pt-3">
    <button @click="createZipFile" class="bg-argon-600 text-white rounded-md py-2 px-3">Compile All Data Into a Single Zip File</button>
  </div> -->
</template>

<script setup lang="ts">
import * as Vue from 'vue';
import { Db } from '../../lib/Db';
import { appConfigDir, appLogDir } from '@tauri-apps/api/path';
import { openPath, revealItemInDir } from '@tauri-apps/plugin-opener';
import Checkbox from '../../components/Checkbox.vue';
import { Config, useConfig } from '../../stores/config.ts';
import { Diagnostics } from '../../lib/Diagnostics.ts';
import ProgressBar from '../../components/ProgressBar.vue';
import { invokeWithTimeout } from '../../lib/tauriApi.ts';
import { remove } from '@tauri-apps/plugin-fs';
import { getInstanceConfigDir } from '../../lib/Utils.ts';

const config = useConfig();
const diagnostics = new Diagnostics(config as Config);
const localDataDir = Vue.ref('');
const localLogDir = Vue.ref('');
const troubleshootingProgress = Vue.ref(0);
const isCreatingTroubleshootingPackage = Vue.ref(false);
const troubleshootingError = Vue.ref('');

async function openLogDir() {
  await openPath(localLogDir.value);
}

async function openDataDir() {
  await openPath(localDataDir.value);
}

async function createZipFile() {
  // TODO: Create zip file
}

async function downloadTroubleshooting() {
  isCreatingTroubleshootingPackage.value = true;
  troubleshootingProgress.value = 0;
  troubleshootingError.value = '';
  try {
    await diagnostics.load();
    const downloadPath = await diagnostics.downloadTroubleshootingPackage(x => {
      troubleshootingProgress.value = x;
    });
    const zipPath = downloadPath.replace('.tar.gz', '.zip');
    const config = await getInstanceConfigDir();
    const logDir = await appLogDir();
    await invokeWithTimeout(
      'create_zip',
      {
        zipName: zipPath,
        pathsWithPrefixes: [
          ['logs', logDir],
          ['data', config],
          ['server', downloadPath],
        ],
      },
      10000,
    );
    await remove(downloadPath);
    await revealItemInDir(zipPath);
  } catch (err) {
    console.error('Error downloading troubleshooting package:', err);
    troubleshootingError.value = `Error downloading troubleshooting package: ${err}`;
  } finally {
    isCreatingTroubleshootingPackage.value = false;
    troubleshootingProgress.value = 0;
  }
}

Vue.onMounted(async () => {
  const dataDir = await appConfigDir();
  localDataDir.value = `${dataDir}/${Db.relativeDir}`;
  localLogDir.value = await appLogDir();
});
</script>

<style scoped>
@reference "../../main.css";

header {
  @apply text-lg font-bold;
}
</style>
