<template>
  <TooltipProvider :disableHoverableContent="true">
    <div ref="seatGridElem" class="seat-grid" :style="seatGridStyle">
      <TooltipRoot v-for="item of gridSeats" :key="`seat-id-${item.seat.id}`">
        <TooltipTrigger
          :class="
            twMerge(
              'seat-dot relative flex flex-row items-center justify-center border text-sm transition-colors duration-500',
              getSeatBorderClasses(item.seat),
              getSeatBackgroundClasses(item.seat),
              getLastBlockMinerSeatClasses(item.seat),
            )
          "
          @mouseenter="setHoveredSlotId(item.seat.slotId)"
          @mouseleave="clearHoveredSlotId(item.seat.slotId)"
          @focus="setHoveredSlotId(item.seat.slotId)"
          @blur="clearHoveredSlotId(item.seat.slotId)">
          <svg v-if="item.startingFrameId !== null" viewBox="0 0 36 36" class="seat-progress-ring" aria-hidden="true">
            <circle
              cx="18"
              cy="18"
              r="17.2"
              pathLength="100"
              :stroke-dasharray="`${getSeatProgressPct(item.startingFrameId)} 100`"
              :class="twMerge('seat-progress-value', getSeatProgressColorClasses(item.seat))" />
          </svg>
          <span
            v-if="props.isLiveFrame && item.seat.miner?.address === props.lastBlockMinerAddress"
            class="relative z-10 flex h-full w-full items-center justify-center">
            <MinerIcon class="h-[54%] w-[54%] text-white" />
          </span>
          <span
            v-else
            class="relative z-10 opacity-50"
            :class="item.seat.miner?.isOurs && item.seat.slotId === currentAuctionSlot ? 'underline' : ''">
            {{ item.seat.id }}
          </span>
        </TooltipTrigger>
        <TooltipContent side="bottom" align="center" :sideOffset="-5" :collisionPadding="9" class="relative z-[1000]">
          <SeatTooltip
            :seat="item.seat"
            :frameId="props.frameId"
            :isLiveFrame="props.isLiveFrame"
            :startingFrameId="item.startingFrameId"
            :ourBidAddresses="ourBidAddresses"
            :hasAuction="item.seat.slotId === currentAuctionSlot"
            :tooltipStats="
              item.seat.miner ? seatTooltipStatsByStartingFrameId[item.seat.miner.startingFrameId] : null
            " />
          <TooltipArrow :width="27" :height="15" class="z-20 -mt-px fill-white stroke-slate-800/20 stroke-[0.5px]" />
        </TooltipContent>
      </TooltipRoot>
    </div>
  </TooltipProvider>
</template>

<script setup lang="ts">
import * as Vue from 'vue';
import { twMerge } from 'tailwind-merge';
import { IMiningSeat, IMiningSlot, IMiningSlotBid } from '@argonprotocol/apps-core';
import { getBlockWatch, getMining, getMiningFrames } from '../../../stores/mainchain.ts';
import { getWalletKeys, useWallets } from '../../../stores/wallets.ts';
import { TooltipProvider, TooltipRoot, TooltipTrigger, TooltipContent, TooltipArrow } from 'reka-ui';
import { getDbPromise } from '../../../stores/helpers/dbPromise.ts';
import SeatTooltip from './SeatTooltip.vue';
import { botEmitter } from '../../../lib/Bot.ts';
import MinerIcon from '../../../assets/miner.svg?component';
import { getMiningSeatProgressAtFrame } from '../miningSeatProgress.ts';

type ISeatTooltipStats = {
  microgonsToBeMinedPerSeat: bigint;
  micronotsToBeMinedPerSeat: bigint;
};

type IMiningDisplaySeat = IMiningSeat & {
  startingFrameId?: number | null;
};

type IMiningDisplaySlot = Omit<IMiningSlot, 'seats'> & {
  seats: IMiningDisplaySeat[];
};

const props = defineProps<{
  isLiveFrame: boolean;
  frameId: number;
  lastBlockMinerAddress?: string;
  frameSlots?: IMiningDisplaySlot[] | null;
}>();

const mining = getMining();
const miningFrames = getMiningFrames();
const dbPromise = getDbPromise();
const wallets = useWallets();
const walletKeys = getWalletKeys();

const currentAuctionSlot = Vue.computed(() => {
  const miningSlotId = (props.frameId % 10) + 1;
  return miningSlotId < 10 ? miningSlotId : 0;
});

const seatGridElem = Vue.ref<HTMLElement | null>(null);
const seatGridWidth = Vue.ref(0);
const seatGridHeight = Vue.ref(0);
let seatGridObserver: ResizeObserver | null = null;

const slots = Vue.ref<IMiningDisplaySlot[]>([]);

const ourBidAddresses = Vue.ref<Set<string>>(new Set());
const hoveredSlotId = Vue.ref<number | null>(null);
const seatTooltipStatsByStartingFrameId = Vue.ref<Record<number, ISeatTooltipStats | null>>({});

let clearHoveredSlotIdTimeout: ReturnType<typeof setTimeout> | null = null;
let stopBlockWatchSubscription: (() => void) | null = null;
let isRefreshingSeats = false;
let shouldRefreshSeatsAgain = false;
let isRefreshingSeatTooltipStats = false;
let shouldRefreshSeatTooltipStatsAgain = false;

const gridSeats = Vue.computed<{ seat: IMiningDisplaySeat; startingFrameId: number | null }[]>(() => {
  return slots.value.flatMap(slot =>
    slot.seats.map(seat => ({
      seat,
      startingFrameId: getSeatStartingFrameId(seat),
    })),
  );
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

function getSeatBorderClasses(seat: IMiningDisplaySeat): string {
  if (getSeatStartingFrameId(seat) !== null) {
    return props.isLiveFrame && seat.slotId === currentAuctionSlot.value
      ? 'border-transparent current-slot-seat'
      : 'border-transparent';
  }

  if (seat.slotId === currentAuctionSlot.value) {
    if (isWinningBid(seat.bid)) {
      return `border-argon-600 border-2 ${props.isLiveFrame ? 'current-slot-seat' : ''}`;
    }

    return `border-[1.5px] border-slate-500/70 ${props.isLiveFrame ? 'current-slot-seat' : ''}`;
  }

  if (isWinningBid(seat.bid)) {
    return 'border-[1.5px] border-argon-400/40';
  }

  return 'border-[1.5px] border-slate-400/45';
}

function getSeatBackgroundClasses(seat: IMiningDisplaySeat): string {
  if (seat.slotId === hoveredSlotId.value) {
    return seat.miner?.isOurs ? 'bg-argon-300/40' : 'bg-slate-200/70';
  }

  return seat.miner?.isOurs ? 'bg-argon-300/30' : 'bg-slate-100/60';
}

function getLastBlockMinerSeatClasses(seat: IMiningDisplaySeat): string {
  if (!props.isLiveFrame) return '';
  if (seat.miner?.address !== props.lastBlockMinerAddress) return '';

  if (seat.slotId === currentAuctionSlot.value) {
    return isWinningBid(seat.bid) ? 'bg-argon-600 text-white' : 'bg-slate-500/70 text-white';
  }

  return seat.miner?.isOurs ? 'bg-argon-500/60 text-white' : 'bg-slate-400/70 text-white';
}

function getSeatStartingFrameId(seat: IMiningDisplaySeat): number | null {
  return seat.startingFrameId ?? seat.miner?.startingFrameId ?? null;
}

function getSeatProgressPct(startingFrameId: number): number {
  const progress = getMiningSeatProgressAtFrame(
    startingFrameId,
    props.frameId,
    props.isLiveFrame ? miningFrames.getCurrentFrameProgress() : 100,
  );
  if (progress < 0) return 0;
  if (progress > 100) return 100;
  return progress;
}

function getSeatProgressColorClasses(seat: IMiningDisplaySeat): string {
  if (seat.slotId === currentAuctionSlot.value) {
    return isWinningBid(seat.bid) ? 'text-argon-400/50' : 'text-slate-300/50';
  }

  return seat.miner?.isOurs ? 'text-argon-300/45' : 'text-slate-300/40';
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

  let nextSlots: IMiningDisplaySlot[];

  if (props.frameSlots) {
    nextSlots = props.frameSlots;
  } else {
    try {
      if (props.isLiveFrame) {
        nextSlots = (await mining.fetchCurrentMiningSeats(wallets.miningBotWallet.address)) as IMiningDisplaySlot[];
      } else {
        nextSlots = props.frameSlots ?? [];
      }
    } catch (error) {
      console.error(`[Mining Seats] Failed to load live seats for frame ${props.frameId}`, error);
      slots.value = [];
      return;
    }
  }

  slots.value = nextSlots;
  await refreshSeatTooltipStats();
}

async function refreshSeats() {
  if (isRefreshingSeats) {
    shouldRefreshSeatsAgain = true;
    return;
  }

  isRefreshingSeats = true;
  try {
    do {
      shouldRefreshSeatsAgain = false;
      await updateSeats();
    } while (shouldRefreshSeatsAgain);
  } finally {
    isRefreshingSeats = false;
  }
}

async function subscribeToLiveSeatUpdates() {
  stopBlockWatchSubscription?.();
  stopBlockWatchSubscription = null;

  if (!props.isLiveFrame) {
    return;
  }

  const blockWatch = getBlockWatch();
  await blockWatch.start();
  stopBlockWatchSubscription = blockWatch.events.on('best-blocks', () => {
    void refreshSeats();
  });
}

function onLiveSeatsUpdated() {
  if (!props.isLiveFrame) {
    return;
  }

  void refreshSeats();
}

Vue.watch(seatGridElem, observeSeatGrid, { flush: 'post' });

Vue.watch(
  () => [props.frameId, props.isLiveFrame, props.frameSlots],
  () => {
    void refreshSeats();
  },
);

Vue.watch(
  () => props.isLiveFrame,
  () => {
    void subscribeToLiveSeatUpdates();
  },
  { immediate: true },
);

Vue.onMounted(() => {
  void refreshSeats();
  observeSeatGrid();
  botEmitter.on('updated-bids-data', onLiveSeatsUpdated);
  botEmitter.on('updated-cohort-data', onLiveSeatsUpdated);
});

Vue.onUnmounted(() => {
  seatGridObserver?.disconnect();
  stopBlockWatchSubscription?.();
  if (clearHoveredSlotIdTimeout) {
    clearTimeout(clearHoveredSlotIdTimeout);
  }
  botEmitter.off('updated-bids-data', onLiveSeatsUpdated);
  botEmitter.off('updated-cohort-data', onLiveSeatsUpdated);
});

async function refreshSeatTooltipStats(): Promise<void> {
  if (isRefreshingSeatTooltipStats) {
    shouldRefreshSeatTooltipStatsAgain = true;
    return;
  }

  isRefreshingSeatTooltipStats = true;
  try {
    do {
      shouldRefreshSeatTooltipStatsAgain = false;

      const missingStartingFrameIds = getVisibleStartingFrameIds().filter(id => {
        return seatTooltipStatsByStartingFrameId.value[id] == null;
      });
      if (!missingStartingFrameIds.length) {
        continue;
      }

      const db = await dbPromise;
      const cohorts = await db.cohortsTable.fetchByIds(missingStartingFrameIds);
      const tooltipStatsByStartingFrameId = { ...seatTooltipStatsByStartingFrameId.value };

      for (const startingFrameId of missingStartingFrameIds) {
        tooltipStatsByStartingFrameId[startingFrameId] = null;
      }

      for (const cohort of cohorts) {
        tooltipStatsByStartingFrameId[cohort.id] = {
          microgonsToBeMinedPerSeat: cohort.microgonsToBeMinedPerSeat,
          micronotsToBeMinedPerSeat: cohort.micronotsToBeMinedPerSeat,
        };
      }

      seatTooltipStatsByStartingFrameId.value = tooltipStatsByStartingFrameId;
    } while (shouldRefreshSeatTooltipStatsAgain);
  } finally {
    isRefreshingSeatTooltipStats = false;
  }
}

function getVisibleStartingFrameIds(): number[] {
  return [
    ...new Set(gridSeats.value.flatMap(({ startingFrameId }) => (startingFrameId !== null ? [startingFrameId] : []))),
  ];
}
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

.seat-progress-ring {
  @apply pointer-events-none absolute -inset-px h-[calc(100%+2px)] w-[calc(100%+2px)] -rotate-90 overflow-visible;
}

.seat-progress-value {
  fill: none;
  stroke: currentColor;
  stroke-width: 2.5;
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
