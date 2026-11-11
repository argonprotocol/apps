<template>
  <OverlayBase :isOpen="true" title="Stabilizer Buy" class="w-240" @close="emit('close')">
    <div class="px-10 py-5 text-base">
      <template v-if="!purchase">
        <div class="pt-3">
          <h1 class="text-2xl font-bold">Choose Your Purchase Amount</h1>
          <p class="mt-2 leading-relaxed font-light">
            Buy ARGN below target, with bonuses available for qualifying purchases.
            <a
              :href="`${NetworkConfig.websiteHost}/docs/network-rules/market-stabilizers#stabilizer-buys`"
              target="_blank"
            >
              Learn more.
            </a>
          </p>
        </div>

        <div class="mt-5 flex items-center gap-4">
          <label class="shrink-0 font-bold text-gray-600/60">Pay From</label>
          <InputMenu
            v-if="market.wallets.length > 1"
            v-model="walletAddress"
            :options="walletOptions"
            ariaLabel="Pay from wallet"
            class="grow"
          />
          <div v-else class="text-slate-600">
            <template v-if="selectedWallet">{{ getEthereumWalletDisplayName(selectedWallet.name) }}</template>
            <template v-else>
              Connect an Ethereum wallet to continue.
              <a
                :href="`${NetworkConfig.websiteHost}/docs/bridgeless-transfers/remote-wallet-connectors`"
                target="_blank"
              >
                View Docs &raquo;
              </a>
            </template>
          </div>
        </div>

        <div class="mt-4 flex flex-col">
          <div class="mb-2 flex flex-row items-center">
            <label class="grow font-bold text-gray-600/60">Amount to Buy</label>
            <span v-if="minUsdcAmount !== undefined && usdcAmount === minUsdcAmount" class="text-sm text-gray-600/60">
              Already at Min Amount
            </span>
            <button
              v-else
              type="button"
              class="text-argon-600 hover:text-argon-700 cursor-pointer text-sm"
              @click="selectAmount('minimum')"
            >
              Min
            </button>
            <span class="mx-3 h-4 border-l border-gray-300" />
            <span v-if="amountSelection === 'maxProfit' && !needsQuote && !isQuoting" class="text-sm text-gray-600/60">
              Already at Max Profit
            </span>
            <button
              v-else
              type="button"
              class="text-argon-600 hover:text-argon-700 cursor-pointer text-sm"
              title="Choose the amount with the highest estimated savings after fees."
              @click="selectAmount('maxProfit')"
            >
              Max Profit
            </button>
            <span class="mx-3 h-4 border-l border-gray-300" />
            <span v-if="availableUsdcAmount && usdcAmount === availableUsdcAmount" class="text-sm text-gray-600/60">
              Already at Max Wallet
            </span>
            <button
              v-else
              type="button"
              :disabled="!availableUsdcAmount"
              class="text-argon-600 hover:text-argon-700 cursor-pointer text-sm disabled:cursor-default disabled:text-gray-400"
              @click="selectAmount('maxWallet')"
            >
              Max Wallet
            </button>
          </div>
          <InputNumber
            :modelValue="usdcAmount"
            :min="0"
            :maxDecimals="6"
            suffix=" USDC"
            aria-label="USDC purchase amount"
            class="px-1 py-2 text-[17px]!"
            @input="setCustomAmount"
          />
          <template v-if="availableUsdcAmount && availableUsdcAmount >= (minUsdcAmount ?? 0)">
            <input
              :value="usdcAmount"
              type="range"
              :min="minUsdcAmount ?? 0"
              :max="availableUsdcAmount"
              step="1"
              aria-label="USDC purchase amount slider"
              class="accent-argon-button mt-3 w-full cursor-pointer"
              @input="setCustomAmount(Number(($event.target as HTMLInputElement).value))"
            />
            <div class="mt-1 flex justify-between font-light text-slate-500">
              <span>{{ numeral(minUsdcAmount ?? 0).format('0,0.[00]') }} USDC</span>
              <span>{{ numeral(availableUsdcAmount).format('0,0') }} USDC</span>
            </div>
          </template>
        </div>

        <WalletFundingCallout v-if="!purchaseError && (needsUsdc || needsEth)" :showArrow="false">
          <AlertIcon class="mr-2 h-4 shrink-0 text-yellow-700" />
          <span v-if="needsUsdc && needsEth">Your Ethereum wallet needs USDC and ETH.</span>
          <span v-else-if="needsUsdc">Your Ethereum wallet needs more USDC.</span>
          <span v-else>Your Ethereum wallet needs ETH for fees.</span>
          <template #action>
            <a
              :href="`${NetworkConfig.websiteHost}/docs/bridgeless-transfers/remote-wallet-connectors`"
              target="_blank"
            >
              View Docs &raquo;
            </a>
          </template>
        </WalletFundingCallout>

        <p v-if="quote && hasCurrentQuote" class="mt-3 flex items-center gap-1 font-light text-slate-500">
          Buys approximately {{ numeral(formatUnits(quote.quotedMicrogonsOut, 6)).format('0,0.[00]') }} ARGN
          <template v-if="purchaseProjection">
            · Average price
            <template v-if="purchaseProjection.discountPercent === 0">at target</template>
            <template v-else>
              {{
                numeral(Math.abs(purchaseProjection.discountPercent)).formatPercent(
                  Math.abs(purchaseProjection.discountPercent) >= 10 ? 0 : 1,
                )
              }}
              {{ purchaseProjection.discountPercent > 0 ? 'below' : 'above' }} target
            </template>
          </template>
          <Tooltip :asChild="true" side="top">
            <button type="button" aria-label="Purchase quote information" class="inline-flex cursor-help">
              <InformationCircleIcon class="size-4 text-gray-400" />
            </button>
            <template #content>
              <p>
                You’ll receive at least {{ numeral(formatUnits(quote.request.minMicrogonsOut, 6)).format('0,0.[00]') }}
                ARGN. Larger purchases can increase your average price.
              </p>
              <p
                v-if="feePreview && numeral(formatEther(feePreview.feeEstimateWei)).format('0.[00000000]') !== '0'"
                class="mt-2"
              >
                Estimated Ethereum fee:
                {{ numeral(formatEther(feePreview.feeEstimateWei)).format('0.[00000000]') }} ETH.
                <template v-if="feePreview?.needsApproval">Includes USDC approval.</template>
              </p>
              <p class="mt-2">ARGN’s price can move above target before your purchase confirms.</p>
            </template>
          </Tooltip>
        </p>

        <section
          v-if="holdingPeriodDays !== undefined"
          class="mt-6 grid grid-cols-3 divide-x divide-slate-600/20 rounded-md border border-slate-600/30 py-6 text-center"
        >
          <div class="px-3">
            <header class="flex items-center justify-center gap-1 font-bold text-gray-600/60">
              HOLDING PERIOD
              <Tooltip :asChild="true" side="top">
                <button type="button" aria-label="Holding period information" class="inline-flex cursor-help">
                  <InformationCircleIcon class="size-4 text-gray-400" />
                </button>
                <template #content>
                  <p v-if="mayEarnRewards === false">
                    <template v-if="quote!.quotedMicrogonsOut < quote!.minimumRewardPrincipal">
                      The minimum purchase amount eligible for bonuses is
                      {{ numeral(formatUnits(quote!.minimumRewardPrincipal, 6)).format('0,0.[000000]') }} ARGN.
                    </template>
                    <template v-else>
                      Bonuses require a purchase discount and a starting price at least $0.01 below ARGN's target.
                    </template>
                    Your ARGN is available after Argon confirms the purchase.
                  </p>
                  <p v-else>
                    <template v-if="market.dates.releases[market.data.currentFrameId]">
                      Qualifying purchases are held until
                      {{ dayjs(market.dates.releases[market.data.currentFrameId]).format('M/D/YYYY') }}, whether or not
                      your bid receives a bonus.
                    </template>
                    <template v-else>
                      Qualifying purchases are held for {{ holdingPeriodDays }} days from admission.
                    </template>
                  </p>
                  <p
                    v-if="
                      mayEarnRewards !== false &&
                      market.dates.opens[market.data.currentFrameId] &&
                      market.dates.closes[market.data.currentFrameId]
                    "
                    class="mt-2"
                  >
                    Bidding: {{ dayjs(market.dates.opens[market.data.currentFrameId]).format('M/D/YYYY') }}–{{
                      dayjs(market.dates.closes[market.data.currentFrameId]).format('M/D/YYYY')
                    }}.
                  </p>
                </template>
              </Tooltip>
            </header>
            <div class="text-argon-600 py-1 text-3xl font-bold">
              <template v-if="mayEarnRewards === false">NO HOLD</template>
              <template v-else>{{ holdingPeriodDays }} DAYS</template>
            </div>
            <div v-if="mayEarnRewards === false" class="font-light text-slate-500">No Bonus Bidding</div>
            <div v-else-if="market.dates.releases[market.data.currentFrameId]" class="font-light text-slate-500">
              If eligible, releases {{ dayjs(market.dates.releases[market.data.currentFrameId]).format('M/D/YYYY') }}
            </div>
          </div>
          <div class="px-3">
            <header class="font-bold text-gray-600/60">ESTIMATED APY</header>
            <div class="text-argon-600 py-1 text-3xl font-bold">
              <!-- prettier-ignore -->
              <template v-if="hasCurrentQuote && purchaseProjection">
                {{ numeral(purchaseProjection.apy.min).formatIfElse(Math.abs(purchaseProjection.apy.min) < 10, '0,0.[0]', '0,0') }}<template v-if="purchaseProjection.apy.max !== purchaseProjection.apy.min">–{{
                  numeral(purchaseProjection.apy.max).formatIfElse(Math.abs(purchaseProjection.apy.max) < 10, '0,0.[0]', '0,0')
                }}</template>%
              </template>
              <template v-else>--</template>
            </div>
            <div v-if="mayEarnRewards === false" class="font-light text-slate-500">
              Modeled Over {{ holdingPeriodDays }} Days
            </div>
            <div v-else class="font-light text-slate-500">Annualized Return Range</div>
          </div>
          <div class="px-3">
            <header class="flex items-center justify-center gap-1 font-bold text-gray-600/60">
              ESTIMATED PROFIT
              <Tooltip :asChild="true" side="top">
                <button type="button" aria-label="Estimated return range information" class="inline-flex cursor-help">
                  <InformationCircleIcon class="size-4 text-gray-400" />
                </button>
                <template #content>
                  <p v-if="mayEarnRewards === false">Your return on this purchase, after estimated Ethereum fees.</p>
                  <p v-else>
                    The lower amount is your savings from buying below target, after estimated Ethereum fees. The upper
                    amount includes the maximum bonus for a qualifying purchase.
                  </p>
                </template>
              </Tooltip>
            </header>
            <div class="text-argon-600 py-1 text-3xl font-bold">
              <!-- prettier-ignore -->
              <template v-if="hasCurrentQuote && purchaseProjection">
                {{ numeral(formatUnits(purchaseProjection.earnings.min, 6)).formatCurrency('₳', 1) }}<template v-if="purchaseProjection.earnings.max !== purchaseProjection.earnings.min">–{{
                  numeral(formatUnits(purchaseProjection.earnings.max, 6)).formatCurrency('₳', 1)
                }}</template>
              </template>
              <template v-else>--</template>
            </div>
            <div class="font-light text-slate-500">
              <template v-if="mayEarnRewards === false">Purchase Only</template>
              <template v-else>Purchase Discount + Bonus</template>
            </div>
          </div>
        </section>
      </template>

      <template v-else-if="purchase.argonPurchaseEvent">
        <h1 class="pt-3 text-2xl font-bold">
          Purchased {{ numeral(formatUnits(purchase.argonPurchaseEvent.transfer.amount, 6)).format('0,0.[00]') }} ARGN
        </h1>
        <p class="mt-2 font-light text-slate-500">
          <template v-if="purchase.status === StabilizerBuyStatus.Complete">
            Your purchased ARGN is available in your Internal App Wallet.
          </template>
          <template v-else-if="purchase.admissionFrame !== undefined && market.dates.releases[purchase.admissionFrame]">
            Held until {{ dayjs(market.dates.releases[purchase.admissionFrame]).format('M/D/YYYY [at] h:mm a') }}.
          </template>
        </p>
        <dl class="mt-6 grid grid-cols-2 gap-y-3 border-y border-slate-400/30 py-5 text-slate-500">
          <dt>Paid</dt>
          <dd class="text-right">
            {{ numeral(formatUnits(purchase.argonPurchaseEvent.purchase.usdcSpent, 6)).format('0,0.00') }} USDC
          </dd>
          <dt>Purchased</dt>
          <dd class="text-right">
            {{ dayjs(purchase.purchasedAt ?? purchase.createdAt).format('M/D/YYYY [at] h:mm a') }}
          </dd>
          <dt>Network</dt>
          <dd class="text-right">Ethereum</dd>
          <template v-if="purchase.admissionFrame !== undefined && market.dates.closes[purchase.admissionFrame]">
            <dt>
              {{ market.data.currentFrameId >= purchase.admissionFrame + 2 ? 'Bidding closed' : 'Bidding closes' }}
            </dt>
            <dd class="text-right">
              {{ dayjs(market.dates.closes[purchase.admissionFrame]).format('M/D/YYYY [at] h:mm a') }}
            </dd>
          </template>
        </dl>
      </template>

      <template v-else>
        <div class="flex flex-col gap-4 py-3 text-slate-700">
          <p v-if="purchase.principal !== undefined" class="font-light">
            Purchased
            <strong>{{ numeral(formatUnits(purchase.principal, 6)).format('0,0.[00]') }} ARGN</strong>
          </p>
          <ProgressBar
            v-if="progressPct !== undefined"
            :progress="progressPct"
            :hasError="purchase.status === StabilizerBuyStatus.Failed"
          />
          <div>
            <div class="font-light text-slate-500">
              <template v-if="purchase.status === StabilizerBuyStatus.Complete">
                Your purchased ARGN is available in your Internal App Wallet.
              </template>
              <template v-else-if="purchase.status === StabilizerBuyStatus.Failed">Purchase Needs Attention</template>
              <template v-else-if="purchase.status === StabilizerBuyStatus.WaitingForPrincipalReleaseOnArgon">
                Purchase confirmed. Your ARGN is held until its scheduled release.
              </template>
              <template v-else>
                {{ purchaseProgress?.currentStepLabel }}
                <template v-if="purchaseProgress?.currentStepDetail">
                  · {{ purchaseProgress.currentStepDetail }}
                </template>
              </template>
            </div>
            <div
              v-if="
                purchase.status !== StabilizerBuyStatus.Complete &&
                purchase.status !== StabilizerBuyStatus.Failed &&
                purchase.status !== StabilizerBuyStatus.WaitingForPrincipalReleaseOnArgon
              "
              class="mt-1 text-sm text-slate-400"
            >
              You can close this window without stopping the purchase.
            </div>
          </div>
          <div
            v-if="purchase.statusError"
            role="alert"
            class="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-red-700"
          >
            {{ purchase.statusError }}
          </div>
        </div>
      </template>

      <p
        v-if="purchaseError"
        role="alert"
        class="mt-4 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-red-700"
      >
        {{ purchaseError }}
      </p>

      <div class="mt-3 flex justify-end gap-3 py-3">
        <button
          type="button"
          class="cursor-pointer rounded-md border border-slate-300 px-4 py-2 text-slate-600 hover:bg-slate-50"
          @click="emit('close')"
        >
          <template v-if="purchase">Close</template>
          <template v-else>Cancel</template>
        </button>
        <button
          v-if="!purchase"
          type="button"
          :disabled="
            !selectedWallet || isQuoting || (!purchaseError && usdcAmount <= 0) || (!needsQuote && !canPurchase)
          "
          class="bg-argon-button hover:bg-argon-button-hover cursor-pointer rounded-md px-5 py-2 font-semibold text-white disabled:cursor-default disabled:opacity-40"
          @click="
            if (needsQuote) refreshQuote();
            else submitPurchase();
          "
        >
          <template v-if="isQuoting">Updating Quote...</template>
          <template v-else-if="purchaseError">Retry Quote &raquo;</template>
          <template v-else-if="needsQuote">Get Quote &raquo;</template>
          <template v-else>Finalize Purchase &raquo;</template>
        </button>
        <button
          v-else-if="purchase.admissionFrame !== undefined"
          type="button"
          class="bg-argon-button hover:bg-argon-button-hover cursor-pointer rounded-md px-5 py-2 font-semibold text-white"
          @click="emit('bid', purchase!.admissionFrame!)"
        >
          <template v-if="canBid">Review Bonus Bid &raquo;</template>
          <template v-else>View Bonus &raquo;</template>
        </button>
      </div>
    </div>
  </OverlayBase>
</template>

<script setup lang="ts">
import { useNow } from '@vueuse/core';
import { computed, onScopeDispose, ref, shallowRef, watch } from 'vue';
import { InformationCircleIcon } from '@heroicons/vue/24/outline';
import { NetworkConfig, UnitOfMeasurement, StabilizerBuyQuoteUnavailableError } from '@argonprotocol/apps-core';
import { formatEther, formatUnits, getAddress, parseUnits } from 'viem';
import dayjs from 'dayjs';
import {
  StabilizerBuyStatus,
  type IStabilizerBuyQuote,
  type IStabilizerBuyOpportunity,
} from '../interfaces/IStabilizerBuyPurchase.ts';
import { getEthereumWalletDisplayName } from '../lib/Wallet.ts';
import OverlayBase from './OverlayBase.vue';
import InputMenu from '../components/InputMenu.vue';
import InputNumber from '../components/InputNumber.vue';
import ProgressBar from '../components/ProgressBar.vue';
import Tooltip from '../components/Tooltip.vue';
import WalletFundingCallout from '../components/WalletFundingCallout.vue';
import AlertIcon from '../assets/alert.svg?component';
import numeral from '../lib/numeral.ts';

import { useMarketStabilizers } from '../stores/marketStabilizers.ts';
import { getStabilizerBuys, getStabilizerBuyPurchases } from '../stores/stabilizerBuys.ts';
import { getWalletKeys } from '../stores/wallets.ts';
import { projectStabilizerBuyQuote } from '../lib/financials/StabilizerBuys.ts';
import type { StabilizerBuyPurchases } from '../lib/StabilizerBuyPurchases.ts';

const props = defineProps<{ buyId?: string; opportunity?: Extract<IStabilizerBuyOpportunity, { type: 'buy' }> }>();
const emit = defineEmits<{
  close: [];
  bid: [admissionFrame: number];
  purchased: [buyId: string];
  expired: [opportunity: Extract<IStabilizerBuyOpportunity, { type: 'buy' }>];
}>();

const market = useMarketStabilizers();
const buys = getStabilizerBuys();
const walletKeys = getWalletKeys();

const opportunity = props.opportunity ?? market.opportunity;
const usdcAmount = ref(0);
const amountSelection = ref<'maxProfit' | 'maxWallet' | 'minimum' | 'custom'>('maxProfit');
const walletAddress = ref(opportunity?.quote.sourceAddress ?? market.wallets[0]?.address);

const quote = shallowRef<IStabilizerBuyQuote>();
const minimumQuote = shallowRef<IStabilizerBuyQuote>();
const feePreview = shallowRef<Awaited<ReturnType<StabilizerBuyPurchases['previewPurchase']>>>();
const purchaseError = ref<string>();
const isPurchasing = ref(false);
const isQuoting = ref(false);
let quoteRequest: AbortController | undefined;
let quoteTimer: ReturnType<typeof setTimeout> | undefined;
let isClosed = false;

const selectedWallet = computed(() =>
  market.wallets.find(wallet => wallet.address.toLowerCase() === walletAddress.value?.toLowerCase()),
);
const walletBalances = computed(() => {
  const wallet = selectedWallet.value;
  if (!wallet?.data.balanceUpdatedAt || wallet.data.fetchErrorMsg || wallet.data.balanceIsCached) return;

  return wallet.data.otherTokens;
});
const availableUsdcAmount = computed(() => {
  if (!walletBalances.value) return;

  const balance = walletBalances.value.find(token => token.unitOfMeasurement === UnitOfMeasurement.USDC)?.value ?? 0n;
  return Number(formatUnits(balance, 6));
});
const walletOptions = computed(() =>
  market.wallets.map(wallet => ({
    name: getEthereumWalletDisplayName(wallet.name),
    value: wallet.address,
  })),
);

const needsUsdc = computed(() => {
  if (availableUsdcAmount.value === undefined) return false;
  return availableUsdcAmount.value === 0 || usdcAmount.value > availableUsdcAmount.value;
});
const needsEth = computed(() => {
  if (!walletBalances.value) return false;

  const balance = walletBalances.value.find(token => token.unitOfMeasurement === UnitOfMeasurement.ETH)?.value ?? 0n;
  return balance === 0n || balance < (feePreview.value?.feeEstimateWei ?? 0n);
});

const minUsdcAmount = computed(() => {
  if (minimumQuote.value) return Number(formatUnits(minimumQuote.value.request.maxUsdcIn, 6));
});

const now = useNow({ interval: 1_000 });
const hasCurrentQuote = computed(() => {
  if (!quote.value) return false;
  if (quote.value.request.deadline <= BigInt(Math.floor(now.value.getTime() / 1000))) return false;
  if (quote.value.request.maxUsdcIn !== BigInt(Math.round(usdcAmount.value * 1_000_000))) return false;
  return quote.value.sourceAddress.toLowerCase() === walletAddress.value?.toLowerCase();
});
const needsQuote = computed(() => !hasCurrentQuote.value || !!purchaseError.value);

const holdingPeriodDays = computed(() => market.data.market?.purchaseHoldFrames);
const purchaseProjection = computed(() => {
  const current = quote.value;
  const matchingRate = market.data.market?.matchingRate;
  const fees = feePreview.value;
  if (!current || !fees || holdingPeriodDays.value === undefined || !matchingRate) return;
  return projectStabilizerBuyQuote({
    quote: current,
    feeEstimateWei: fees.feeEstimateWei,
    periodDays: holdingPeriodDays.value,
    matchingRate,
  });
});
const mayEarnRewards = computed(() => {
  const current = quote.value;
  if (!current || !hasCurrentQuote.value) return;
  return current.qualifiesForRewards;
});

const canPurchase = computed(
  () =>
    hasCurrentQuote.value &&
    !!feePreview.value &&
    availableUsdcAmount.value !== undefined &&
    !isQuoting.value &&
    !needsUsdc.value &&
    !needsEth.value &&
    !isPurchasing.value &&
    walletKeys.canSign,
);

const purchase = computed(() => market.data.buys.find(buy => buy.id === props.buyId));
const progressPct = computed(() => {
  if (props.buyId) return market.progressByPurchaseId[props.buyId];
});
const purchaseProgress = computed(() => {
  if (props.buyId) return market.purchaseProgressById[props.buyId];
});
const canBid = computed(
  () => market.biddingFrame !== undefined && purchase.value?.admissionFrame === market.biddingFrame,
);

watch(
  () => market.wallets,
  wallets => {
    if (!selectedWallet.value) walletAddress.value = wallets[0]?.address;
  },
  { immediate: true },
);

watch(
  [walletAddress, availableUsdcAmount, () => selectedWallet.value?.data.fetchErrorMsg],
  ([address], previous) => {
    if (address !== previous?.[0]) {
      amountSelection.value = 'maxProfit';
      minimumQuote.value = undefined;
    }
    void refreshQuote();
  },
  { immediate: true },
);

onScopeDispose(() => {
  isClosed = true;
  quoteRequest?.abort();
  clearTimeout(quoteTimer);
});

function setCustomAmount(amount: number) {
  // InputNumber also emits on blur; keep an unchanged, accepted quote ready to purchase.
  if (amount === usdcAmount.value && hasCurrentQuote.value && !isQuoting.value) return;

  amountSelection.value = 'custom';
  usdcAmount.value = amount;
  quoteRequest?.abort();
  quote.value = undefined;
  feePreview.value = undefined;
  purchaseError.value = undefined;
  isQuoting.value = false;
  clearTimeout(quoteTimer);
  if (amount > 0) quoteTimer = setTimeout(() => void refreshQuote(), 400);
}

function selectAmount(selection: typeof amountSelection.value) {
  amountSelection.value = selection;
  void refreshQuote();
}

async function refreshQuote() {
  clearTimeout(quoteTimer);
  quoteRequest?.abort();
  const request = new AbortController();
  quoteRequest = request;
  isQuoting.value = false;

  const wallet = selectedWallet.value;
  if (isClosed || props.buyId || !wallet) return;

  isQuoting.value = true;
  purchaseError.value = undefined;
  try {
    const purchases = getStabilizerBuyPurchases();
    if (!purchases) throw new Error('Configure an Ethereum RPC in Settings to quote a purchase.');

    const quoter = NetworkConfig.get().ethereumNetwork.stabilizerBuyQuoterAddress;
    if (!quoter) throw new Error('This network has no Stabilizer price quoter configured.');

    if (amountSelection.value === 'maxProfit' || amountSelection.value === 'maxWallet') {
      if (availableUsdcAmount.value === undefined)
        throw new Error(wallet.data.fetchErrorMsg || 'Your Ethereum wallet balance is still loading. Retry shortly.');
    }

    const input = {
      slippageBps: 50,
      deadline: BigInt(Math.floor(Date.now() / 1000) + 15 * 60),
      destinationAddress: buys.accountAddress,
      sourceAddress: wallet.address,
      quoterAddress: getAddress(quoter),
    };

    let current: IStabilizerBuyQuote;
    let preview: NonNullable<typeof feePreview.value>;
    if (amountSelection.value === 'maxProfit') {
      const result = await purchases.quoteMaxProfit(
        { ...input, maxUsdcIn: parseUnits(availableUsdcAmount.value!.toFixed(6), 6) },
        request.signal,
      );
      if (request.signal.aborted) return;

      minimumQuote.value = result.minimumQuote;
      current = result.quote;
      preview = result.preview;
    } else {
      let maxUsdcIn: bigint | undefined;
      if (amountSelection.value === 'maxWallet') usdcAmount.value = availableUsdcAmount.value!;
      if (amountSelection.value !== 'minimum') {
        if (usdcAmount.value <= 0) return;
        maxUsdcIn = parseUnits(usdcAmount.value.toFixed(6), 6);
      }

      current = await purchases.quote({ ...input, maxUsdcIn, sizeToTarget: amountSelection.value === 'minimum' });
      if (request.signal.aborted) return;
      preview = await purchases.previewPurchase({ ethereumQuote: current });
    }

    if (request.signal.aborted) return;

    if (amountSelection.value === 'minimum') minimumQuote.value = current;
    quote.value = current;
    feePreview.value = preview;
    if (amountSelection.value !== 'custom') usdcAmount.value = Number(formatUnits(current.request.maxUsdcIn, 6));
    if (availableUsdcAmount.value === undefined)
      purchaseError.value =
        wallet.data.fetchErrorMsg || 'Your Ethereum wallet balance is still loading. Retry shortly.';
  } catch (error) {
    if (request.signal.aborted) return;

    if (error instanceof StabilizerBuyQuoteUnavailableError && opportunity) emit('expired', opportunity);
    else purchaseError.value = (error as Error).message;
  } finally {
    if (!request.signal.aborted) isQuoting.value = false;
  }
}

async function submitPurchase() {
  if (!canPurchase.value || !quote.value || !feePreview.value || !selectedWallet.value) return;

  isPurchasing.value = true;
  try {
    const purchases = getStabilizerBuyPurchases();
    if (!purchases) throw new Error('Configure an Ethereum RPC in Settings.');

    const saved = await purchases.purchase({
      id: crypto.randomUUID(),
      ethereumQuote: quote.value,
      ethereumWallet: selectedWallet.value,
      ethereumMaxFeeWei: feePreview.value.feeEstimateWei,
    });

    if (!isClosed) emit('purchased', saved.id);
    quote.value = undefined;
    usdcAmount.value = 0;
  } catch (error) {
    purchaseError.value = (error as Error).message;
  } finally {
    isPurchasing.value = false;
  }
}
</script>
