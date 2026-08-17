<template>
  <BgOverlay v-if="isOpen" :style="backdropZIndex" :showWindowControls="false" rounded="lg" @close="isOpen = false" />

  <div class="shrink-0 text-slate-500" :class="{ 'text-sm': mode === 'expiration' }">
    <template v-if="mode === 'expiration'">Redeemable for&nbsp;</template>
    <PopoverRoot
      :open="isOpen"
      @update:open="
        isOpen = $event;
        if ($event) editedDays = mode === 'extension' ? (isExpired ? 0 : (currentDays ?? 0)) : days;
      "
    >
      <PopoverTrigger :asChild="true">
        <button
          type="button"
          :disabled="disabled"
          class="text-argon-600 cursor-pointer underline underline-offset-2 disabled:cursor-default disabled:opacity-50"
          :class="{ 'font-semibold': mode === 'expiration' }"
        >
          <template v-if="mode === 'extension'">
            <template v-if="isExpired && currentDays === 0">now</template>
            <template v-else>
              {{ currentDays }} {{ currentDays === 1 ? 'day' : 'days' }}{{ isExpired ? ' ago' : '' }}
            </template>
          </template>
          <template v-else>{{ days }} {{ days === 1 ? 'day' : 'days' }}</template>
        </button>
      </PopoverTrigger>
      <PopoverPortal>
        <PopoverContent
          :side="side"
          :sideOffset="8"
          :style="editorZIndex"
          class="w-96 rounded-md border border-slate-500/60 bg-white shadow-lg"
        >
          <div
            class="text-argon-600/70 mx-2 border-b border-slate-400/30 pt-4 pb-1 text-center font-sans text-xl font-bold select-none"
          >
            {{ mode === 'extension' ? 'Fee Waiver Expiration' : 'Fee Waiver Availability' }}
          </div>
          <div class="mt-4 flex flex-col px-5 text-slate-600">
            <p class="mb-3 text-sm leading-5">
              <template v-if="mode === 'extension' && isExpired">
                Set how many days the remaining fee waiver will be available from now.
              </template>
              <template v-else-if="mode === 'extension'">
                Set how many days remain before this fee waiver expires.
              </template>
              <template v-else>The waiver period starts when the member accepts the invite.</template>
            </p>
            <div class="mb-0.5 text-sm font-bold opacity-60">
              {{ mode === 'extension' ? 'Days Until Expiration' : 'Days Available' }}
            </div>
            <InputNumber
              v-model.number="editedDays"
              :min="mode === 'extension' ? 0 : 1"
              :max="365"
              :dragBy="1"
              :dragByMin="1"
              :maxDecimals="0"
              class="w-full"
            />
          </div>
          <div class="mx-2 mt-5 flex justify-end space-x-3 border-t border-slate-400/50 pt-3 pr-3 pb-3">
            <button
              type="button"
              class="cursor-pointer rounded-md border border-slate-400 px-3 text-sm text-slate-800/70"
              @click="isOpen = false"
            >
              Cancel
            </button>
            <button
              type="button"
              :disabled="
                !Number.isSafeInteger(editedDays) ||
                editedDays < (mode === 'extension' && !isExpired ? 0 : 1) ||
                editedDays > 365
              "
              class="bg-argon-button border-argon-600 cursor-pointer rounded-md border px-3 text-sm text-white disabled:cursor-default disabled:opacity-40"
              @click="
                days = editedDays;
                emit('save', editedDays);
                isOpen = false;
              "
            >
              Save
            </button>
          </div>
        </PopoverContent>
      </PopoverPortal>
    </PopoverRoot>
  </div>
</template>

<script setup lang="ts">
import * as Vue from 'vue';
import { PopoverContent, PopoverPortal, PopoverRoot, PopoverTrigger } from 'reka-ui';
import BgOverlay from '../../components/BgOverlay.vue';
import InputNumber from '../../components/InputNumber.vue';
import { useFloatingZIndex } from '../helpers/OverlayZIndex.ts';

withDefaults(
  defineProps<{
    mode?: 'expiration' | 'extension';
    side?: 'left' | 'right';
    currentDays?: number;
    isExpired?: boolean;
    disabled?: boolean;
  }>(),
  { mode: 'expiration', side: 'left' },
);

const emit = defineEmits<{ save: [days: number] }>();

const days = defineModel<number>({ required: true });

const isOpen = Vue.ref(false);
const editedDays = Vue.ref(1);
const backdropZIndex = useFloatingZIndex();
const editorZIndex = useFloatingZIndex(2);
</script>
