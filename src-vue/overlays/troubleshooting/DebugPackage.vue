<template>
  <ul class="space-y-4 px-4 pt-2 pb-5">
    <li class="flex flex-col">
      <p>Download a debugging package to share with support:</p>
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
      </div>
      <p v-if="savedPackagePath" class="mt-3 text-sm text-slate-600">
        Saved debugging package:
        <a
          :href="savedPackagePath"
          :title="savedPackagePath"
          class="text-argon-600 cursor-pointer break-all underline"
          @click.prevent="revealSavedPackage"
        >
          {{ savedPackagePath.split(/[\\/]/).at(-1) }}
        </a>
      </p>
    </li>
  </ul>
</template>

<script setup lang="ts">
import * as Vue from 'vue';
import { invoke } from '@tauri-apps/api/core';
import { appLogDir, downloadDir, join, tempDir } from '@tauri-apps/api/path';
import { listen } from '@tauri-apps/api/event';
import { revealItemInDir } from '@tauri-apps/plugin-opener';
import { Config, getConfig } from '../../stores/config.ts';
import { Diagnostics } from '../../lib/Diagnostics.ts';
import ProgressBar from '../../components/ProgressBar.vue';
import { invokeWithTimeout } from '../../lib/tauriApi.ts';
import { copyFile, mkdir, readDir, remove, writeTextFile } from '@tauri-apps/plugin-fs';
import { getInstanceConfigDir } from '../../lib/Utils.ts';
import { getWalletKeys } from '../../stores/wallets.ts';
import { INSTANCE_NAME, LOG_FILE_PREFIX } from '../../lib/Env.ts';

const { includeServer = true } = defineProps<{ includeServer?: boolean }>();

const troubleshootingProgress = Vue.ref(0);
const isCreatingTroubleshootingPackage = Vue.ref(false);
const troubleshootingError = Vue.ref('');
const savedPackagePath = Vue.ref('');

async function downloadTroubleshooting() {
  isCreatingTroubleshootingPackage.value = true;
  troubleshootingProgress.value = 0;
  troubleshootingError.value = '';
  const removeOnFinish: { path: string; recursive?: boolean }[] = [];
  let unsubZipProgress: (() => void) | undefined;

  try {
    const timestamp = Date.now();
    const troubleshootingRoot = await join(await tempDir(), `argon_${INSTANCE_NAME}_troubleshooting_${timestamp}`);
    const dataSnapshotDir = await join(troubleshootingRoot, 'data');
    const osProfilePath = await join(troubleshootingRoot, 'os-profile.json');
    const collectionErrorsPath = await join(troubleshootingRoot, 'collection-errors.txt');
    const collectionErrors: string[] = [];
    const zipPath = await join(await downloadDir(), `argon_${INSTANCE_NAME}_troubleshooting_${timestamp}.zip`);
    let serverPackagePath: string | undefined;
    let hasOsProfile = false;

    removeOnFinish.push({ path: troubleshootingRoot, recursive: true });
    await mkdir(dataSnapshotDir, { recursive: true });

    let diagnostics: Diagnostics | undefined;
    if (includeServer) diagnostics = new Diagnostics(getConfig() as Config, getWalletKeys());
    if (diagnostics?.hasServer()) {
      try {
        await diagnostics.load();
        const downloadPath = await diagnostics.downloadTroubleshootingPackage(progress => {
          troubleshootingProgress.value = progress * 0.6;
        });
        serverPackagePath = downloadPath;
        removeOnFinish.push({ path: downloadPath });
      } catch (error) {
        console.warn('Unable to include server debugging package:', error);
        collectionErrors.push(`Server debugging package: ${String(error)}`);
        troubleshootingProgress.value = Math.max(troubleshootingProgress.value, 15);
      }
    } else {
      troubleshootingProgress.value = 15;
    }

    await copyDirectorySnapshot(await getInstanceConfigDir(), dataSnapshotDir, collectionErrors);
    troubleshootingProgress.value = Math.max(troubleshootingProgress.value, 75);

    try {
      const osProfile = await invokeWithTimeout<string>('collect_troubleshooting_os_profile', {}, 15e3);
      await writeTextFile(osProfilePath, osProfile);
      hasOsProfile = true;
    } catch (error) {
      collectionErrors.push(`Local OS profile: ${String(error)}`);
    }
    troubleshootingProgress.value = Math.max(troubleshootingProgress.value, 85);

    const localLogDir = await appLogDir();
    const logEntries = await readDir(localLogDir).catch(error => {
      collectionErrors.push(`Local logs: ${String(error)}`);
      return [];
    });
    const pathsWithPrefixes: [string, string][] = [];
    for (const entry of logEntries) {
      if (!entry.isFile || !entry.name.startsWith(LOG_FILE_PREFIX)) continue;
      const suffix = entry.name.slice(LOG_FILE_PREFIX.length);
      // Current file and timestamped rotations from the native logger.
      if (suffix !== '.log' && !/^_\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}\.log(?:\.bak)?$/.test(suffix)) continue;
      pathsWithPrefixes.push(['logs', await join(localLogDir, entry.name)]);
    }
    pathsWithPrefixes.push(['data', dataSnapshotDir]);

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

    // A frontend timeout cannot stop the native job; keep its inputs until it actually finishes.
    await invoke('create_zip', {
      eventProgressKey: zipProgressEventKey,
      pathsWithPrefixes,
      zipName: zipPath,
    });

    troubleshootingProgress.value = 100;
    savedPackagePath.value = zipPath;
    await revealSavedPackage();
  } catch (err) {
    console.error('Error downloading debugging package:', err);
    troubleshootingError.value = 'Could not save the debugging package. Please try again.';
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

async function revealSavedPackage() {
  await revealItemInDir(savedPackagePath.value).catch(error => {
    console.warn('Unable to reveal the saved debugging package:', error);
  });
}

async function copyDirectorySnapshot(sourceDir: string, destinationDir: string, collectionErrors: string[]) {
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
    if (entry.name.toLowerCase().startsWith('mnemonic')) {
      continue;
    }
    // An unfinished account replacement can still contain its keychain encryption key.
    if (entry.name.startsWith('wallet.tmp.json')) {
      continue;
    }

    const sourcePath = await join(sourceDir, entry.name);
    const destinationPath = await join(destinationDir, entry.name);

    if (entry.isDirectory) {
      await copyDirectorySnapshot(sourcePath, destinationPath, collectionErrors);
      continue;
    }
    if (entry.isFile) {
      await copyFile(sourcePath, destinationPath).catch(error => {
        collectionErrors.push(`Copy local data file ${sourcePath}: ${String(error)}`);
      });
    }
  }
}
</script>

<style scoped>
@reference "../../main.css";

header {
  @apply text-lg font-bold;
}
</style>
