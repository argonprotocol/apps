<!-- prettier-ignore -->
<template>
  <div
    class="w-full rounded-lg border overflow-hidden"
    :class="config.hasSavedMnemonic ? 'border-slate-300/60' : 'border-argon-600/30'"
  >
    <button
      type="button"
      :aria-expanded="isExpanded"
      aria-controls="mnemonic-backup-panel"
      class="w-full flex flex-row items-center gap-2 px-3 py-2.5 cursor-pointer hover:bg-argon-menu-hover transition-colors"
      @click="isExpanded = !isExpanded"
    >
      <ShieldCheckIcon v-if="config.hasSavedMnemonic" class="w-4.5 h-4.5 text-emerald-600 shrink-0" />
      <ShieldExclamationIcon v-else class="w-4.5 h-4.5 text-argon-600 shrink-0" />
      <span class="grow text-left text-sm" :class="config.hasSavedMnemonic ? 'text-slate-400' : 'text-argon-text-primary'">
        {{ config.hasSavedMnemonic ? 'Recovery phrase backed up' : "Your account recovery phrase hasn't been backed up" }}
      </span>
      <span v-if="!config.hasSavedMnemonic && !isExpanded" class="shrink-0 text-sm text-argon-600">Back Up Now</span>
      <ChevronDownIcon :class="['w-4 h-4 text-slate-400 shrink-0 transition-transform duration-200', isExpanded ? 'rotate-180' : '']" />
    </button>

    <div v-if="isExpanded" id="mnemonic-backup-panel" role="region" class="px-3 pb-3 border-t border-argon-600/10">
      <p class="text-xs text-slate-500 mt-2.5 mb-3">
        Write down these 12 words and store them somewhere safe. They are the only way to recover your account.
      </p>

      <MnemonicDisplay v-slot="{ mnemonic }">
        <div class="flex flex-row items-center justify-between mt-3">
          <CopyToClipboard :content="mnemonic" class="cursor-pointer">
            <button type="button" class="text-sm text-slate-500 hover:text-slate-700 underline decoration-dashed underline-offset-4 cursor-pointer">
              Copy to Clipboard
            </button>
            <template #copied>
              <span class="text-sm text-slate-500">
                Copied!
              </span>
            </template>
          </CopyToClipboard>
          <button
            v-if="!config.hasSavedMnemonic"
            type="button"
            @click.stop="confirmSaved"
            class="text-sm text-argon-600 hover:text-argon-800 underline decoration-dashed underline-offset-4 cursor-pointer"
          >
            I've Saved It
          </button>
        </div>
      </MnemonicDisplay>
    </div>
  </div>
</template>

<script setup lang="ts">
import * as Vue from 'vue';
import { ShieldExclamationIcon, ShieldCheckIcon, ChevronDownIcon } from '@heroicons/vue/24/outline';
import { getConfig } from '../stores/config.ts';
import MnemonicDisplay from './MnemonicDisplay.vue';
import CopyToClipboard from './CopyToClipboard.vue';

const config = getConfig();
const isExpanded = Vue.ref(false);

async function confirmSaved() {
  try {
    config.hasSavedMnemonic = true;
    await config.save();
    isExpanded.value = false;
  } catch {
    config.hasSavedMnemonic = false;
  }
}
</script>
