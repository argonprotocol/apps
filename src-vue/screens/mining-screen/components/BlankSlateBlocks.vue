<template>
  <div class="BlankSlateBlocks Component h-[117px] w-full overflow-hidden">
    <Motion
      as="ul"
      :animate="{ x: `${translateX}%` }"
      :transition="isAnimationEnabled ? { duration: 0.6, ease: 'easeOut' } : { duration: 0 }"
      class="flex h-full w-full flex-row justify-end">
      <template v-for="(block, idx) in blocks" :key="`block-${block.hash}-${animationKey}`">
        <li
          Block
          class="pulse-highlight relative leading-5.5"
          :class="{
            isLoading: !block.hash,
            isLoaded: block.hash,
            isNew: block.isNew,
          }"
          :style="{ animationDelay: `${getAnimationDelay(idx)}ms` }">
          <div class="absolute top-0 left-0 h-px w-full bg-white"></div>
          <div class="absolute top-0 left-0 h-full w-px bg-white"></div>
          <template v-if="block.hash">
            <div class="mb-2 border-b border-slate-300 pb-1">
              #
              <span class="font-bold opacity-50">{{ block.number }}</span>
            </div>
            <div>{{ block.timestamp.local().format('h:mm A') }}</div>
            <div>{{ microgonToArgonNm(block.microgons).format('0.[00]') }} argons</div>
            <div>{{ micronotToArgonotNm(block.micronots).format('0.[00]') }} argonots</div>
          </template>
          <template v-else-if="block.isMining">
            <div class="flex flex-col items-center justify-center text-center">
              <img src="/mining.gif" class="relative -left-1 mt-2 inline-block w-8" />
              <div class="flex flex-row justify-center pt-4">
                <div class="flex flex-col items-center leading-none">
                  <div>{{ minutesSinceBlock }}</div>
                  <div>min{{ minutesSinceBlock === 1 ? '' : 's' }}</div>
                </div>
                <div class="mx-3 h-full w-[1px] bg-slate-300"></div>
                <div class="flex flex-col items-center leading-none">
                  <div>{{ secondsSinceBlock }}</div>
                  <div>sec{{ secondsSinceBlock === 1 ? '' : 's' }}</div>
                </div>
              </div>
            </div>
          </template>
          <template v-else></template>
        </li>
        <li Connection :class="{ isLoading: !block.hash, isLoaded: block.hash }">
          <div class="wrapper">
            <div></div>
          </div>
        </li>
      </template>
    </Motion>
  </div>
</template>

<script lang="ts">
import { IBlock as IBlockchainBlock } from '../../../stores/blockchain';

interface IBlock extends IBlockchainBlock {
  isMining?: boolean;
  isNew?: boolean;
}

const blocks = Vue.ref<IBlock[]>([]);
</script>

<script lang="ts" setup>
import * as Vue from 'vue';
import { useCurrency } from '../../../stores/currency';
import { createNumeralHelpers } from '../../../lib/numeral';
import { storeToRefs } from 'pinia';
import { useBlockchainStore } from '../../../stores/blockchain';
import dayjs, { Dayjs } from 'dayjs';
import utc from 'dayjs/plugin/utc';
import { Motion } from 'motion-v';

dayjs.extend(utc);

const blockchainStore = useBlockchainStore();
const currency = useCurrency();
const { microgonToArgonNm, micronotToArgonotNm } = createNumeralHelpers(currency);

const { cachedBlocks } = storeToRefs(blockchainStore);

const minutesSinceBlock = Vue.ref(0);
const secondsSinceBlock = Vue.ref(0);

const translateX = Vue.ref(0);
const isAnimationEnabled = Vue.ref(false);
const animationKey = Vue.ref(0); // Force re-render of animations

const startedWithBlocks = blocks.value.some(block => block.hash);
blocks.value = [...cachedBlocks.value];

let blocksSubscription: any = null;
let lastBlockTimestamp: Dayjs;
let timeSinceBlockTimeout: any = null;

// Animation delay calculation based on visual position
function getAnimationDelay(position: number): number {
  return (position + 1) * 200;
}

function resetBlockAnimations() {
  // Increment animation key to force re-render of all blocks
  animationKey.value++;
}

function appendMiningBlock(useAnimation: boolean = true) {
  const lastBlock = blocks.value[blocks.value.length - 1];
  if (lastBlock.isMining) return;

  blocks.value.push({
    number: 0,
    hash: '',
    author: '',
    microgons: 0n,
    micronots: 0n,
    timestamp: dayjs.utc(),
    isMining: true,
  });

  if (useAnimation) {
    // Pause animation
    isAnimationEnabled.value = false;
    translateX.value = 10.8;
    setTimeout(() => {
      // Unpause animation and animate to 0
      isAnimationEnabled.value = true;
      translateX.value = 0;
    }, 100);
  }

  resetBlockAnimations();

  setTimeout(() => {
    if (blocks.value.length > 9) {
      blocks.value.shift();
    }
  }, 1000);
}

async function loadBlocks() {
  const fetchPromise = blockchainStore.fetchBlocks(null, 9).then(newBlocks => {
    cachedBlocks.value = newBlocks.reverse();
    blocks.value = [...cachedBlocks.value];
    const lastBlock = cachedBlocks.value[cachedBlocks.value.length - 1];
    lastBlockTimestamp = lastBlock?.timestamp;
    setTimeout(() => appendMiningBlock(), 1000);
  });

  if (startedWithBlocks) {
    const lastBlock = cachedBlocks.value[cachedBlocks.value.length - 1];
    lastBlockTimestamp = lastBlock?.timestamp;
    updateTimeSinceBlock(false);
  } else {
    await fetchPromise;
  }

  blocksSubscription = await blockchainStore.subscribeToBlocks(newBlockData => {
    const blockExists = cachedBlocks.value.find(x => x.number === newBlockData.number);
    if (blockExists) return;

    // Add new block to array (now has 10 items)
    (newBlockData as IBlock).isNew = true;
    cachedBlocks.value.push(newBlockData);
    cachedBlocks.value.sort((a, b) => a.number - b.number);
    if (cachedBlocks.value.length > 9) {
      cachedBlocks.value.splice(0, cachedBlocks.value.length - 9);
    }
    blocks.value = [...cachedBlocks.value];
    lastBlockTimestamp = newBlockData.timestamp;
    updateTimeSinceBlock(false);

    setTimeout(() => appendMiningBlock(), 1000);
    setTimeout(() => {
      (newBlockData as IBlock).isNew = false;
    }, 2000);
  });
}

function updateTimeSinceBlock(runContinuously: boolean = true) {
  if (lastBlockTimestamp) {
    const now = dayjs.utc();
    const totalSecondsSinceBlock = now.diff(lastBlockTimestamp, 'seconds');
    minutesSinceBlock.value = totalSecondsSinceBlock < 60 ? 0 : Math.floor(totalSecondsSinceBlock / 60);
    secondsSinceBlock.value = totalSecondsSinceBlock % 60;
  }
  if (runContinuously) {
    timeSinceBlockTimeout = setTimeout(updateTimeSinceBlock, 1000);
  }
}

Vue.onMounted(async () => {
  updateTimeSinceBlock();
  await loadBlocks();
});

Vue.onBeforeUnmount(() => {
  if (blocksSubscription) {
    blocksSubscription();
    blocksSubscription = null;
  }
  if (timeSinceBlockTimeout) {
    clearTimeout(timeSinceBlockTimeout);
    timeSinceBlockTimeout = null;
  }
});
</script>

<style scoped>
@reference "../../../main.css";

@keyframes pulseHighlight {
  0%,
  100% {
    opacity: 0.8;
    background-color: rgba(255, 255, 255, 0.7);
    border-color: rgba(203, 213, 225, 0.8);
  }
  50% {
    opacity: 1;
    background-color: rgba(139, 92, 246, 0.1);
    border-color: rgba(139, 92, 246, 0.4);
  }
}

@keyframes newBlockFadeIn {
  0% {
    opacity: 0;
    transform: scale(0.9);
  }
  100% {
    opacity: 1;
    transform: scale(1);
  }
}

.BlankSlateBlocks {
  position: relative;
  &:before {
    content: '';
    display: block;
    position: absolute;
    top: 0;
    left: -2px;
    width: 8%;
    height: calc(100% + 2px);
    background: linear-gradient(to right, rgba(249, 242, 250, 1), rgba(249, 242, 250, 0));
    z-index: 10;
  }
}

ul {
  position: relative;
  width: 100%;
  min-width: 100%;

  li[Block] {
    @apply relative rounded border border-slate-800/20 bg-white/20;
    &.isNew:before {
      content: '';
      position: absolute;
      top: -1px;
      left: -1px;
      width: calc(100% + 2px);
      height: calc(100% + 2px);
      @apply border-argon-600/60 bg-argon-600/20 z-1 rounded border;
    }
    &.isLoaded {
      @apply shadow;
    }
    width: calc(95% / 9);
    flex-shrink: 0;
    text-align: center;
    padding: 5px 5px;
    font-weight: 200;
    transition: all 0.3s ease;

    &.pulse-highlight {
      animation: pulseHighlight 3s ease-in-out infinite;
    }
  }
  li[Connection] {
    width: calc(5% / 8);
    flex-shrink: 0;
    position: relative;
    z-index: 5;
    &:last-child {
      display: none;
    }
    div.wrapper {
      display: block;
      width: calc(100% + 16px);
      height: 7px;
      position: absolute;
      top: 50%;
      right: -8px;
      transform: translateY(-50%);
      background: white;
    }
    div.wrapper > div {
      display: block;
      width: 100%;
      height: 100%;
      box-shadow: 1px 1px 0 0 rgba(0, 0, 0, 0.5);
      background-color: #b9bcc0;
    }
  }
}
</style>
