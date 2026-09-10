<template>
  <OverlayBase
    title="Bidding Bot"
    :isOpen="isOpen"
    class="BiddingBotOverlay w-10/12 max-w-6xl text-base"
    data-testid="BiddingBotOverlay"
    @close="emit('close')"
    @pressEsc="emit('close')"
  >
    <template #default>
      <div class="px-6 py-5 text-slate-700">
        <section class="my-2 flex flex-row">
          <MiningFundsPopover
            :open="activeStat === 'capital'"
            :pinned="pinnedStat === 'capital'"
            :capitalTransfer="capitalTransfer"
            :capitalChangeError="capitalChangeError"
            @preview="previewStat('capital')"
            @leave="leaveStat('capital')"
            @togglePin="toggleStat('capital')"
            @dismiss="dismissStats"
            @updateCapital="changeMiningCapital"
          />

          <div data-testid="BiddingBotOverlay.statDivider" class="mx-2 w-px bg-slate-300/80" />

          <MiningWinningBidsPopover
            :open="activeStat === 'bids'"
            :pinned="pinnedStat === 'bids'"
            :bids="currentBids"
            @preview="previewStat('bids')"
            @leave="leaveStat('bids')"
            @togglePin="toggleStat('bids')"
            @dismiss="dismissStats"
          />

          <div data-testid="BiddingBotOverlay.statDivider" class="mx-2 w-px bg-slate-300/80" />

          <MiningSeatCapacityPopover
            :open="activeStat === 'seats'"
            :pinned="pinnedStat === 'seats'"
            @preview="previewStat('seats')"
            @leave="leaveStat('seats')"
            @togglePin="toggleStat('seats')"
            @dismiss="dismissStats"
            @manageCapital="showCapital"
            @openSettings="openBotSettings"
          />
        </section>

        <div data-testid="BiddingBotOverlay.gridDivider" class="my-3 border-t border-slate-300/50" aria-hidden="true" />

        <section class="grid grid-cols-2 divide-x divide-slate-300">
          <MiningBidTable
            ariaLabel="Previous auction bids"
            title="Yesterday's Winning Bids"
            :bids="previousBids"
            :currentTick="bot.state?.currentTick ?? miningFrames.currentTick"
            emptyText="No previous bids"
          />
          <MiningBidTable
            ariaLabel="Current auction bids"
            title="Current Winning Bids"
            :bids="currentBids"
            :currentTick="miningFrames.currentTick"
            :closesAtTick="currentAuctionClosesAtTick"
            emptyText="No current bids"
          />
        </section>
      </div>
    </template>
  </OverlayBase>
</template>

<script lang="ts">
export interface IMiningCapitalTransferProgress {
  id: number;
  progressPct: number;
  progressLabel: string;
  microgons: bigint;
  micronots: bigint;
  error?: string;
}
</script>

<script setup lang="ts">
import * as Vue from 'vue';
import { Mining, MoveFrom, MoveTo, type IMiningFrameDetail, type IWinningBid } from '@argonprotocol/apps-core';
import OverlayBase from '../OverlayBase.vue';
import MiningBidTable from './MiningBidTable.vue';
import MiningFundsPopover from './MiningFundsPopover.vue';
import MiningSeatCapacityPopover from './MiningSeatCapacityPopover.vue';
import MiningWinningBidsPopover from './MiningWinningBidsPopover.vue';
import basicEmitter from '../../emitters/basicEmitter.ts';
import type { ITransactionMoveMetadata } from '../../lib/txs/Balance.transfer.ts';
import type { TransactionInfo } from '../../lib/TransactionInfo.ts';
import { getBot } from '../../stores/bot.ts';
import { getMainchainClient, getMining, getMiningFrames } from '../../stores/mainchain.ts';
import { getMyMiningSeats } from '../../stores/myMiningSeats.ts';
import { getMoveCapital, getWalletKeys, useWallets } from '../../stores/wallets.ts';

const props = defineProps<{ isOpen: boolean }>();

const emit = defineEmits<{
  (event: 'close'): void;
}>();

const bot = getBot();
const mining = getMining();
const miningFrames = getMiningFrames();
const myMiningSeats = getMyMiningSeats();
const wallets = useWallets();
const moveCapital = getMoveCapital();
const previousBids = Vue.ref<IWinningBid[]>([]);
const currentBids = Vue.ref<IWinningBid[]>(
  (bot.isReady ? bot.state?.winningBids : undefined) ?? myMiningSeats.allWinningBids,
);
const currentAuctionClosesAtTick = Vue.ref(0);
const capitalTransfer = Vue.ref<IMiningCapitalTransferProgress>();
const capitalChangeError = Vue.ref<string | undefined>(moveCapital.data.allocationError);
let stopCapitalProgress: VoidFunction | undefined;
let biddingRefreshRequestId = 0;
let previousBidsBotRequestId = 0;

type StatId = 'capital' | 'bids' | 'seats';
const activeStat = Vue.ref<StatId>();
const pinnedStat = Vue.ref<StatId>();

function previewStat(stat: StatId) {
  if (!pinnedStat.value) activeStat.value = stat;
}

function leaveStat(stat: StatId) {
  if (!pinnedStat.value && activeStat.value === stat) activeStat.value = undefined;
}

function toggleStat(stat: StatId) {
  if (pinnedStat.value === stat) {
    dismissStats();
    return;
  }

  pinnedStat.value = stat;
  activeStat.value = stat;
}

function dismissStats() {
  activeStat.value = undefined;
  pinnedStat.value = undefined;
}

function showCapital() {
  activeStat.value = 'capital';
  pinnedStat.value = 'capital';
}

function openBotSettings() {
  dismissStats();
  basicEmitter.emit('openBotEditOverlay');
}

async function refreshBiddingData() {
  const requestId = ++biddingRefreshRequestId;
  const previousFrameId = myMiningSeats.latestFrameId - 1;

  if (previousFrameId > 0) {
    void bot
      .getClient()
      .then(client => client.fetch('/mining-frame', previousFrameId))
      .then(frame => {
        if (requestId === biddingRefreshRequestId) {
          previousBidsBotRequestId = requestId;
          previousBids.value = (frame as IMiningFrameDetail).winningBids;
        }
      })
      .catch(() => undefined);
  }

  void loadBidsFromChain(requestId);
  void mining
    .fetchTickAtStartOfAuctionClosing()
    .then(auctionCloseTick => {
      if (requestId === biddingRefreshRequestId) currentAuctionClosesAtTick.value = auctionCloseTick;
    })
    .catch(error => {
      console.error('[Bidding Bot Overlay] Unable to load auction close time', error);
    });
}

async function loadBidsFromChain(requestId: number) {
  try {
    await miningFrames.isLoadedPromise;
    const client = await getMainchainClient(true);
    const currentFrameId = miningFrames.currentFrameId;
    const [current, previous, subaccounts] = await Promise.all([
      bot.isReady ? undefined : Mining.fetchWinningBids(client),
      currentFrameId > 0 ? client.query.miningSlot.minersByCohort(currentFrameId) : [],
      getWalletKeys().getMiningBotSubaccounts(),
    ]);
    if (requestId !== biddingRefreshRequestId) return;

    if (!bot.isReady && current) {
      currentBids.value = current.map(bid => ({ ...bid, subAccountIndex: subaccounts[bid.address]?.index }));
    }
    if (previousBidsBotRequestId !== requestId) {
      previousBids.value = (previous ?? []).map((bid, bidPosition) => ({
        address: bid.accountId,
        subAccountIndex: subaccounts[bid.accountId]?.index,
        lastBidAtTick: 'bidAtTick' in bid ? bid.bidAtTick : undefined,
        bidPosition,
        microgonsPerSeat: bid.bid,
        micronotsStakedPerSeat: bid.argonots,
      }));
    }
  } catch (error) {
    console.error('[Bidding Bot Overlay] Unable to load winning bids from chain', error);
  }
}

async function changeMiningCapital(value: { microgons: bigint; micronots: bigint }) {
  capitalChangeError.value = undefined;
  try {
    await moveCapital.changeAllocation({
      targetMicrogons: value.microgons,
      targetMicronots: value.micronots,
      sourceWallet: wallets.defaultArgonWallet,
      allocatedWallet: wallets.miningBotWallet,
      allocateFrom: MoveFrom.DefaultArgon,
      allocateTo: MoveTo.MiningBot,
    });
  } catch (error) {
    capitalChangeError.value = error instanceof Error ? error.message : String(error);
    console.error('[Bidding Bot Overlay] Unable to change mining capital', error);
  }
}

function trackCapitalTransfer(txInfo: TransactionInfo<ITransactionMoveMetadata>) {
  capitalChangeError.value = undefined;
  stopCapitalProgress?.();
  const operation = txInfo.tx.metadataJson.allocationChange;
  if (!operation) return;

  const amounts = operation.legs.reduce(
    (total, leg) => ({
      microgons: total.microgons + (leg.assetsToMove.ARGN ?? 0n),
      micronots: total.micronots + (leg.assetsToMove.ARGNOT ?? 0n),
    }),
    { microgons: 0n, micronots: 0n },
  );
  capitalTransfer.value = {
    id: txInfo.tx.id,
    progressPct: txInfo.getStatus().progressPct,
    progressLabel: 'Preparing transaction...',
    ...amounts,
  };
  stopCapitalProgress = txInfo.subscribeToProgress((progress, error) => {
    capitalTransfer.value = {
      id: txInfo.tx.id,
      progressPct: progress.progressPct,
      progressLabel: progress.progressMessage,
      error: error?.message,
      ...amounts,
    };
  });
}

Vue.watch(
  () => props.isOpen,
  isOpen => {
    if (isOpen) void refreshBiddingData();
  },
  { immediate: true },
);

Vue.watch(
  () => bot.state?.winningBids,
  bids => {
    if (bids !== undefined) currentBids.value = bids;
    if (props.isOpen) void refreshBiddingData();
  },
);

Vue.watch(
  () => moveCapital.data.pendingAllocationChange,
  txInfo => {
    if (txInfo) trackCapitalTransfer(txInfo);
    else {
      stopCapitalProgress?.();
      stopCapitalProgress = undefined;
      if (capitalTransfer.value?.error) capitalChangeError.value = capitalTransfer.value.error;
      capitalTransfer.value = undefined;
    }
  },
  { immediate: true },
);

Vue.watch(
  () => moveCapital.data.allocationError,
  error => {
    if (error) capitalChangeError.value = error;
  },
);

Vue.onBeforeUnmount(() => {
  stopCapitalProgress?.();
});
</script>
