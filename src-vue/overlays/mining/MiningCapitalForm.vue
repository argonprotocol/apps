<template>
  <div data-testid="MiningCapitalOverlay">
    <section data-testid="MiningCapitalForm.argonSection">
      <div class="mb-2 flex items-baseline justify-between">
        <label class="grow font-bold opacity-40">ARGN</label>
        <div class="flex items-baseline text-sm">
          <span v-if="argonTarget === lockedMicrogons" class="text-gray-600/60">Min</span>
          <button
            v-else
            type="button"
            class="text-argon-600 hover:text-argon-700 cursor-pointer"
            @click="argonTarget = lockedMicrogons"
          >
            Min
          </button>
          <span class="mx-2 text-gray-300">|</span>
          <span v-if="argonTarget === maximumMicrogons" class="text-gray-600/60">Wallet Max</span>
          <button
            v-else
            type="button"
            class="text-argon-600 hover:text-argon-700 cursor-pointer"
            @click="argonTarget = maximumMicrogons"
          >
            Wallet Max
          </button>
        </div>
      </div>
      <InputToken
        v-model="argonTarget"
        :min="lockedMicrogons"
        :max="maximumMicrogons"
        suffix=" ARGN"
        :hideArrows="true"
        class="w-full"
        data-testid="MiningCapitalOverlay.argonTarget"
      />
      <SliderRoot
        v-model="argonSlider"
        class="relative mt-1 flex h-5 w-full touch-none items-center select-none"
        :min="0"
        :max="100"
        :step="0.01"
      >
        <SliderTrack class="relative h-2 grow rounded-full bg-gray-500/30">
          <SliderRange class="bg-argon-600/50 absolute h-full rounded-full" />
        </SliderTrack>
        <!-- prettier-ignore -->
        <SliderThumb aria-label="ARGN bidding capital" class="block h-5 w-5 rounded-full border border-gray-400 bg-white shadow-sm focus:outline-none" />
      </SliderRoot>
      <div class="mt-1 flex justify-between text-slate-500">
        <span>{{ microgonToArgonNm(lockedMicrogons).format('0,0') }} locked</span>
        <span>{{ microgonToArgonNm(maximumMicrogons).format('0,0') }} max</span>
      </div>
    </section>

    <section data-testid="MiningCapitalForm.argonotSection" class="mt-4">
      <div class="mb-2 flex items-baseline justify-between">
        <label class="grow font-bold opacity-40">ARGNOT</label>
        <div class="flex items-baseline text-sm">
          <span v-if="argonotTarget === minimumMicronotTarget" class="text-gray-600/60">Min</span>
          <button
            v-else
            type="button"
            class="text-argon-600 hover:text-argon-700 cursor-pointer"
            @click="
              isArgonotFollowingArgon = true;
              argonotTarget = minimumMicronotTarget;
            "
          >
            Min
          </button>
          <span class="mx-2 text-gray-300">|</span>
          <span v-if="argonotTarget === maximumMicronots" class="text-gray-600/60">Wallet Max</span>
          <button
            v-else
            type="button"
            class="text-argon-600 hover:text-argon-700 cursor-pointer"
            @click="
              isArgonotFollowingArgon = false;
              argonotTarget = maximumMicronots;
            "
          >
            Wallet Max
          </button>
        </div>
      </div>
      <InputToken
        v-model="argonotTarget"
        :min="minimumAllocatedMicronots"
        :max="maximumMicronots"
        suffix=" ARGNOT"
        :hideArrows="true"
        class="w-full"
        data-testid="MiningCapitalOverlay.argonotTarget"
        @input="isArgonotFollowingArgon = false"
      />
      <SliderRoot
        v-model="argonotSlider"
        class="relative mt-1 flex h-5 w-full touch-none items-center select-none"
        :min="0"
        :max="100"
        :step="0.01"
        @pointerdown="isArgonotFollowingArgon = false"
        @keydown="isArgonotFollowingArgon = false"
      >
        <SliderTrack class="relative h-2 grow rounded-full bg-gray-500/30">
          <SliderRange class="bg-argon-600/50 absolute h-full rounded-full" />
        </SliderTrack>
        <!-- prettier-ignore -->
        <SliderThumb aria-label="ARGNOT bidding capital" class="block h-5 w-5 rounded-full border border-gray-400 bg-white shadow-sm focus:outline-none" />
      </SliderRoot>
      <div class="mt-1 flex justify-between text-slate-500">
        <span>{{ micronotToArgonotNm(lockedMicronots).format('0,0') }} locked</span>
        <span>{{ micronotToArgonotNm(maximumMicronots).format('0,0') }} max</span>
      </div>
      <div
        v-if="argonotTarget < requiredMicronotsForArgon"
        data-testid="MiningCapitalForm.argonotRequirement"
        class="mt-3 flex items-center rounded border border-yellow-400/70 bg-yellow-100 px-3 py-2 text-yellow-900"
      >
        <AlertIcon class="mr-2 h-4 shrink-0 text-yellow-700" />
        <span>{{ micronotToArgonotNm(requiredMicronotsForArgon).format('0,0.00') }} ARGNOT needed</span>
        <button
          v-if="argonotTarget !== minimumMicronotTarget"
          type="button"
          class="ml-auto cursor-pointer pl-3 font-semibold hover:underline"
          aria-label="Fix ARGNOT amount"
          @mousedown.prevent
          @click="
            isArgonotFollowingArgon = true;
            argonotTarget = minimumMicronotTarget;
          "
        >
          Fix
        </button>
      </div>
    </section>

    <div v-if="error" class="mt-4 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-red-700">
      {{ error }}
    </div>

    <footer class="mt-4 flex justify-end gap-2 border-t border-slate-300 pt-3">
      <button
        type="button"
        class="cursor-pointer rounded-md border border-slate-300 px-4 py-1 font-bold text-slate-600 hover:bg-slate-50"
        @click="emit('close')"
      >
        Cancel
      </button>
      <button
        type="button"
        class="bg-argon-button hover:bg-argon-button-hover cursor-pointer rounded-md px-4 py-1 font-bold text-white"
        @click="saveCapital"
      >
        Save Changes
      </button>
    </footer>
  </div>
</template>

<script setup lang="ts">
import * as Vue from 'vue';
import BigNumber from 'bignumber.js';
import {
  bigIntMax,
  bigIntMin,
  bigNumberToBigInt,
  MICROGONS_PER_ARGON,
  MICRONOTS_PER_ARGONOT,
} from '@argonprotocol/apps-core';
import { SliderRange, SliderRoot, SliderThumb, SliderTrack } from 'reka-ui';
import AlertIcon from '../../assets/alert.svg?component';
import InputToken from '../../components/InputToken.vue';
import { createNumeralHelpers } from '../../lib/numeral.ts';
import { getConfig } from '../../stores/config.ts';
import { getBot } from '../../stores/bot.ts';
import { getCurrency } from '../../stores/currency.ts';
import { getBiddingCalculator, getBiddingCalculatorData } from '../../stores/mainchain.ts';
import { getMyMiningSeats } from '../../stores/myMiningSeats.ts';
import { useWallets } from '../../stores/wallets.ts';
import { existentialDepositMicronots } from '../../lib/WalletForArgon.ts';

const props = defineProps<{
  isOpen: boolean;
  error?: string;
}>();

const emit = defineEmits<{
  (event: 'close'): void;
  (event: 'save', value: { microgons: bigint; micronots: bigint }): void;
}>();

const currency = getCurrency();
const config = getConfig();
const bot = getBot();
const biddingCalculator = getBiddingCalculator();
const biddingCalculatorData = getBiddingCalculatorData();
const myMiningSeats = getMyMiningSeats();
const wallets = useWallets();
const { microgonToArgonNm, micronotToArgonotNm } = createNumeralHelpers(currency);
const botMicrogons = Vue.computed(
  () => wallets.miningBotWallet.availableMicrogons + wallets.miningBotWallet.reservedMicrogons,
);
const botMicronots = Vue.computed(
  () => wallets.miningBotWallet.availableMicronots + wallets.miningBotWallet.reservedMicronots,
);
const walletMicronots = Vue.computed(() =>
  bigIntMax(wallets.defaultArgonWallet.availableMicronots - existentialDepositMicronots, 0n),
);
const lockedMicrogons = Vue.computed(() =>
  bigIntMax(wallets.miningBotWallet.reservedMicrogons, myMiningSeats.pendingBids.microgonsBidTotal),
);
const lockedMicronots = Vue.computed(() =>
  bigIntMax(wallets.miningBotWallet.reservedMicronots, myMiningSeats.pendingBids.micronotsStakedTotal),
);
const minimumAllocatedMicronots = Vue.computed(() => {
  const walletMinimum =
    botMicronots.value - bigIntMax(wallets.miningBotWallet.availableMicronots - existentialDepositMicronots, 0n);
  const biddingMinimum = bigIntMin(lockedMicronots.value + existentialDepositMicronots, botMicronots.value);
  return bigIntMax(walletMinimum, biddingMinimum);
});
const argonTarget = Vue.ref(botMicrogons.value);
const argonotTarget = Vue.ref(botMicronots.value);
const isArgonotFollowingArgon = Vue.ref(true);
const clientMaximumBidMicrogons = Vue.ref<bigint | undefined>(
  biddingCalculator.maximumBidAmountOverride ?? biddingCalculator.maximumBidAmount,
);
const clientMicronotsPerSeat = Vue.ref(biddingCalculatorData.currentMicronotsForBid);
const maximumBidMicrogons = Vue.computed(
  () => (bot.isReady ? bot.state?.maximumBidMicrogonsPerSeat : undefined) ?? clientMaximumBidMicrogons.value,
);
const micronotsPerSeat = Vue.computed(
  () => (bot.isReady ? bot.state?.currentAuctionMicronotsPerSeat : undefined) ?? clientMicronotsPerSeat.value,
);
let isResettingTargets = false;
let calculatorLoadSubscription: { unsubscribe: () => void } | undefined;

const maximumMicrogons = Vue.computed(() => botMicrogons.value + wallets.defaultArgonSpendableMicrogons);
const maximumMicronots = Vue.computed(() => botMicronots.value + walletMicronots.value);
const argonFundedSeatCount = Vue.computed(() => {
  if (!maximumBidMicrogons.value || maximumBidMicrogons.value <= 0n) return 0n;

  const affordableSeatCount = argonTarget.value / maximumBidMicrogons.value;
  const maximumSeatCount = BigInt(
    (bot.isReady ? bot.state?.seatGoalCount : undefined) ?? biddingCalculatorData.getMaxFrameSeats(config.biddingRules),
  );
  return bigIntMin(affordableSeatCount, maximumSeatCount);
});
const requiredMicronotsForArgon = Vue.computed(() => argonFundedSeatCount.value * micronotsPerSeat.value);
const minimumMicronotTarget = Vue.computed(() => {
  return bigIntMin(bigIntMax(requiredMicronotsForArgon.value, minimumAllocatedMicronots.value), maximumMicronots.value);
});

const argonSlider = createSliderModel(
  argonTarget,
  () => lockedMicrogons.value,
  maximumMicrogons,
  BigInt(MICROGONS_PER_ARGON),
);
const argonotSlider = createSliderModel(
  argonotTarget,
  () => minimumAllocatedMicronots.value,
  maximumMicronots,
  BigInt(MICRONOTS_PER_ARGONOT),
);

Vue.onMounted(() => {
  calculatorLoadSubscription = biddingCalculator.onLoad(() => {
    clientMaximumBidMicrogons.value = biddingCalculator.maximumBidAmountOverride ?? biddingCalculator.maximumBidAmount;
    clientMicronotsPerSeat.value = biddingCalculatorData.currentMicronotsForBid;
  });
});

Vue.onUnmounted(() => calculatorLoadSubscription?.unsubscribe());

Vue.watch(
  () => props.isOpen,
  async isOpen => {
    if (!isOpen) return;
    isResettingTargets = true;
    isArgonotFollowingArgon.value = true;
    argonTarget.value = botMicrogons.value;
    argonotTarget.value = botMicronots.value;
    await Vue.nextTick();
    isResettingTargets = false;
  },
);

Vue.watch(minimumMicronotTarget, minimumMicronots => {
  if (!isResettingTargets && isArgonotFollowingArgon.value) argonotTarget.value = minimumMicronots;
});

Vue.watch(lockedMicrogons, minimum => {
  if (argonTarget.value < minimum) argonTarget.value = minimum;
});

Vue.watch(minimumAllocatedMicronots, minimum => {
  if (argonotTarget.value < minimum) argonotTarget.value = minimum;
});

function createSliderModel(
  value: Vue.Ref<bigint>,
  minimum: () => bigint,
  maximum: Vue.ComputedRef<bigint>,
  unitsPerToken: bigint,
): Vue.WritableComputedRef<number[]> {
  return Vue.computed<number[]>({
    get: () => {
      const range = maximum.value - minimum();
      if (range === 0n) return [0];
      return [
        BigNumber((value.value - minimum()).toString())
          .dividedBy(range.toString())
          .multipliedBy(100)
          .toNumber(),
      ];
    },
    set: ([percentage]) => {
      const range = maximum.value - minimum();
      if ((percentage ?? 0) <= 0) {
        value.value = minimum();
        return;
      }
      if ((percentage ?? 0) >= 100) {
        value.value = maximum.value;
        return;
      }

      const unsnappedValue =
        minimum() +
        bigNumberToBigInt(
          BigNumber(range.toString())
            .multipliedBy(percentage ?? 0)
            .dividedBy(100),
        );
      const step = unsnappedValue < unitsPerToken * 10n ? unitsPerToken : unitsPerToken * 10n;
      let snappedValue = ((unsnappedValue + step / 2n) / step) * step;
      if (unsnappedValue > value.value && snappedValue <= value.value) {
        snappedValue = ((value.value + step) / step) * step;
      } else if (unsnappedValue < value.value && snappedValue >= value.value) {
        snappedValue = ((value.value - 1n) / step) * step;
      }
      value.value = bigIntMin(bigIntMax(snappedValue, minimum()), maximum.value);
    },
  });
}

function saveCapital() {
  emit('save', { microgons: argonTarget.value, micronots: argonotTarget.value });
}
</script>
