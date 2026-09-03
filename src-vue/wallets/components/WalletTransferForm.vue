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
            :unitsPerToken="selectedMoveToken === MoveToken.BTC ? SATOSHIS_PER_BITCOIN : undefined"
            :maxDecimals="selectedMoveToken === MoveToken.BTC ? 8 : 2"
            class="rounded-r-none border-r-0"
          />
        </div>
        <div class="w-4/12">
          <InputMenu
            v-model="selectedMoveToken"
            :options="tokenOptions"
            :dataTestid="props.testIdPrefix + '.token'"
            class="rounded-l-none"
          />
        </div>
      </div>
      <SliderRoot
        v-model="sliderValue"
        class="relative mt-2 flex h-5 w-full touch-none items-center select-none"
        :min="0"
        :max="sliderMaximum"
        :step="selectedMoveToken === MoveToken.BTC ? 1 : 0.01"
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
        <span v-if="selectedMoveToken === MoveToken.BTC" :data-testid="props.testIdPrefix + '.maximum'">
          {{ satToBtcNm(maxValue).format('0,0.[00000000]') }} BTC{{
            liquidLockedSatoshis > 0n && !isBitcoinEntirelyLocked ? '*' : ''
          }}
        </span>
        <span v-else>{{ microgonToArgonNm(maxValue).format('0,0.[00]') }} {{ selectedMoveToken }}</span>
      </div>
      <PopoverRoot v-if="selectedMoveToken === MoveToken.BTC && liquidLockedSatoshis > 0n">
        <WalletFundingCallout v-if="isBitcoinEntirelyLocked" :showAction="false" :showArrow="false" class="text-sm">
          <AlertIcon class="mr-2 h-4 shrink-0 text-yellow-700" />
          <span>
            No Bitcoin is available to send. Channels must have no active Liquids to send BTC.
            <PopoverTrigger asChild>
              <button class="cursor-pointer font-semibold hover:underline" type="button">Details</button>
            </PopoverTrigger>
          </span>
        </WalletFundingCallout>
        <PopoverTrigger v-else asChild>
          <button type="button" class="text-argon-600 inline-flex items-center gap-1 self-end text-xs hover:underline">
            * {{ satToBtcNm(liquidLockedSatoshis).format('0,0.[00000000]') }} BTC is used by Liquids
            <InformationCircleIcon class="h-4 w-4" />
          </button>
        </PopoverTrigger>
        <PopoverPortal>
          <PopoverContent
            side="bottom"
            align="end"
            :sideOffset="6"
            :collisionPadding="30"
            :style="floatingZIndex"
            class="w-80 rounded-lg shadow-2xl"
          >
            <div class="rounded-lg border border-black/50 bg-white p-4 text-left text-sm text-gray-700">
              <p>Bitcoin used by active Liquids cannot be sent until those Liquids are closed.</p>
              <div class="mt-3 border-t border-slate-300 pt-3">
                <div
                  v-for="(detail, index) in liquidLockedChannelDetails"
                  :key="detail.channel.uuid"
                  :class="index ? 'mt-3' : ''"
                >
                  <div class="flex items-center gap-3">
                    <span class="min-w-0 grow">Cosigner: {{ detail.cosigner }}</span>
                    <span class="shrink-0">
                      {{ satToBtcNm(detail.channel.fundedSatoshis).format('0,0.[00000000]') }} BTC channel
                    </span>
                  </div>
                  <div class="mt-1 flex items-center gap-3 text-xs">
                    <span v-if="detail.address" class="min-w-0 grow truncate font-mono text-slate-500">
                      {{ detail.address }}
                    </span>
                    <span v-else class="grow" />
                    <span class="shrink-0">
                      {{ satToBtcNm(detail.channel.fissionedSatoshis ?? 0n).format('0,0.[00000000]') }} BTC Liquid
                    </span>
                  </div>
                </div>
              </div>
              <PopoverArrow
                :width="26"
                :height="12"
                class="pointer-events-none -mt-px fill-white stroke-gray-800/40 stroke-[0.5]"
              />
            </div>
          </PopoverContent>
        </PopoverPortal>
      </PopoverRoot>
    </div>

    <div
      v-if="!isBitcoinEntirelyLocked"
      :data-testid="props.testIdPrefix + '.destination'"
      class="mt-6 flex flex-col gap-x-3"
    >
      <label class="mb-1 font-bold text-gray-500/80">Send To</label>
      <InputMenu
        v-if="showDestinationMenu"
        v-model="destination"
        :options="destinationOptions"
        :selectFirst="true"
        :dataTestid="props.testIdPrefix + '.destinationMenu'"
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

    <div v-if="isBitcoinTransfer && !isBitcoinEntirelyLocked" class="mt-6 flex flex-col gap-x-3">
      <label class="mb-1 font-bold text-gray-500/80">Bitcoin Network Speed</label>
      <InputMenu
        v-model="selectedBitcoinFeeRateKey"
        :options="bitcoinFeeRateOptions"
        :dataTestid="props.testIdPrefix + '.bitcoinFeeRate'"
      />
    </div>

    <div v-if="showFees" :data-testid="props.testIdPrefix + '.cost'" class="mt-6 flex flex-col gap-x-3">
      <label class="mb-1 font-bold text-gray-500/80">Cost of Send</label>
      <div class="border-b border-gray-300 text-sm">
        <div v-if="bitcoinFeeEstimate" class="flex flex-row border-t border-gray-300 py-2">
          <div class="grow">Bitcoin Network</div>
          <div class="relative ml-4 text-right">
            <span :class="{ 'opacity-20': isEstimatingFees }">
              {{ satToBtcNm(bitcoinFeeEstimate.bitcoinFee).format('0,0.[00000000]') }} BTC ({{ currency.symbol
              }}{{ microgonToMoneyNm(currency.convertSatToMicrogon(bitcoinFeeEstimate.bitcoinFee)).format('0,0.000') }})
            </span>
            <span
              v-if="isEstimatingFees"
              class="border-t-argon-600 absolute top-1/2 right-0 ml-2 size-3 -translate-y-1/2 animate-spin rounded-full border-2 border-slate-300"
            />
          </div>
        </div>
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
        <div v-if="argonFeeEstimate != null" class="flex flex-row border-t border-gray-300 py-2">
          <div class="grow">Argon Network</div>
          <div class="relative">
            <span :class="{ 'opacity-20': isEstimatingFees }">
              {{ microgonToArgonNm(argonFeeEstimate).format('0.[00000000]') }} ARGN ({{ currency.symbol
              }}{{ microgonToMoneyNm(argonFeeEstimate).format('0,0.000') }})
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
        v-if="showFeeError"
        class="mt-3 flex flex-row items-center rounded border border-red-100 bg-red-100/50 px-2 py-2 text-sm text-red-500"
      >
        <AlertIcon class="mr-2 w-5" />
        <template v-if="feeEstimateError">
          {{ feeEstimateError }}
        </template>
        <template v-else-if="isBitcoinTransfer">Your Internal App Wallet does not have enough ARGN.</template>
        <template v-else>Your {{ destinationLabel }} wallet does not have enough ETH.</template>
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
import { bigIntMax, bigNumberToBigInt, MoveToken, SATOSHIS_PER_BITCOIN } from '@argonprotocol/apps-core';
import { EvmContracts } from '@argonprotocol/mainchain';
import BigNumber from 'bignumber.js';
import { InformationCircleIcon } from '@heroicons/vue/24/outline';
import {
  PopoverArrow,
  PopoverContent,
  PopoverPortal,
  PopoverRoot,
  PopoverTrigger,
  SliderRange,
  SliderRoot,
  SliderThumb,
  SliderTrack,
} from 'reka-ui';
import AlertIcon from '../../assets/alert.svg';
import InputMenu, { type IOption } from '../../components/InputMenu.vue';
import InputToken from '../../components/InputToken.vue';
import WalletFundingCallout from '../../components/WalletFundingCallout.vue';
import { validateBitcoinAddressForNetwork } from '../../lib/BitcoinAddressValidation.ts';
import BitcoinLocks from '../../lib/BitcoinLocks.ts';
import type { IEthereumMoveToken } from '../../lib/EthereumClient.ts';
import type { IArgonWalletType } from '../../interfaces/IEthereumInboundTransferTracker.ts';
import { WalletType } from '../../lib/Wallet.ts';
import type { WalletForArgon } from '../../lib/WalletForArgon.ts';
import type { WalletForBitcoin } from '../../lib/WalletForBitcoin.ts';
import type { WalletForEthereum } from '../../lib/WalletForEthereum.ts';
import { createNumeralHelpers } from '../../lib/numeral.ts';
import { abbreviateAddress } from '../../lib/Utils.ts';
import { useFloatingZIndex } from '../../overlays/helpers/OverlayZIndex.ts';
import { getCurrency } from '../../stores/currency.ts';
import { getConfig } from '../../stores/config.ts';
import { getBitcoinLocks, getBitcoinTransactionOperations } from '../../stores/bitcoin.ts';
import { getEthereumMoveTracker } from '../../stores/moveFromEthereum.ts';
import { getEthereumOutboundTransferTracker } from '../../stores/moveToEthereum.ts';
import { getVaults } from '../../stores/vaults.ts';
import { getWalletKeys } from '../../stores/wallets.ts';

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
const config = getConfig();
const vaults = getVaults();
const bitcoinLocks = getBitcoinLocks();
const { bitcoinLockRelease } = getBitcoinTransactionOperations();
const inboundTracker = getEthereumMoveTracker();
const outboundTracker = getEthereumOutboundTransferTracker();
const floatingZIndex = useFloatingZIndex();
const {
  microgonToArgonNm,
  microgonToMoneyNm,
  micronotToArgonotNm,
  micronotToMoneyNm,
  satToBtcNm,
  weiToEthNm,
  weiToMoneyNm,
} = createNumeralHelpers(currency);

const tokensToMove = Vue.ref(0n);
const selectedMoveToken = Vue.ref<MoveToken>(MoveToken.ARGN);
const destination = Vue.ref('');
const destinationAddress = Vue.ref('');
const maximumTransferOutAmount = Vue.ref<bigint>();
const feeEstimateWei = Vue.ref<bigint>();
const feeEstimateMicrogon = Vue.ref<bigint>();
const feeEstimateMicronot = Vue.ref<bigint>();
const bitcoinFeeEstimate = Vue.ref<{
  argonFee: bigint;
  availableArgons: bigint;
  bitcoinFee: bigint;
  canAfford: boolean;
  networkFees: bigint[];
}>();
const bitcoinFeeRateOptions = Vue.ref<IOption[]>([
  { name: 'Fast = ~10 min', value: 'fast', sats: 10n },
  { name: 'Medium = ~30 min', value: 'medium', sats: 5n },
  { name: 'Slow = ~60 min', value: 'slow', sats: 3n },
]);
const selectedBitcoinFeeRateKey = Vue.ref('medium');
const feeEstimateError = Vue.ref('');
const maximumTransferError = Vue.ref('');
const submissionError = Vue.ref('');
const isCalculatingMaximum = Vue.ref(false);
const isEstimatingFees = Vue.ref(false);
const isSliding = Vue.ref(false);

const bitcoinWallet = Vue.computed(() =>
  props.toWallets.find((wallet): wallet is WalletForBitcoin => wallet.type === WalletType.bitcoin),
);
const sendableBitcoinChannels = Vue.computed(() => bitcoinWallet.value?.getSendableChannels() ?? []);
const liquidLockedChannelDetails = Vue.computed(() => {
  const wallet = bitcoinWallet.value;
  if (!wallet) return [];
  return wallet.getLiquidLockedChannels().map(channel => {
    let address = '';
    if (channel.scriptDetails) {
      try {
        address = abbreviateAddress(wallet.getChannelFundingAddress(channel), 8);
      } catch {
        // Current chain state remains usable while incomplete historical script details are repaired.
      }
    }
    return {
      channel,
      cosigner:
        vaults.operatorNamesByVaultId[channel.vaultId] ??
        (config.upstreamOperator?.vaultId === channel.vaultId ? config.upstreamOperator.name : undefined) ??
        `Vault ${channel.vaultId}`,
      address,
    };
  });
});
const liquidLockedSatoshis = Vue.computed(() =>
  liquidLockedChannelDetails.value.reduce((total, detail) => total + (detail.channel.fissionedSatoshis ?? 0n), 0n),
);
const isBitcoinEntirelyLocked = Vue.computed(
  () =>
    selectedMoveToken.value === MoveToken.BTC &&
    sendableBitcoinChannels.value.length === 0 &&
    liquidLockedSatoshis.value > 0n,
);
const hasFundedBitcoinChannels = Vue.computed(
  () => sendableBitcoinChannels.value.length > 0 || liquidLockedChannelDetails.value.length > 0,
);
const bitcoinTransferAmounts = Vue.computed(() => {
  let total = 0n;
  return [
    0n,
    ...sendableBitcoinChannels.value.map(channel => {
      total += channel.fundedSatoshis;
      return total;
    }),
  ];
});
const selectedBitcoinChannels = Vue.computed(() => {
  if (selectedMoveToken.value !== MoveToken.BTC) return [];
  const channelCount = bitcoinTransferAmounts.value.indexOf(tokensToMove.value);
  return channelCount < 1 ? [] : sendableBitcoinChannels.value.slice(0, channelCount);
});
const bitcoinNetworkFees = Vue.computed(() => bitcoinFeeEstimate.value?.networkFees ?? []);
const bitcoinFeeRatePerSatVb = Vue.computed(
  () => bitcoinFeeRateOptions.value.find(option => option.value === selectedBitcoinFeeRateKey.value)?.sats ?? 5n,
);

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
          disabled: !hasFundedBitcoinChannels.value,
        },
      ]
    : []),
]);
const hasTokens = Vue.computed(() => {
  const sourceWallet = props.fromWallet;
  const hasArgonTokens = sourceWallet.data.availableMicrogons > 0n || sourceWallet.data.availableMicronots > 0n;
  if (isEthereumWallet(sourceWallet)) return hasArgonTokens;
  if (isArgonWallet(sourceWallet)) {
    return hasArgonTokens || hasFundedBitcoinChannels.value;
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
const isBitcoinTransfer = Vue.computed(
  () => selectedMoveToken.value === MoveToken.BTC && selectedDestinationWallet.value?.type === WalletType.bitcoin,
);
const showEthereumFees = Vue.computed(() => !!selectedEthereumMoveToken.value && !!selectedEthereumWallet.value);
const showFees = Vue.computed(
  () => showEthereumFees.value || (isBitcoinTransfer.value && !isBitcoinEntirelyLocked.value),
);
const argonFeeEstimate = Vue.computed(() => bitcoinFeeEstimate.value?.argonFee ?? feeEstimateMicrogon.value);
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
const sliderMaximum = Vue.computed(() =>
  selectedMoveToken.value === MoveToken.BTC ? Math.max(bitcoinTransferAmounts.value.length - 1, 0) : 100,
);
const bitcoinAmountError = Vue.computed(() => {
  if (
    selectedMoveToken.value !== MoveToken.BTC ||
    tokensToMove.value === 0n ||
    bitcoinTransferAmounts.value.includes(tokensToMove.value)
  )
    return '';
  return 'Choose an amount matching the available Bitcoin channel increments.';
});
const hasSufficientEthereumFeeBalance = Vue.computed(
  () => !showEthereumFees.value || (feeEstimateWei.value != null && ethereumBalanceWei.value >= feeEstimateWei.value),
);
const hasSufficientBitcoinFeeBalance = Vue.computed(
  () => !isBitcoinTransfer.value || bitcoinFeeEstimate.value?.canAfford === true,
);
const showFeeError = Vue.computed(
  () =>
    showFees.value &&
    tokensToMove.value > 0n &&
    !isEstimatingFees.value &&
    (!!feeEstimateError.value ||
      (feeEstimateWei.value != null && !hasSufficientEthereumFeeBalance.value) ||
      (bitcoinFeeEstimate.value != null && !hasSufficientBitcoinFeeBalance.value)),
);
const bitcoinDestinationError = Vue.computed(() => {
  if (!isBitcoinTransfer.value || !destinationAddress.value.trim()) return '';
  return validateBitcoinAddressForNetwork(destinationAddress.value.trim(), bitcoinLocks.bitcoinNetwork);
});
const formError = Vue.computed(
  () =>
    submissionError.value || maximumTransferError.value || bitcoinAmountError.value || bitcoinDestinationError.value,
);
const hasValidDestination = Vue.computed(
  () => !!selectedDestinationWallet.value && (!showDestinationAddress.value || !!destinationAddress.value.trim()),
);
const isReady = Vue.computed(
  () =>
    !isSliding.value &&
    !isCalculatingMaximum.value &&
    !isEstimatingFees.value &&
    !feeEstimateError.value &&
    !formError.value &&
    hasValidDestination.value &&
    tokensToMove.value > 0n &&
    tokensToMove.value <= maxValue.value &&
    !bitcoinAmountError.value &&
    (!showEthereumFees.value || (feeEstimateWei.value != null && hasSufficientEthereumFeeBalance.value)) &&
    (!isBitcoinTransfer.value || (bitcoinFeeEstimate.value != null && hasSufficientBitcoinFeeBalance.value)),
);
const sliderValue = Vue.computed<number[]>({
  get: () => {
    if (selectedMoveToken.value === MoveToken.BTC) {
      const exactIndex = bitcoinTransferAmounts.value.indexOf(tokensToMove.value);
      if (exactIndex >= 0) return [exactIndex];
      return [
        bitcoinTransferAmounts.value.reduce(
          (selectedIndex, amount, index) => (amount < tokensToMove.value ? index : selectedIndex),
          0,
        ),
      ];
    }
    return maxValue.value === 0n
      ? [0]
      : [BigNumber(tokensToMove.value.toString()).dividedBy(maxValue.value.toString()).multipliedBy(100).toNumber()];
  },
  set: ([percentage]) => {
    if (selectedMoveToken.value === MoveToken.BTC) {
      tokensToMove.value = bitcoinTransferAmounts.value[Math.round(percentage ?? 0)] ?? 0n;
      return;
    }
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
  return bitcoinTransferAmounts.value.at(-1) ?? 0n;
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
  () =>
    [
      isSliding.value,
      tokensToMove.value,
      selectedMoveToken.value,
      destination.value,
      destinationAddress.value,
      bitcoinFeeRatePerSatVb.value,
    ] as const,
  async ([sliding, amount], _oldValues, onCleanup) => {
    feeEstimateError.value = '';
    if (sliding) {
      isEstimatingFees.value = false;
      return;
    }

    if (isBitcoinTransfer.value) {
      feeEstimateWei.value = undefined;
      feeEstimateMicrogon.value = undefined;
      feeEstimateMicronot.value = undefined;
      const channels = selectedBitcoinChannels.value;
      const toScriptPubkey = destinationAddress.value.trim();
      if (amount <= 0n || channels.length === 0 || !toScriptPubkey || bitcoinDestinationError.value) {
        bitcoinFeeEstimate.value = undefined;
        isEstimatingFees.value = false;
        return;
      }

      let cancelled = false;
      onCleanup(() => (cancelled = true));
      isEstimatingFees.value = true;
      try {
        const txSigner = await getWalletKeys().getLiquidLockingKeypair();
        const estimates = await Promise.all(
          channels.map(async channel => {
            const bitcoinFee = await bitcoinLocks.calculateBitcoinNetworkFee(
              channel,
              bitcoinFeeRatePerSatVb.value,
              toScriptPubkey,
            );
            const prepared = await bitcoinLockRelease.prepare({
              utxoId: channel.utxoId!,
              bitcoinNetworkFee: bitcoinFee,
              toScriptPubkey,
              txSigner,
            });
            return { bitcoinFee, prepared };
          }),
        );
        if (!cancelled) {
          const argonFee = estimates.reduce((total, estimate) => total + estimate.prepared.txFeePlusTip, 0n);
          const availableArgons = estimates[0]?.prepared.availableBalance ?? 0n;
          bitcoinFeeEstimate.value = {
            argonFee,
            availableArgons,
            bitcoinFee: estimates.reduce((total, estimate) => total + estimate.bitcoinFee, 0n),
            canAfford: argonFee <= availableArgons,
            networkFees: estimates.map(estimate => estimate.bitcoinFee),
          };
        }
      } catch (error) {
        if (!cancelled) {
          bitcoinFeeEstimate.value = undefined;
          feeEstimateError.value = error instanceof Error ? error.message : 'Unable to estimate the transfer fees.';
        }
      } finally {
        if (!cancelled) isEstimatingFees.value = false;
      }
      return;
    }

    bitcoinFeeEstimate.value = undefined;
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
        feeEstimateError.value = error instanceof Error ? error.message : 'Unable to estimate the transfer fees.';
      }
    } finally {
      if (!cancelled) isEstimatingFees.value = false;
    }
  },
  { immediate: true },
);

Vue.onMounted(async () => {
  try {
    const latestFeeRates = await BitcoinLocks.getFeeRates();
    bitcoinFeeRateOptions.value = Object.entries(latestFeeRates).map(([key, rate]) => ({
      name: `${key.charAt(0).toUpperCase() + key.slice(1)} = ~${rate.estimatedMinutes} min`,
      value: key,
      sats: rate.feeRate,
    }));
  } catch (error) {
    console.warn('Failed to update Bitcoin fee rates, using defaults', error);
  }
});

defineExpose({
  availableAmount,
  bitcoinNetworkFees,
  destinationAddress,
  isReady,
  selectedDestinationWallet,
  selectedBitcoinChannels,
  selectedMoveToken,
  setFormError,
  setMoveToken,
  tokensToMove,
});
</script>
