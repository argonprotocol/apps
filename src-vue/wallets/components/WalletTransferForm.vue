<template>
  <div v-if="hasTokens">
    <div class="mt-4 flex flex-col">
      <label class="mb-1 font-bold text-gray-500/80">Amount to Send</label>
      <div class="flex flex-row">
        <div :data-testid="props.testIdPrefix + '.amount'" class="w-8/12">
          <InputToken
            v-model="tokensToMove"
            :min="0n"
            :max="maxValue"
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
        @pointerdown.capture="isSliding = true"
        @pointerup="isSliding = false"
        @pointercancel="isSliding = false"
        @lostpointercapture="isSliding = false"
      >
        <SliderTrack class="relative h-2 grow rounded-full bg-gray-500/30">
          <SliderRange class="bg-argon-600/50 absolute h-full rounded-full" />
        </SliderTrack>
        <!-- prettier-ignore -->
        <SliderThumb class="block h-6 w-6 rounded-full border border-gray-400 bg-white shadow-sm focus:outline-none" />
      </SliderRoot>
      <div class="mt-1 flex justify-between text-xs text-stone-400">
        <span>0 {{ selectedMoveToken }}</span>
        <span>{{ microgonToArgonNm(maxValue).format('0,0.[00]') }} {{ selectedMoveToken }}</span>
      </div>
    </div>

    <div :data-testid="props.testIdPrefix + '.destination'" class="mt-6 flex flex-col gap-x-3">
      <label class="mb-1 font-bold text-gray-500/80">Send To</label>
      <InputMenu
        v-if="showDestinationMenu"
        v-model="destination"
        :options="destinationOptions"
        :selectFirst="true"
        class="w-full"
      />
      <div
        v-else
        class="grow truncate rounded-md border border-slate-900/20 px-2 py-1.5 whitespace-nowrap text-gray-500/80"
      >
        {{ destinationLabel }}
      </div>
      <input
        v-if="showDestinationAddress"
        v-model="destinationAddress"
        data-testid="WalletTransferForm.destinationAddress"
        type="text"
        autocomplete="off"
        spellcheck="false"
        :placeholder="destinationAddressPlaceholder"
        class="mt-2 h-[30px] w-full rounded-md border border-slate-700/50 bg-white px-2 font-mono text-sm outline-none placeholder:text-gray-400"
      />
    </div>

    <div v-if="showEthereumFees" class="mt-6 flex flex-col gap-x-3">
      <label class="mb-1 font-bold text-gray-500/80">Cost of Send</label>
      <div class="border-b border-gray-300 text-sm">
        <div v-if="feeEstimateWei != null" class="flex flex-row border-t border-gray-300 py-2">
          <div class="grow">Ethereum Network</div>
          <div class="relative">
            <span :class="{ 'opacity-20': isEstimatingFees }">
              {{ weiToEthNm(feeEstimateWei).format('0.[00000000000000000000000000000]') }} ETH ({{ currency.symbol
              }}{{ weiToMoneyNm(feeEstimateWei).format('0,0.000') }})
            </span>
            <span
              v-if="isEstimatingFees"
              class="border-t-argon-600 absolute top-1/2 right-0 ml-2 size-3 -translate-y-1/2 animate-spin rounded-full border-2 border-slate-300"
            />
          </div>
        </div>
        <div v-if="feeEstimateMicrogon != null" class="flex flex-row border-t border-gray-300 py-2">
          <div class="grow">Argon Network</div>
          <div class="relative">
            <span :class="{ 'opacity-20': isEstimatingFees }">
              {{ microgonToArgonNm(feeEstimateMicrogon).format('0.[00000000]') }} ARGN ({{ currency.symbol
              }}{{ microgonToMoneyNm(feeEstimateMicrogon).format('0,0.000') }})
            </span>
            <span
              v-if="isEstimatingFees"
              class="border-t-argon-600 absolute top-1/2 right-0 ml-2 size-3 -translate-y-1/2 animate-spin rounded-full border-2 border-slate-300"
            />
          </div>
        </div>
        <div v-if="feeEstimateMicronot" class="flex flex-row">
          <div class="relative grow">
            &nbsp;
            <div class="absolute top-0 right-0 h-px w-1/2 bg-linear-to-r from-transparent to-gray-300" />
          </div>
          <div class="relative border-t border-gray-300 py-2">
            <span :class="{ 'opacity-20': isEstimatingFees }">
              {{ micronotToArgonotNm(feeEstimateMicronot).format('0.[00000000]') }} ARGNOT ({{ currency.symbol
              }}{{ micronotToMoneyNm(feeEstimateMicronot).format('0,0.000') }})
            </span>
            <span
              v-if="isEstimatingFees"
              class="border-t-argon-600 absolute top-1/2 right-0 ml-2 size-3 -translate-y-1/2 animate-spin rounded-full border-2 border-slate-300"
            />
          </div>
        </div>
      </div>
      <div
        v-if="showEthereumFeeError"
        class="mt-3 flex flex-row items-center rounded border border-red-100 bg-red-100/50 px-2 py-2 text-sm text-red-500"
      >
        <AlertIcon class="mr-2 w-5" />
        <template v-if="ethereumFeeEstimateError">
          {{ ethereumFeeEstimateError }}
        </template>
        <template v-else>Your {{ destinationLabel }} wallet does not have enough eth.</template>
      </div>
    </div>

    <div v-if="formError" class="mt-4 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
      {{ formError }}
    </div>
  </div>
  <div v-else>This wallet has no tokens to transfer.</div>
</template>

<script setup lang="ts">
import * as Vue from 'vue';
import { bigIntMax, bigNumberToBigInt, MoveToken } from '@argonprotocol/apps-core';
import { EvmContracts } from '@argonprotocol/mainchain';
import BigNumber from 'bignumber.js';
import { SliderRange, SliderRoot, SliderThumb, SliderTrack } from 'reka-ui';
import AlertIcon from '../../assets/alert.svg';
import InputMenu, { type IOption } from '../../components/InputMenu.vue';
import InputToken from '../../components/InputToken.vue';
import type { IEthereumMoveToken } from '../../lib/EthereumClient.ts';
import type { IArgonWalletType } from '../../interfaces/IEthereumInboundTransferTracker.ts';
import { WalletType } from '../../lib/Wallet.ts';
import type { WalletForArgon } from '../../lib/WalletForArgon.ts';
import type { WalletForBitcoin } from '../../lib/WalletForBitcoin.ts';
import type { WalletForEthereum } from '../../lib/WalletForEthereum.ts';
import { createNumeralHelpers } from '../../lib/numeral.ts';
import { getCurrency } from '../../stores/currency.ts';
import { getEthereumMoveTracker } from '../../stores/moveFromEthereum.ts';
import { getEthereumOutboundTransferTracker } from '../../stores/moveToEthereum.ts';

type ITransferArgonWallet = WalletForArgon<'argon'> | WalletForArgon<'miningBot'>;
export type ITransferWallet = ITransferArgonWallet | WalletForEthereum | WalletForBitcoin;

const props = withDefaults(
  defineProps<{
    fromWallet: ITransferWallet;
    toWallets: ITransferWallet[];
    testIdPrefix?: string;
  }>(),
  { testIdPrefix: 'WalletTransferForm' },
);
const emit = defineEmits<{
  (event: 'selectDestinationWallet', wallet: ITransferWallet | undefined): void;
}>();

const currency = getCurrency();
const inboundTracker = getEthereumMoveTracker();
const outboundTracker = getEthereumOutboundTransferTracker();
const { microgonToArgonNm, microgonToMoneyNm, micronotToArgonotNm, micronotToMoneyNm, weiToEthNm, weiToMoneyNm } =
  createNumeralHelpers(currency);

const tokensToMove = Vue.ref(0n);
const selectedMoveToken = Vue.ref<MoveToken>(MoveToken.ARGN);
const destination = Vue.ref('');
const destinationAddress = Vue.ref('');
const maximumTransferOutAmount = Vue.ref<bigint>();
const feeEstimateWei = Vue.ref<bigint>();
const feeEstimateMicrogon = Vue.ref<bigint>();
const feeEstimateMicronot = Vue.ref<bigint>();
const ethereumFeeEstimateError = Vue.ref('');
const maximumTransferError = Vue.ref('');
const submissionError = Vue.ref('');
const isCalculatingMaximum = Vue.ref(false);
const isEstimatingFees = Vue.ref(false);
const isSliding = Vue.ref(false);

const tokenOptions = Vue.computed<IOption[]>(() => [
  {
    name: 'ARGN',
    value: MoveToken.ARGN,
    disabled: getWalletAvailableAmount(props.fromWallet, MoveToken.ARGN) <= 0n,
  },
  {
    name: 'ARGNOT',
    value: MoveToken.ARGNOT,
    disabled: getWalletAvailableAmount(props.fromWallet, MoveToken.ARGNOT) <= 0n,
  },
  ...(isArgonWallet(props.fromWallet)
    ? [
        {
          name: 'BTC',
          value: MoveToken.BTC,
          disabled: getWalletAvailableAmount(props.fromWallet, MoveToken.BTC) <= 0n,
        },
      ]
    : []),
]);
const hasTokens = Vue.computed(() => {
  const sourceWallet = props.fromWallet;
  const hasArgonTokens = sourceWallet.data.availableMicrogons > 0n || sourceWallet.data.availableMicronots > 0n;
  if (isEthereumWallet(sourceWallet)) return hasArgonTokens;
  if (isArgonWallet(sourceWallet)) {
    return hasArgonTokens || getWalletAvailableAmount(sourceWallet, MoveToken.BTC) > 0n;
  }
  return false;
});
const destinationWallets = Vue.computed(() =>
  props.toWallets.filter(wallet =>
    selectedMoveToken.value === MoveToken.BTC ? wallet.type === WalletType.bitcoin : wallet.type !== WalletType.bitcoin,
  ),
);
const destinationOptions = Vue.computed<IOption[]>(() =>
  destinationWallets.value.map(wallet => ({ name: getDestinationLabel(wallet), value: getDestinationValue(wallet) })),
);
const selectedDestinationWallet = Vue.computed(() =>
  destinationWallets.value.find(wallet => getDestinationValue(wallet) === destination.value),
);
const destinationLabel = Vue.computed(() =>
  selectedDestinationWallet.value ? getDestinationLabel(selectedDestinationWallet.value) : '',
);
const showDestinationMenu = Vue.computed(
  () =>
    destinationOptions.value.length > 0 && (!isEthereumWallet(props.fromWallet) || destinationOptions.value.length > 1),
);
const showDestinationAddress = Vue.computed(
  () => isArgonWallet(props.fromWallet) && !isEthereumWallet(selectedDestinationWallet.value),
);
const destinationAddressPlaceholder = Vue.computed(() =>
  selectedDestinationWallet.value?.type === WalletType.bitcoin
    ? 'Enter Bitcoin network address'
    : 'Enter Argon network address',
);
const selectedEthereumMoveToken = Vue.computed<IEthereumMoveToken | undefined>(() => {
  if (selectedMoveToken.value === MoveToken.BTC) return;
  return selectedMoveToken.value;
});
const selectedEthereumWallet = Vue.computed(() => {
  if (isEthereumWallet(props.fromWallet)) return props.fromWallet;
  return isEthereumWallet(selectedDestinationWallet.value) ? selectedDestinationWallet.value : undefined;
});
const showEthereumFees = Vue.computed(() => !!selectedEthereumMoveToken.value && !!selectedEthereumWallet.value);
const ethereumBalanceWei = Vue.computed(
  () => selectedEthereumWallet.value?.data.otherTokens.find(token => token.symbol === 'ETH')?.value ?? 0n,
);
const availableAmount = Vue.computed(() => {
  const rawAmount = getWalletAvailableAmount(props.fromWallet, selectedMoveToken.value);
  const moveToken = selectedEthereumMoveToken.value;
  if (!moveToken) return rawAmount;
  if (isEthereumWallet(props.fromWallet)) {
    return bigIntMax(
      rawAmount -
        inboundTracker.getPendingAmount(props.fromWallet.address, moveToken, props.fromWallet.data.balanceUpdatedAt),
      0n,
    );
  }
  if (isArgonWallet(props.fromWallet) && isEthereumWallet(selectedDestinationWallet.value)) {
    return bigIntMax(
      rawAmount -
        outboundTracker.getPendingAmount(props.fromWallet.address, selectedDestinationWallet.value.address, moveToken),
      0n,
    );
  }
  return rawAmount;
});
const maxValue = Vue.computed(() => maximumTransferOutAmount.value ?? availableAmount.value);
const hasSufficientFeeBalance = Vue.computed(
  () => !showEthereumFees.value || (feeEstimateWei.value != null && ethereumBalanceWei.value >= feeEstimateWei.value),
);
const showEthereumFeeError = Vue.computed(
  () => showEthereumFees.value && !isEstimatingFees.value && !hasSufficientFeeBalance.value,
);
const formError = Vue.computed(() => submissionError.value || maximumTransferError.value);
const hasValidDestination = Vue.computed(
  () => !!selectedDestinationWallet.value && (!showDestinationAddress.value || !!destinationAddress.value.trim()),
);
const isReady = Vue.computed(
  () =>
    !isSliding.value &&
    !isCalculatingMaximum.value &&
    !isEstimatingFees.value &&
    !ethereumFeeEstimateError.value &&
    !formError.value &&
    hasValidDestination.value &&
    tokensToMove.value > 0n &&
    tokensToMove.value <= maxValue.value &&
    (!showEthereumFees.value || (feeEstimateWei.value != null && hasSufficientFeeBalance.value)),
);
const sliderValue = Vue.computed<number[]>({
  get: () =>
    maxValue.value === 0n
      ? [0]
      : [BigNumber(tokensToMove.value.toString()).dividedBy(maxValue.value.toString()).multipliedBy(100).toNumber()],
  set: ([percentage]) => {
    tokensToMove.value = bigNumberToBigInt(
      BigNumber(maxValue.value.toString())
        .multipliedBy(percentage ?? 0)
        .dividedBy(100),
    );
  },
});

function getWalletAvailableAmount(wallet: ITransferWallet, moveToken: MoveToken): bigint {
  if (moveToken === MoveToken.ARGN) return wallet.data.availableMicrogons;
  if (moveToken === MoveToken.ARGNOT) return wallet.data.availableMicronots;
  return wallet.data.otherTokens.find(token => token.symbol === 'BTC')?.value ?? 0n;
}

function getDestinationValue(wallet: ITransferWallet): string {
  if (wallet.type === WalletType.bitcoin) return WalletType.bitcoin;
  if (isEthereumWallet(wallet)) return `${WalletType.ethereum}:${wallet.id ?? wallet.address}`;
  return `${wallet.type}:${wallet.address}`;
}

function getDestinationLabel(wallet: ITransferWallet): string {
  if (isEthereumWallet(wallet)) return wallet.name;
  if (wallet.type === WalletType.bitcoin) return 'Bitcoin Network Address';
  return isEthereumWallet(props.fromWallet) ? 'Internal App Wallet' : 'Another Argon Wallet';
}

function isEthereumWallet(wallet: ITransferWallet | undefined): wallet is WalletForEthereum {
  return wallet?.type === WalletType.ethereum;
}

function isArgonWallet(wallet: ITransferWallet | undefined): wallet is ITransferArgonWallet {
  return wallet?.type === WalletType.argon;
}

function setFormError(error: string): void {
  submissionError.value = error;
}

function setMoveToken(moveToken: MoveToken): void {
  if (tokenOptions.value.some(option => option.value === moveToken)) selectedMoveToken.value = moveToken;
}

Vue.watch(
  destinationOptions,
  options => {
    if (options.some(option => option.value === destination.value)) return;
    destination.value = options[0]?.value ?? '';
    destinationAddress.value = '';
  },
  { immediate: true },
);
Vue.watch(selectedDestinationWallet, wallet => emit('selectDestinationWallet', wallet), {
  immediate: true,
  flush: 'post',
});
Vue.watch(
  () => [selectedMoveToken.value, destination.value, destinationAddress.value] as const,
  () => (submissionError.value = ''),
);
Vue.watch(
  () => [selectedMoveToken.value, destination.value, availableAmount.value] as const,
  async ([moveToken, _destination, available], _oldValues, onCleanup) => {
    maximumTransferError.value = '';
    maximumTransferOutAmount.value = undefined;
    const ethereumWallet = selectedDestinationWallet.value;
    if (
      !isArgonWallet(props.fromWallet) ||
      !isEthereumWallet(ethereumWallet) ||
      moveToken === MoveToken.BTC ||
      available <= 0n
    ) {
      isCalculatingMaximum.value = false;
      return;
    }
    let cancelled = false;
    onCleanup(() => (cancelled = true));
    isCalculatingMaximum.value = true;
    try {
      const maximum = await outboundTracker.getMaximumTransferOutAmount(available, moveToken);
      if (!cancelled) maximumTransferOutAmount.value = maximum;
    } catch (error) {
      if (!cancelled)
        maximumTransferError.value =
          error instanceof Error ? error.message : 'Unable to calculate the maximum transfer.';
    } finally {
      if (!cancelled) isCalculatingMaximum.value = false;
    }
  },
  { immediate: true },
);
Vue.watch(
  maxValue,
  max => {
    if (tokensToMove.value === 0n || tokensToMove.value > max) tokensToMove.value = max;
  },
  { immediate: true },
);
Vue.watch(
  () => [isSliding.value, tokensToMove.value, selectedMoveToken.value, destination.value] as const,
  async ([sliding, amount], _oldValues, onCleanup) => {
    ethereumFeeEstimateError.value = '';
    if (sliding) {
      isEstimatingFees.value = false;
      return;
    }
    const moveToken = selectedEthereumMoveToken.value;
    const ethereumWallet = selectedEthereumWallet.value;
    if (amount <= 0n || !moveToken || !ethereumWallet) {
      feeEstimateWei.value = undefined;
      feeEstimateMicrogon.value = undefined;
      feeEstimateMicronot.value = undefined;
      isEstimatingFees.value = false;
      return;
    }
    let cancelled = false;
    onCleanup(() => (cancelled = true));
    isEstimatingFees.value = true;
    try {
      if (isEthereumWallet(props.fromWallet)) {
        const estimate = await inboundTracker.estimateFeeWei({
          moveToken,
          amountBaseUnits: amount * EvmContracts.MINTING_GATEWAY_RUNTIME_TO_ERC20_SCALE,
          targetWalletType: WalletType.argon,
          ethereumWallet: props.fromWallet,
        });
        if (!cancelled) {
          feeEstimateWei.value = estimate;
          feeEstimateMicrogon.value = undefined;
          feeEstimateMicronot.value = undefined;
        }
      } else if (isArgonWallet(props.fromWallet) && isEthereumWallet(selectedDestinationWallet.value)) {
        const [ethereumFeeRange, argonFees] = await Promise.all([
          outboundTracker.estimateFeeRangeWei({ moveToken, amount, ethereumWallet: selectedDestinationWallet.value }),
          outboundTracker.estimateArgonFees({
            moveToken,
            amount,
            sourceWalletType: WalletType.argon,
            ethereumWallet: selectedDestinationWallet.value,
          }),
        ]);
        if (!cancelled) {
          feeEstimateWei.value = ethereumFeeRange?.[1];
          feeEstimateMicrogon.value =
            argonFees.transactionFeeMicrogons + (moveToken === MoveToken.ARGN ? argonFees.mintingAuthorityTip : 0n);
          feeEstimateMicronot.value = moveToken === MoveToken.ARGNOT ? argonFees.mintingAuthorityTip : 0n;
        }
      }
    } catch (error) {
      if (!cancelled) {
        feeEstimateWei.value = undefined;
        feeEstimateMicrogon.value = undefined;
        feeEstimateMicronot.value = undefined;
        ethereumFeeEstimateError.value =
          error instanceof Error ? error.message : 'Unable to estimate the transfer fees.';
      }
    } finally {
      if (!cancelled) isEstimatingFees.value = false;
    }
  },
  { immediate: true },
);

defineExpose({
  availableAmount,
  destinationAddress,
  isReady,
  selectedDestinationWallet,
  selectedMoveToken,
  setFormError,
  setMoveToken,
  tokensToMove,
});
</script>
