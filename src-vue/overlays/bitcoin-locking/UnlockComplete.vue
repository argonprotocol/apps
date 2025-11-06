<template>
  <div class="flex flex-col space-y-5 px-10 py-5">
    <p class="text-gray-700">
      Your bitcoin has been officially unlocked from the Argon network. It's now sitting back under your full control at
      the following address:
    </p>

    <div class="mb-10 ml-4 text-gray-700 italic">{{ personalLock.releaseToDestinationAddress }}</div>

    <button
      @click="closeOverlay"
      class="bg-argon-600 border-argon-700 mb-2 w-full cursor-pointer rounded-lg border px-6 py-2 text-lg font-bold text-white focus:outline-none">
      Close
    </button>
  </div>
</template>

<script setup lang="ts">
import * as Vue from 'vue';
import { IBitcoinLockRecord } from '../../lib/db/BitcoinLocksTable.ts';

const props = defineProps<{
  personalLock: IBitcoinLockRecord;
}>();

const emit = defineEmits<{
  (e: 'close'): void;
}>();

function closeOverlay() {
  emit('close');
}
</script>
