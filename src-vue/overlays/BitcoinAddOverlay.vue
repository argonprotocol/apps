<template>
  <DialogRoot class="absolute inset-0 z-10" :open="true">
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
            class="text-md absolute z-50 w-200 overflow-scroll rounded-lg border border-black/40 bg-white px-4 pt-2 pb-2 shadow-xl focus:outline-none">
            <h2
              @mousedown="draggable.onMouseDown($event)"
              :style="{ cursor: draggable.isDragging ? 'grabbing' : 'grab' }"
              class="mb-2 flex w-full flex-row items-center space-x-4 border-b border-black/20 px-3 pt-3 pb-3 text-5xl font-bold">
              <DialogTitle class="grow text-2xl font-bold">Liquid Lock Your Bitcoin</DialogTitle>
              <div
                @click="closeOverlay"
                class="z-10 mr-1 flex h-[30px] w-[30px] cursor-pointer items-center justify-center rounded-md border border-slate-400/60 text-sm/6 font-semibold hover:border-slate-500/60 hover:bg-[#f1f3f7] focus:outline-none">
                <XMarkIcon class="h-5 w-5 stroke-4 text-[#B74CBA]" />
              </div>
            </h2>

            <div box class="flex flex-col px-3 py-3">
              <p>
                Your vault currently has enough securitization to lock up to ₳1,004.43 in bitcoin (0.9943 btc). As part
                of Argon's Liquid Locking process, you will be able to receive the full market value of your bitcoin in
                Argon stablecoins.
              </p>

              <div class="mt-5 flex flex-row gap-x-5">
                <div class="flex w-1/2 grow flex-col">
                  <label>Bitcoin Amount</label>
                  <InputNumber v-model="bitcoinAmount" :maxDecimals="0" :min="0" :dragBy="0.1" :dragByMin="0.01" />
                </div>
                <div class="flex w-1/2 grow flex-col">
                  <label>Argons to Receive</label>
                  <InputArgon
                    v-model="argonAmount"
                    :maxDecimals="0"
                    :min="0n"
                    :dragBy="1_000_000n"
                    :dragByMin="1_000_000n" />
                </div>
              </div>

              <div class="mt-10 flex flex-row items-center justify-end gap-x-3 border-t border-black/20 pt-4">
                <button
                  class="cursor-pointer rounded-lg bg-gray-200 px-10 py-2 text-lg font-bold text-black hover:bg-gray-300"
                  @click="closeOverlay">
                  Cancel
                </button>
                <button
                  class="bg-argon-600 hover:bg-argon-700 cursor-pointer rounded-lg px-10 py-2 text-lg font-bold text-white">
                  Liquid Lock Your Bitcoin
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
import dayjs from 'dayjs';
import utc from 'dayjs/plugin/utc';
import { DialogContent, DialogOverlay, DialogPortal, DialogRoot, DialogTitle } from 'reka-ui';
import { AnimatePresence, Motion } from 'motion-v';
import BgOverlay from '../components/BgOverlay.vue';
import Draggable from './helpers/Draggable.ts';
import { XMarkIcon } from '@heroicons/vue/24/outline';
import InputNumber from '../components/InputNumber.vue';
import InputArgon from '../components/InputArgon.vue';

dayjs.extend(utc);

const emit = defineEmits<{
  close: [];
}>();

const draggable = Vue.reactive(new Draggable());

const bitcoinAmount = Vue.ref(0);
const argonAmount = Vue.ref(0n);

function closeOverlay() {
  emit('close');
}
</script>
