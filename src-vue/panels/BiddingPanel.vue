<!-- prettier-ignore -->
<template>
  <DialogRoot class="absolute inset-0 z-10" :open="isOpen">
    <DialogPortal>
      <DialogOverlay asChild>
        <BgOverlay rounded="none" :style="{ zIndex: overlayZIndex.backdropZIndex }" @close="closePanel" />
      </DialogOverlay>

      <DialogContent asChild @escapeKeyDown="closePanel" :aria-describedby="undefined" :style="{ zIndex: overlayZIndex.contentZIndex }">
        <div
          class="BiddingPanel inner-input-shadow bg-argon-menu-bg absolute top-[80px] bottom-[80px] left-1/2 flex w-10/12 min-w-[1000px] max-w-[1500px] -translate-x-1/2 flex-col overflow-hidden rounded-md border border-black/30 text-left transition-all focus:outline-none"
          style="
            box-shadow:
              0 -1px 2px 0 rgba(0, 0, 0, 0.1),
              inset 0 2px 0 rgba(255, 255, 255, 1);
          "
        >
          <div class="mx-1 flex min-h-[60px] flex-row items-center gap-x-5 border-b border-slate-300 bg-white pl-5 pr-5">
            <DialogTitle class="text-2xl font-bold text-slate-800/70">Bidding Panel</DialogTitle>
            <div
              v-if="isBiddingControlUpdating || didPauseBiddingForPanel || bot.state?.isBiddingPaused"
              class="border-argon-700 bg-argon-500 flex items-center gap-x-2 rounded border px-3 py-1.5 text-sm font-bold text-white shadow-sm"
            >
              <PauseIcon class="size-4" />
              <template v-if="biddingControlAction === 'resume'">Resuming automatic bids...</template>
              <template v-else-if="isBiddingControlUpdating">Pausing automatic bids...</template>
              <template v-else>Automatic bidding is paused while you review bids</template>
            </div>
            <div
              @click="closePanel"
              class="absolute top-[18px] right-5 z-50 flex h-[30px] w-[30px] cursor-pointer items-center justify-center rounded-md border border-slate-400/60 text-sm/6 font-semibold hover:border-slate-500/70 hover:bg-[#D6D9DF] focus:outline-none">
              <XMarkIcon class="h-5 w-5 stroke-4 text-[#B74CBA]" />
            </div>
          </div>

          <div v-if="isLoaded" class="flex min-h-0 grow flex-col gap-y-3 overflow-y-auto px-5 py-4">
            <section box class="grid shrink-0 grid-cols-[1fr_1fr_1.5fr_1fr_1fr] overflow-hidden">
              <div stat-box>
                <span>
                  {{ currency.symbol }}{{ microgonToMoneyNm(miningAssets.auctionMicrogonsUnused + miningAssets.auctionMicrogonsActivated + transactionFees).format('0,0.[00]') }}
                </span>
                <label>In Starting Capital</label>
              </div>
              <div stat-box>
                <span>{{ currency.symbol }}{{ microgonToMoneyNm(miningAssets.auctionMicrogonsUnused).format('0,0.[00]') }}</span>
                <label>Available for Bidding</label>
              </div>
              <div stat-box>
                <span>Auction #{{ currentFrameId }}</span>
                <label>{{ currentFrameStartDate }} to {{ currentFrameEndDate }}</label>
              </div>
              <div stat-box>
                <span>{{ currency.symbol }}{{ microgonToMoneyNm(miningAssets.auctionMicrogonsActivated).format('0,0.[00]') }}</span>
                <label>Locked in Bid Escrow</label>
              </div>
              <div stat-box>
                <span>{{ micronotToArgonotNm(currentMicronotsForBid).format('0,0.[00000000]') }}</span>
                <label class="flex items-center gap-x-1">
                  ARGNOT Collateral / Seat
                  <Tooltip
                    asChild
                    side="top"
                    content="The network sets this collateral from 2x the previous day's median winning bid, converted at the previous frame's average ARGNOT price."
                  >
                    <span class="cursor-help text-slate-400 hover:text-slate-600">
                      <InformationCircleIcon class="size-3.5" />
                    </span>
                  </Tooltip>
                </label>
              </div>
            </section>

            <section box class="flex shrink-0 flex-col gap-y-3 px-4 py-3">
              <div class="flex items-start justify-between gap-x-6">
                <div>
                  <div class="text-lg font-bold text-slate-800/80">Your Next Bid</div>
                  <div class="mt-1 text-sm text-slate-600">
                    {{ nextBidTimingText }}
                  </div>
                </div>
                <div class="flex items-center gap-x-3">
                  <div v-if="currentBidIsWaiting" class="text-right text-sm font-medium text-amber-700">
                    Waiting on last bid finalization
                  </div>
                  <Tooltip
                    v-if="bot.state?.isBiddingOpen || didPauseBiddingForPanel || bot.state?.isBiddingPaused"
                    asChild
                    side="left"
                    content="Pause automatic bidding while you prepare a manual bid. An in-flight bid will still finalize."
                  >
                    <button
                      type="button"
                      class="cursor-pointer rounded border px-3 py-1.5 text-sm font-semibold transition-colors disabled:cursor-wait disabled:opacity-50"
                      :class="
                        didPauseBiddingForPanel || bot.state?.isBiddingPaused
                          ? 'border-argon-400 text-argon-700 hover:bg-argon-50'
                          : 'border-slate-300 text-slate-600 hover:border-slate-400 hover:bg-slate-50'
                      "
                      :disabled="isBiddingControlUpdating"
                      @click="toggleAutomaticBidding"
                    >
                      <template v-if="isBiddingControlUpdating">Updating...</template>
                      <template v-else-if="didPauseBiddingForPanel || bot.state?.isBiddingPaused">
                        Resume Auto-Bidding
                      </template>
                      <template v-else>Pause Auto-Bidding</template>
                    </button>
                  </Tooltip>
                </div>
              </div>

              <div v-if="biddingControlError" class="text-sm font-medium text-red-700">
                {{ biddingControlError }}
              </div>

              <template v-if="bot.state?.isBiddingOpen">
                <div class="flex items-center justify-between gap-x-6 rounded border border-slate-300/70 bg-slate-50 px-3 py-2 text-sm text-slate-700">
                  <div>
                    <span class="font-bold text-slate-800/80">Current:</span>
                    <span class="font-mono">{{ currentBidSummary }}</span>
                  </div>
                  <div>
                    <span class="font-bold text-slate-800/80">ARGNOT locked:</span>
                    <span class="font-mono">
                      {{ micronotToArgonotNm(myMiningSeats.pendingBids.micronotsStakedTotal).format('0,0.[00000000]') }}
                    </span>
                  </div>
                </div>

                <div class="grid grid-cols-[minmax(0,1fr)_minmax(160px,220px)_220px] items-end gap-x-4">
                  <InputMoney
                    v-model="draftMicrogonsPerSeat"
                    :min="minBidIncrement"
                    :dragBy="minBidIncrement"
                    :dragByMin="minBidIncrement"
                    :minDecimals="2"
                    :maxDecimals="2"
                    suffix=" / seat"
                    class="w-full"
                    @update:modelValue="markDraftEdited"
                  />
                  <InputNumber
                    v-model="draftSeats"
                    :min="1"
                    :max="nextCohortSize || undefined"
                    suffix=" seats"
                    class="w-full"
                    @update:modelValue="markDraftEdited"
                  />
                  <button
                    @click="submitManualBid"
                    :disabled="isSubmitDisabled"
                    :class="isSubmitDisabled ? 'opacity-50 cursor-not-allowed' : 'cursor-pointer hover:bg-argon-500'"
                    class="bg-argon-button rounded-md px-5 py-2.5 text-lg font-bold text-white transition-colors"
                  >
                    {{ isSubmitting ? 'Submitting...' : 'Submit Bid' }}
                  </button>
                </div>

                <div class="flex items-center justify-between gap-x-6 text-sm text-slate-700/80">
                  <div>{{ effectSentence }}</div>
                  <div class="text-right">
                    <span class="text-slate-500">Locked after submit:</span>
                    <span class="font-mono font-bold text-slate-800/90">
                      {{ currency.symbol }}{{ microgonToMoneyNm(preview?.targetLockedMicrogons ?? 0n).format('0,0.[00]') }}
                    </span>
                  </div>
                </div>

                <div class="flex items-center justify-between gap-x-6 text-sm">
                  <div class="text-slate-600">
                    <template v-if="!preview">Enter a bid to see any additional ARGNOT needed.</template>
                    <template v-else-if="preview.additionalMicronotsNeeded > 0n">
                      +{{ micronotToArgonotNm(preview.additionalMicronotsNeeded).format('0,0.[00000000]') }} ARGNOT needed for this bid.
                    </template>
                    <template v-else>No additional ARGNOT needed for this bid.</template>
                  </div>
                  <div v-if="submitError || blockingReason" class="font-medium text-red-700">
                    {{ submitError || blockingReason }}
                  </div>
                </div>

                <div class="flex items-center justify-between gap-x-6 border-t border-slate-300/70 pt-3 text-sm text-slate-700">
                  <div>
                    <span class="font-bold text-slate-800/80">Expected per seat:</span>
                    {{ micronotToArgonotNm(bidEconomics.micronotsMined).format('0,0.[0000]') }} ARGNOT +
                    {{ microgonToArgonNm(bidEconomics.microgonsEarned).format('0,0.[00]') }} ARGN
                    <span v-if="bidEconomics.microgonsMinted > 0n" class="text-slate-500">
                      ({{ microgonToArgonNm(bidEconomics.microgonsMinted).format('0,0.[00]') }} supplemental)
                    </span>
                  </div>
                  <div class="flex items-center justify-end gap-x-1 font-mono">
                    {{ currency.symbol }}{{ microgonToMoneyNm(bidEconomics.microgonValue).format('0,0.[00]') }} projected value ·
                    {{ numeral(bidEconomics.projectedReturnPct).formatIfElse('0', '0', '+0.[0]') }}% return
                    <Tooltip
                      asChild
                      side="top"
                      :content="`Projected value combines fixed ARGN rewards, supplemental ARGN using your ${numeral(bidEconomics.annualArgonCirculationGrowthPct).formatIfElse('0', '0', '+0.[0]')}% circulation-growth assumption, and ARGNOT rewards using your ${numeral(bidEconomics.annualArgonotPriceChangePct).formatIfElse('0', '0', '+0.[0]')}% annual price-change assumption.`"
                    >
                      <span class="cursor-help text-slate-400 hover:text-slate-600">
                        <InformationCircleIcon class="size-3.5" />
                      </span>
                    </Tooltip>
                  </div>
                </div>
              </template>
            </section>

            <section class="mt-auto flex h-[280px] min-h-0 shrink-0 flex-row gap-x-3">
              <BidHistoryTable
                class="w-1/2"
                title="Previous Auction's Winning Bids"
                emptyText="No winning bids recorded for the previous auction."
                :bids="previousWinningBids"
              />
              <BidHistoryTable
                class="w-1/2"
                title="Current Winning Bids"
                emptyText="No winning bids are loaded for the current auction."
                :bids="currentWinningBids"
              />
            </section>
          </div>

          <div v-else class="flex min-h-[300px] items-center justify-center text-xl font-bold text-slate-600/40">
            Loading Bidding Panel...
          </div>
        </div>
      </DialogContent>
    </DialogPortal>
  </DialogRoot>
</template>

<script setup lang="ts">
import * as Vue from 'vue';
import dayjs from 'dayjs';
import relativeTime from 'dayjs/plugin/relativeTime';
import utc from 'dayjs/plugin/utc';
import {
  Accountset,
  bigIntMax,
  getRange,
  type IBotState,
  type IBidPlan,
  type IBidPlanBid,
  type IBidPlanSubaccount,
  type IManualBidRequest,
  planBidWithFeeEstimate,
} from '@argonprotocol/apps-core';
import { ask as askDialog, message as messageDialog } from '@tauri-apps/plugin-dialog';
import { useDebounceFn } from '@vueuse/core';
import { DialogContent, DialogOverlay, DialogPortal, DialogRoot, DialogTitle } from 'reka-ui';
import { InformationCircleIcon, PauseIcon, XMarkIcon } from '@heroicons/vue/24/outline';
import BgOverlay from '../components/BgOverlay.vue';
import BidHistoryTable from './BidHistoryTable.vue';
import InputMoney from '../components/InputMoney.vue';
import InputNumber from '../components/InputNumber.vue';
import Tooltip from '../components/Tooltip.vue';
import basicEmitter from '../emitters/basicEmitter.ts';
import { getBot } from '../stores/bot.ts';
import { getConfig } from '../stores/config.ts';
import { getCurrency } from '../stores/currency.ts';
import numeral, { createNumeralHelpers } from '../lib/numeral.ts';
import { getDbPromise } from '../stores/helpers/dbPromise.ts';
import { getBiddingCalculator, getMining, getMainchainClient, getMiningFrames } from '../stores/mainchain.ts';
import { useMiningAssetBreakdown } from '../stores/miningAssetBreakdown.ts';
import { getMyMiningSeats } from '../stores/myMiningSeats.ts';
import { getWalletKeys } from '../stores/wallets.ts';
import { TICK_MILLIS } from '../lib/Env.ts';
import type { IFrameBidRecord } from '../interfaces/db/IFrameBidRecord.ts';
import { provideOverlayContentZIndex, useOverlayZIndex } from '../overlays/helpers/OverlayZIndex.ts';

dayjs.extend(utc);
dayjs.extend(relativeTime);

type IBidPreview = IBidPlan & {
  canSubmit: boolean;
  currentWinningSeats: number;
  alreadyWinningSeats: number;
  targetLockedMicrogons: bigint;
  newAccounts: IBidPlanSubaccount[];
};

const bot = getBot();
const config = getConfig();
const currency = getCurrency();
const biddingCalculator = getBiddingCalculator();
const mining = getMining();
const miningFrames = getMiningFrames();

const miningAssets = useMiningAssetBreakdown();
const myMiningSeats = getMyMiningSeats();
const walletKeys = getWalletKeys();

const { microgonToMoneyNm, micronotToArgonotNm, microgonToArgonNm } = createNumeralHelpers(currency);

const isOpen = Vue.ref(false);
const overlayZIndex = useOverlayZIndex(() => isOpen.value);
provideOverlayContentZIndex(Vue.toRef(overlayZIndex, 'contentZIndex'));

const isLoaded = Vue.ref(false);
const isSubmitting = Vue.ref(false);
const isClosing = Vue.ref(false);
const isBiddingControlUpdating = Vue.ref(false);
const didPauseBiddingForPanel = Vue.ref(false);
const isPreviewLoading = Vue.ref(false);
const hasEditedDraft = Vue.ref(false);
const biddingControlAction = Vue.ref<'pause' | 'resume'>();
const biddingControlError = Vue.ref('');
const submitError = Vue.ref('');

const minBidIncrement = Vue.ref(10_000n);
const currentMicronotsForBid = Vue.ref(0n);
const nextCohortSize = Vue.ref(0);
const transactionFees = Vue.ref(0n);
const previousWinningBids = Vue.ref<IFrameBidRecord[]>([]);
const previewFeeEstimate = Vue.ref(0n);
const automaticBidAtPause = Vue.ref<IBotState['nextBid']>();

const preview = Vue.ref<IBidPreview | null>(null);
const draftMicrogonsPerSeat = Vue.ref(0n);
const draftSeats = Vue.ref(1);

let previewRequestId = 0;
let previewAccountset: Accountset | null = null;
let biddingControlPromise: Promise<void> | undefined;

const currentFrameId = Vue.computed(() => bot.state?.currentFrameId ?? miningFrames.currentFrameId);

const currentWinningBids = Vue.computed(() => {
  return [...myMiningSeats.allWinningBids].sort((a, b) => (a.bidPosition ?? 0) - (b.bidPosition ?? 0));
});

const myWinningBids = Vue.computed(() => {
  return currentWinningBids.value.filter(bid => typeof bid.subAccountIndex === 'number');
});

const currentBidIsWaiting = Vue.computed(() => bot.state?.lastBid?.isFinalized === false);

const bidEconomics = Vue.computed(() => {
  const submittedSeats = preview.value?.accountsToBidWith.length ?? 0;
  const transactionFees = submittedSeats
    ? previewFeeEstimate.value / BigInt(submittedSeats)
    : biddingCalculator.data.estimatedTransactionFee;

  return biddingCalculator.calculateBidEconomics({
    bidPrincipal: draftMicrogonsPerSeat.value,
    transactionFees,
  });
});

const currentFrameStartDate = Vue.computed(() => {
  const frameStartTick = miningFrames.getTickStart(currentFrameId.value);
  if (!frameStartTick) {
    return '-----';
  }
  return dayjs
    .utc(frameStartTick * TICK_MILLIS)
    .local()
    .format('MMMM D, h:mm A');
});

const currentFrameEndDate = Vue.computed(() => {
  const frameEndTick = miningFrames.getTickEnd(currentFrameId.value);
  if (!frameEndTick) {
    return '-----';
  }
  return dayjs
    .utc(frameEndTick * TICK_MILLIS)
    .local()
    .add(1, 'minute')
    .format('MMMM D, h:mm A');
});

const nextBidTimingText = Vue.computed(() => {
  if (isBiddingControlUpdating.value || didPauseBiddingForPanel.value || bot.state?.isBiddingPaused) {
    if (automaticBidAtPause.value) {
      return `Automatic bidding is paused. Its planned ${formatBidSummary(automaticBidAtPause.value.microgonsPerSeat, automaticBidAtPause.value.seats)} is loaded below.`;
    }

    return 'Automatic bidding is paused. Manual bids remain available.';
  }

  if (!bot.state?.isBiddingOpen) {
    return 'Bidding is closed for the current auction window.';
  }

  if (bot.state?.nextBid) {
    return `Scheduled ${formatBidSummary(bot.state.nextBid.microgonsPerSeat, bot.state.nextBid.seats)}. Submitting ${tickFromNow(bot.state.nextBid.bidAtTick)}.`;
  }

  if (currentBidIsWaiting.value && bot.state?.lastBid) {
    return `Finalizing latest submission at ${formatBidSummary(bot.state.lastBid.microgonsPerSeat, bot.state.lastBid.seats)}.`;
  }

  return 'No bot bid is currently scheduled.';
});

const currentBidSummary = Vue.computed(() => {
  if (!myWinningBids.value.length) {
    return 'No active winning bids';
  }
  const amounts = myWinningBids.value.map(x => x.microgonsPerSeat ?? 0n);
  const uniqueAmounts = [...new Set(amounts)];
  if (uniqueAmounts.length === 1) {
    return `${currency.symbol}${microgonToMoneyNm(uniqueAmounts[0]).format('0,0.00')} / seat for ${myWinningBids.value.length}`;
  }
  const sorted = [...uniqueAmounts].sort((a, b) => Number(a - b));
  return `${currency.symbol}${microgonToMoneyNm(sorted[0]).format('0,0.00')} - ${currency.symbol}${microgonToMoneyNm(sorted.at(-1) ?? 0n).format('0,0.00')} across ${myWinningBids.value.length}`;
});

const effectSentence = Vue.computed(() => {
  if (isPreviewLoading.value) {
    return 'Checking how this bid would affect your active seats.';
  }
  if (!preview.value) {
    return 'Enter a bid price and seat count to preview how this bid would affect your active seats.';
  }
  const parts: string[] = [];
  if (preview.value.alreadyWinningSeats) {
    parts.push(
      `keep ${preview.value.alreadyWinningSeats} winning seat${preview.value.alreadyWinningSeats === 1 ? '' : 's'} in place`,
    );
  }
  if (preview.value.replacedBids.length) {
    parts.push(
      `replace ${preview.value.replacedBids.length} lower bid${preview.value.replacedBids.length === 1 ? '' : 's'}`,
    );
  }
  if (preview.value.newAccounts.length) {
    parts.push(`add ${preview.value.newAccounts.length} seat${preview.value.newAccounts.length === 1 ? '' : 's'}`);
  }
  if (!parts.length) {
    parts.push('leave your active bid set unchanged');
  }

  return `This would ${parts.join(', ')}.`;
});

const blockingReason = Vue.computed(() => {
  if (!bot.state?.isBiddingOpen) {
    return 'Bidding is closed for this auction.';
  }
  if (currentBidIsWaiting.value) {
    return 'Your last bid is still being finalized on-chain.';
  }
  if (draftMicrogonsPerSeat.value <= 0n || draftSeats.value <= 0) {
    return undefined;
  }
  if (draftMicrogonsPerSeat.value % minBidIncrement.value !== 0n) {
    return `Bid price must be a multiple of ${microgonToArgonNm(minBidIncrement.value).format('0,0.[00000000]')} ARGN.`;
  }
  if (!preview.value) {
    return isPreviewLoading.value ? 'Checking this bid...' : undefined;
  }
  return mapPlanReasonToMessage(preview.value.reason, preview.value);
});
const isSubmitDisabled = Vue.computed(() => {
  return isSubmitting.value || isPreviewLoading.value || Boolean(blockingReason.value) || !preview.value?.canSubmit;
});

async function closePanel() {
  if (isClosing.value) {
    return;
  }

  isClosing.value = true;
  isOpen.value = false;

  try {
    await biddingControlPromise;
    if (!didPauseBiddingForPanel.value) {
      return;
    }

    const shouldResume = await askDialog(
      'Automatic bidding was paused while you used the bidding panel. Resume it now?',
      {
        title: 'Resume Automatic Bidding?',
        kind: 'info',
        okLabel: 'Resume Bidding',
        cancelLabel: 'Keep Paused',
      },
    );

    if (shouldResume) {
      try {
        const client = await bot.getClient();
        await client.fetch('/resume-bidding');
      } catch (error) {
        await messageDialog(
          `Automatic bidding is still paused. ${error instanceof Error ? error.message : String(error)}`,
          {
            title: 'Unable to Resume Bidding',
            kind: 'error',
          },
        );
      }
    }
  } finally {
    biddingControlPromise = undefined;
    didPauseBiddingForPanel.value = false;
    isClosing.value = false;
  }
}

function markDraftEdited() {
  hasEditedDraft.value = true;
}

function toggleAutomaticBidding() {
  if (biddingControlPromise) {
    return biddingControlPromise;
  }

  const shouldResume = didPauseBiddingForPanel.value || bot.state?.isBiddingPaused;
  biddingControlAction.value = shouldResume ? 'resume' : 'pause';
  isBiddingControlUpdating.value = true;
  biddingControlError.value = '';

  if (!shouldResume) {
    automaticBidAtPause.value = bot.state?.nextBid;
  }

  biddingControlPromise = (async () => {
    try {
      const client = await bot.getClient();
      await client.fetch(shouldResume ? '/resume-bidding' : '/pause-bidding');
      didPauseBiddingForPanel.value = !shouldResume;
      if (shouldResume) {
        automaticBidAtPause.value = undefined;
      }
    } catch (error) {
      const action = shouldResume ? 'resumed' : 'paused';
      biddingControlError.value = `Automatic bidding could not be ${action}. ${error instanceof Error ? error.message : String(error)}`;
    } finally {
      biddingControlPromise = undefined;
      biddingControlAction.value = undefined;
      isBiddingControlUpdating.value = false;
    }
  })();

  return biddingControlPromise;
}

function formatBidSummary(microgonsPerSeat: bigint, seats: number) {
  return `${currency.symbol}${microgonToMoneyNm(microgonsPerSeat).format('0,0.00')} / seat for ${seats} seat${seats === 1 ? '' : 's'}`;
}

function tickFromNow(tick?: number) {
  if (!tick) {
    return '---';
  }
  return dayjs
    .utc(tick * TICK_MILLIS)
    .local()
    .fromNow();
}

async function ensurePreviewAccountset() {
  if (previewAccountset) {
    return previewAccountset;
  }
  const client = await getMainchainClient(false);
  const [fundingAccount, txSubmitter, sessionMiniSecret] = await Promise.all([
    walletKeys.getMiningBotKeypair(),
    walletKeys.getMiningBidProxyKeypair(),
    walletKeys.getMiningSessionMiniSecret(),
  ]);
  previewAccountset = new Accountset({
    client,
    fundingAccountId: fundingAccount.address,
    isProxy: true,
    sessionMiniSecretOrMnemonic: sessionMiniSecret,
    subaccountRange: getRange(0, 144),
    txSubmitter,
  });
  return previewAccountset;
}

async function loadManualSubaccounts(): Promise<IBidPlanSubaccount[]> {
  const accountset = await ensurePreviewAccountset();
  const subaccounts: IBidPlanSubaccount[] = [];
  const seenAddresses = new Set<string>();

  for (const bid of myWinningBids.value) {
    if (typeof bid.subAccountIndex !== 'number' || seenAddresses.has(bid.address)) {
      continue;
    }
    subaccounts.push({
      address: bid.address,
      index: bid.subAccountIndex,
      isRebid: true,
    });
    seenAddresses.add(bid.address);
  }

  const availableAccounts = await accountset.getAvailableMinerAccounts(
    Math.max(nextCohortSize.value, draftSeats.value),
  );
  for (const account of availableAccounts) {
    if (seenAddresses.has(account.address)) {
      continue;
    }
    subaccounts.push(account);
    seenAddresses.add(account.address);
  }

  return subaccounts;
}

async function estimateBidFee(
  accountset: Accountset,
  subaccounts: IBidPlanSubaccount[],
  bidAmount: bigint,
  tip: bigint,
) {
  if (!subaccounts.length) {
    return 0n;
  }
  const submitter = await accountset.createMiningBidTx({
    subaccounts: subaccounts.map(x => ({ address: x.address })),
    bidAmount,
  });
  return await submitter.feeEstimate(tip);
}

async function refreshPreview() {
  if (!isOpen.value) {
    return;
  }
  const requestId = ++previewRequestId;
  if (draftMicrogonsPerSeat.value <= 0n || draftSeats.value <= 0) {
    preview.value = null;
    previewFeeEstimate.value = 0n;
    return;
  }

  isPreviewLoading.value = true;
  previewFeeEstimate.value = 0n;
  try {
    const accountset = await ensurePreviewAccountset();
    const [subaccounts, submitterBalance, stakedMicronots] = await Promise.all([
      loadManualSubaccounts(),
      accountset.submitterBalance(),
      accountset.accountMicronots(),
    ]);

    const allWinningBids: IBidPlanBid[] = currentWinningBids.value.map(bid => ({
      address: bid.address,
      bidMicrogons: bid.microgonsPerSeat ?? 0n,
      micronotsStaked: bid.micronotsStakedPerSeat ?? 0n,
    }));

    const myWinningPlanBids: IBidPlanBid[] = myWinningBids.value.map(bid => ({
      address: bid.address,
      bidMicrogons: bid.microgonsPerSeat ?? 0n,
      micronotsStaked: bid.micronotsStakedPerSeat ?? 0n,
    }));
    const request: IManualBidRequest = {
      microgonsPerSeat: draftMicrogonsPerSeat.value,
      seats: draftSeats.value,
    };
    const accountBalance = bigIntMax(submitterBalance - (config.biddingRules?.sidelinedMicrogons ?? 0n), 0n);
    const accountMicronots = bigIntMax(stakedMicronots - (config.biddingRules?.sidelinedMicronots ?? 0n), 0n);

    const { plan, feeEstimate } = await planBidWithFeeEstimate({
      ...request,
      nextCohortSize: nextCohortSize.value,
      micronotsPerSeat: currentMicronotsForBid.value,
      accountBalance,
      accountMicronots,
      tip: 0n,
      allWinningBids,
      myWinningBids: myWinningPlanBids,
      subaccounts,
      estimateFee: (subaccounts, bidAmount, tip) => estimateBidFee(accountset, subaccounts, bidAmount, tip),
    });

    if (requestId !== previewRequestId) {
      return;
    }
    const keptBids = myWinningPlanBids.filter(x => x.bidMicrogons >= request.microgonsPerSeat);
    const replacedBidAddresses = new Set(plan.replacedBids.map(x => x.address));
    const requestedAdditionalSeats = Math.max(0, request.seats - keptBids.length);

    preview.value = {
      ...plan,
      canSubmit: !plan.reason && plan.accountsToBidWith.length > 0,
      currentWinningSeats: myWinningPlanBids.length,
      alreadyWinningSeats: keptBids.length,
      targetLockedMicrogons:
        keptBids.reduce((sum, bid) => sum + bid.bidMicrogons, 0n) +
        BigInt(requestedAdditionalSeats) * request.microgonsPerSeat,
      newAccounts: plan.accountsToBidWith.filter(x => !replacedBidAddresses.has(x.address)),
    };
    previewFeeEstimate.value = feeEstimate;
  } catch (error) {
    if (requestId === previewRequestId) {
      preview.value = null;
      previewFeeEstimate.value = 0n;
    }
    console.error('Failed to refresh bidding panel preview:', error);
  } finally {
    if (requestId === previewRequestId) {
      isPreviewLoading.value = false;
    }
  }
}

async function loadPanelData() {
  const [db, client] = await Promise.all([getDbPromise(), getMainchainClient(false), biddingCalculator.load()]);
  biddingCalculator.updateBiddingRules(config.biddingRules);
  const frameId = currentFrameId.value;
  const [micronotsForBid, cohortSize, winningBids, frameTransactionFees] = await Promise.all([
    mining.fetchCurrentMicronotsForBid(client),
    mining.fetchNextCohortSize(client),
    frameId > 1 ? db.frameBidsTable.fetchForFrameId(frameId - 1) : [],
    db.cohortsTable.getTxFees(frameId),
  ]);
  minBidIncrement.value = client.consts.miningSlot.bidIncrements.toBigInt();
  currentMicronotsForBid.value = micronotsForBid;
  nextCohortSize.value = cohortSize;
  previousWinningBids.value = winningBids;
  transactionFees.value = frameTransactionFees;

  if (!hasEditedDraft.value) {
    const nextBid = automaticBidAtPause.value ?? bot.state?.nextBid;
    draftMicrogonsPerSeat.value =
      nextBid?.microgonsPerSeat ?? myWinningBids.value.at(-1)?.microgonsPerSeat ?? minBidIncrement.value;
    draftSeats.value = nextBid?.seats ?? Math.max(1, myWinningBids.value.length);
  }
}

const refreshPreviewDebounced = useDebounceFn(refreshPreview, 100, { maxWait: 250 });

async function submitManualBid() {
  if (isSubmitDisabled.value) {
    return;
  }
  isSubmitting.value = true;
  submitError.value = '';
  try {
    const client = await bot.getClient();
    await client.fetch('/manual-bid', {
      microgonsPerSeat: draftMicrogonsPerSeat.value,
      seats: draftSeats.value,
    });
    await refreshPreview();
  } catch (error) {
    submitError.value = mapSubmitErrorToMessage(error);
  } finally {
    isSubmitting.value = false;
  }
}

function mapPlanReasonToMessage(reason: string | undefined, plan: IBidPreview | null): string | undefined {
  if (!reason || !plan) {
    return undefined;
  }
  switch (reason) {
    case 'invalid-bid-amount':
      return 'Enter a bid amount greater than zero.';
    case 'invalid-seat-count':
      return 'Enter at least one seat.';
    case 'seat-reduction':
      return `You already have ${plan.currentWinningSeats} winning seat${plan.currentWinningSeats === 1 ? '' : 's'}. Manual bids cannot reduce them.`;
    case 'no-op':
      return 'This request would not change any of your active bids.';
    case 'max-bid-too-low':
      return 'There are not enough replaceable winning slots at this price.';
    case 'insufficient-bidding-accounts':
      return 'There are not enough bidding accounts available for this request.';
    case 'insufficient-argon-balance':
      return `You need +${microgonToArgonNm(plan.additionalMicrogonsNeeded).format('0,0.[00000000]')} ARGN to submit this bid.`;
    case 'insufficient-argonot-balance':
      return `You need +${micronotToArgonotNm(plan.additionalMicronotsNeeded).format('0,0.[00000000]')} ARGNOT to submit this bid.`;
    default:
      return 'This bid cannot be submitted right now.';
  }
}

function mapSubmitErrorToMessage(error: unknown): string {
  const reason = error instanceof Error ? error.message : String(error);
  const planMessage = mapPlanReasonToMessage(reason, preview.value);
  if (planMessage) {
    return planMessage;
  }
  switch (reason) {
    case 'bidding-closed':
      return 'Bidding is closed for this auction.';
    case 'bidder-stopping':
      return 'The mining bot is restarting. Try again in a moment.';
    case 'invalid-bid-increment':
      return `Bid amount must be a multiple of ${microgonToArgonNm(minBidIncrement.value).format('0,0.[00000000]')} ARGN.`;
    case 'waiting-for-bid-results':
      return 'Your last bid is still settling. Try again in a moment.';
    case 'manual-bid-busy':
      return 'Another bid request is still being processed. Try again in a moment.';
    default:
      return reason;
  }
}

Vue.watch(
  () => [
    draftMicrogonsPerSeat.value.toString(),
    draftSeats.value,
    currentMicronotsForBid.value.toString(),
    nextCohortSize.value,
  ],
  () => {
    if (!isOpen.value || !isLoaded.value) {
      return;
    }
    submitError.value = '';
    void refreshPreviewDebounced();
  },
);

Vue.watch(
  () =>
    currentWinningBids.value
      .map(bid => `${bid.address}:${bid.microgonsPerSeat ?? 0n}:${bid.lastBidAtTick ?? 0}`)
      .join('|'),
  () => {
    if (!isOpen.value || !isLoaded.value) {
      return;
    }
    submitError.value = '';
    void refreshPreviewDebounced();
  },
);

Vue.watch(
  () => currentFrameId.value,
  () => {
    if (!isOpen.value || !isLoaded.value) {
      return;
    }
    submitError.value = '';
    void loadPanelData().then(refreshPreview);
  },
);

basicEmitter.on('openBiddingPanel', async () => {
  if (isOpen.value || isClosing.value) {
    return;
  }

  isOpen.value = true;
  isLoaded.value = false;
  isClosing.value = false;
  hasEditedDraft.value = false;
  didPauseBiddingForPanel.value = false;
  biddingControlError.value = '';
  submitError.value = '';
  preview.value = null;
  automaticBidAtPause.value = undefined;

  await loadPanelData();
  isLoaded.value = true;
  await refreshPreview();
});
</script>

<style scoped>
@reference "../main.css";

[box] {
  @apply rounded border border-slate-400/30 bg-white shadow;
}

[stat-box] {
  @apply flex min-h-[70px] flex-col items-center justify-center px-3 py-2 text-center text-slate-800/85;
}

[stat-box] + [stat-box] {
  @apply border-l border-slate-300/70;
}

[stat-box] > span {
  @apply font-mono text-xl leading-tight font-bold;
}

[stat-box] label {
  @apply mt-1 text-xs text-slate-500;
}
</style>
