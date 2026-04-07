<!-- prettier-ignore -->
<template>
  <div data-testid="FirstAuction" class="flex flex-col h-full w-full">
    <FirstAuctionFailed v-if="bot.state?.maxSeatsInPlay === 0" />
    <FirstAuctionWinning v-else-if="config.hasMiningBids" />
    <FirstAuctionStarting v-else />
  </div>
</template>

<script setup lang="ts">
import * as Vue from 'vue';
import FirstAuctionStarting from './FirstAuctionStarting.vue';
import FirstAuctionWinning from './FirstAuctionWinning.vue';
import FirstAuctionFailed from './FirstAuctionFailed.vue';
import { getStats } from '../../../stores/stats.ts';
import { getConfig } from '../../../stores/config.ts';
import { getBot } from '../../../stores/bot.ts';

const stats = getStats();
const bot = getBot();
const config = getConfig();

Vue.onMounted(() => stats.subscribeToActivity());
Vue.onUnmounted(() => stats.unsubscribeFromActivity());
</script>
