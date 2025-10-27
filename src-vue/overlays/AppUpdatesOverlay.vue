<!-- prettier-ignore -->
<template>
  <DialogRoot class="absolute inset-0 z-10" :open="isOpen">
    <DialogPortal>
      <AnimatePresence>
        <DialogOverlay asChild>
          <Motion asChild :initial="{ opacity: 0 }" :animate="{ opacity: 1 }" :exit="{ opacity: 0 }">
            <BgOverlay @close="closeOverlay" />
          </Motion>
        </DialogOverlay>

        <DialogContent asChild @escapeKeyDown="closeOverlay" :aria-describedby="undefined">
          <Motion
            :ref="draggable.setModalRef"
            :initial="{ opacity: 0 }"
            :animate="{ opacity: 1 }"
            :exit="{ opacity: 0 }"
            class="absolute z-50 bg-white border border-black/40 px-3 pt-6 pb-4 rounded-lg shadow-xl w-160 min-h-60 overflow-scroll focus:outline-none"
            :style="{
              top: `calc(50% + ${draggable.modalPosition.y}px)`,
              left: `calc(50% + ${draggable.modalPosition.x}px)`,
              transform: 'translate(-50%, -50%)',
              cursor: draggable.isDragging ? 'grabbing' : 'default',
            }"
          >
            <h2
              class="pb-4 mb-5 px-3 flex flex-row justify-between items-center text-2xl font-bold text-slate-800/70 border-b border-slate-300 select-none"
              @mousedown="draggable.onMouseDown($event)"
            >
           {{ update ? 'Update Available' : 'Checking for Updates' }}
              <DialogClose
                @click="closeOverlay"
                class="z-10 flex items-center justify-center text-sm/6 font-semibold cursor-pointer border rounded-md w-[30px] h-[30px] focus:outline-none border-slate-400/60 hover:border-slate-500/60 hover:bg-[#f1f3f7]"
              >
                <XMarkIcon class="w-5 h-5 text-[#B74CBA] stroke-4" />
              </DialogClose>
            </h2>


            <div class="px-6 text-lg pb-3 mb-6 relative z-10 grid grid-col gap-2">
              <p class="text-lg mb-2">
                <template v-if="update">
                  A new version of Argon Investor Console is ready to download and install
                </template>
                <template v-else-if="isChecking">
                  Checking..
                </template>
                <template v-else>
                  You are already on the latest version of Argon Investor. No updates available.
                </template>
              </p>
              <div class="grid grid-cols-2 grow-col">
                <div class="text-md font-bold">Installed Version</div>
                <div class="text-md font-light">{{version}}</div>
              </div>
              <div class="grid grid-cols-2 grow-col" v-if="update">
                <div class="text-md font-bold">New Version</div>
                <div class="text-md font-light">{{update?.version}}</div>
              </div>
              <div class="grid grid-cols-2 grow-col" v-if="update">
                <div class="text-md font-bold">Release Date</div>
                <div class="text-md font-light">{{dayjs(update?.date).fromNow()}}</div>
              </div>
              <div class="grid grid-cols-2 grow-col" v-if="update">
                <div class="text-md font-bold">Release Notes</div>
                <div class="text-md font-bold"><a @click="openReleaseNotes" class="text-argon-500 hover:underline cursor-pointer">Read details ↗️</a></div>
              </div>

              <div class="border-t border-slate-300 pt-4" v-if="update">
                <ProgressBar :progress="downloadProgress" class="mb-5" v-if="downloadProgress" :has-error="errorMessage != ''" />
                <p class="text-red-500 text-lg mb-5" v-if="errorMessage">{{ errorMessage }}</p>
                <button
                  v-if="!isReadyToInstall"
                  @click="startUpgrade"
                  :disabled="isReadyToInstall"
                  class=" bg-argon-button border border-argon-button-hover hover:bg-argon-button-hover text-white font-bold inner-button-shadow px-12 py-2 rounded-md cursor-pointer"
                >
                  Install Update
                </button>
                <button v-else
                  @click="relaunchApp"
                  class="bg-argon-button border border-argon-button-hover hover:bg-argon-button-hover text-white font-bold inner-button-shadow px-12 py-2 rounded-md cursor-pointer">
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
import { toRaw } from 'vue';
import BgOverlay from '../components/BgOverlay.vue';
import Draggable from './helpers/Draggable.ts';
import ProgressBar from '../components/ProgressBar.vue';
import { app } from '@tauri-apps/api';
import { ENABLE_AUTO_UPDATE } from '../lib/Env.ts';
import basicEmitter from '../emitters/basicEmitter.ts';
import { check, Update } from '@tauri-apps/plugin-updater';
import { relaunch } from '@tauri-apps/plugin-process';
import { open as tauriOpenUrl } from '@tauri-apps/plugin-shell';
import { DialogClose, DialogContent, DialogOverlay, DialogPortal, DialogRoot } from 'reka-ui';
import { AnimatePresence, Motion } from 'motion-v';
import { XMarkIcon } from '@heroicons/vue/24/outline';
import dayjs from 'dayjs';

if (ENABLE_AUTO_UPDATE) {
  setInterval(() => checkForUpdates(true), 60e3);
}
const isOpen = Vue.ref(false);
const downloadProgress = Vue.ref(0);

const draggable = Vue.reactive(new Draggable());

const isChecking = Vue.ref(false);
const isDownloading = Vue.ref(false);
const update = Vue.ref<Update | null>(null);
const isReadyToInstall = Vue.ref(false);
const errorMessage = Vue.ref('');
const version = Vue.ref('loading');
app.getVersion().then(x => {
  version.value = x;
});

const lastChecked = Vue.ref<Date | null>(null);

async function relaunchApp() {
  try {
    isDownloading.value = false;
    await relaunch();
  } catch (e) {
    console.error('Error during relaunch', e);
  }
}

function openReleaseNotes() {
  tauriOpenUrl('https://github.com/argonprotocol/apps/tree/main/RELEASE_NOTES.md')
    .then(() => console.log('Release notes opened'))
    .catch(e => console.error('Error opening release notes', e));
}

function closeOverlay() {
  isOpen.value = false;
  isChecking.value = false;
}

async function startUpgrade() {
  if (update.value) {
    isDownloading.value = true;
    try {
      let downloaded = 0;
      let contentLength = 0;
      downloadProgress.value = 0;
      // alternatively we could also call update.download() and update.install() separately
      await toRaw(update.value).downloadAndInstall(event => {
        switch (event.event) {
          case 'Started':
            contentLength = event.data.contentLength ?? 0;
            console.log(`started downloading ${event.data.contentLength} bytes`);
            break;
          case 'Progress':
            downloaded += event.data.chunkLength;
            downloadProgress.value = downloaded / contentLength;
            console.log(`downloaded ${downloaded} from ${contentLength}`);
            break;
          case 'Finished':
            console.log('download finished');
            downloadProgress.value = 1;
            break;
        }
      });
      isReadyToInstall.value = true;
    } catch (e) {
      console.error('Error during download', e);
      errorMessage.value = 'Error downloading update. Please try again later.';
    } finally {
      isDownloading.value = false;
    }
  }
}

let lastAutoshownVersion = '';
async function checkForUpdates(showIfFound = false) {
  if (isChecking.value) {
    return;
  }
  isChecking.value = true;
  try {
    const newVersion = await check();
    lastChecked.value = new Date();
    if (newVersion && newVersion.version == update.value?.version) {
      console.log(newVersion);
      return;
    }
    update.value = newVersion;
    downloadProgress.value = 0;
    if (showIfFound && newVersion) {
      if (newVersion.version === lastAutoshownVersion) {
        console.log('Update already shown, skipping');
        return;
      }
      lastAutoshownVersion = newVersion.version;
      isOpen.value = true;
    }
  } catch (e) {
    console.error('Error checking for updates', e);
  } finally {
    isChecking.value = false;
  }
}

basicEmitter.on('openCheckForAppUpdatesOverlay', () => {
  isOpen.value = true;

  void checkForUpdates().catch(console.error);
});
</script>
