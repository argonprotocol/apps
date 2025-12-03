<template>
  <PopoverRoot as="div" class="relative" @update:open="onOpen">
    <PopoverTrigger as="button" class="focus:outline-none">
      <slot>
        <span
          class="border-argon-300 text-argon-600 hover:bg-argon-50/40 hover:border-argon-600 mt-10 cursor-pointer rounded border px-7 py-2 text-center text-lg font-bold whitespace-nowrap transition-all duration-300">
          View Argon Blocks
        </span>
      </slot>
    </PopoverTrigger>
    <PopoverContent
      as="div"
      :class="panelPositioningClasses"
      class="absolute z-50 mt-10 w-220 rounded-lg border border-gray-300 bg-white text-center text-lg font-bold shadow-lg">
      <div :class="arrowPositioningClasses" class="absolute h-[15px] w-[30px] overflow-hidden">
        <div class="relative top-[5px] left-[5px] h-[20px] w-[20px] rotate-45 bg-white ring-1 ring-gray-900/20"></div>
      </div>
      <div class="flex h-full max-w-full flex-col px-6 pt-4 pb-2 text-base">
        <h2 class="mb-2 text-left text-2xl font-bold">Recent Argon Blocks</h2>
        <table class="text-md w-full max-w-full grow font-mono">
          <thead>
            <tr class="text-md table-fixed text-left text-gray-500">
              <th class="w-[15%] border-b border-slate-400/30 py-2 pl-1">Block</th>
              <th class="w-[30%] border-b border-slate-400/30 py-2">Time</th>
              <th class="w-[20%] border-b border-slate-400/30 py-2">Earned</th>
              <th class="w-[35%] border-b border-slate-400/30 py-2 pr-3 text-right">Author</th>
            </tr>
          </thead>
          <tbody class="text-left font-light">
            <tr v-for="block in Object.values(blocks)" :key="block.number" class="text-gray-500">
              <td class="border-t border-slate-400/30 text-left">
                {{ numeral(block.number).format('0,0') }}
              </td>
              <td class="border-t border-slate-400/30 text-left">
                {{ block.timestamp.fromNow() }}
              </td>
              <td class="border-t border-slate-400/30 text-left">
                {{ currency.symbol
                }}{{
                  microgonToMoneyNm(currency.micronotToMicrogon(block.micronots) + block.microgons).formatIfElse(
                    '< 1_000',
                    '0,0.00',
                    '0,0',
                  )
                }}
              </td>
              <td class="relative border-t border-slate-400/30 text-right">
                <span>{{ abbreviateAddress(block.author, 10) }}</span>
                <span
                  v-if="isOurAddress(block.author)"
                  class="bg-argon-600 absolute top-1/2 right-0 -translate-y-1/2 rounded px-1.5 pb-0.25 text-sm text-white">
                  YOU
                  <span
                    class="absolute top-0 -left-3 inline-block h-full w-3 bg-gradient-to-r from-transparent to-white"></span>
                </span>
              </td>
            </tr>
          </tbody>
        </table>
        <div v-if="!Object.keys(blocks).length" class="flex grow flex-col items-center justify-center pt-8">
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
import * as Vue from 'vue';
import { IBlock, useBlockchainStore } from '../stores/blockchain';
import { useCurrency } from '../stores/currency.ts';
import numeral, { createNumeralHelpers } from '../lib/numeral.ts';
import { abbreviateAddress } from '../lib/Utils.ts';
import { PopoverContent, PopoverRoot, PopoverTrigger } from 'reka-ui';
import { useWalletKeys } from '../stores/wallets.ts';

const walletKeys = useWalletKeys();
const currency = useCurrency();

const { microgonToMoneyNm } = createNumeralHelpers(currency);

const blockchainStore = useBlockchainStore();

const blocks = Vue.ref<{ [number: number]: IBlock }>({});
const isOpen = Vue.ref(false);

const subaccounts = Vue.ref(new Set<string>());
Vue.onMounted(() => {
  walletKeys.getMiningSubaccounts().then(x => {
    for (const key of Object.keys(x)) {
      subaccounts.value.add(key);
    }
  });
});

const props = withDefaults(
  defineProps<{
    position?: 'left' | 'top';
  }>(),
  {
    position: 'top',
  },
);
const panelPositioningClasses = Vue.computed(() => {
  if (props.position === 'left') {
    return 'top-[-140px] right-[calc(100%+24px)] h-160';
  } else {
    // props.position === 'top'
    return 'top-[-55px] left-1/2 -translate-x-1/2 -translate-y-full h-140';
  }
});

const arrowPositioningClasses = Vue.computed(() => {
  if (props.position === 'left') {
    return 'top-[92px] right-[12.5px] translate-x-[34.5px] -translate-y-full rotate-90';
  } else {
    // props.position === 'top'
    return 'top-full left-1/2 -translate-x-1/2 rotate-180';
  }
});

let unsubscribeFromBlocks: any = null;

function isOurAddress(address: string): boolean {
  return subaccounts.value.has(address);
}

async function onOpen(open: boolean) {
  isOpen.value = open;
  if (open) {
    await load();
  } else {
    unload();
  }
}

async function load() {
  const startingBlocks = await blockchainStore.fetchBlocks(null, 10);
  for (const block of startingBlocks) {
    blocks.value[block.number] = block;
  }

  unsubscribeFromBlocks = await blockchainStore.subscribeToBlocks(newBlock => {
    blocks.value[newBlock.number] = newBlock;
    if (Object.keys(blocks.value).length > 10) {
      const toRemove = Math.min(...Object.keys(blocks.value).map(Number));
      delete blocks.value[toRemove];
    }
  });
}

function unload() {
  if (unsubscribeFromBlocks) {
    unsubscribeFromBlocks();
    unsubscribeFromBlocks = null;
  }
}

Vue.onMounted(load);
Vue.onBeforeUnmount(unload);
</script>
