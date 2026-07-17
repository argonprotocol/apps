<template>
  <ul class="space-y-4 px-4 pt-2 pb-5">
    <li>
      <header>Local Data</header>
      <p>Most of your locally cached data is stored in a sqlite database, which located in the following directory:</p>
      <div class="relative mt-2">
        <input
          v-model="localDataDir"
          disabled
          class="text-md w-full overflow-x-scroll rounded-md border border-black/20 p-1 pr-32 font-mono whitespace-nowrap"
        />
        <div
          class="absolute top-1 right-1 bottom-1 flex items-center bg-gradient-to-r from-transparent from-0% via-white via-20% to-white pr-2 pl-10"
        >
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
          class="text-md w-full overflow-x-scroll rounded-md border border-black/20 p-1 pr-32 font-mono whitespace-nowrap"
        />
        <div
          class="absolute top-1 right-1 bottom-1 flex items-center bg-gradient-to-r from-transparent from-0% via-white via-20% to-white pr-2 pl-10"
        >
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
        v-if="isCreatingTroubleshootingPackage || troubleshootingProgress > 0"
      />
      <span v-if="troubleshootingError" class="text-sm text-red-500">
        {{ troubleshootingError }}
      </span>
      <div class="mt-5 flex flex-row items-center gap-2">
        <button
          @click="downloadTroubleshooting"
          :disabled="isCreatingTroubleshootingPackage"
          :class="{
            'opacity-50': isCreatingTroubleshootingPackage,
          }"
          class="bg-argon-button border-argon-600 hover:bg-argon-700 right align-end w-1/2 grow cursor-pointer rounded-md border px-3 py-1 text-lg text-white"
        >
          Download
        </button>
        <button
          @click="includeWalletMnemonics = !includeWalletMnemonics"
          type="button"
          class="ml-2 flex cursor-pointer flex-row items-center space-x-2 whitespace-nowrap text-gray-800"
        >
          <Checkbox :isChecked="includeWalletMnemonics" :size="5" />
          <span class="text-sm font-bold">Include Wallet Mnemonics</span>
        </button>
      </div>
      <p class="mt-2 text-xs text-slate-500">Wallet mnemonic files are excluded unless you opt in.</p>
    </li>
  </ul>
  <!-- <div class="flex my-3 mx-4 border-t border-black/20 pt-3">
    <button @click="createZipFile" class="bg-argon-600 text-white rounded-md py-2 px-3">Compile All Data Into a Single Zip File</button>
  </div> -->
</template>

<script setup lang="ts">
import * as Vue from 'vue';
import { Db } from '../../../lib/Db.ts';
import { appConfigDir, appLogDir, join, tempDir } from '@tauri-apps/api/path';
import { listen } from '@tauri-apps/api/event';
import { openPath, revealItemInDir } from '@tauri-apps/plugin-opener';
import Checkbox from '../../../components/Checkbox.vue';
import { Config, getConfig } from '../../../stores/config.ts';
import { Diagnostics } from '../../../lib/Diagnostics.ts';
import ProgressBar from '../../../components/ProgressBar.vue';
import { invokeWithTimeout } from '../../../lib/tauriApi.ts';
import { copyFile, mkdir, readDir, remove, writeTextFile } from '@tauri-apps/plugin-fs';
import { getWalletKeys } from '../../../stores/wallets.ts';
import { INSTANCE_NAME } from '../../../lib/Env.ts';
import { getInstanceConfigDir } from '../../../lib/Utils.ts';

const config = getConfig();
const walletKeys = getWalletKeys();

const diagnostics = new Diagnostics(config as Config, walletKeys);
const localDataDir = Vue.ref('');
const localLogDir = Vue.ref('');
const troubleshootingProgress = Vue.ref(0);
const isCreatingTroubleshootingPackage = Vue.ref(false);
const troubleshootingError = Vue.ref('');
const includeWalletMnemonics = Vue.ref(false);

async function openLogDir() {
  await openPath(localLogDir.value);
}

async function openDataDir() {
  await openPath(localDataDir.value);
}

async function downloadTroubleshooting() {
  isCreatingTroubleshootingPackage.value = true;
  troubleshootingProgress.value = 0;
  troubleshootingError.value = '';
  const removeOnFinish: { path: string; recursive?: boolean }[] = [];
  let unsubZipProgress: (() => void) | undefined;

  try {
    let zipPath = `argon_${INSTANCE_NAME}_troubleshooting_${Date.now()}.zip`;
    let serverPackagePath: string | undefined;

    if (diagnostics.hasServer()) {
      await diagnostics.load();
      const downloadPath = await diagnostics.downloadTroubleshootingPackage(x => {
        troubleshootingProgress.value = Math.min(60, x);
      });
      serverPackagePath = downloadPath;
      removeOnFinish.push({ path: downloadPath });
      zipPath = downloadPath.replace('.tar.gz', '.zip');
    } else {
      zipPath = await join(await tempDir(), zipPath);
      troubleshootingProgress.value = 15;
    }

    const troubleshootingRoot = await join(await tempDir(), `argon_${INSTANCE_NAME}_troubleshooting_${Date.now()}`);
    const dataSnapshotDir = await join(troubleshootingRoot, 'data');
    const osProfilePath = await join(troubleshootingRoot, 'os-profile.json');

    removeOnFinish.push({ path: troubleshootingRoot, recursive: true });

    await mkdir(dataSnapshotDir, { recursive: true });
    await copyDirectorySnapshot(await getInstanceConfigDir(), dataSnapshotDir, includeWalletMnemonics.value);
    troubleshootingProgress.value = Math.max(troubleshootingProgress.value, 75);

    const osProfile = await invokeWithTimeout<string>('collect_troubleshooting_os_profile', {}, 15e3);
    await writeTextFile(osProfilePath, osProfile);
    troubleshootingProgress.value = Math.max(troubleshootingProgress.value, 85);

    const pathsWithPrefixes: [string, string][] = [
      ['logs', localLogDir.value],
      ['data', dataSnapshotDir],
      ['profile', osProfilePath],
    ];

    if (serverPackagePath) {
      pathsWithPrefixes.push(['server', serverPackagePath]);
    }

    const zipProgressEventKey = `troubleshooting_zip_progress_${Date.now()}`;
    unsubZipProgress = await listen<number>(zipProgressEventKey, event => {
      const zipProgress = 85 + (event.payload / 100) * 14;
      troubleshootingProgress.value = Math.max(troubleshootingProgress.value, Math.min(99, zipProgress));
      if (event.payload === 100) {
        unsubZipProgress?.();
        unsubZipProgress = undefined;
      }
    });

    await invokeWithTimeout(
      'create_zip',
      {
        eventProgressKey: zipProgressEventKey,
        pathsWithPrefixes,
        zipName: zipPath,
      },
      300e3,
    );

    troubleshootingProgress.value = Math.max(troubleshootingProgress.value, 99);
    await revealItemInDir(zipPath);
    troubleshootingProgress.value = 100;
  } catch (err) {
    console.error('Error downloading troubleshooting package:', err);
    troubleshootingError.value = `Error downloading troubleshooting package: ${err}`;
  } finally {
    unsubZipProgress?.();

    for (const { path, recursive } of removeOnFinish) {
      await remove(path, recursive ? { recursive } : undefined).catch(error => {
        console.warn(`Unable to remove troubleshooting temp path ${path}:`, error);
      });
    }
    isCreatingTroubleshootingPackage.value = false;
    troubleshootingProgress.value = 0;
  }
}

async function copyDirectorySnapshot(sourceDir: string, destinationDir: string, includeMnemonic: boolean) {
  await mkdir(destinationDir, { recursive: true });

  for (const entry of await readDir(sourceDir)) {
    if (!entry.name) {
      continue;
    }
    if (entry.name === '.DS_Store') {
      continue;
    }
    if (!includeMnemonic && entry.name === 'mnemonic') {
      continue;
    }

    const sourcePath = await join(sourceDir, entry.name);
    const destinationPath = await join(destinationDir, entry.name);

    if (entry.isDirectory) {
      await copyDirectorySnapshot(sourcePath, destinationPath, includeMnemonic);
      continue;
    }
    if (entry.isFile) {
      await copyFile(sourcePath, destinationPath);
    }
  }
}

Vue.onMounted(async () => {
  const dataDir = await appConfigDir();
  localDataDir.value = `${dataDir}/${Db.relativeDir}`;
  localLogDir.value = await appLogDir();
});
</script>

<style scoped>
@reference "../../../main.css";

header {
  @apply text-lg font-bold;
}
</style>
