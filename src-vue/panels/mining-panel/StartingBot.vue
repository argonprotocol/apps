<!-- prettier-ignore -->
<template>
  <div class="flex flex-col h-full w-full">
    <div class="grow relative bg-white rounded border border-[#CCCEDA] shadow text-center m-3 overflow-hidden">
      <div
        v-if="!bot.isBroken && !config.isMinerWaitingForUpgradeApproval"
        class="relative mx-auto inline-block w-6/10 h-full"
      >
        <div v-if="!bot.isSyncing && !installer.isRunning" class="fade-in-out text-[55px] font-bold text-gray-300 text-center mt-32 mb-4 whitespace-nowrap pt-16">
          CONNECTING TO {{}}
          <div class="text-7xl">BIDDING BOT</div>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import * as Vue from 'vue';
import { useStats } from '../../stores/stats';
import { useConfig } from '../../stores/config';
import { useBot } from '../../stores/bot';
import { useInstaller } from '../../stores/installer';

const stats = useStats();
const config = useConfig();
const bot = useBot();
const installer = useInstaller();

Vue.onMounted(() => stats.subscribeToActivity());
Vue.onUnmounted(() => stats.unsubscribeFromActivity());
</script>

<style scoped>
@reference "../../main.css";

.fade-in-out {
  animation: fadeInOut 1.5s ease-in-out infinite;
  animation-delay: 0s;
}

@keyframes fadeInOut {
  0% {
    opacity: 0.1;
  }
  50% {
    opacity: 1;
  }
  100% {
    opacity: 0.1;
  }
}
</style>
