<!-- prettier-ignore -->
<template>
  <p class="text-md text-slate-500 px-3">
    The following words constitute your wallet recovery phrase (the order is important). They are used to recover your
    wallet if this device or app is lost or damaged. Keep them in a safe place! Anyone who knows this mnemonic can
    access your wallet and funds.
  </p>

  <MnemonicDisplay gridClass="px-3 mt-5 mb-6" v-slot="{ mnemonic }">
    <CopyToClipboard :content="mnemonic" class="cursor-pointer">
      <button class="w-full mt-4 bg-slate-600/20 hover:bg-slate-600/15 border border-slate-900/10 inner-button-shadow text-slate-900 px-4 py-1 rounded-lg focus:outline-none cursor-pointer">
        Copy to Clipboard
      </button>
      <template #copied>
        <button class="w-full mt-4 bg-slate-600/20 hover:bg-slate-600/15 border border-slate-900/10 inner-button-shadow text-slate-900 px-4 py-1 rounded-lg focus:outline-none cursor-pointer">
          Copied!
        </button>
      </template>
    </CopyToClipboard>
  </MnemonicDisplay>
</template>

<script setup lang="ts">
import MnemonicDisplay from '../../components/MnemonicDisplay.vue';
import CopyToClipboard from '../../components/CopyToClipboard.vue';

defineEmits(['close', 'goTo']);
</script>
