<!-- prettier-ignore -->
<template>
  <DialogRoot class="absolute inset-0 z-10" :open="true">
    <DialogPortal>
      <DialogOverlay asChild>
        <BgOverlay @close="cancelOverlay" />
      </DialogOverlay>

      <DialogContent @escapeKeyDown="cancelOverlay" :aria-describedby="undefined">
        <div
          :ref="draggable.setModalRef"
          :style="{
            top: `calc(50% + ${draggable.modalPosition.y}px)`,
            left: `calc(50% + ${draggable.modalPosition.x}px)`,
            transform: 'translate(-50%, -50%)',
          }"
          class="VaultEditOverlay absolute w-[1000px] min-h-[550px] flex flex-col rounded-md border border-black/30 inner-input-shadow bg-argon-menu-bg text-left z-20 focus:outline-none"
          style="box-shadow: 1px 1px 10px rgba(0, 0, 0, 0.2), inset 2px 2px 0 rgba(255, 255, 255, 1)"
        >
          <BgOverlay v-if="hasEditBoxOverlay" @close="closeEditBoxOverlay" :showWindowControls="false" rounded="md" class="z-100" />
          <div class="flex flex-col h-full w-full grow">
            <h2
              @mousedown="draggable.onMouseDown($event)"
              :style="{ cursor: draggable.isDragging ? 'grabbing' : 'grab' }"
              style="box-shadow: 0 1px 4px rgba(0, 0, 0, 0.1)"
              class="relative text-3xl font-bold text-left border-b border-slate-300 pt-5 pb-4 pl-3 mx-4 text-[#672D73]"
            >
              <DialogTitle as="div" class="relative z-10">Configure Vault Settings</DialogTitle>
              <div @click="cancelOverlay" class="absolute top-[22px] right-[0px] z-10 flex items-center justify-center text-sm/6 font-semibold cursor-pointer border rounded-md w-[30px] h-[30px] focus:outline-none border-slate-400/60 hover:border-slate-500/70 hover:bg-[#D6D9DF]">
                <XMarkIcon class="w-5 h-5 text-[#B74CBA] stroke-4" />
              </div>
            </h2>

            <div v-if="isLoaded" class="flex flex-col grow relative w-full h-full">
              <DialogDescription class="text-gray-600 font-light py-6 pl-10 pr-[6%]">
                The following settings control how your vault operates, allocates capital, and earns revenue.
              </DialogDescription>

              <VaultSettings ref="vaultSettings" @toggleEditBoxOverlay="(x: boolean) => hasEditBoxOverlay = x" :includeProjections="false" :isEditingSettings="true" />
            </div>
            <div v-else class="grow flex items-center justify-center">Loading...</div>

            <div class="flex flex-row justify-end border-t border-slate-300 mx-4 py-4 space-x-4 rounded-b-lg">
              <div v-if="savingError" class="text-red-700 font-bold grow flex items-center my-2">
                {{ savingError }}
              </div>
              <div :class="{ 'opacity-50': isSaving || hasEditBoxOverlay }" class="flex flex-row space-x-4 justify-center items-center">
                <button @click="cancelOverlay" class="border border-argon-button/50 text-xl font-bold text-gray-500 px-7 py-1 rounded-md cursor-pointer">
                  <span>Cancel</span>
                </button>
                <Tooltip asChild :calculateWidth="() => calculateElementWidth(saveButtonElement)" side="top" content="Clicking this button does not commit you to anything.">
                  <button @click="saveRules" ref="saveButtonElement" :disabled="isSaving" class="bg-argon-button text-xl font-bold text-white px-7 py-1 rounded-md cursor-pointer">
                    <span v-if="!isSaving">Save Rules</span>
                    <span v-else>Save Rules...</span>
                  </button>
                </Tooltip>
              </div>
            </div>

          </div>
        </div>
      </DialogContent>
    </DialogPortal>
  </DialogRoot>
</template>

<script setup lang="ts">
import * as Vue from 'vue';
import { DialogContent, DialogDescription, DialogOverlay, DialogPortal, DialogRoot, DialogTitle } from 'reka-ui';
import { useConfig } from '../stores/config';
import { getVaultCalculator } from '../stores/mainchain';
import BgOverlay from '../components/BgOverlay.vue';
import { XMarkIcon } from '@heroicons/vue/24/outline';
import { JsonExt } from '@argonprotocol/apps-core';
import IVaultingRules from '../interfaces/IVaultingRules';
import Tooltip from '../components/Tooltip.vue';
import VaultSettings from '../components/VaultSettings.vue';
import Draggable from './helpers/Draggable.ts';
import { useMyVault } from '../stores/vaults.ts';

const emit = defineEmits<{
  (e: 'close'): void;
}>();

const config = useConfig();
const myVault = useMyVault();

const draggable = Vue.reactive(new Draggable());

let previousVaultingRules: string | null = null;

const rules = Vue.computed(() => {
  return config.vaultingRules as IVaultingRules;
});

const calculator = getVaultCalculator();

const isLoaded = Vue.ref(false);
const isSaving = Vue.ref(false);
const savingError = Vue.ref<string | null>(null);
const hasEditBoxOverlay = Vue.ref(false);

const vaultSettings = Vue.ref<typeof VaultSettings | null>(null);
const saveButtonElement = Vue.ref<HTMLElement | null>(null);

function calculateElementWidth(element: HTMLElement | null) {
  if (!element) return;
  const elementWidth = element.getBoundingClientRect().width;
  return `${elementWidth}px`;
}

function cancelOverlay() {
  if (isSaving.value || hasEditBoxOverlay.value) return;

  if (previousVaultingRules) {
    config.vaultingRules = JsonExt.parse<IVaultingRules>(previousVaultingRules);
  }

  emit('close');
}

function closeEditBoxOverlay() {
  vaultSettings.value?.closeEditBoxOverlay();
}

async function saveRules() {
  if (isSaving.value || hasEditBoxOverlay.value) return;

  if (rules.value) {
    try {
      savingError.value = null;
      isSaving.value = true;

      await myVault.updateSettings({
        rules: Vue.toRaw(rules.value),
        previousRules: JsonExt.parse<IVaultingRules>(previousVaultingRules!),
        txProgressCallback(progress: number) {
          console.log(`Vault settings update progress: ${progress}%`);
        },
      });
      await config.saveVaultingRules();
    } catch (error: any) {
      console.error('Error saving vault rules:', error);
      savingError.value = error.message || 'Unknown error occurred while saving vault rules.';
      return;
    } finally {
      isSaving.value = false;
    }
  }

  emit('close');
}

Vue.onMounted(async () => {
  isLoaded.value = false;
  await myVault.load();

  await calculator.load(rules.value);
  previousVaultingRules = JsonExt.stringify(config.vaultingRules);

  isLoaded.value = true;
});
</script>

<style>
@reference "../main.css";

.VaultEditOverlay {
  h2 {
    position: relative;
    &:before {
      @apply from-argon-menu-bg bg-gradient-to-r to-transparent;
      content: '';
      display: block;
      width: 30px;
      position: absolute;
      z-index: 1;
      left: -5px;
      top: 0;
      bottom: -5px;
    }
    &:after {
      @apply from-argon-menu-bg bg-gradient-to-l to-transparent;
      content: '';
      display: block;
      width: 30px;
      position: absolute;
      z-index: 1;
      right: -5px;
      top: 0;
      bottom: -5px;
    }
  }

  [StatHeader] {
    @apply group-hover:text-argon-600/70 text-lg font-bold text-[#a08fb7];
  }

  [PrimaryStat] {
    @apply relative;

    [tooltip]:focus {
      @apply text-argon-600;
    }

    &:hover {
      [tooltip] {
        @apply text-argon-600;
      }
      [PiechartIcon] {
        animation: fadeToArgon 2s ease-in-out 1;
      }
    }

    [InputFieldWrapper] {
      @apply text-argon-600 border-none font-mono text-6xl font-bold !outline-none hover:bg-transparent focus:!outline-none;
      box-shadow: none;
    }
    [NumArrows] {
      @apply relative top-2;
    }
    svg[NumArrowUp],
    svg[NumArrowDown] {
      @apply size-[24px];
    }

    [StatHeader] {
      @apply text-argon-600/70;
      background: linear-gradient(to bottom, oklch(0.88 0.09 320 / 0.2) 0%, transparent 100%);
      text-shadow: 1px 1px 0 white;
    }
  }

  section div[MainWrapper] {
    @apply cursor-pointer;

    &:hover {
      @apply bg-argon-20;
      [MainRule]::before {
        background: linear-gradient(to right, var(--color-argon-20) 0%, transparent 100%);
      }
      [MainRule]::after {
        background: linear-gradient(to left, var(--color-argon-20) 0%, transparent 100%);
      }
      [StatHeader] {
        @apply text-argon-600/70;
      }
      [EditIcon] {
        @apply inline-block;
      }
    }

    [StatHeader] {
      @apply pt-1;
    }

    [EditIcon] {
      @apply text-argon-600/50 relative z-10 -mt-0.5 ml-2 hidden h-4.5 min-h-4.5 w-4.5 min-w-4.5;
    }

    [MainRule] {
      @apply text-argon-700/80 relative my-1.5 border-t border-b border-dashed border-slate-500/30 py-1 text-center font-mono font-bold;
      &::before {
        content: '';
        display: block;
        width: 10%;
        height: calc(100% + 4px);
        background: linear-gradient(to right, var(--color-argon-menu-bg) 0%, transparent 100%);
        position: absolute;
        top: -2px;
        left: 0;
      }
      &::after {
        content: '';
        display: block;
        width: 10%;
        height: calc(100% + 4px);
        background: linear-gradient(to left, var(--color-argon-menu-bg) 0%, transparent 100%);
        position: absolute;
        top: -2px;
        right: 0;
      }
      span {
        @apply relative z-10;
      }
    }
  }

  @keyframes fadeToArgon {
    0% {
      color: rgb(209 213 219); /* text-gray-300 */
    }
    10% {
      color: oklch(0.48 0.24 320); /* text-argon-600 */
    }
    100% {
      color: rgb(209 213 219); /* text-gray-300 */
    }
  }
}
</style>
