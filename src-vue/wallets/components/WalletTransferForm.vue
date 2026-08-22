<template>
<!--  <div class="flex min-h-40 flex-col items-center justify-center gap-y-3 text-center text-slate-500">-->
<!--    <div>This wallet has no argons/argonots.</div>-->
<!--    <button-->
<!--      type="button"-->
<!--      :disabled="isRefreshingTokenData"-->
<!--      class="border-argon-600 text-argon-600 flex cursor-pointer items-center gap-x-1.5 rounded border px-2 py-1 disabled:opacity-50"-->
<!--      @click="refreshTokenData"-->
<!--    >-->
<!--      <ArrowPathIcon :class="['h-4 w-4', isRefreshingTokenData ? 'animate-spin' : '']" />-->
<!--      Refresh Token Data-->
<!--    </button>-->
<!--  </div>-->
  <div>
    <div class="mt-4 flex flex-col">
      <label class="mb-1 font-bold text-gray-500/80">Amount to Send</label>
      <div class="flex flex-row">
        <div :data-testid="props.testIdPrefix + '.amount'" class="w-8/12">
          <InputToken
            v-model="tokensToMove"
            :min="0n"
            :max="props.maxValue"
            :maxDecimals="2"
            class="rounded-r-none border-r-0"
          />
        </div>
        <div class="w-4/12">
          <InputMenu v-model="selectedMoveToken" :options="tokenOptions" class="rounded-l-none" />
        </div>
      </div>
      <SliderRoot
        v-model="sliderValue"
        class="relative mt-2 flex h-5 w-full touch-none items-center select-none"
        :min="0"
        :max="100"
        :step="0.01"
        @pointerdown.capture="emit('update:isSliding', true)"
        @pointerup="emit('update:isSliding', false)"
        @pointercancel="emit('update:isSliding', false)"
        @lostpointercapture="emit('update:isSliding', false)"
      >
        <SliderTrack class="relative h-2 grow rounded-full bg-gray-500/30">
          <SliderRange class="bg-argon-600/50 absolute h-full rounded-full" />
        </SliderTrack>
        <!-- prettier-ignore -->
        <SliderThumb class="block h-6 w-6 rounded-full border border-gray-400 bg-white shadow-sm focus:outline-none" />
      </SliderRoot>
      <div class="mt-1 flex justify-between text-xs text-stone-400">
        <span>0 {{ selectedMoveToken }}</span>
        <span>{{ microgonToArgonNm(props.maxValue).format('0,0.[00]') }} {{ selectedMoveToken }}</span>
      </div>
    </div>

    <div :data-testid="props.testIdPrefix + '.destination'" class="mt-6 flex flex-col gap-x-3">
      <label class="mb-1 font-bold text-gray-500/80">Send To</label>
      <InputMenu
        v-if="props.destinationOptions"
        v-model="destination"
        :options="props.destinationOptions"
        :selectFirst="true"
        class="w-full"
      />
      <div
        v-else
        class="grow truncate rounded-md border border-slate-900/20 px-2 py-1.5 whitespace-nowrap text-gray-500/80"
      >
        {{ props.destinationLabel }}
      </div>
      <input
        v-if="props.showDestinationAddress"
        v-model="destinationAddress"
        data-testid="WalletTransferForm.destinationAddress"
        type="text"
        autocomplete="off"
        spellcheck="false"
        :placeholder="props.destinationAddressPlaceholder"
        class="mt-2 h-[30px] w-full rounded-md border border-slate-700/50 bg-white px-2 font-mono text-sm outline-none placeholder:text-gray-400"
      />
    </div>

    <div v-if="props.showEthereumFees" class="mt-6 flex flex-col gap-x-3">
      <label class="mb-1 font-bold text-gray-500/80">Cost of Send</label>
      <div class="border-b border-gray-300 text-sm">
        <div v-if="props.feeEstimateWei" class="flex flex-row border-t border-gray-300 py-2">
          <div class="grow">Ethereum Network</div>
          <div class="relative">
            <span :class="{ 'opacity-20': props.isEstimatingFees }">
              {{ weiToEthNm(props.feeEstimateWei).format('0.[00000000000000000000000000000]') }} ETH ({{
                currency.symbol
              }}{{ weiToMoneyNm(props.feeEstimateWei).format('0,0.000') }})
            </span>
            <span
              v-if="props.isEstimatingFees"
              class="border-t-argon-600 absolute top-1/2 right-0 ml-2 size-3 -translate-y-1/2 animate-spin rounded-full border-2 border-slate-300"
            />
          </div>
        </div>
        <div v-if="props.feeEstimateMicrogon" class="flex flex-row border-t border-gray-300 py-2">
          <div class="grow">Argon Network</div>
          <div class="relative">
            <span :class="{ 'opacity-20': props.isEstimatingFees }">
              {{ microgonToArgonNm(props.feeEstimateMicrogon).format('0.[00000000]') }} ARGN ({{ currency.symbol
              }}{{ microgonToMoneyNm(props.feeEstimateMicrogon).format('0,0.000') }})
            </span>
            <span
              v-if="props.isEstimatingFees"
              class="border-t-argon-600 absolute top-1/2 right-0 ml-2 size-3 -translate-y-1/2 animate-spin rounded-full border-2 border-slate-300"
            />
          </div>
        </div>
        <div v-if="props.feeEstimateMicronot" class="flex flex-row">
          <div class="relative grow">
            &nbsp;
            <div class="absolute top-0 right-0 h-px w-1/2 bg-linear-to-r from-transparent to-gray-300" />
          </div>
          <div class="relative border-t border-gray-300 py-2">
            <span :class="{ 'opacity-20': props.isEstimatingFees }">
              {{ micronotToArgonotNm(props.feeEstimateMicronot).format('0.[00000000]') }} ARGNOT ({{ currency.symbol
              }}{{ micronotToMoneyNm(props.feeEstimateMicronot).format('0,0.000') }})
            </span>
            <span
              v-if="props.isEstimatingFees"
              class="border-t-argon-600 absolute top-1/2 right-0 ml-2 size-3 -translate-y-1/2 animate-spin rounded-full border-2 border-slate-300"
            />
          </div>
        </div>
      </div>
      <div
        v-if="!props.hasSufficientFeeBalance"
        class="mt-3 flex flex-row items-center rounded border border-red-100 bg-red-100/50 px-2 py-2 text-sm text-red-500"
      >
        <AlertIcon class="mr-2 w-5" />
        {{ props.ethereumFeeEstimateError || 'Unable to estimate network fees.' }}
        {{
          props.ethereumBalanceWei > 0n
            ? 'Please try again with a higher gas price.'
            : 'Please connect a wallet with ETH to estimate fees.'
        }}
      </div>
    </div>

    <div v-if="props.formError" class="mt-4 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
      {{ props.formError }}
    </div>
  </div>
</template>

<script setup lang="ts">
import * as Vue from 'vue';
import { bigNumberToBigInt, MoveToken } from '@argonprotocol/apps-core';
import BigNumber from 'bignumber.js';
import { SliderRange, SliderRoot, SliderThumb, SliderTrack } from 'reka-ui';
import AlertIcon from '../../assets/alert.svg';
import InputMenu, { type IOption } from '../../components/InputMenu.vue';
import InputToken from '../../components/InputToken.vue';
import { createNumeralHelpers } from '../../lib/numeral.ts';
import { getCurrency } from '../../stores/currency.ts';
import { ArrowPathIcon } from '@heroicons/vue/24/outline';

const props = withDefaults(
  defineProps<{
    tokensToMove: bigint;
    selectedMoveToken: MoveToken;
    maxValue: bigint;
    allowBtc?: boolean;
    destinationLabel?: string;
    destination?: string;
    destinationOptions?: IOption[];
    destinationAddress?: string;
    destinationAddressPlaceholder?: string;
    showDestinationAddress?: boolean;
    showEthereumFees?: boolean;
    feeEstimateWei?: bigint;
    feeEstimateMicrogon?: bigint;
    feeEstimateMicronot?: bigint;
    ethereumFeeEstimateError?: string;
    ethereumBalanceWei?: bigint;
    hasSufficientFeeBalance?: boolean;
    isEstimatingFees?: boolean;
    formError?: string;
    testIdPrefix: string;
  }>(),
  {
    destinationLabel: '',
    destination: '',
    destinationOptions: undefined,
    destinationAddress: '',
    destinationAddressPlaceholder: 'Enter Argon network address',
    showDestinationAddress: false,
    showEthereumFees: true,
    feeEstimateWei: undefined,
    feeEstimateMicrogon: undefined,
    feeEstimateMicronot: undefined,
    ethereumFeeEstimateError: '',
    ethereumBalanceWei: () => 0n,
    hasSufficientFeeBalance: true,
    isEstimatingFees: false,
    formError: '',
  },
);

const emit = defineEmits<{
  (event: 'update:tokensToMove', value: bigint): void;
  (event: 'update:selectedMoveToken', value: MoveToken): void;
  (event: 'update:isSliding', value: boolean): void;
  (event: 'update:destination', value: string): void;
  (event: 'update:destinationAddress', value: string): void;
}>();

const currency = getCurrency();

const { microgonToArgonNm, microgonToMoneyNm, micronotToArgonotNm, micronotToMoneyNm, weiToEthNm, weiToMoneyNm } =
  createNumeralHelpers(currency);

const isSliding = Vue.ref(false);

const isReady = Vue.computed(() => {
  return !isSliding.value;
});

const tokenOptions = [
  { name: 'ARGN', value: MoveToken.ARGN },
  { name: 'ARGNOT', value: MoveToken.ARGNOT },
  ...(props.allowBtc ? [{ name: 'BTC', value: MoveToken.BTC }] : []),
];
const tokensToMove = Vue.computed({
  get: () => props.tokensToMove,
  set: value => emit('update:tokensToMove', value),
});
const selectedMoveToken = Vue.computed({
  get: () => props.selectedMoveToken,
  set: value => emit('update:selectedMoveToken', value as MoveToken),
});
const destination = Vue.computed({
  get: () => props.destination,
  set: value => emit('update:destination', value),
});
const destinationAddress = Vue.computed({
  get: () => props.destinationAddress,
  set: value => emit('update:destinationAddress', value),
});
const sliderValue = Vue.computed<number[]>({
  get: () =>
    props.maxValue === 0n
      ? [0]
      : [BigNumber(props.tokensToMove.toString()).dividedBy(props.maxValue.toString()).multipliedBy(100).toNumber()],
  set: ([percentage]) => {
    emit(
      'update:tokensToMove',
      bigNumberToBigInt(
        BigNumber(props.maxValue.toString())
          .multipliedBy(percentage ?? 0)
          .dividedBy(100),
      ),
    );
  },
});

Vue.watch(
  () => [isSliding.value, tokensToMove.value, selectedMoveToken.value],
  async (_values, _oldValues, onCleanup) => {
    if (isSliding.value) {
      isEstimatingFees.value = false;
      return;
    }

    void updateFees(onCleanup);
  },
  { immediate: true },
);

defineExpose({ isReady });

</script>
