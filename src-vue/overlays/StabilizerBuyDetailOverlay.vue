<template>
  <OverlayBase :isOpen="true" title="Stabilizer Buy Details" class="w-200" @close="emit('close')">
    <template #default="{ floatingZIndex }">
      <div class="px-10 py-5 text-base">
        <PopoverRoot v-if="purchases.length">
          <div class="group relative flex w-fit items-baseline gap-x-2">
            <h1 class="text-2xl font-bold text-slate-700 group-hover:text-slate-600">
              {{ numeral(formatUnits(principal, 6)).format('0,0.[00]') }} ARGN purchased
            </h1>
            <PopoverAnchor as-child>
              <ChevronDownIcon class="size-5 self-center text-slate-400 group-hover:text-slate-600" />
            </PopoverAnchor>
            <PopoverTrigger as-child>
              <button type="button" class="absolute inset-0 cursor-pointer" title="Show purchase details" />
            </PopoverTrigger>
          </div>
          <PopoverPortal>
            <PopoverContent
              side="bottom"
              align="start"
              :sideOffset="8"
              :collisionPadding="24"
              :style="{ zIndex: floatingZIndex }"
              class="w-110 rounded-md border border-gray-800/20 bg-white px-5 py-4 text-sm text-slate-600 shadow-xl"
            >
              <h2 class="border-b border-slate-200 pb-2 font-bold text-slate-700">Purchases on Ethereum</h2>
              <article
                v-for="purchase in purchases"
                :key="purchase.id"
                class="flex items-start justify-between gap-5 border-b border-slate-200 py-3 last:border-0"
              >
                <div>
                  <strong class="text-slate-700">
                    {{ numeral(formatUnits(purchase.principal ?? 0n, 6)).format('0,0.[00]') }} ARGN
                  </strong>
                  <div v-if="purchase.purchasedAt" class="mt-1 text-slate-500">
                    {{ dayjs(purchase.purchasedAt).format('M/D/YYYY [at] h:mm a') }}
                  </div>
                </div>
                <span
                  v-if="purchase.ethereumGatewayActivity || purchase.argonPurchaseEvent"
                  class="text-right whitespace-nowrap"
                >
                  {{
                    numeral(
                      formatUnits(
                        purchase.ethereumGatewayActivity?.purchase.usdcSpent ??
                          purchase.argonPurchaseEvent!.purchase.usdcSpent,
                        6,
                      ),
                    ).format('0,0.00')
                  }}
                  USDC
                </span>
              </article>
              <PopoverArrow :width="24" :height="12" class="-mt-px fill-white stroke-gray-400/30" />
            </PopoverContent>
          </PopoverPortal>
        </PopoverRoot>
        <p class="mt-1 flex flex-wrap items-center gap-x-2 text-sm text-slate-500">
          <span v-if="purchasedAt">Purchased {{ dayjs(purchasedAt).format('M/D/YYYY') }}</span>
          <template v-if="releasedAt">
            <span v-if="purchasedAt" aria-hidden="true">·</span>
            <span>Funds available in wallet {{ dayjs(releasedAt).format('M/D/YYYY') }}</span>
          </template>
          <template v-else-if="position && position.heldPrincipal > 0n && market.dates.releases[admissionFrame]">
            <span v-if="purchasedAt" aria-hidden="true">·</span>
            <span>Funds available in wallet {{ dayjs(market.dates.releases[admissionFrame]).format('M/D/YYYY') }}</span>
          </template>
        </p>

        <section
          v-if="!isBiddingOpen && returns && returns.availability !== 'unavailable'"
          class="border-argon-600/30 mt-5 rounded-md border py-5"
        >
          <div class="grid grid-cols-3 divide-x divide-slate-600/20 text-center">
            <div class="px-3">
              <header class="text-sm font-bold text-slate-400">TOTAL INVESTED</header>
              <div class="py-1 text-2xl font-bold text-slate-600">
                <template v-if="returns">
                  {{ microgonToMoneyNm(returns.investedCost).formatCurrency(currency.symbol) }}
                </template>
              </div>
              <div class="text-sm text-slate-500">Including fees</div>
            </div>
            <div class="px-3">
              <header class="text-sm font-bold text-slate-400">NET EARNINGS</header>
              <div class="py-1 text-2xl font-bold text-slate-600">
                <template v-if="returns?.returnAmount !== undefined">
                  {{ microgonToMoneyNm(returns.returnAmount).formatCurrency(currency.symbol) }}
                </template>
              </div>
              <div class="text-sm text-slate-500">After fees</div>
            </div>
            <div class="px-3">
              <header class="text-sm font-bold text-slate-400">APY</header>
              <div class="py-1 text-2xl font-bold text-slate-600">
                <Returns
                  v-if="returns?.apy !== undefined"
                  :returns="returns"
                  metric="APY"
                  :hideDecimalsAt="10"
                  :showLabel="false"
                />
              </div>
              <div class="text-sm text-slate-500">Annualized return</div>
            </div>
          </div>
        </section>

        <details :open="isBiddingOpen" class="group mt-6 border-t border-slate-200">
          <summary class="flex cursor-pointer list-none items-center justify-between gap-3 py-4">
            <h2 class="font-bold text-slate-700">Bidding for a Bonus</h2>
            <span class="flex items-center gap-3 text-sm text-slate-500">
              <span
                v-if="!isBiddingOpen && rewards?.awardedReward !== undefined"
                class="flex items-center gap-3 group-open:hidden"
              >
                <span>₳{{ numeral(formatUnits(rewards.awardedReward, 6)).format('0,0.[00]') }} earned</span>
                <span v-if="rewards.awardedReward > 0n && !rewards.payout">· Payment pending</span>
              </span>
              <span v-else-if="market.data.currentFrameId >= admissionFrame + 2" class="group-open:hidden">
                Result pending
              </span>
              <ChevronDownIcon class="size-4 shrink-0 text-slate-400 transition-transform group-open:rotate-180" />
            </span>
          </summary>
          <p class="text-sm leading-relaxed text-slate-500">
            The Argon network offers bonuses for Stabilizer Buys.
            <template v-if="isBiddingOpen && bidOptions.matchingBasis !== undefined">
              Your maximum bonus is ₳{{ numeral(formatUnits(bidOptions.matchingBasis, 6)).format('0,0.[00]') }}.
            </template>
            <template v-if="rewards?.awardedReward !== undefined || market.data.currentFrameId >= admissionFrame + 2">
              Buyers who accepted less of their maximum bonus were considered first.
            </template>
            <template v-else>You can move ahead of other buyers by accepting less of your maximum bonus.</template>
            <a
              :href="`${NetworkConfig.websiteHost}/docs/network-rules/market-stabilizers#stabilizer-buys`"
              target="_blank"
            >
              Learn more.
            </a>
          </p>
          <div class="mt-5 grid grid-cols-2 items-stretch divide-x divide-slate-400/30">
            <div class="text-center">
              <template v-if="rewards?.awardedReward === undefined">
                <header class="font-bold text-gray-600/60">BONUS POOL</header>
                <div v-if="bidOptions.rewardBudget !== undefined" class="text-argon-600 py-1 text-3xl font-bold">
                  ₳{{ numeral(formatUnits(bidOptions.rewardBudget, 6)).format('0,0.[00]') }}
                </div>
                <div class="font-light text-slate-500">For This Bidding Round</div>
              </template>
              <template v-else>
                <header class="font-bold text-gray-600/60">EARNED</header>
                <div class="text-argon-600 py-1 text-3xl font-bold">
                  ₳{{ numeral(formatUnits(rewards.awardedReward, 6)).format('0,0.[00]') }}
                </div>
                <div class="font-light text-slate-500">From Your Bid</div>
              </template>
            </div>
            <CountdownClock
              v-if="market.dates.closes[admissionFrame]"
              :time="dayjs.utc(market.dates.closes[admissionFrame])"
              v-slot="{ days, hours, minutes, seconds, isFinished }"
            >
              <div class="flex items-start justify-center gap-5">
                <svg
                  v-if="market.dates.opens[admissionFrame] && !isFinished"
                  viewBox="0 0 36 36"
                  class="size-16 shrink-0 -rotate-90 self-center"
                  aria-hidden="true"
                >
                  <circle cx="18" cy="18" r="16" fill="none" class="stroke-current text-gray-200" stroke-width="3" />
                  <circle
                    cx="18"
                    cy="18"
                    r="16"
                    fill="none"
                    class="text-argon-600 stroke-current"
                    stroke-width="3"
                    stroke-dasharray="100"
                    :stroke-dashoffset="
                      ((days * 86400 + hours * 3600 + minutes * 60 + seconds) * 100_000) /
                      (market.dates.closes[admissionFrame].getTime() - market.dates.opens[admissionFrame].getTime())
                    "
                  />
                </svg>
                <div class="text-center">
                  <header class="font-bold text-gray-600/60">
                    <template v-if="isFinished">BIDDING CLOSED</template>
                    <template v-else>BIDDING CLOSES IN</template>
                  </header>
                  <div v-if="!isFinished" class="text-argon-600 py-1 font-mono text-3xl font-bold tabular-nums">
                    <span v-if="days">{{ days }}d</span>
                    {{ numeral(hours).format('00') }}:{{ numeral(minutes).format('00') }}:{{
                      numeral(seconds).format('00')
                    }}
                  </div>
                  <div v-if="!isFinished" class="font-light text-slate-500">To Submit Your Bid</div>
                  <template v-else>
                    <div class="text-argon-600 py-1 text-3xl font-bold">
                      {{ dayjs(market.dates.closes[admissionFrame]).format('M/D/YYYY') }}
                    </div>
                    <div class="font-light text-slate-500">
                      {{ dayjs(market.dates.closes[admissionFrame]).format('h:mm a') }}
                    </div>
                  </template>
                </div>
              </div>
            </CountdownClock>
          </div>

          <section class="mt-6">
            <table
              v-if="bidOptions.cohortBids?.length || rewards?.awardedReward !== undefined"
              aria-label="Bonus bids"
              class="w-full text-left"
            >
              <thead class="border-b border-slate-400/30 font-light text-slate-500">
                <tr>
                  <th scope="col" class="px-3 pb-3 font-normal">Buyer</th>
                  <th scope="col" class="px-3 pb-3 text-right font-normal">
                    <div class="flex items-center justify-end gap-1">
                      Bid
                      <Tooltip :asChild="true" side="top">
                        <button type="button" aria-label="How bonus bids work" class="inline-flex cursor-help">
                          <InformationCircleIcon class="size-4 text-gray-400" />
                        </button>
                        <template #content>
                          Your bid is the percentage of your maximum bonus you’ll accept. Lower percentages rank first;
                          ties favor larger maximum bonuses.
                        </template>
                      </Tooltip>
                    </div>
                  </th>
                  <th scope="col" class="px-3 pb-3 text-right font-normal">Requested</th>
                  <th scope="col" class="px-3 pb-3 text-right font-normal">
                    <template v-if="rewards?.awardedReward !== undefined">Earned</template>
                    <template v-else>Estimated</template>
                  </th>
                </tr>
              </thead>
              <tbody>
                <template v-if="rewards?.awardedReward === undefined">
                  <template v-for="(bid, index) in bidOptions.cohortBids" :key="bid.ownerAccount">
                    <tr v-if="index === fundingCutoffIndex">
                      <td colspan="4" class="border-y border-dashed border-slate-400 py-2 text-center text-slate-500">
                        <div class="flex items-center justify-center gap-1">
                          Outside bonus cutoff
                          <Tooltip :asChild="true" side="top">
                            <button type="button" aria-label="Bonus cutoff" class="inline-flex cursor-help">
                              <InformationCircleIcon class="size-4 text-gray-400" />
                            </button>
                            <template #content>
                              Up to 90% of this round’s total maximum bonuses qualify. The last included buyer may
                              receive a partial bonus, even with funds left in the pool.
                            </template>
                          </Tooltip>
                        </div>
                      </td>
                    </tr>
                    <tr
                      class="border-b border-slate-400/20 text-slate-500"
                      :class="{
                        'bg-argon-600/10 text-argon-600 font-semibold': bid.ownerAccount === rewards?.ownerAccount,
                      }"
                    >
                      <td class="relative px-3 py-3">
                        <Tooltip
                          v-if="isBiddingOpen && bid.ownerAccount === rewards?.ownerAccount"
                          :asChild="true"
                          side="top"
                        >
                          <button
                            type="button"
                            aria-label="Move up"
                            :disabled="!bidOptions.canEdit || bidOptions.isSubmitting || bidAheadPercent === undefined"
                            class="bg-argon-button hover:bg-argon-button-hover absolute top-1/2 -left-1 -translate-x-full -translate-y-1/2 cursor-pointer rounded-md p-2 text-white disabled:cursor-default disabled:opacity-40"
                            @click="rewardPercent = bidAheadPercent ?? rewardPercent"
                          >
                            <ArrowUpIcon class="size-4" />
                          </button>
                          <template #content>Move ahead of the next buyer, then submit your bid.</template>
                        </Tooltip>
                        <div class="flex items-center gap-3">
                          <span class="w-5 text-right font-light">
                            <template v-if="bid.latestBid > 0">{{ index + 1 }}</template>
                            <template v-else>–</template>
                          </span>
                          <span v-if="bid.ownerAccount === rewards?.ownerAccount">You</span>
                          <span v-else class="font-mono">
                            {{ bid.ownerAccount.slice(0, 6) }}…{{ bid.ownerAccount.slice(-4) }}
                          </span>
                        </div>
                      </td>
                      <td class="px-3 py-3 text-right">
                        <InputNumber
                          v-if="isBiddingOpen && bid.ownerAccount === rewards?.ownerAccount"
                          :modelValue="displayedRewardPercent"
                          :disabled="!bidOptions.canEdit || bidOptions.isSubmitting"
                          :min="0"
                          :max="100"
                          :dragBy="1"
                          :dragByMin="1"
                          :maxDecimals="0"
                          :hideArrows="true"
                          suffix="%"
                          aria-label="Bonus bid percentage"
                          class="reward-bid-input -mr-2 ml-auto w-24 py-1 pr-0 pl-1"
                          @update:modelValue="rewardPercent = $event"
                        />
                        <template v-else>{{ bid.latestBid }}%</template>
                      </td>
                      <td class="px-3 py-3 text-right">
                        ₳{{ numeral(formatUnits(bid.requestedReward, 6)).format('0,0.[00]') }}
                      </td>
                      <td class="px-3 py-3 text-right">
                        ₳{{ numeral(formatUnits(bid.fundingEstimate, 6)).format('0,0.[00]') }}
                        <span
                          v-if="bid.fundingEstimate > 0n && bid.fundingEstimate < bid.requestedReward"
                          class="font-light"
                        >
                          (partial)
                        </span>
                      </td>
                    </tr>
                  </template>
                </template>
                <tr v-else class="bg-argon-600/10 text-argon-600 border-b border-slate-400/20 font-semibold">
                  <td class="px-3 py-3">You</td>
                  <td class="px-3 py-3 text-right">{{ rewards.latestBid }}%</td>
                  <td class="px-3 py-3 text-right">
                    <template v-if="rewards.requestedReward !== undefined">
                      ₳{{ numeral(formatUnits(rewards.requestedReward, 6)).format('0,0.[00]') }}
                    </template>
                  </td>
                  <td class="px-3 py-3 text-right">
                    ₳{{ numeral(formatUnits(rewards.awardedReward, 6)).format('0,0.[00]') }}
                  </td>
                </tr>
              </tbody>
            </table>

            <p v-if="bidOptions.canEdit && rewardPercent === 0" class="mt-3 font-light text-slate-500">
              You’re opting out of bonuses.
            </p>
          </section>

          <p v-if="isBiddingOpen" class="mt-4 border-t border-slate-400/30 pt-4 text-sm text-slate-500">
            Use the up arrow to move ahead, then submit your bid.
          </p>

          <p
            v-if="isBiddingOpen && bidOptions.estimatedApy !== undefined && bidOptions.projectedEarnings !== undefined"
            class="mt-4 flex flex-wrap items-center justify-center gap-x-2 gap-y-1 text-slate-500"
          >
            <span>Your estimate:</span>
            <span class="text-argon-600 font-semibold">
              {{ numeral(formatUnits(bidOptions.projectedEarnings, 6)).formatCurrency('₳', 1) }}
            </span>
            net earnings
            <span aria-hidden="true">·</span>
            <span class="text-argon-600 font-semibold">
              <Returns :returns="{ apy: bidOptions.estimatedApy }" metric="APY" :hideDecimalsAt="10" />
            </span>
            <Tooltip :asChild="true" side="top">
              <button type="button" aria-label="Estimated earnings information" class="inline-flex cursor-help">
                <InformationCircleIcon class="size-4 text-gray-400" />
              </button>
              <template #content>
                Includes your purchase savings and estimated bonus, after fees. Your bonus can change until bidding
                closes.
              </template>
            </Tooltip>
          </p>
          <template v-if="rewards?.awardedReward !== undefined">
            <template v-if="rewards.payout">
              <p v-if="!releasedAt" class="mt-4 text-sm text-slate-500">
                Bonus paid to your Internal App Wallet on
                {{ dayjs(rewards.payout.blockTime).format('M/D/YYYY [at] h:mm a') }}.
              </p>
            </template>
            <template v-else-if="rewards.awardedReward > 0n">
              <p
                v-if="rewards.maturesAtFrame !== undefined && market.data.currentFrameId >= rewards.maturesAtFrame"
                class="mt-4 text-sm text-slate-500"
              >
                Your bonus payment is queued.
              </p>
              <p
                v-else-if="!position?.heldPrincipal && market.dates.releases[admissionFrame]"
                class="mt-4 text-sm text-slate-500"
              >
                Bonus available from {{ dayjs(market.dates.releases[admissionFrame]).format('M/D/YYYY') }}.
              </p>
            </template>
          </template>
          <p v-else-if="market.data.currentFrameId <= admissionFrame" class="mt-4 text-sm text-slate-500">
            Bidding opens
            <template v-if="market.dates.opens[admissionFrame]">
              {{ dayjs(market.dates.opens[admissionFrame]).format('M/D/YYYY [at] h:mm a') }}.
            </template>
            <template v-else>in the next frame.</template>
          </p>
          <p v-else-if="!isBiddingOpen" class="mt-4 text-sm text-slate-500">The bonus is being finalized.</p>
        </details>

        <p
          v-if="bidOptions.error"
          role="alert"
          class="mt-4 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-red-700"
        >
          {{ bidOptions.error }}
        </p>

        <div class="mt-3 flex justify-end gap-3 py-3">
          <button
            type="button"
            class="cursor-pointer rounded-md border border-slate-300 px-4 py-2 text-slate-600 hover:bg-slate-50"
            @click="emit('close')"
          >
            Close
          </button>
          <button
            v-if="isBiddingOpen"
            type="button"
            :disabled="
              !bidOptions.canSubmit ||
              bidOptions.isSubmitting ||
              (rewardPercent > 0 && rewardPercent === rewards?.latestBid)
            "
            class="bg-argon-button hover:bg-argon-button-hover cursor-pointer rounded-md px-5 py-2 font-semibold text-white disabled:cursor-default disabled:opacity-40"
            @click="submitBid()"
          >
            <template v-if="bidOptions.isSubmitting">Submitting Bid…</template>
            <template v-else-if="displayedRewardPercent === 0">Opt Out of Bonuses</template>
            <template
              v-else-if="
                rewards &&
                market.data.market?.maxPositiveBids !== undefined &&
                rewards.bidCount >= market.data.market?.maxPositiveBids
              "
            >
              Bid Limit Reached
            </template>
            <template v-else>
              Submit Bid
              <template v-if="rewards && market.data.market?.maxPositiveBids !== undefined">
                #{{ rewards.bidCount + 1 }} of {{ market.data.market?.maxPositiveBids }}
              </template>
              &raquo;
            </template>
          </button>
        </div>
      </div>
    </template>
  </OverlayBase>
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { formatUnits } from 'viem';
import { NetworkConfig, StabilizerBuy } from '@argonprotocol/apps-core';
import { ArrowUpIcon, ChevronDownIcon, InformationCircleIcon } from '@heroicons/vue/24/outline';
import dayjs from 'dayjs';
import { PopoverAnchor, PopoverArrow, PopoverContent, PopoverPortal, PopoverRoot, PopoverTrigger } from 'reka-ui';
import OverlayBase from './OverlayBase.vue';
import InputNumber from '../components/InputNumber.vue';
import Tooltip from '../components/Tooltip.vue';
import CountdownClock from '../components/CountdownClock.vue';
import numeral, { createNumeralHelpers } from '../lib/numeral.ts';
import { getCurrency } from '../stores/currency.ts';
import Returns from '../components/Returns.vue';

import { useMarketStabilizers } from '../stores/marketStabilizers.ts';
import { getStabilizerBuys, getStabilizerBuyOperations } from '../stores/stabilizerBuys.ts';
import { getWalletKeys, useWallets } from '../stores/wallets.ts';
import { getTransactionFailureMessage } from '../lib/TransactionInfo.ts';
import { projectStabilizerBuyBid } from '../lib/financials/StabilizerBuys.ts';

const props = defineProps<{ admissionFrame: number }>();
const emit = defineEmits<{ close: [] }>();

const market = useMarketStabilizers();
const buys = getStabilizerBuys();
const walletKeys = getWalletKeys();
const wallets = useWallets();
const currency = getCurrency();
const { microgonToMoneyNm } = createNumeralHelpers(currency);

const purchases = computed(() => market.data.buys.filter(buy => buy.admissionFrame === props.admissionFrame));
const principal = computed(() => purchases.value.reduce((sum, buy) => sum + (buy.principal ?? 0n), 0n));
const returns = computed(() => market.returns.byFrame[props.admissionFrame]);
const purchasedAt = computed(() => {
  const dates = purchases.value.flatMap(buy => (buy.purchasedAt ? [buy.purchasedAt.getTime()] : []));

  if (dates.length) return new Date(Math.min(...dates));
});
const releasedAt = computed(() => {
  if (!purchases.value.length || purchases.value.some(buy => !buy.purchaseArgonReleaseBlockTime)) return;

  return new Date(Math.max(...purchases.value.map(buy => buy.purchaseArgonReleaseBlockTime!.getTime())));
});

const rewards = computed(() =>
  market.data.frameRewards.find(rewards => rewards.admissionFrame === props.admissionFrame),
);
const position = computed(() =>
  market.data.positions.find(position => position.admissionFrame === props.admissionFrame),
);
const isBiddingOpen = computed(
  () => rewards.value?.awardedReward === undefined && !!position.value?.isBiddingOpen(market.data.currentFrameId),
);

const investmentPeriodDays = computed(() => market.data.market?.purchaseHoldFrames);

const rewardPercent = ref(rewards.value?.latestBid ?? 0);
const isBidding = ref(false);
const bidError = ref<string>();
const bidFee = ref<bigint>();

watch(
  [
    () => props.admissionFrame,
    rewardPercent,
    () => market.data.currentFrameId,
    () => wallets.defaultArgonWallet.availableMicrogons,
    () => walletKeys.canSign,
    () => position.value?.purchase.principal,
    () => position.value?.purchase.positiveBidCount,
    () => position.value?.purchase.bidRate.toFixed(),
  ],
  async ([admissionFrame, rewardPercent], _, onCleanup) => {
    bidFee.value = undefined;
    bidError.value = undefined;

    let active = true;
    onCleanup(() => {
      active = false;
    });

    if (admissionFrame === undefined || !position.value || !market.data.market) return;

    const error = position.value.getBidError({
      currentFrameId: market.data.currentFrameId,
      rewardPercent,
      maxPositiveBids: market.data.market.maxPositiveBids,
    });
    if (error) return;
    try {
      const txSigner = await walletKeys.getDefaultArgonSigner();
      if (!active) return;
      const prepared = await getStabilizerBuyOperations().stabilizerBuyBid.prepare({
        admissionFrame,
        rewardPercent,
        txSigner,
      });
      if (active) {
        bidFee.value = prepared.txFeePlusTip;
        if (!prepared.canAfford) bidError.value = 'Add ARGN to pay the bonus bid transaction fee.';
      }
    } catch (error) {
      if (active) bidError.value = (error as Error).message;
    }
  },
  { immediate: true },
);

const bidOptions = computed(() => {
  const admissionFrame = props.admissionFrame;
  if (admissionFrame === undefined) return { canSubmit: false };

  const snapshot = market.data.auctionsByFrame[admissionFrame];
  const inclusionPercent = market.data.market?.auctionInclusionPercent;
  if (!snapshot || !inclusionPercent) return { canSubmit: false };

  const own = position.value;
  const hasPendingBid = !!getStabilizerBuyOperations().stabilizerBuyBid.getPendingForFrame(admissionFrame);
  const canEdit =
    walletKeys.canSign && !!own?.isBiddingOpen(market.data.currentFrameId) && !isBidding.value && !hasPendingBid;

  let bids = snapshot.bids;
  if (own) {
    bids = bids.filter(bid => bid.ownerAccount !== buys.accountAddress);
    bids.push({
      ownerAccount: buys.accountAddress,
      latestBid: canEdit ? rewardPercent.value : own.purchase.bidRate.times(100).toNumber(),
      matchingBasis: own.matchingBasis,
    });
  }

  const cohortBids = StabilizerBuy.allocateBids(bids, snapshot.auction, inclusionPercent);
  const ownBid = cohortBids.find(bid => bid.ownerAccount === buys.accountAddress);

  let projection;
  if (ownBid && bidFee.value !== undefined && investmentPeriodDays.value) {
    projection = projectStabilizerBuyBid({
      snapshot: buys.snapshot,
      admissionFrame,
      reward: ownBid.fundingEstimate,
      bidFee: bidFee.value,
      periodDays: investmentPeriodDays.value,
    });
  }

  const error = own?.getBidError({
    currentFrameId: market.data.currentFrameId,
    rewardPercent: rewardPercent.value,
    maxPositiveBids: market.data.market?.maxPositiveBids ?? 0,
  });

  return {
    estimatedApy: projection?.apy,
    projectedEarnings: projection?.earnings,
    cohortBids,
    rewardBudget: snapshot.auction.budget ?? undefined,
    matchingBasis: ownBid?.matchingBasis,
    maxPositiveBids: market.data.market?.maxPositiveBids,
    canEdit,
    canSubmit: canEdit && !error && !bidError.value && bidFee.value !== undefined,
    isSubmitting: isBidding.value || hasPendingBid,
    error: bidError.value,
  };
});

async function submitBid() {
  if (isBidding.value) return;

  // Busy rendering can update the input while the signer is being acquired.
  const bid = { admissionFrame: props.admissionFrame, rewardPercent: rewardPercent.value };
  isBidding.value = true;
  bidError.value = undefined;
  try {
    const txSigner = await walletKeys.getDefaultArgonSigner();
    const info = await getStabilizerBuyOperations().stabilizerBuyBid.submit({
      ...bid,
      txSigner,
    });
    await info.waitForPostProcessing;
    const failure = getTransactionFailureMessage(info);
    if (failure) throw new Error(failure);
  } catch (error) {
    bidError.value = (error as Error).message;
  } finally {
    isBidding.value = false;
  }
}

const displayedRewardPercent = computed(() =>
  bidOptions.value.canEdit ? rewardPercent.value : (rewards.value?.latestBid ?? rewardPercent.value),
);
const fundingCutoffIndex = computed(() =>
  bidOptions.value.cohortBids?.findIndex(bid => bid.latestBid > 0 && bid.fundingEstimate === 0n),
);
const bidAheadPercent = computed(() =>
  StabilizerBuy.getBidAheadPercent(bidOptions.value.cohortBids ?? [], buys.accountAddress),
);
</script>
<style scoped>
.reward-bid-input {
  font: inherit;
}

.reward-bid-input :deep([InputFieldWrapper]) {
  justify-content: flex-end;
}

.reward-bid-input :deep([Suffix]) {
  min-width: 0;
  flex-grow: 0;
  opacity: 1;
}
</style>
