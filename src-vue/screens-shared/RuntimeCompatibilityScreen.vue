<template>
  <div class="flex h-screen w-screen cursor-default flex-col overflow-hidden">
    <div
      class="flex min-h-14 w-full flex-row items-center bg-white/95 select-none"
      style="border-radius: 10px 10px 0 0; box-shadow: 0 2px 2px rgba(0, 0, 0, 0.2)"
      data-tauri-drag-region>
      <div class="pointer-events-none relative top-px flex w-1/2 flex-row items-center">
        <WindowControls />
        <div class="text-[19px] font-bold whitespace-nowrap">
          {{ APP_NAME }}
        </div>
      </div>

      <div class="pointer-events-none relative top-px mr-3 flex w-1/2 grow flex-row items-center justify-end space-x-2">
        <button
          class="text-argon-600 pointer-events-auto rounded-full border border-white/15 px-4 py-2 text-sm font-semibold transition hover:border-white/30 hover:text-white"
          :disabled="isLoading"
          @click="runtimeCompatibility.refreshCompatibility('manual')">
          <template v-if="isLoading">Loading...</template>
          <template v-else>Retry Now</template>
        </button>
      </div>
    </div>

    <main class="relative flex h-full items-center justify-center px-6 py-20">
      <div v-if="isLoading" class="mb-8 flex flex-col items-center justify-center py-10">
        <Spinner class="mr-0" />
        <div class="mt-4 text-xs font-semibold tracking-[0.3em] text-slate-400 uppercase">Loading</div>
      </div>
      <section
        v-else
        class="bg-argon-700 w-full max-w-3xl rounded-4xl border border-white/10 p-8 shadow-2xl shadow-black/40 backdrop-blur">
        <div class="mb-8">
          <div
            v-if="phase === 'paused'"
            class="mb-3 text-xs font-semibold tracking-[0.35em] text-amber-300/80 uppercase">
            Network Upgrade In Progress
          </div>
          <div
            v-else-if="phase === 'upgrade-required'"
            class="mb-3 text-xs font-semibold tracking-[0.35em] text-amber-300/80 uppercase">
            Update Required
          </div>

          <h1 class="mb-4 text-4xl leading-tight font-semibold text-white">
            <template v-if="phase === 'paused'">
              This version of {{ APP_NAME }} is incompatible with the current Argon network.
            </template>
            <template v-else>A new {{ APP_NAME }} version is required before you can continue.</template>
          </h1>
        </div>

        <div
          v-if="updaterErrorMessage || compatibilityErrorMessage"
          class="mb-6 rounded-2xl border border-amber-400/25 bg-amber-400/10 px-4 py-3 text-sm leading-6 text-amber-100">
          {{ updaterErrorMessage || compatibilityErrorMessage }}
        </div>

        <div v-if="downloadProgress" class="mb-5">
          <ProgressBar :progress="downloadProgress * 100" :has-error="updaterErrorMessage !== ''" />
        </div>

        <div class="flex flex-wrap items-center gap-3">
          <button
            v-if="update && !isReadyToInstall"
            :disabled="isDownloading"
            class="rounded-full bg-amber-400 px-6 py-3 text-sm font-semibold text-slate-950 transition hover:bg-amber-300 disabled:cursor-not-allowed disabled:bg-amber-400/60"
            @click="updater.downloadAndInstallUpdate()">
            {{ isDownloading ? 'Downloading Update...' : 'Install Update' }}
          </button>
          <button
            v-else-if="isReadyToInstall"
            class="rounded-full bg-emerald-400 px-6 py-3 text-sm font-semibold text-slate-950 transition hover:bg-emerald-300"
            @click="updater.relaunchToInstallUpdate()">
            Restart App to Activate Update
          </button>
          <div class="max-w-2xl text-xl leading-7 text-slate-200/85">
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
import WindowControls from '../tauri-controls/WindowControls.vue';
import ProgressBar from '../components/ProgressBar.vue';
import Spinner from '../components/Spinner.vue';
import { APP_NAME } from '../lib/Env.ts';
import { useAppUpdater } from '../stores/appUpdater.ts';
import { useRuntimeCompatibility } from '../stores/runtimeCompatibility.ts';

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
