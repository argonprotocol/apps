<template>
  <PopoverRoot as="div" class="relative" @update:open="onOpen">
    <PopoverTrigger as="button" class="focus:outline-none">
      <slot>
        <span
          class="border-argon-300 text-argon-600 hover:bg-argon-50/40 hover:border-argon-600 mt-10 cursor-pointer rounded border px-7 py-2 text-center text-lg font-bold whitespace-nowrap transition-all duration-300">
          View Bitcoin Blocks
        </span>
      </slot>
    </PopoverTrigger>
    <PopoverContent
      as="div"
      :class="panelPositioningClasses"
      class="absolute z-50 mt-10 w-150 rounded-lg border border-gray-300 bg-white text-center text-lg font-bold shadow-lg">
      <div :class="arrowPositioningClasses" class="absolute h-[15px] w-[30px] overflow-hidden">
        <div class="relative top-[5px] left-[5px] h-[20px] w-[20px] rotate-45 bg-white ring-1 ring-gray-900/20"></div>
      </div>
      <div class="flex h-full max-w-full flex-col px-6 pt-4 pb-2 text-base">
        <h2 class="mb-2 text-left text-2xl font-bold">Recent Bitcoin Blocks</h2>
        <table class="text-md w-full max-w-full grow font-mono">
          <thead>
            <tr class="text-md table-fixed text-left text-gray-500">
              <th class="w-[20%] border-b border-slate-400/30 py-2 pl-1">Block</th>
              <th class="w-[40%] border-b border-slate-400/30 py-2">Time</th>
              <th class="w-[25%] border-b border-slate-400/30 py-2">Transactions</th>
              <th class="w-[20%] border-b border-slate-400/30 py-2 pr-3 text-right">Size</th>
            </tr>
          </thead>
          <tbody class="text-left font-light">
            <tr v-for="block in blocks" :key="block.height" class="text-gray-500">
              <td class="border-t border-slate-400/30 text-left">
                {{ numeral(block.height).format('0,0') }}
              </td>
              <td class="border-t border-slate-400/30 text-left">
                {{ dayjs(block.time * 1000).fromNow() }}
              </td>
              <td class="border-t border-slate-400/30 text-left">{{ numeral(block.nTx).format('0,0') }}</td>
              <td class="relative border-t border-slate-400/30 text-right">
                {{ numeral(block.size / (1024 * 1024)).format('0,0.[0]') }} MB
              </td>
            </tr>
          </tbody>
        </table>
        <div v-if="!blocks.length" class="flex grow flex-col items-center justify-center pt-8">
          <span>
            <img src="/mining.gif" class="relative -left-1 inline-block w-16 opacity-20" />
          </span>
          <div class="mt-5 flex flex-col items-center opacity-30">
            <div class="text-lg font-bold">No Blocks Have Been Mined</div>
            <div>(miners are actively working on first block)</div>
          </div>
        </div>
      </div>
    </PopoverContent>
  </PopoverRoot>
</template>

<script setup lang="ts">
import { type IBitcoinBlockMeta } from '@argonprotocol/apps-core';
import * as Vue from 'vue';
import { WatchHandle } from 'vue';
import numeral from '../lib/numeral';
import { PopoverContent, PopoverRoot, PopoverTrigger } from 'reka-ui';
import dayjs from 'dayjs';
import { BotFetch } from '../lib/BotFetch.ts';
import { useStats } from '../stores/stats.ts';

const stats = useStats();

const blocks = Vue.ref<IBitcoinBlockMeta[]>([]);

const props = withDefaults(
  defineProps<{
    position?: 'right' | 'top';
  }>(),
  {
    position: 'right',
  },
);
const panelPositioningClasses = Vue.computed(() => {
  if (props.position === 'right') {
    return 'top-[-140px] left-[calc(100%+24px)] h-160 ';
  } else {
    // props.position === 'top'
    return 'top-[-55px] left-1/2 -translate-x-1/2 -translate-y-full h-140';
  }
});

const arrowPositioningClasses = Vue.computed(() => {
  if (props.position === 'right') {
    return 'top-[94px] left-[15.5px] translate-x-[-37.5px] -translate-y-full rotate-270';
  } else {
    // props.position === 'top'
    return 'top-full left-1/2 -translate-x-1/2 rotate-180';
  }
});

async function onOpen(open: boolean) {
  if (open) {
    await load();
  } else {
    unload();
  }
}

let lastBlockNumber = 0;
let watcher: WatchHandle | undefined;

async function load() {
  blocks.value = await BotFetch.fetchLatestBitcoinBlocks();
  watcher = Vue.watch(
    stats.serverState,
    async value => {
      if (value.bitcoinLocalNodeBlockNumber === lastBlockNumber) {
        return;
      }
      lastBlockNumber = value.bitcoinLocalNodeBlockNumber;
      blocks.value = await BotFetch.fetchLatestBitcoinBlocks();
    },
    { deep: true },
  );
}

function unload() {
  watcher?.stop();
}

Vue.onMounted(load);
Vue.onBeforeUnmount(unload);
</script>
