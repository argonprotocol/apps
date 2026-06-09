<template>
  <div
    class="from-argon-600/6 via-argon-menu-bg flex h-screen w-screen cursor-default flex-col overflow-hidden rounded-[10px] bg-gradient-to-br to-white"
  >
    <div
      class="flex min-h-14 w-full flex-row items-center bg-white/95 select-none"
      style="border-radius: 10px 10px 0 0; box-shadow: 0 2px 2px rgba(0, 0, 0, 0.2)"
      data-tauri-drag-region
    >
      <div class="pointer-events-none relative top-px flex w-1/2 flex-row items-center">
        <WindowControls />
        <div class="text-argon-text-primary text-[19px] font-bold whitespace-nowrap">
          {{ APP_NAME }}
        </div>
      </div>

      <div class="pointer-events-none relative top-px mr-3 flex w-1/2 grow flex-row items-center justify-end space-x-2">
        <button
          class="text-argon-600 border-argon-600/20 hover:border-argon-600/40 hover:bg-argon-600/6 pointer-events-auto cursor-pointer rounded-full border bg-white/70 px-4 py-2 text-sm font-semibold transition disabled:opacity-70"
          :disabled="isLoading"
          @click="runtimeCompatibility.refreshCompatibility('manual')"
        >
          <template v-if="isLoading">Loading...</template>
          <template v-else>Retry Now</template>
        </button>
      </div>
    </div>

    <main class="relative flex h-full items-center justify-center px-6 py-20">
      <div v-if="isLoading" class="mb-8 flex flex-col items-center justify-center py-10">
        <Spinner class="mr-0" />
        <div class="text-argon-600/70 mt-4 text-xs font-semibold tracking-[0.3em] uppercase">Loading</div>
      </div>
      <section
        v-else
        class="inner-input-shadow bg-argon-menu-bg w-full max-w-3xl rounded-md border border-black/30 p-8 backdrop-blur"
        style="
          box-shadow:
            0 -1px 2px 0 rgba(0, 0, 0, 0.1),
            inset 0 2px 0 rgba(255, 255, 255, 1);
        "
      >
        <div class="mb-8">
          <div
            v-if="phase === 'paused'"
            class="text-argon-600/70 mb-3 text-xs font-semibold tracking-[0.35em] uppercase"
          >
            Network Upgrade In Progress
          </div>
          <div
            v-else-if="phase === 'upgrade-required'"
            class="text-argon-600/70 mb-3 text-xs font-semibold tracking-[0.35em] uppercase"
          >
            Update Required
          </div>

          <h1 class="text-argon-text-primary mb-4 text-4xl leading-tight font-semibold">
            <template v-if="phase === 'paused'">
              This version of {{ APP_NAME }} is incompatible with the current Argon network.
            </template>
            <template v-else>A new {{ APP_NAME }} version is required before you can continue.</template>
          </h1>
        </div>

        <div
          v-if="updaterErrorMessage || compatibilityErrorMessage"
          class="text-argon-text-primary border-argon-600/15 bg-argon-600/6 mb-6 rounded-md border px-4 py-3 text-sm leading-6"
        >
          {{ updaterErrorMessage || compatibilityErrorMessage }}
        </div>

        <div v-if="downloadProgress" class="mb-5">
          <ProgressBar
            :progress="downloadProgress * 100"
            :has-error="updaterErrorMessage !== ''"
            :show-label="false"
            class="runtime-download-progress"
          />
        </div>

        <div class="flex flex-wrap items-center gap-3">
          <button
            v-if="update && !isReadyToInstall"
            :disabled="isDownloading"
            class="bg-argon-button hover:bg-argon-button-hover border-argon-button-hover cursor-pointer rounded-full border px-6 py-3 text-sm font-semibold text-white transition disabled:cursor-not-allowed disabled:opacity-60"
            @click="updater.downloadAndInstallUpdate()"
          >
            {{ isDownloading ? 'Downloading Update...' : 'Install Update' }}
          </button>
          <button
            v-else-if="isReadyToInstall"
            class="bg-argon-600 hover:bg-argon-700 border-argon-700 cursor-pointer rounded-full border px-6 py-3 text-sm font-semibold text-white transition"
            @click="updater.relaunchToInstallUpdate()"
          >
            Restart App to Activate Update
          </button>
          <div class="text-argon-text-primary/80 max-w-2xl text-xl leading-7">
            <template v-if="phase === 'upgrade-required'">Install the latest app update to continue.</template>
            <template v-else>Waiting for a compatible app update...</template>
          </div>
        </div>
      </section>
    </main>
  </div>
</template>

<script setup lang="ts">
import { storeToRefs } from 'pinia';
import WindowControls from '../../tauri-controls/WindowControls.vue';
import ProgressBar from '../../components/ProgressBar.vue';
import Spinner from '../../components/Spinner.vue';
import { APP_NAME } from '../../lib/Env.ts';
import { useAppUpdater } from '../../stores/appUpdater.ts';
import { useRuntimeCompatibility } from '../../stores/runtimeCompatibility.ts';

const updater = useAppUpdater();
const runtimeCompatibility = useRuntimeCompatibility();
const {
  downloadProgress,
  errorMessage: updaterErrorMessage,
  isDownloading,
  isReadyToInstall,
  update,
} = storeToRefs(updater);
const { errorMessage: compatibilityErrorMessage, isLoading, phase } = storeToRefs(runtimeCompatibility);
</script>
