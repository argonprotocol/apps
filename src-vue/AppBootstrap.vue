<template>
  <div
    class="from-argon-600/6 via-argon-menu-bg flex h-screen w-screen cursor-default flex-col overflow-hidden rounded-[10px] bg-gradient-to-br to-white"
  >
    <div
      class="TopBar relative flex min-h-14 w-full flex-row items-center bg-white/95 select-none"
      style="border-radius: 10px 10px 0 0; box-shadow: 0 2px 2px rgba(0, 0, 0, 0.2)"
      data-tauri-drag-region
    >
      <!-- prettier-ignore -->
      <div class="pointer-events-none absolute top-0 right-0 h-[calc(100%+4px)] w-2/3 rounded-tr-[10px] bg-gradient-to-r from-transparent via-[var(--bg-color)] via-55% to-[var(--bg-color)]" />
      <!-- prettier-ignore -->
      <div class="absolute right-2 -bottom-px h-px w-full bg-slate-400/30" />
      <div class="pointer-events-none relative top-px flex w-1/2 flex-row items-center">
        <WindowControls />
        <div class="relative top-px text-[19px] font-bold whitespace-nowrap">
          {{ APP_NAME }}
        </div>
      </div>

      <div class="pointer-events-none relative top-px mr-3 flex w-1/2 grow flex-row items-center justify-end space-x-2">
        <button
          v-if="shouldShowCompatibilityScreen && !isBrowserUnsupported && !isLoading && phase !== 'upgrade-required'"
          class="text-argon-600 border-argon-600/20 hover:border-argon-600/40 hover:bg-argon-600/6 pointer-events-auto cursor-pointer rounded-full border bg-white/70 px-4 py-2 text-sm font-semibold transition disabled:opacity-70"
          @click="runtimeCompatibility.refreshCompatibility('manual')"
        >
          Retry Now
        </button>
        <NavigationMenuRoot class="pointer-events-auto relative" :delay-duration="0">
          <NavigationMenuList>
            <AccountMenu startup-only :can-back-up-mnemonic="!isBrowserUnsupported" />
          </NavigationMenuList>
          <NavigationMenuViewport
            align="end"
            class="bg-argon-menu-bg absolute top-full left-[var(--reka-navigation-menu-viewport-left)] z-50 mt-2 h-[var(--reka-navigation-menu-viewport-height)] w-[var(--reka-navigation-menu-viewport-width)] rounded border border-gray-900/20 shadow-lg"
          />
        </NavigationMenuRoot>
      </div>
    </div>

    <main class="relative flex min-h-0 flex-1 items-center justify-center px-6 py-20">
      <section
        v-if="shouldShowCompatibilityScreen && !isLoading"
        class="inner-input-shadow bg-argon-menu-bg w-full max-w-3xl rounded-md border border-black/30 p-8 backdrop-blur"
        style="
          box-shadow:
            0 -1px 2px 0 rgba(0, 0, 0, 0.1),
            inset 0 2px 0 rgba(255, 255, 255, 1);
        "
      >
        <div class="mb-8">
          <div
            v-if="isBrowserUnsupported"
            class="text-argon-600/70 mb-3 text-xs font-semibold tracking-[0.35em] uppercase"
          >
            {{ webRuntimeRequirement.name }} Required
          </div>
          <div
            v-else-if="phase === 'paused'"
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
            <template v-if="isBrowserUnsupported">Argon Desktop requires {{ webRuntimeRequirement.name }}.</template>
            <template v-else-if="phase === 'paused'">
              The Argon Network has been upgraded and needs a new version of {{ APP_NAME }} to work properly.
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
            <template v-if="isBrowserUnsupported">
              {{ webRuntimeRequirement.updateInstructions }} Then close and reopen Argon Desktop.
            </template>
            <template v-else-if="phase === 'upgrade-required'">Install the latest app update to continue.</template>
            <template v-else>Waiting for a compatible app update...</template>
          </div>
        </div>
      </section>
      <section
        v-else-if="isRecovering"
        class="max-h-full w-full max-w-xl overflow-y-auto rounded-lg border border-slate-300 bg-white p-6"
      >
        <h1 class="mb-4 text-xl font-bold text-slate-700">Recover Account Access</h1>
        <FromMnemonic recovery-only @close="isRecovering = false" @recovered="openAccount" />
      </section>
      <section v-else-if="startup.errorMessage && !startup.isLoading" class="w-full max-w-sm text-center">
        <p class="mt-4 text-sm text-slate-600" role="alert">{{ startup.errorMessage }}</p>
        <button
          type="button"
          class="bg-argon-button hover:bg-argon-button-hover mt-6 cursor-pointer rounded-md px-4 py-1 font-bold text-white"
          @click="openAccount()"
        >
          Try again
        </button>
        <button
          type="button"
          class="mt-4 block w-full cursor-pointer text-sm text-slate-600 underline"
          @click="isRecovering = true"
        >
          Recover from Mnemonic
        </button>
      </section>
      <div v-else class="flex flex-col items-center pb-12 text-center" role="status" aria-live="polite">
        <div class="mt-7 flex items-center justify-center gap-3 font-light text-gray-500">
          <Spinner class="mr-0" aria-hidden="true" />
          <span>Loading…</span>
        </div>
      </div>
    </main>
  </div>
</template>

<script setup lang="ts">
import * as Vue from 'vue';
import { storeToRefs } from 'pinia';
import { useStartupStore } from './stores/startup.ts';
import FromMnemonic from './overlays/import-account/FromMnemonic.vue';
import type { EncryptionAuthentication } from './lib/EncryptionSecret.ts';
import WindowControls from './tauri-controls/WindowControls.vue';
import ProgressBar from './components/ProgressBar.vue';
import Spinner from './components/Spinner.vue';
import ArgonLogo from './assets/wallets/tokens/argon.svg?component';
import AccountMenu from './navigation/AccountMenu.vue';
import { NavigationMenuList, NavigationMenuRoot, NavigationMenuViewport } from 'reka-ui';
import { APP_NAME } from './lib/Env.ts';
import { useAppUpdater } from './stores/appUpdater.ts';
import { useRuntimeCompatibility } from './stores/runtimeCompatibility.ts';
import { platformType } from './tauri-controls/utils/os.ts';

const emit = defineEmits<{ openAccount: [authentication?: EncryptionAuthentication] }>();

const startup = useStartupStore();
const isRecovering = Vue.ref(false);

const updater = useAppUpdater();
const runtimeCompatibility = useRuntimeCompatibility();

const webRuntimeRequirement = {
  macos: {
    name: 'Safari 16.4 or later',
    updateInstructions: 'Update Safari to version 16.4 or later, or update macOS.',
  },
  windows: {
    name: 'Microsoft Edge WebView2 Runtime 111 or later',
    updateInstructions: 'Update Microsoft Edge WebView2 Runtime to version 111 or later, or update Windows.',
  },
  gnome: {
    name: 'WebKitGTK 2.40 or later',
    updateInstructions: 'Update WebKitGTK to version 2.40 or later using your Linux distribution.',
  },
}[platformType];

const {
  downloadProgress,
  errorMessage: updaterErrorMessage,
  isDownloading,
  isReadyToInstall,
  update,
} = storeToRefs(updater);
const {
  errorMessage: compatibilityErrorMessage,
  isBrowserUnsupported,
  isLoading,
  phase,
  shouldShowCompatibilityScreen,
} = storeToRefs(runtimeCompatibility);

function openAccount(authentication?: EncryptionAuthentication) {
  isRecovering.value = false;
  emit('openAccount', authentication);
}
</script>
