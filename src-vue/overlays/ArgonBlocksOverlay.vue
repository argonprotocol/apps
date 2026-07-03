<template>
  <PopoverRoot as="div" @update:open="onOpen">
    <PopoverTrigger type="button" class="inline-flex appearance-none bg-transparent p-0 text-left focus:outline-none">
      <slot>
        <span
          class="border-argon-300 text-argon-600 hover:bg-argon-50/40 hover:border-argon-600 mt-10 cursor-pointer rounded border px-7 py-2 text-center text-lg font-bold whitespace-nowrap transition-all duration-300"
        >
          View Argon Blocks
        </span>
      </slot>
    </PopoverTrigger>
    <PopoverPortal>
      <PopoverContent
        as="div"
        :side="popoverSide"
        align="center"
        :sideOffset="10"
        :collisionPadding="24"
        :avoidCollisions="true"
        class="group relative z-[2002] h-140 w-150 rounded-lg border border-gray-300 bg-white text-center text-lg font-bold shadow-lg"
      >
        <PopoverPanelArrow />
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
              <tr v-for="block in sortedBlocks" :key="block.number" class="text-gray-500">
                <td class="border-t border-slate-400/30 text-left">
                  {{ numeral(block.number).format('0,0') }}
                </td>
                <td class="border-t border-slate-400/30 text-left">
                  {{ block.timestamp.fromNow() }}
                </td>
                <td class="border-t border-slate-400/30 text-left">
                  {{ currency.symbol
                  }}{{
                    microgonToMoneyNm(
                      currency.convertMicronotTo(block.micronots, UnitOfMeasurement.Microgon) + block.microgons,
                    ).formatIfElse('< 1_000', '0,0.00', '0,0')
                  }}
                </td>
                <td class="relative border-t border-slate-400/30 text-right">
                  <span>{{ abbreviateAddress(block.author, 10) }}</span>
                  <span
                    v-if="isOurAddress(block.author)"
                    class="bg-argon-600 absolute top-1/2 right-0 -translate-y-1/2 rounded px-1.5 pb-0.25 text-sm text-white"
                  >
                    YOU
                    <span
                      class="absolute top-0 -left-3 inline-block h-full w-3 bg-gradient-to-r from-transparent to-white"
                    ></span>
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
    </PopoverPortal>
  </PopoverRoot>
</template>

<script setup lang="ts">
import * as Vue from 'vue';
import { IBlock, useBlockchainStore } from '../stores/blockchain.ts';
import { getCurrency } from '../stores/currency.ts';
import numeral, { createNumeralHelpers } from '../lib/numeral.ts';
import { abbreviateAddress } from '../lib/Utils.ts';
import { PopoverContent, PopoverPortal, PopoverRoot, PopoverTrigger } from 'reka-ui';
import { getWalletKeys } from '../stores/wallets.ts';
import { UnitOfMeasurement } from '../lib/Currency.ts';
import PopoverPanelArrow from '../components/PopoverPanelArrow.vue';

const walletKeys = getWalletKeys();
const currency = getCurrency();

const { microgonToMoneyNm } = createNumeralHelpers(currency);

const blockchainStore = useBlockchainStore();

const blocks = Vue.ref<{ [number: number]: IBlock }>({});
const isOpen = Vue.ref(false);

const sortedBlocks = Vue.computed(() => {
  return Object.values(blocks.value).sort((a, b) => b.number - a.number);
});

const subaccounts = Vue.ref(new Set<string>());
Vue.onMounted(() => {
  walletKeys.getMiningBotSubaccounts().then(x => {
    for (const key of Object.keys(x)) {
      subaccounts.value.add(key);
    }
  });
});

const props = withDefaults(
  defineProps<{
    position?: 'left' | 'right' | 'top';
  }>(),
  {
    position: 'top',
  },
);

const popoverSide = Vue.computed(() => {
  if (props.position === 'left') {
    return 'left';
  }

  return props.position === 'right' ? 'right' : 'top';
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
