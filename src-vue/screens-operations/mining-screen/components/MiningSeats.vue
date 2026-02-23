<template>
  <TooltipProvider :disableHoverableContent="true">
    <div ref="seatGridElem" class="seat-grid" :style="seatGridStyle">
      <TooltipRoot v-for="item of gridSeats" :key="`seat-id-${item.seat.id}`">
        <TooltipTrigger
          :class="
            twMerge(
              'seat-dot flex flex-row items-center justify-center border text-sm transition-colors duration-500',
              item.seat.slotId === currentAuctionSlot
                ? isWinningBid(item.seat.bid)
                  ? 'border-argon-600 current-slot-seat border-2 border-dashed'
                  : 'current-slot-seat border-[1.5px] border-dashed border-slate-500/70'
                : item.seat.miner?.isOurs
                  ? 'border-argon-500/30'
                  : 'border-slate-400/30',
              item.seat.slotId === hoveredSlotId
                ? item.seat.miner?.isOurs
                  ? 'bg-argon-300/40'
                  : 'bg-slate-200/70'
                : item.seat.miner?.isOurs
                  ? 'bg-argon-300/30'
                  : 'bg-slate-100/60',
            )
          "
          @mouseenter="setHoveredSlotId(item.seat.slotId)"
          @mouseleave="clearHoveredSlotId(item.seat.slotId)"
          @focus="setHoveredSlotId(item.seat.slotId)"
          @blur="clearHoveredSlotId(item.seat.slotId)">
          <span
            class="opacity-50"
            :class="item.seat.miner?.isOurs && item.seat.slotId === currentAuctionSlot ? 'underline' : ''">
            {{ item.seat.id }}
          </span>
        </TooltipTrigger>
        <TooltipContent side="bottom" align="center" :sideOffset="-5" :collisionPadding="9" class="relative z-10">
          <SeatTooltip
            :seat="item.seat"
            :ourBidAddresses="ourBidAddresses"
            :hasAuction="item.seat.slotId === currentAuctionSlot" />
          <TooltipArrow :width="27" :height="15" class="z-20 -mt-px fill-white stroke-slate-800/20 stroke-[0.5px]" />
        </TooltipContent>
      </TooltipRoot>
    </div>
  </TooltipProvider>
</template>

<script setup lang="ts">
import * as Vue from 'vue';
import { twMerge } from 'tailwind-merge';
import { getMining } from '../../../stores/mainchain.ts';
import { IMiningSeat, IMiningSlot, IMiningSlotBid } from '@argonprotocol/apps-core';
import { getWalletKeys, useWallets } from '../../../stores/wallets.ts';
import { getStats } from '../../../stores/stats.ts';
import { TooltipProvider, TooltipRoot, TooltipTrigger, TooltipContent, TooltipArrow } from 'reka-ui';
import SeatTooltip from './SeatTooltip.vue';

const mining = getMining();
const wallets = useWallets();
const walletKeys = getWalletKeys();
const stats = getStats();

const currentAuctionSlot = Vue.computed(() => {
  const currentSlotId = stats.latestFrameId % 10;
  const miningSlotId = currentSlotId + 1;
  return miningSlotId < 10 ? miningSlotId : 0;
});

const seatGridElem = Vue.ref<HTMLElement | null>(null);
const seatGridWidth = Vue.ref(0);
const seatGridHeight = Vue.ref(0);
let seatGridObserver: ResizeObserver | null = null;

const slots = Vue.ref<IMiningSlot[]>([]);
const ourBidAddresses = Vue.ref<Set<string>>(new Set());
const hoveredSlotId = Vue.ref<number | null>(null);
let clearHoveredSlotIdTimeout: ReturnType<typeof setTimeout> | null = null;
const gridSeats = Vue.computed<{ seat: IMiningSeat }[]>(() => {
  return slots.value.flatMap(slot => slot.seats.map(seat => ({ seat })));
});

const seatGridStyle = Vue.computed((): Record<string, string> => {
  const dotCount = gridSeats.value.length;
  if (!dotCount) {
    return {};
  }

  const baseGapX = 6;
  const gapY = 6;
  const width = Math.max(seatGridWidth.value, 1);
  const height = Math.max(seatGridHeight.value, 1);
  const cols = Math.max(1, Math.ceil(Math.sqrt((dotCount * width) / height)));
  const rows = Math.max(1, Math.ceil(dotCount / cols));
  let dotPx = Math.max(
    3,
    Math.floor(Math.min((width - (cols - 1) * baseGapX) / cols, (height - (rows - 1) * gapY) / rows)),
  );

  if (dotPx * cols > width) {
    dotPx = Math.max(3, Math.floor(width / cols));
  }

  const gapX = cols > 1 ? Math.max(0, (width - dotPx * cols) / (cols - 1)) : 0;

  return {
    '--seat-dot-size': `${dotPx}px`,
    '--seat-dot-gap-x': `${gapX}px`,
    '--seat-dot-gap-y': `${gapY}px`,
    gridTemplateColumns: `repeat(${cols}, var(--seat-dot-size))`,
    justifyContent: 'start',
  };
});

function isWinningBid(bid: IMiningSlotBid | null) {
  if (!bid) return false;
  return ourBidAddresses.value.has(bid.address);
}

function observeSeatGrid() {
  seatGridObserver?.disconnect();
  seatGridObserver = null;
  if (!seatGridElem.value) {
    seatGridWidth.value = 0;
    seatGridHeight.value = 0;
    return;
  }

  seatGridObserver = new ResizeObserver(entries => {
    const rect = entries[0]?.contentRect;
    if (!rect) return;
    seatGridWidth.value = rect.width;
    seatGridHeight.value = rect.height;
  });
  seatGridObserver.observe(seatGridElem.value);
}

function setHoveredSlotId(slotId: number): void {
  if (clearHoveredSlotIdTimeout) {
    clearTimeout(clearHoveredSlotIdTimeout);
    clearHoveredSlotIdTimeout = null;
  }
  hoveredSlotId.value = slotId;
}

function clearHoveredSlotId(slotId: number): void {
  if (clearHoveredSlotIdTimeout) {
    clearTimeout(clearHoveredSlotIdTimeout);
  }

  clearHoveredSlotIdTimeout = setTimeout(() => {
    if (hoveredSlotId.value === slotId) {
      hoveredSlotId.value = null;
    }
    clearHoveredSlotIdTimeout = null;
  }, 500);
}

async function updateSeats() {
  const subaccounts = await walletKeys.getMiningBotSubaccounts();
  ourBidAddresses.value = new Set(Object.keys(subaccounts));
  slots.value = await mining.fetchCurrentMiningSeats(wallets.miningBotWallet.address);
}

Vue.watch(seatGridElem, observeSeatGrid, { flush: 'post' });

Vue.onMounted(() => {
  updateSeats();
  observeSeatGrid();
});

Vue.onUnmounted(() => {
  seatGridObserver?.disconnect();
  if (clearHoveredSlotIdTimeout) {
    clearTimeout(clearHoveredSlotIdTimeout);
  }
});
</script>

<style scoped>
@reference "../../../main.css";

.seat-grid {
  @apply grid h-full w-full content-center;
  column-gap: var(--seat-dot-gap-x, 6px);
  row-gap: var(--seat-dot-gap-y, 6px);
}

.seat-dot {
  @apply rounded-full;
  width: var(--seat-dot-size, 14px);
  height: var(--seat-dot-size, 14px);
  text-shadow: 1px 1px 0 rgba(255, 255, 255, 0.7);
}

.current-slot-seat {
  animation: current-slot-fade 1.25s ease-in-out infinite;
}

@keyframes current-slot-fade {
  0%,
  100% {
    opacity: 0.3;
  }
  50% {
    opacity: 1;
  }
}
</style>
