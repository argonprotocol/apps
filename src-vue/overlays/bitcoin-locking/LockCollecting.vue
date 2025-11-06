<template>
  <div class="space-y-5 px-10 pt-5 pb-5">
    <p>
      Your bitcoin has been successfully processed! You have been awarded the full market value of your Bitcoin as
      unencumbered Argon stablecoins. These stablecoins will be minted and sent to your wallet as the network's minting
      algorithms dictate.
    </p>

    <button @click="closeOverlay">Close</button>
  </div>
</template>

<script setup lang="ts">
import * as Vue from 'vue';

const emit = defineEmits<{
  (e: 'close'): void;
}>();

function closeOverlay() {
  emit('close');
}
</script>
