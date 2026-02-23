<!-- prettier-ignore -->
<template>
  <DialogRoot :open="isOpen">
    <DialogPortal>
      <AnimatePresence>
        <DialogOverlay asChild>
          <Motion asChild :initial="{ opacity: 0 }" :animate="{ opacity: 1 }" :exit="{ opacity: 0 }">
            <BgOverlay />
          </Motion>
        </DialogOverlay>
        
        <DialogContent asChild :aria-describedby="undefined">
          <Motion asChild :initial="{ opacity: 0 }" :animate="{ opacity: 1 }" :exit="{ opacity: 0 }">
            <div 
              :ref="draggable.setModalRef"
              :style="{
                top: `calc(50% + ${draggable.modalPosition.y}px)`,
                left: `calc(50% + ${draggable.modalPosition.x}px)`,
                transform: 'translate(-50%, -50%)',
                cursor: draggable.isDragging ? 'grabbing' : 'default',
              }"
              class="absolute z-50 bg-white border border-black/40 p-2 rounded-lg pointer-events-auto shadow-xl w-9/12 overflow-scroll focus:outline-none"
            >
              <h2 @mousedown="draggable.onMouseDown($event)" class="text-2xl font-bold text-slate-800/70 border-b border-slate-300 pt-6 pb-3 mb-3">
                <DialogTitle>Importing Account</DialogTitle>
              </h2>
            </div>
          </Motion>
        </DialogContent>
      </AnimatePresence>
    </DialogPortal>
  </DialogRoot>
</template>

<script setup lang="ts">
import * as Vue from 'vue';
import { DialogContent, DialogOverlay, DialogPortal, DialogRoot, DialogTitle } from 'reka-ui';
import { AnimatePresence, Motion } from 'motion-v';
import basicEmitter from '../emitters/basicEmitter';
import BgOverlay from '../components/BgOverlay.vue';
import Draggable from './helpers/Draggable.ts';
import Importer from '../lib/Importer.ts';

const isOpen = Vue.ref(false);
const isLoaded = Vue.ref(false);

const draggable = Vue.reactive(new Draggable());

basicEmitter.on('openImportingOverlay', async ({ importer, dataRaw }: { importer: Importer; dataRaw: string }) => {
  isOpen.value = true;
  isLoaded.value = true;
  await importer.importFromFile(dataRaw);
  console.log('openImportingOverlay', importer);
});
</script>
