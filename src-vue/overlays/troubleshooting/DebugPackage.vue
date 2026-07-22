<template>
  <ul class="space-y-4 px-4 pt-2 pb-5">
    <li class="flex flex-col">
      <p>Download a troubleshooting package from your mining machine:</p>
      <ProgressBar
        :progress="troubleshootingProgress"
        class="my-2"
        v-if="isCreatingTroubleshootingPackage || troubleshootingProgress > 0"
      />
      <span v-if="troubleshootingError" class="text-sm text-red-500">
        {{ troubleshootingError }}
      </span>
      <span v-if="troubleshootingWarning" class="text-sm text-amber-600">
        {{ troubleshootingWarning }}
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
</template>

<script setup lang="ts">
import * as Vue from 'vue';
import { appConfigDir, appLogDir, join, tempDir } from '@tauri-apps/api/path';
import { listen } from '@tauri-apps/api/event';
import { revealItemInDir } from '@tauri-apps/plugin-opener';
import Checkbox from '../../components/Checkbox.vue';
import { Config, getConfig } from '../../stores/config.ts';
import { Diagnostics } from '../../lib/Diagnostics.ts';
import ProgressBar from '../../components/ProgressBar.vue';
import { invokeWithTimeout } from '../../lib/tauriApi.ts';
import { copyFile, mkdir, readDir, remove, writeTextFile } from '@tauri-apps/plugin-fs';
import { getInstanceConfigDir } from '../../lib/Utils.ts';
import { getWalletKeys } from '../../stores/wallets.ts';
import { INSTANCE_NAME } from '../../lib/Env.ts';

const config = getConfig();
const walletKeys = getWalletKeys();

const diagnostics = new Diagnostics(config as Config, walletKeys);
const localLogDir = Vue.ref('');
const troubleshootingProgress = Vue.ref(0);
const isCreatingTroubleshootingPackage = Vue.ref(false);
const troubleshootingError = Vue.ref('');
const troubleshootingWarning = Vue.ref('');
const includeWalletMnemonics = Vue.ref(false);

async function downloadTroubleshooting() {
  isCreatingTroubleshootingPackage.value = true;
  troubleshootingProgress.value = 0;
  troubleshootingError.value = '';
  troubleshootingWarning.value = '';
  const removeOnFinish: { path: string; recursive?: boolean }[] = [];
  let unsubZipProgress: (() => void) | undefined;

  try {
    const timestamp = Date.now();
    const troubleshootingRoot = await join(await tempDir(), `argon_${INSTANCE_NAME}_troubleshooting_${timestamp}`);
    const dataSnapshotDir = await join(troubleshootingRoot, 'data');
    const osProfilePath = await join(troubleshootingRoot, 'os-profile.json');
    const collectionErrorsPath = await join(troubleshootingRoot, 'collection-errors.txt');
    const collectionErrors: string[] = [];
    let zipPath = await join(await tempDir(), `argon_${INSTANCE_NAME}_troubleshooting_${timestamp}.zip`);
    let serverPackagePath: string | undefined;
    let hasOsProfile = false;

    removeOnFinish.push({ path: troubleshootingRoot, recursive: true });
    await mkdir(dataSnapshotDir, { recursive: true });

    if (diagnostics.hasServer()) {
      try {
        await diagnostics.load();
        const downloadPath = await diagnostics.downloadTroubleshootingPackage(x => {
          troubleshootingProgress.value = Math.min(60, x);
        });
        serverPackagePath = downloadPath;
        removeOnFinish.push({ path: downloadPath });
        zipPath = downloadPath.replace('.tar.gz', '.zip');
      } catch (error) {
        console.warn('Unable to include server troubleshooting package:', error);
        collectionErrors.push(`Server troubleshooting package: ${String(error)}`);
        troubleshootingWarning.value = 'Server diagnostics failed. The downloaded package contains local diagnostics.';
        troubleshootingProgress.value = Math.max(troubleshootingProgress.value, 15);
      }
    } else {
      troubleshootingProgress.value = 15;
    }

    await copyDirectorySnapshot(
      await getInstanceConfigDir(),
      dataSnapshotDir,
      includeWalletMnemonics.value,
      collectionErrors,
    );
    troubleshootingProgress.value = Math.max(troubleshootingProgress.value, 75);

    try {
      const osProfile = await invokeWithTimeout<string>('collect_troubleshooting_os_profile', {}, 15e3);
      await writeTextFile(osProfilePath, osProfile);
      hasOsProfile = true;
    } catch (error) {
      collectionErrors.push(`Local OS profile: ${String(error)}`);
    }
    troubleshootingProgress.value = Math.max(troubleshootingProgress.value, 85);

    const pathsWithPrefixes: [string, string][] = [
      ['logs', localLogDir.value],
      ['data', dataSnapshotDir],
    ];

    if (hasOsProfile) pathsWithPrefixes.push(['profile', osProfilePath]);
    if (serverPackagePath) {
      pathsWithPrefixes.push(['server', serverPackagePath]);
    }
    if (collectionErrors.length) {
      await writeTextFile(collectionErrorsPath, collectionErrors.join('\n\n'));
      pathsWithPrefixes.push(['errors', collectionErrorsPath]);
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

async function copyDirectorySnapshot(
  sourceDir: string,
  destinationDir: string,
  includeMnemonic: boolean,
  collectionErrors: string[],
) {
  await mkdir(destinationDir, { recursive: true }).catch(error => {
    collectionErrors.push(`Create local snapshot directory ${destinationDir}: ${String(error)}`);
  });

  const entries = await readDir(sourceDir).catch(error => {
    collectionErrors.push(`Read local data directory ${sourceDir}: ${String(error)}`);
    return [];
  });

  for (const entry of entries) {
    if (!entry.name) {
      continue;
    }
    if (entry.name === '.DS_Store') {
      continue;
    }
    if (entry.isDirectory && entry.name === 'virtual-machine') {
      continue;
    }
    if (!includeMnemonic && entry.name.toLowerCase().startsWith('mnemonic')) {
      continue;
    }

    const sourcePath = await join(sourceDir, entry.name);
    const destinationPath = await join(destinationDir, entry.name);

    if (entry.isDirectory) {
      await copyDirectorySnapshot(sourcePath, destinationPath, includeMnemonic, collectionErrors);
      continue;
    }
    if (entry.isFile) {
      await copyFile(sourcePath, destinationPath).catch(error => {
        collectionErrors.push(`Copy local data file ${sourcePath}: ${String(error)}`);
      });
    }
  }
}

Vue.onMounted(async () => {
  localLogDir.value = await appLogDir();
});
</script>

<style scoped>
@reference "../../main.css";

header {
  @apply text-lg font-bold;
}
</style>
