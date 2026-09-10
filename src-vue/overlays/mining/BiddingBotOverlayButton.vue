<template>
  <button
    type="button"
    class="hover:bg-argon-50/40 hover:border-argon-600 text-argon-600 border-argon-300 mt-10 cursor-pointer rounded border px-7 py-2 text-center text-lg font-bold whitespace-nowrap transition-all duration-300"
    @click="basicEmitter.emit('openMiningBiddingBotOverlay')"
  >
    View Bidding Bot
  </button>
</template>

<script setup lang="ts">
import basicEmitter from '../../emitters/basicEmitter.ts';
</script>
