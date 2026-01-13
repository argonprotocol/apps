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
            @mousedown="draggable.onMouseDown($event)"
            :initial="{ opacity: 0 }"
            :animate="{ opacity: 1 }"
            :exit="{ opacity: 0 }"
            :style="{
              top: `calc(50% + ${draggable.modalPosition.y}px)`,
              left: `calc(50% + ${draggable.modalPosition.x}px)`,
              transform: 'translate(-50%, -50%)',
              cursor: draggable.isDragging ? 'grabbing' : 'default',
            }"
            class="absolute z-50 bg-white text-md border border-black/40 px-4 pt-6 pb-4 rounded-lg text-center shadow-xl w-80 overflow-scroll focus:outline-none"
          >
            <img src="/app-icon.png" class="w-14 h-14 rounded-lg mx-auto" />
            <DialogTitle class="text-lg font-bold mt-4">{{ APP_NAME }}</DialogTitle>
            <div class="flex flex-col gap-2 border-y border-black/10 py-4 mt-4">
              <div>Version: {{ config.version }}</div>
              <div>OS: {{ platformName }} {{ platformVersion }}</div>
              <div>Instance Name: {{ INSTANCE_NAME }}</div>
              <div>Internal Tauri Port: {{ INSTANCE_PORT }}</div>
              <div>Argon Network: {{ NETWORK_NAME }}</div>
            </div>
            <div class="flex justify-center gap-3 mt-4 mx-5">
              <button @click="copyDetails" class="w-1/2 cursor-pointer bg-slate-600/20 hover:bg-slate-600/15 border border-slate-900/10 inner-button-shadow text-slate-900 px-4 py-1 rounded-lg focus:outline-none">
                {{ wasCopied ? 'Copied!' : 'Copy' }}
              </button>
              <button @click="closeOverlay" class="w-1/2 cursor-pointer bg-slate-600/20 hover:bg-slate-600/15 border border-slate-900/10 inner-button-shadow text-slate-900 px-4 py-1 rounded-lg focus:outline-none">
                Close
              </button>
            </div>
            <div class="mt-4 italic text-black/50">
              Open source. Zero rights reserved.
            </div>
          </Motion>
        </DialogContent>
      </AnimatePresence>
    </DialogPortal>
  </DialogRoot>
</template>

<script setup lang="ts">
import * as Vue from 'vue';
import basicEmitter from '../emitters/basicEmitter';
import BgOverlay from '../components/BgOverlay.vue';
import { DialogContent, DialogOverlay, DialogPortal, DialogRoot, DialogTitle } from 'reka-ui';
import { AnimatePresence, Motion } from 'motion-v';
import { getConfig } from '../stores/config';
import Draggable from './helpers/Draggable';
import { platformName, platformVersion } from '../tauri-controls/utils/os';
import { APP_NAME, INSTANCE_NAME, INSTANCE_PORT, NETWORK_NAME } from '../lib/Env.ts';

const config = getConfig();

const isOpen = Vue.ref(false);
const wasCopied = Vue.ref(false);
const draggable = Vue.reactive(new Draggable());

basicEmitter.on('openAboutOverlay', async (data: any) => {
  isOpen.value = true;
  draggable.modalPosition = { x: 0, y: 0 };
});

function closeOverlay() {
  isOpen.value = false;
}

function copyDetails() {
  const details = `Version: ${config.version}\nOS: ${platformName} ${platformVersion}`;
  navigator.clipboard.writeText(details);
  wasCopied.value = true;
  setTimeout(() => {
    wasCopied.value = false;
  }, 2000);
}
</script>
