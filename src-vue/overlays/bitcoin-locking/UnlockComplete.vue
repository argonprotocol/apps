<template>
  <div class="flex flex-col space-y-5 px-10 py-5">
    <p class="text-gray-700">
      Your bitcoin has now been unlocked from the Argon network and is back in your full control.
    </p>

    <button @click="closeOverlay">Close</button>
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
