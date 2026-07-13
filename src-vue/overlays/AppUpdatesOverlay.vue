<!-- prettier-ignore -->
<template>
  <DialogRoot class="absolute inset-0 z-10" :open="isOpen">
    <DialogPortal>
      <AnimatePresence>
        <DialogOverlay asChild>
          <BgOverlay :style="{ zIndex: overlayZIndex.backdropZIndex }" @close="closeOverlay" />
        </DialogOverlay>

        <DialogContent asChild @escapeKeyDown="closeOverlay" :aria-describedby="undefined" :style="{ zIndex: overlayZIndex.contentZIndex }">
          <Motion
            :ref="draggable.setModalRef"
            :initial="{ opacity: 0 }"
            :animate="{ opacity: 1 }"
            :exit="{ opacity: 0 }"
            class="absolute min-h-60 w-160 overflow-scroll rounded-lg border border-black/40 bg-white px-3 pt-6 pb-4 shadow-xl focus:outline-none"
            :style="{
              top: `calc(50% + ${draggable.modalPosition.y}px)`,
              left: `calc(50% + ${draggable.modalPosition.x}px)`,
              transform: 'translate(-50%, -50%)',
              cursor: draggable.isDragging ? 'grabbing' : 'default',
            }">
            <h2
              class="mb-5 flex flex-row items-center justify-between border-b border-slate-300 px-3 pb-4 text-2xl font-bold text-slate-800/70 select-none"
              @mousedown="draggable.onMouseDown($event)">
              {{ update ? 'Update Available' : isChecking ? 'Checking for Updates' : 'No Updates Available' }}
              <DialogClose
                @click="closeOverlay"
                class="z-10 flex h-[30px] w-[30px] cursor-pointer items-center justify-center rounded-md border border-slate-400/60 text-sm/6 font-semibold hover:border-slate-500/60 hover:bg-[#f1f3f7] focus:outline-none">
                <XMarkIcon class="w-5 h-5 text-[#B74CBA] stroke-4" />
              </DialogClose>
            </h2>

            <div class="grid-col relative z-10 mb-6 grid gap-2 px-6 pb-3 text-base">
              <p class="mb-2">
                <template v-if="update">A new version of {{ APP_NAME }} is ready to download and install</template>
                <template v-else-if="isChecking">Checking...</template>
                <template v-else>You are already on the latest version. No updates available.</template>
              </p>

              <div class="flex flex-row gap-x-2">
                <div class="text-md font-bold">Installed Version</div>
                <div class="text-md font-light">{{ installedVersion }}</div>
              </div>

              <div v-if="update" class="flex flex-row gap-x-2">
                <div class="text-md font-bold">New Version</div>
                <div class="text-md font-light">{{ update?.version }}</div>
              </div>

              <div v-if="update" class="flex flex-row gap-x-2">
                <div class="text-md font-bold">Release Date</div>
                <div class="text-md font-light">{{ dayjs(update?.date).fromNow() }}</div>
              </div>

              <div v-if="update" class="flex flex-row gap-x-2">
                <div class="text-md font-bold">Release Notes</div>
                <div class="text-md font-bold">
                  <a @click="openReleaseNotes" class="text-argon-500 cursor-pointer hover:underline">Read details ↗️</a>
                </div>
              </div>

              <div v-if="update" class="border-t border-slate-300 pt-4">
                <ProgressBar
                  v-if="downloadProgress"
                  :progress="downloadProgress * 100"
                  :has-error="errorMessage !== ''"
                  class="mb-5" />
                <p v-if="errorMessage" class="mb-5 text-lg text-red-500">{{ errorMessage }}</p>
                <button
                  v-if="!isReadyToInstall"
                  @click="startUpgrade"
                  :disabled="isDownloading || isReadyToInstall"
                  class="bg-argon-button border-argon-button-hover hover:bg-argon-button-hover inner-button-shadow cursor-pointer rounded-md border px-12 py-2 font-bold text-white">
                  {{ isDownloading ? 'Downloading Update...' : 'Install Update' }}
                </button>
                <button
                  v-else
                  @click="relaunchApp"
                  class="bg-argon-button border-argon-button-hover hover:bg-argon-button-hover inner-button-shadow cursor-pointer rounded-md border px-12 py-2 font-bold text-white">
                  Restart App to Activate Update
                </button>
              </div>
            </div>
          </Motion>
        </DialogContent>
      </AnimatePresence>
    </DialogPortal>
  </DialogRoot>
</template>

<script setup lang="ts">
import * as Vue from 'vue';
import { storeToRefs } from 'pinia';
import BgOverlay from '../components/BgOverlay.vue';
import Draggable from './helpers/Draggable.ts';
import ProgressBar from '../components/ProgressBar.vue';
import { APP_NAME, ENABLE_AUTO_UPDATE } from '../lib/Env.ts';
import basicEmitter from '../emitters/basicEmitter.ts';
import { open as tauriOpenUrl } from '@tauri-apps/plugin-shell';
import { DialogClose, DialogContent, DialogOverlay, DialogPortal, DialogRoot } from 'reka-ui';
import { AnimatePresence, Motion } from 'motion-v';
import { XMarkIcon } from '@heroicons/vue/24/outline';
import dayjs from 'dayjs';
import { useAppUpdater } from '../stores/appUpdater.ts';
import { useOverlayZIndex } from './helpers/OverlayZIndex.ts';

const isOpen = Vue.ref(false);
const draggable = Vue.reactive(new Draggable());
const overlayZIndex = useOverlayZIndex(() => isOpen.value);
const updater = useAppUpdater();
const { downloadProgress, errorMessage, installedVersion, isChecking, isDownloading, isReadyToInstall, update } =
  storeToRefs(updater);

updater.start();

async function relaunchApp() {
  await updater.relaunchToInstallUpdate();
}

function openReleaseNotes() {
  tauriOpenUrl('https://github.com/argonprotocol/apps/tree/main/RELEASE_NOTES.md')
    .then(() => console.log('Release notes opened'))
    .catch(e => console.error('Error opening release notes', e));
}

function closeOverlay() {
  isOpen.value = false;
}

async function startUpgrade() {
  await updater.downloadAndInstallUpdate();
}

let lastAutoshownVersion = '';
Vue.watch(
  () => update.value?.version,
  version => {
    if (!ENABLE_AUTO_UPDATE || !version) {
      return;
    }
    if (version === lastAutoshownVersion) {
      return;
    }

    lastAutoshownVersion = version;
    isOpen.value = true;
  },
);

async function refreshUpdates() {
  const newVersion = await updater.checkForUpdates();
  if (newVersion) {
    console.log(newVersion);
  }
}

basicEmitter.on('openCheckForAppUpdatesOverlay', () => {
  isOpen.value = true;

  void refreshUpdates().catch(console.error);
});
</script>
