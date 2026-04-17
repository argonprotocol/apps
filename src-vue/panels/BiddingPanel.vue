<!-- prettier-ignore -->
<template>
  <DialogRoot class="absolute inset-0 z-10" :open="isOpen">
    <DialogPortal>
      <DialogOverlay asChild>
        <BgOverlay @close="closePanel" />
      </DialogOverlay>

      <DialogContent @escapeKeyDown="closePanel" :aria-describedby="undefined">
        <div
          class="BiddingPanel inner-input-shadow bg-argon-menu-bg absolute top-[50px] right-2 bottom-2 left-2 z-50 flex flex-col rounded-md border border-black/30 text-left transition-all focus:outline-none overflow-hidden"
          style="
            box-shadow:
              0 -1px 2px 0 rgba(0, 0, 0, 0.1),
              inset 0 2px 0 rgba(255, 255, 255, 1);
          "
        >
          <div class="mx-1 flex min-h-[60px] flex-row items-center border-b border-slate-300 bg-white pl-5 pr-5">
            <DialogTitle class="text-2xl font-bold text-slate-800/70">Bidding Panel</DialogTitle>
            <div
              @click="closePanel"
              class="absolute top-[18px] right-5 z-50 flex h-[30px] w-[30px] cursor-pointer items-center justify-center rounded-md border border-slate-400/60 text-sm/6 font-semibold hover:border-slate-500/70 hover:bg-[#D6D9DF] focus:outline-none">
              <XMarkIcon class="h-5 w-5 stroke-4 text-[#B74CBA]" />
            </div>
          </div>

          <div v-if="isLoaded" class="flex min-h-0 grow flex-col gap-y-3 px-5 py-4">
            <section class="grid grid-cols-[1fr_1fr_1.5fr_1fr_1fr] gap-x-2">
              <div stat-box>
                <span>{{ currency.symbol }}{{ microgonToMoneyNm(startingFrameCapital).format('0,0.[00]') }}</span>
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
                <label>ARGNOT Required / Seat</label>
              </div>
            </section>

            <section box class="flex flex-col gap-y-4 px-4 py-4">
              <div class="flex items-start justify-between gap-x-6">
                <div>
                  <div class="text-lg font-bold text-slate-800/80">Your Next Bid</div>
                  <div class="mt-1 text-sm text-slate-600">
                    {{ nextBidTimingText }}
                  </div>
                </div>
                <div v-if="currentBidIsWaiting" class="text-right text-sm font-medium text-amber-700">
                  Waiting on last bid finalization
                </div>
              </div>

              <div class="grid grid-cols-3 gap-x-3 text-sm text-slate-700/80">
                <div info-box>
                  <div info-label>Current Bid</div>
                  <div class="font-mono text-lg font-bold text-slate-800/90">{{ currentBidSummary }}</div>
                </div>
                <div info-box>
                  <div info-label>Locked Now</div>
                  <div class="font-mono text-lg font-bold text-slate-800/90">
                    {{ micronotToArgonotNm(myMiningSeats.pendingBids.micronotsStakedTotal).format('0,0.[00000000]') }} ARGNOT
                  </div>
                </div>
                <div info-box>
                  <div info-label>Status</div>
                  <div class="font-mono text-lg font-bold text-slate-800/90">{{ bidStatusSummary }}</div>
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

              <div class="flex items-end justify-between gap-x-6">
                <div class="grow text-sm text-slate-700/80">
                  {{ effectSentence }}
                </div>
                <div class="min-w-[12rem] text-right">
                  <div class="font-mono text-2xl font-bold text-argon-700/90">
                    {{ currency.symbol }}{{ microgonToMoneyNm(targetLockedMicrogons).format('0,0.[00]') }}
                  </div>
                  <div class="text-xs uppercase tracking-wide text-slate-500">Locked After Submit</div>
                </div>
              </div>

              <div class="flex items-center justify-between gap-x-6 text-sm">
                <div class="text-slate-600">
                  {{ argonotDeltaText }}
                </div>
                <div v-if="submitError || blockingReason" class="font-medium text-red-700">
                  {{ submitError || blockingReason }}
                </div>
              </div>
            </section>

            <section class="flex min-h-0 grow flex-row gap-x-3">
              <div box class="flex min-h-0 w-1/2 flex-col px-4 py-3">
                <div class="mb-3 flex items-end justify-between gap-x-4">
                  <div class="text-lg font-bold text-slate-800/80">Previous Auction's Winning Bids</div>
                  <div class="text-xs uppercase tracking-wide text-slate-500">
                    {{ previousWinningBids.length }} network bids, {{ previousOwnedBidCount }} by you
                  </div>
                </div>
                <div v-if="previousWinningBids.length === 0" class="flex grow items-center justify-center text-slate-500">
                  No winning bids recorded for the previous auction.
                </div>
                <div v-else class="min-h-0 grow overflow-y-auto">
                  <table class="w-full">
                    <thead>
                      <tr>
                        <th>#</th>
                        <th>Amount</th>
                        <th>Bid Submitted</th>
                        <th class="text-right">Bidding Account</th>
                      </tr>
                    </thead>
                    <tbody class="font-mono font-light">
                      <tr v-for="bid in previousWinningBids" :key="`prev-${bid.address}`">
                        <td class="text-left opacity-50">{{ bidRank(bid) }}</td>
                        <td class="text-left">{{ currency.symbol }}{{ microgonToMoneyNm(bid.microgonsPerSeat).format('0,0.00') }}</td>
                        <td class="text-left">{{ tickFromNow(bid.lastBidAtTick) }}</td>
                        <td class="relative text-right">
                          {{ shortAddress(bid.address) }}
                          <span v-if="typeof bid.subAccountIndex === 'number'" owned-badge>YOU</span>
                        </td>
                      </tr>
                    </tbody>
                  </table>
                </div>
              </div>

              <div box class="flex min-h-0 w-1/2 flex-col px-4 py-3">
                <div class="mb-3 flex items-end justify-between gap-x-4">
                  <div class="text-lg font-bold text-slate-800/80">Current Winning Bids</div>
                  <div class="text-xs uppercase tracking-wide text-slate-500">
                    {{ currentWinningBids.length }} network bids, {{ currentOwnedBidCount }} by you
                  </div>
                </div>
                <div v-if="currentWinningBids.length === 0" class="flex grow items-center justify-center text-slate-500">
                  No winning bids are loaded for the current auction.
                </div>
                <div v-else class="min-h-0 grow overflow-y-auto">
                  <table class="w-full">
                    <thead>
                      <tr>
                        <th>#</th>
                        <th>Amount</th>
                        <th>Bid Submitted</th>
                        <th class="text-right">Bidding Account</th>
                      </tr>
                    </thead>
                    <tbody class="font-mono font-light">
                      <tr v-for="bid in currentWinningBids" :key="`current-${bid.address}`">
                        <td class="text-left opacity-50">{{ bidRank(bid) }}</td>
                        <td class="text-left">{{ currency.symbol }}{{ microgonToMoneyNm(bid.microgonsPerSeat ?? 0n).format('0,0.00') }}</td>
                        <td class="text-left">{{ tickFromNow(bid.lastBidAtTick) }}</td>
                        <td class="relative text-right">
                          {{ shortAddress(bid.address) }}
                          <span v-if="typeof bid.subAccountIndex === 'number'" owned-badge>YOU</span>
                        </td>
                      </tr>
                    </tbody>
                  </table>
                </div>
              </div>
            </section>
          </div>

          <div v-else class="flex grow items-center justify-center text-xl font-bold text-slate-600/40">
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
  getRange,
  type IBidPlan,
  type IBidPlanBid,
  type IBidPlanSubaccount,
  type IManualBidRequest,
  planBidWithFeeEstimate,
} from '@argonprotocol/apps-core';
import { DialogContent, DialogOverlay, DialogPortal, DialogRoot, DialogTitle } from 'reka-ui';
import { XMarkIcon } from '@heroicons/vue/24/outline';
import BgOverlay from '../components/BgOverlay.vue';
import InputMoney from '../components/InputMoney.vue';
import InputNumber from '../components/InputNumber.vue';
import basicEmitter from '../emitters/basicEmitter.ts';
import { getBot } from '../stores/bot.ts';
import { getConfig } from '../stores/config.ts';
import { getCurrency } from '../stores/currency.ts';
import { createNumeralHelpers } from '../lib/numeral.ts';
import { getDbPromise } from '../stores/helpers/dbPromise.ts';
import { getMining, getMainchainClient, getMiningFrames } from '../stores/mainchain.ts';
import { useMiningAssetBreakdown } from '../stores/miningAssetBreakdown.ts';
import { getMyMiningSeats } from '../stores/myMiningSeats.ts';
import { getWalletKeys } from '../stores/wallets.ts';
import { TICK_MILLIS } from '../lib/Env.ts';
import type { IFrameBidRecord } from '../interfaces/db/IFrameBidRecord.ts';

dayjs.extend(utc);
dayjs.extend(relativeTime);

const bot = getBot();
const config = getConfig();
const currency = getCurrency();
const mining = getMining();
const miningFrames = getMiningFrames();

const miningAssets = useMiningAssetBreakdown();
const myMiningSeats = getMyMiningSeats();
const walletKeys = getWalletKeys();

const { microgonToMoneyNm, micronotToArgonotNm, microgonToArgonNm } = createNumeralHelpers(currency);

const isOpen = Vue.ref(false);
const isLoaded = Vue.ref(false);
const isSubmitting = Vue.ref(false);
const isPreviewLoading = Vue.ref(false);
const hasEditedDraft = Vue.ref(false);
const submitError = Vue.ref('');

const minBidIncrement = Vue.ref(10_000n);
const currentMicronotsForBid = Vue.ref(0n);
const nextCohortSize = Vue.ref(0);
const transactionFees = Vue.ref(0n);
const previousWinningBids = Vue.ref<IFrameBidRecord[]>([]);

const preview = Vue.ref<IBidPlan | null>(null);
const draftMicrogonsPerSeat = Vue.ref(0n);
const draftSeats = Vue.ref(1);
const manualSubaccounts = Vue.ref<IBidPlanSubaccount[]>([]);

let previewRequestId = 0;
let previewAccountset: Accountset | null = null;

const currentFrameId = Vue.computed(() => bot.state?.currentFrameId ?? miningFrames.currentFrameId);

const currentWinningBids = Vue.computed(() => {
  return [...myMiningSeats.allWinningBids].sort((a, b) => (a.bidPosition ?? 0) - (b.bidPosition ?? 0));
});

const myWinningBids = Vue.computed(() => {
  return currentWinningBids.value.filter(bid => typeof bid.subAccountIndex === 'number');
});

const currentOwnedBidCount = Vue.computed(() => myWinningBids.value.length);
const previousOwnedBidCount = Vue.computed(
  () => previousWinningBids.value.filter(bid => typeof bid.subAccountIndex === 'number').length,
);

const currentBidIsWaiting = Vue.computed(() => bot.state?.lastBid?.isFinalized === false);

const startingFrameCapital = Vue.computed(() => {
  return miningAssets.auctionMicrogonsUnused + miningAssets.auctionMicrogonsActivated + transactionFees.value;
});

const targetLockedMicrogons = Vue.computed(() => preview.value?.targetLockedMicrogons ?? 0n);

const currentFrameStartDate = Vue.computed(() => {
  const frameStartTick = miningFrames.getTickStart(currentFrameId.value);
  if (!frameStartTick) {
    return '-----';
  }
  return dayjs.utc(frameStartTick * TICK_MILLIS).local().format('MMMM D, h:mm A');
});

const currentFrameEndDate = Vue.computed(() => {
  const frameEndTick = miningFrames.getTickEnd(currentFrameId.value);
  if (!frameEndTick) {
    return '-----';
  }
  return dayjs.utc(frameEndTick * TICK_MILLIS).local().add(1, 'minute').format('MMMM D, h:mm A');
});

const nextBidTimingText = Vue.computed(() => {
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
  const uniqueAmounts = [...new Set(amounts.map(x => x.toString()))].map(x => BigInt(x));
  if (uniqueAmounts.length === 1) {
    return `${currency.symbol}${microgonToMoneyNm(uniqueAmounts[0]).format('0,0.00')} / seat for ${myWinningBids.value.length}`;
  }
  const sorted = [...uniqueAmounts].sort((a, b) => Number(a - b));
  return `${currency.symbol}${microgonToMoneyNm(sorted[0]).format('0,0.00')} - ${currency.symbol}${microgonToMoneyNm(sorted.at(-1) ?? 0n).format('0,0.00')} across ${myWinningBids.value.length}`;
});

const bidStatusSummary = Vue.computed(() => {
  if (currentBidIsWaiting.value) {
    return 'Finalizing';
  }
  if (!bot.state?.isBiddingOpen) {
    return 'Closed';
  }
  return bot.state?.nextBid ? 'Scheduled' : 'Idle';
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
    parts.push(`keep ${preview.value.alreadyWinningSeats} winning seat${preview.value.alreadyWinningSeats === 1 ? '' : 's'} in place`);
  }
  if (preview.value.replacedBids.length) {
    parts.push(`replace ${preview.value.replacedBids.length} lower bid${preview.value.replacedBids.length === 1 ? '' : 's'}`);
  }
  if (preview.value.newAccounts.length) {
    parts.push(`add ${preview.value.newAccounts.length} seat${preview.value.newAccounts.length === 1 ? '' : 's'}`);
  }
  if (!parts.length) {
    parts.push('leave your active bid set unchanged');
  }

  let sentence = `This would ${parts.join(', ')}.`;
  if (preview.value.additionalMicronotsNeeded > 0n) {
    sentence += ` It needs +${micronotToArgonotNm(preview.value.additionalMicronotsNeeded).format('0,0.[00000000]')} ARGNOT.`;
  }
  return sentence;
});

const argonotDeltaText = Vue.computed(() => {
  if (!preview.value) {
    return `Current requirement: ${micronotToArgonotNm(currentMicronotsForBid.value).format('0,0.[00000000]')} ARGNOT per seat.`;
  }

  if (preview.value.additionalMicronotsNeeded > 0n) {
    return `Current requirement: ${micronotToArgonotNm(currentMicronotsForBid.value).format('0,0.[00000000]')} ARGNOT per seat. This bid needs +${micronotToArgonotNm(preview.value.additionalMicronotsNeeded).format('0,0.[00000000]')} ARGNOT.`;
  }

  return `Current requirement: ${micronotToArgonotNm(currentMicronotsForBid.value).format('0,0.[00000000]')} ARGNOT per seat.`;
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
    return `Bid price must be a multiple of ${microgonToArgonNm(minBidIncrement.value).format('0,0.[00000000]')} ARG.`;
  }
  if (!preview.value) {
    return isPreviewLoading.value ? 'Checking this bid...' : undefined;
  }
  return mapPlanReasonToMessage(preview.value.reason, preview.value);
});
const isSubmitDisabled = Vue.computed(() => {
  return isSubmitting.value || isPreviewLoading.value || Boolean(blockingReason.value) || !preview.value?.canSubmit;
});

function closePanel() {
  isOpen.value = false;
}

function markDraftEdited() {
  hasEditedDraft.value = true;
}

function shortAddress(address: string) {
  return `${address.slice(0, 10)}...${address.slice(-7)}`;
}

function bidRank(bid: { bidPosition?: number }) {
  return `${(bid.bidPosition ?? 0) + 1})`;
}

function formatBidSummary(microgonsPerSeat: bigint, seats: number) {
  return `${currency.symbol}${microgonToMoneyNm(microgonsPerSeat).format('0,0.00')} / seat for ${seats} seat${seats === 1 ? '' : 's'}`;
}

function tickFromNow(tick?: number) {
  if (!tick) {
    return '---';
  }
  return dayjs.utc(tick * TICK_MILLIS).local().fromNow();
}

async function ensurePreviewAccountset() {
  if (previewAccountset) {
    return previewAccountset;
  }
  const client = await getMainchainClient(false);
  const [seedAccount, sessionMiniSecret] = await Promise.all([
    walletKeys.getMiningBotKeypair(),
    walletKeys.getMiningSessionMiniSecret(),
  ]);
  previewAccountset = new Accountset({
    client,
    seedAccount,
    sessionMiniSecretOrMnemonic: sessionMiniSecret,
    subaccountRange: getRange(0, 144),
  });
  return previewAccountset;
}

async function loadManualSubaccounts() {
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

  const availableAccounts = await accountset.getAvailableMinerAccounts(Math.max(nextCohortSize.value, draftSeats.value));
  for (const account of availableAccounts) {
    if (seenAddresses.has(account.address)) {
      continue;
    }
    subaccounts.push({
      address: account.address,
      index: account.index,
      isRebid: account.isRebid,
    });
    seenAddresses.add(account.address);
  }

  manualSubaccounts.value = subaccounts;
}

async function estimateBidFee(accountset: Accountset, subaccounts: IBidPlanSubaccount[], bidAmount: bigint, tip: bigint) {
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
    return;
  }

  isPreviewLoading.value = true;
  try {
    const accountset = await ensurePreviewAccountset();
    await loadManualSubaccounts();

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
    let accountBalance = await accountset.submitterBalance();
    accountBalance -= config.biddingRules?.sidelinedMicrogons ?? 0n;
    if (accountBalance < 0n) {
      accountBalance = 0n;
    }

    let accountMicronots = await accountset.accountMicronots();
    accountMicronots -= config.biddingRules?.sidelinedMicronots ?? 0n;
    if (accountMicronots < 0n) {
      accountMicronots = 0n;
    }

    const { plan } = await planBidWithFeeEstimate({
      ...request,
      nextCohortSize: nextCohortSize.value,
      micronotsPerSeat: currentMicronotsForBid.value,
      accountBalance,
      accountMicronots,
      tip: 0n,
      allWinningBids,
      myWinningBids: myWinningPlanBids,
      subaccounts: manualSubaccounts.value,
      estimateFee: (subaccounts, bidAmount, tip) => estimateBidFee(accountset, subaccounts, bidAmount, tip),
    });

    if (requestId !== previewRequestId) {
      return;
    }
    preview.value = plan;
  } catch (error) {
    if (requestId === previewRequestId) {
      preview.value = null;
    }
    console.error('Failed to refresh bidding panel preview:', error);
  } finally {
    if (requestId === previewRequestId) {
      isPreviewLoading.value = false;
    }
  }
}

async function loadPanelData() {
  const [db, client] = await Promise.all([getDbPromise(), getMainchainClient(false)]);
  await miningFrames.load();
  minBidIncrement.value = client.consts.miningSlot.bidIncrements.toBigInt();
  currentMicronotsForBid.value = await mining.fetchCurrentMicronotsForBid(client);
  nextCohortSize.value = await mining.fetchNextCohortSize(client);
  previousWinningBids.value = currentFrameId.value > 1 ? await db.frameBidsTable.fetchForFrameId(currentFrameId.value - 1) : [];
  transactionFees.value = await db.cohortsTable.getTxFees(currentFrameId.value);

  if (!hasEditedDraft.value) {
    const nextBid = bot.state?.nextBid;
    draftMicrogonsPerSeat.value =
      nextBid?.microgonsPerSeat ??
      myWinningBids.value.at(-1)?.microgonsPerSeat ??
      minBidIncrement.value;
    draftSeats.value = nextBid?.seats ?? Math.max(1, currentOwnedBidCount.value);
  }
}

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

function mapPlanReasonToMessage(reason: string | undefined, plan: IBidPlan | null): string | undefined {
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
      return `You need +${microgonToArgonNm(plan.additionalMicrogonsNeeded).format('0,0.[00000000]')} ARG to submit this bid.`;
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
      return `Bid amount must be a multiple of ${microgonToArgonNm(minBidIncrement.value).format('0,0.[00000000]')} ARG.`;
    case 'waiting-for-bid-results':
      return 'Your last bid is still settling. Try again in a moment.';
    case 'manual-bid-busy':
      return 'Another bid request is still being processed. Try again in a moment.';
    default:
      return reason;
  }
}

Vue.watch(
  () => [draftMicrogonsPerSeat.value.toString(), draftSeats.value, currentMicronotsForBid.value.toString(), nextCohortSize.value],
  () => {
    if (!isOpen.value) {
      return;
    }
    submitError.value = '';
    void refreshPreview();
  },
);

Vue.watch(
  () =>
    currentWinningBids.value
      .map(bid => `${bid.address}:${bid.microgonsPerSeat ?? 0n}:${bid.lastBidAtTick ?? 0}`)
      .join('|'),
  () => {
    if (!isOpen.value) {
      return;
    }
    submitError.value = '';
    void refreshPreview();
  },
);

Vue.watch(
  () => currentFrameId.value,
  () => {
    if (!isOpen.value) {
      return;
    }
    submitError.value = '';
    void loadPanelData().then(refreshPreview);
  },
);

basicEmitter.on('openBiddingPanel', async () => {
  if (isOpen.value) {
    return;
  }

  isOpen.value = true;
  isLoaded.value = false;
  hasEditedDraft.value = false;
  submitError.value = '';
  preview.value = null;
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
  @apply text-argon-600 flex min-h-[88px] flex-col items-center justify-center rounded border border-slate-400/30 bg-white px-3 py-3 text-center shadow;

  span {
    @apply font-mono text-2xl font-bold leading-tight;
  }

  label {
    @apply mt-1 text-sm text-slate-500;
  }
}

[info-box] {
  @apply rounded border border-slate-300/70 bg-slate-50 px-3 py-2;
}

[info-label] {
  @apply mb-1 text-xs font-bold uppercase tracking-wide text-slate-500;
}

[owned-badge] {
  @apply bg-argon-600 absolute top-1/2 right-0 -translate-y-1/2 rounded px-1.5 pb-0.25 text-sm text-white;
}

table {
  thead th {
    @apply border-b border-slate-300 pb-2 text-left text-sm font-bold text-argon-600/80;
  }

  tbody td {
    @apply border-b border-slate-200 py-2 text-sm;
  }

  tbody tr:last-child td {
    @apply border-b-0;
  }
}
</style>
