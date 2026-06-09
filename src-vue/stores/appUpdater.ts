import * as Vue from 'vue';
import { defineStore } from 'pinia';
import { toRaw } from 'vue';
import { app } from '@tauri-apps/api';
import { relaunch } from '@tauri-apps/plugin-process';
import { check } from '@tauri-apps/plugin-updater';
import { ENABLE_AUTO_UPDATE } from '../lib/Env.ts';

type AppUpdate = Awaited<ReturnType<typeof check>>;

export const useAppUpdater = defineStore('appUpdater', () => {
  const installedVersion = Vue.ref('loading');
  const update = Vue.ref<AppUpdate>(null);
  const isChecking = Vue.ref(false);
  const isDownloading = Vue.ref(false);
  const isReadyToInstall = Vue.ref(false);
  const downloadProgress = Vue.ref(0);
  const errorMessage = Vue.ref('');
  const lastCheckedAt = Vue.ref<Date | null>(null);

  let isStarted = false;
  let versionPromise: Promise<string> | null = null;
  let updateCheckPromise: Promise<AppUpdate> | null = null;
  let updatePollInterval: ReturnType<typeof setInterval> | null = null;

  function start() {
    if (isStarted) {
      return;
    }

    isStarted = true;
    void ensureInstalledVersion().catch(console.error);

    if (ENABLE_AUTO_UPDATE && !updatePollInterval) {
      updatePollInterval = setInterval(() => {
        void checkForUpdates();
      }, 60e3);
    }
  }

  async function ensureInstalledVersion(): Promise<string> {
    if (installedVersion.value !== 'loading') {
      return installedVersion.value;
    }

    versionPromise ??= app
      .getVersion()
      .then(version => {
        installedVersion.value = version;
        return version;
      })
      .catch(error => {
        console.error('Error loading app version', error);
        installedVersion.value = 'unknown';
        return installedVersion.value;
      });

    return versionPromise;
  }

  async function checkForUpdates(): Promise<AppUpdate> {
    if (updateCheckPromise) {
      return updateCheckPromise;
    }

    updateCheckPromise = Promise.resolve().then(async () => {
      isChecking.value = true;

      try {
        const nextUpdate = await check();
        const hasNewVersion = nextUpdate?.version !== update.value?.version;

        lastCheckedAt.value = new Date();
        update.value = nextUpdate;

        if (hasNewVersion) {
          downloadProgress.value = 0;
          errorMessage.value = '';
          isReadyToInstall.value = false;
        }

        return nextUpdate;
      } catch (error) {
        console.error('Error checking for updates', error);
        return update.value as AppUpdate;
      } finally {
        isChecking.value = false;
        updateCheckPromise = null;
      }
    });

    return updateCheckPromise;
  }

  async function downloadAndInstallUpdate() {
    if (!update.value || isReadyToInstall.value) {
      return;
    }

    isDownloading.value = true;
    errorMessage.value = '';
    downloadProgress.value = 0;

    try {
      let downloaded = 0;
      let contentLength = 0;

      await toRaw(update.value).downloadAndInstall(event => {
        switch (event.event) {
          case 'Started':
            contentLength = event.data.contentLength ?? 0;
            console.log(`started downloading ${event.data.contentLength} bytes`);
            break;
          case 'Progress':
            downloaded += event.data.chunkLength;
            downloadProgress.value = contentLength ? downloaded / contentLength : 0;
            console.log(`downloaded ${downloaded} from ${contentLength}`);
            break;
          case 'Finished':
            console.log('download finished');
            downloadProgress.value = 1;
            break;
        }
      });

      isReadyToInstall.value = true;
    } catch (error) {
      console.error('Error during download', error);
      errorMessage.value = 'Error downloading update. Please try again later.';
    } finally {
      isDownloading.value = false;
    }
  }

  async function relaunchToInstallUpdate() {
    try {
      console.log(`Relaunching app to install new version (${update.value?.version ?? 'unknown'})`);
      isDownloading.value = false;
      await relaunch();
    } catch (error) {
      console.error('Error during relaunch', error);
    }
  }

  return {
    installedVersion,
    update,
    isChecking,
    isDownloading,
    isReadyToInstall,
    downloadProgress,
    errorMessage,
    lastCheckedAt,
    start,
    ensureInstalledVersion,
    checkForUpdates,
    downloadAndInstallUpdate,
    relaunchToInstallUpdate,
  };
});
