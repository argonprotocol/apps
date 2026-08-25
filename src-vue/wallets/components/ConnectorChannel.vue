<template>
  <PopoverRoot :open="props.open" :modal="true" @update:open="emit('update:open', $event)">
    <PopoverTrigger asChild>
      <slot />
    </PopoverTrigger>
    <PopoverPortal>
      <PopoverContent
        side="bottom"
        :align="props.direction === 'left' ? 'start' : 'end'"
        :alignOffset="-150"
        :sideOffset="-20"
        :collisionPadding="30"
        :style="floatingZIndex"
        class="w-108 rounded-lg shadow-2xl"
        @pointerDownOutside="keepOpenForRelatedConnector"
      >
        <div
          class="flex max-h-[var(--reka-popover-content-available-height)] flex-col rounded-lg border border-black/50 bg-white text-left text-gray-700"
        >
          <h2
            class="z-20 mx-1 flex items-center gap-x-2.5 border-b border-slate-400/50 pt-3 pr-3 pb-2 pl-2 select-none"
          >
            <span class="min-w-0 grow px-1 text-xl font-bold text-slate-800/70">
              {{ displayedChannel ? 'Bitcoin Channel' : 'Create Bitcoin Channel' }}
            </span>
            <ButtonClose @close="emit('update:open', false)" />
          </h2>
          <div v-if="!config.hasExtensionTreasury" class="min-h-48 px-5 py-4">
            This feature requires access to Treasury.
          </div>
          <div v-else-if="isLoadingChannels" class="flex min-h-48 items-center justify-center px-5 py-4 text-slate-500">
            Loading Bitcoin channels...
          </div>
          <div v-else-if="channelLoadError" class="min-h-48 px-5 py-4">
            <div class="flex items-start gap-2 rounded-md bg-amber-50 px-3 py-3 text-sm text-amber-800">
              <AlertIcon class="mt-0.5 h-4 shrink-0" />
              <span>{{ channelLoadError }}</span>
            </div>
            <button
              class="border-argon-600 text-argon-600 mt-5 cursor-pointer rounded-lg border px-5 py-1"
              @click="loadChannels()"
            >
              Retry
            </button>
          </div>
          <div v-else-if="isCreatingChannel" class="min-h-48 px-5 py-7 text-center">
            <div class="text-lg font-semibold text-slate-700">Creating your Bitcoin channel</div>
            <div class="mt-1 text-sm text-slate-500">Preparing the Bitcoin channel request...</div>
            <ProgressBar :progress="0" class="mt-5 h-5" />
            <div class="mt-3 text-xs text-slate-400">You can close this window while the request continues.</div>
          </div>
          <div v-else-if="displayedChannel" class="min-h-48 px-5 py-4">
            <div v-if="channelDisplayError" class="flex flex-col gap-4">
              <div class="flex items-start gap-2 rounded-md bg-amber-50 px-3 py-3 text-sm text-amber-800">
                <AlertIcon class="mt-0.5 h-4 shrink-0" />
                <span>{{ channelDisplayError }}</span>
              </div>
              <button
                class="border-argon-600 text-argon-600 cursor-pointer rounded-lg border px-5 py-1"
                @click="showChannelForm"
              >
                Create Another Channel
              </button>
            </div>
            <div v-else-if="isArgonChannelProcessing" class="py-3 text-center">
              <div class="text-lg font-semibold text-slate-700">Creating your Bitcoin channel</div>
              <div class="mt-1 text-sm text-slate-500">{{ channelProgressLabel }}</div>
              <ProgressBar :progress="channelProgress.progressPct" class="mt-5 h-5" />
              <div class="mt-3 text-xs text-slate-400">You can close this window while the transaction continues.</div>
            </div>
            <div v-else class="flex flex-col items-center py-2 text-center">
              <div class="text-lg font-semibold text-slate-700">
                {{ channelHasObservedFunding ? 'Bitcoin funding detected' : 'Your Bitcoin channel is ready' }}
              </div>
              <div class="bg-argon-100/30 text-argon-900/80 mt-2 flex items-center rounded-full py-1 pr-3 pl-1 text-sm">
                <ClockIcon class="h-4" />
                <span class="mr-1">Funding window:</span>
                <CountdownClock :time="channelFundingExpirationTime" v-slot="{ days, hours, minutes, seconds }">
                  <template v-if="days > 0">{{ days }} day{{ days === 1 ? '' : 's' }}</template>
                  <template v-if="days || hours">{{ hours }}h</template>
                  <template v-else>{{ minutes }}m {{ seconds }}s</template>
                </CountdownClock>
              </div>
              <div class="mt-1 text-sm text-slate-500">
                {{
                  channelHasObservedFunding
                    ? channelProgressLabel
                    : 'Send Bitcoin to this address before the funding window expires.'
                }}
              </div>
              <div class="mt-5 flex w-full items-center gap-2 rounded-md border border-slate-300 bg-slate-50 px-3 py-2">
                <span class="min-w-0 grow truncate text-left font-mono text-xs">{{ channelFundingAddress }}</span>
                <ButtonCopy :address="channelFundingAddress" />
              </div>
              <ProgressBar v-if="channelHasObservedFunding" :progress="channelProgress.progressPct" class="mt-5 h-5" />
            </div>
          </div>
          <div v-else class="min-h-48 px-5 py-4">
            <div
              v-if="previousFundedChannel"
              class="border-argon-300/60 bg-argon-50 mb-4 rounded-md border px-3 py-3 text-sm text-slate-600"
            >
              Bitcoin funding is still being confirmed for a previous channel.
              <button class="text-argon-600 ml-1 cursor-pointer font-semibold" @click="showPreviousChannel">
                View channel &rarr;
              </button>
            </div>
            <p class="text-md font-light">
              Argon uses channel mechanisms to maintain security when sending BTC into the network.
              <a href="">Learn more</a>
              .
            </p>

            <div class="mt-4 flex flex-col">
              <label class="mb-1 font-bold text-gray-500/80">
                Cosigner
                <span class="font-light">(change)</span>
              </label>
              <div
                class="relative grow truncate rounded-md border border-slate-900/20 px-2 py-1.5 whitespace-nowrap text-gray-500/80"
              >
                {{ myVault.vaultId ? 'My Vault' : upstreamOperatorName }}
                <InfoIcon
                  class="text-argon-600/30 hover:text-argon-600 absolute top-1/2 right-2 w-4 -translate-y-1/2"
                />
              </div>
            </div>

            <div class="relative mt-4 flex flex-col">
              <div class="flex flex-row items-center">
                <label class="mb-1 grow font-bold text-gray-500/80">Desired BTC Insurance</label>
                <a href="" class="text-sm opacity-50 hover:opacity-100">Info</a>
              </div>
              <InputToken v-model="insuranceAmount" :min="0n" :max="maxValue" :maxDecimals="2" />
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
                <span>{{ currency.symbol }}0</span>
                <span>{{ currency.symbol }}{{ microgonToArgonNm(maxValue).format('0,0.[00]') }}</span>
              </div>
            </div>
            <div class="mt-6 flex flex-col gap-x-3">
              <label class="mb-1 font-bold text-gray-500/80">Cost of Channel</label>
              <div class="border-b border-gray-300 text-sm">
                <div class="flex flex-row border-t border-gray-300 py-2">
                  <div class="grow">Insurance Fee</div>
                  <div class="relative">
                    <span>{{ currency.symbol }}{{ microgonToMoneyNm(btcLockingCost).format('0,0.00') }}</span>
                  </div>
                </div>
              </div>
            </div>

            <div v-if="formError" class="mt-5 text-sm text-amber-700">{{ formError }}</div>
            <div class="mt-8 mb-2 flex flex-row gap-x-2">
              <button
                v-if="!isCreatingChannel"
                class="border-argon-600 text-argon-600 cursor-pointer rounded-lg border px-5 py-1"
                @click="emit('update:open', false)"
              >
                Cancel
              </button>
              <button
                :disabled="isCreatingChannel || !insuranceAmount || !defaultVault"
                class="border-argon-700 bg-argon-600 grow cursor-pointer rounded-lg border px-5 py-1 text-white disabled:cursor-default disabled:border-gray-400 disabled:bg-gray-300 disabled:text-gray-500"
                @click="createChannel"
              >
                {{ isCreatingChannel ? 'Creating Channel...' : `Create Channel` }} &raquo;
              </button>
            </div>
          </div>
        </div>
        <PopoverArrow :width="26" :height="12" class="-mt-px fill-white stroke-gray-800/40 stroke-[0.5]" />
      </PopoverContent>
    </PopoverPortal>
  </PopoverRoot>
</template>

<script setup lang="ts">
import {
  PopoverArrow,
  PopoverContent,
  PopoverPortal,
  PopoverRoot,
  PopoverTrigger,
  type PointerDownOutsideEvent,
  SliderTrack,
  SliderThumb,
  SliderRoot,
  SliderRange,
} from 'reka-ui';
import { useFloatingZIndex } from '../../overlays/helpers/OverlayZIndex.ts';
import ButtonClose from './ButtonClose.vue';
import ButtonCopy from './ButtonCopy.vue';
import InputToken from '../../components/InputToken.vue';
import CountdownClock from '../../components/CountdownClock.vue';
import * as Vue from 'vue';
import BigNumber from 'bignumber.js';
import dayjs from 'dayjs';
import utc from 'dayjs/plugin/utc';
import { bigNumberToBigInt, type Vault } from '@argonprotocol/apps-core';
import { BitcoinLockStatus } from '../../interfaces/IBitcoinLockRecord.ts';
import { createNumeralHelpers } from '../../lib/numeral.ts';
import type { WalletForBitcoin } from '../../lib/WalletForBitcoin.ts';
import { getCurrency } from '../../stores/currency.ts';
import InfoIcon from '../../assets/info.svg';
import { getConfig } from '../../stores/config.ts';
import { getMyVault, getVaults } from '../../stores/vaults.ts';
import AlertIcon from '../../assets/alert.svg?component';
import ClockIcon from '../../assets/clock.svg?component';
import ProgressBar from '../../components/ProgressBar.vue';
import { getBitcoinLocks } from '../../stores/bitcoin.ts';

dayjs.extend(utc);

const props = defineProps<{
  connectorId?: string;
  direction: 'right' | 'left';
  open: boolean;
  wallet: WalletForBitcoin;
}>();

const emit = defineEmits<{
  (event: 'update:open', value: boolean): void;
}>();

const currency = getCurrency();
const floatingZIndex = useFloatingZIndex();
const config = getConfig();
const myVault = getMyVault();
const vaults = getVaults();
const bitcoinLocks = getBitcoinLocks();

const { microgonToArgonNm, microgonToMoneyNm } = createNumeralHelpers(currency);

const isSliding = Vue.ref(false);
const insuranceAmount = Vue.ref(0n);
const maxValue = Vue.ref(0n);
const isCreatingChannelRequest = Vue.ref(false);
const isLoadingChannels = Vue.ref(false);
const channelLoadError = Vue.ref('');
const formError = Vue.ref('');
const sessionChannelUuid = Vue.ref<string>();
const progressNow = Vue.ref(Date.now());
let channelSessionKey = 0;
let progressRefreshInterval: ReturnType<typeof setInterval> | undefined;

const sliderValue = Vue.computed<number[]>({
  get: () =>
    maxValue.value === 0n
      ? [0]
      : [BigNumber(insuranceAmount.value.toString()).dividedBy(maxValue.value.toString()).multipliedBy(100).toNumber()],
  set: ([percentage]) => {
    insuranceAmount.value = bigNumberToBigInt(
      BigNumber(maxValue.value.toString())
        .multipliedBy(percentage ?? 0)
        .dividedBy(100),
    );
  },
});

const upstreamOperatorName = Vue.computed(() => {
  const upstreamOperator = config.upstreamOperator;
  return upstreamOperator?.name || 'Unnamed';
});

const defaultVault = Vue.computed(() => {
  const vaultId = myVault.vaultId;
  if (vaultId) return vaults.vaultsById[vaultId] ?? myVault.createdVault;

  const upstreamVaultId = config.upstreamOperator?.vaultId;
  if (upstreamVaultId) return vaults.vaultsById[upstreamVaultId];
});
const latestActiveChannel = Vue.computed(() => {
  const vaultId = defaultVault.value?.vaultId;
  return vaultId == null ? undefined : props.wallet.getLatestActiveChannel(vaultId);
});
const previousFundedChannel = Vue.computed(() => {
  progressNow.value;
  const vaultId = defaultVault.value?.vaultId;
  return vaultId == null ? undefined : props.wallet.getLatestFundedUnexpiredChannel(vaultId);
});
const displayedChannel = Vue.computed(() => {
  const uuid = sessionChannelUuid.value;
  return uuid ? props.wallet.getChannel(uuid) : undefined;
});
const isArgonChannelProcessing = Vue.computed(
  () => displayedChannel.value?.status === BitcoinLockStatus.LockIsProcessingOnArgon,
);
const channelHasObservedFunding = Vue.computed(() => {
  const channel = displayedChannel.value;
  return channel ? props.wallet.hasObservedChannelFunding(channel) : false;
});
const channelProgress = Vue.computed(() => {
  progressNow.value;
  const channel = displayedChannel.value;
  return channel
    ? props.wallet.getChannelProgress(channel)
    : { progressPct: 0, confirmations: -1, expectedConfirmations: 0 };
});
const channelFundingAddress = Vue.computed(() => {
  const channel = displayedChannel.value;
  if (!channel || isArgonChannelProcessing.value || channel.status === BitcoinLockStatus.LockFailed) return '';
  try {
    return props.wallet.getChannelFundingAddress(channel);
  } catch {
    return '';
  }
});
const channelFundingExpirationTime = Vue.computed(() => {
  const channel = displayedChannel.value;
  return channel ? dayjs.utc(bitcoinLocks.verifyExpirationTime(channel)) : dayjs.utc();
});
const channelDisplayError = Vue.computed(() => {
  const channel = displayedChannel.value;
  if (!channel) return '';
  const error = props.wallet.getChannelError(channel);
  if (error) return error;
  if (!isArgonChannelProcessing.value && !channelFundingAddress.value) {
    return 'Unable to load the Bitcoin funding address for this channel.';
  }
  return '';
});
const channelProgressLabel = Vue.computed(() => {
  const { confirmations, expectedConfirmations } = channelProgress.value;
  if (isArgonChannelProcessing.value) {
    if (confirmations < 0 || expectedConfirmations <= 0) return 'Submitting to the Argon network...';
    return `Argon confirmation ${Math.min(confirmations + 1, expectedConfirmations)} of ${expectedConfirmations}`;
  }
  if (confirmations < 0) return 'Detected in the Bitcoin mempool. Waiting for the first confirmation...';
  if (expectedConfirmations <= 0) return 'Bitcoin funding detected.';
  return `Bitcoin confirmation ${Math.min(confirmations + 1, expectedConfirmations)} of ${expectedConfirmations}`;
});
const btcLockingCost = Vue.computed(() => {
  const vault = defaultVault.value;
  if (!vault || insuranceAmount.value <= 0n) return 0n;
  return vault.calculateBitcoinFee(insuranceAmount.value);
});
const isCreatingChannel = Vue.computed(() => {
  const vaultId = defaultVault.value?.vaultId;
  return isCreatingChannelRequest.value || (vaultId != null && props.wallet.isCreatingChannel(vaultId));
});

Vue.watch(defaultVault, (vault, _, onCleanup) => void updateMaximumInsurance(vault, onCleanup), { immediate: true });
Vue.watch(
  () => [props.open, defaultVault.value?.vaultId] as const,
  ([open], _, onCleanup) => {
    const sessionKey = ++channelSessionKey;
    if (!open) {
      sessionChannelUuid.value = undefined;
      formError.value = '';
      return;
    }
    void loadChannels(sessionKey, onCleanup);
  },
  { immediate: true },
);
Vue.watch(
  latestActiveChannel,
  channel => {
    if (props.open && !sessionChannelUuid.value && channel) sessionChannelUuid.value = channel.uuid;
  },
  { immediate: true },
);

async function loadChannels(sessionKey = channelSessionKey, onCleanup?: (cleanup: () => void) => void): Promise<void> {
  let cancelled = false;
  onCleanup?.(() => (cancelled = true));
  isLoadingChannels.value = true;
  channelLoadError.value = '';
  try {
    await props.wallet.loadChannels();
    if (cancelled || sessionKey !== channelSessionKey || !props.open) return;
    sessionChannelUuid.value = latestActiveChannel.value?.uuid;
  } catch (error) {
    if (!cancelled && sessionKey === channelSessionKey) {
      channelLoadError.value = error instanceof Error ? error.message : 'Unable to load Bitcoin channels.';
    }
  } finally {
    if (!cancelled && sessionKey === channelSessionKey) isLoadingChannels.value = false;
  }
}

async function updateMaximumInsurance(vault: Vault | undefined, onCleanup: (cleanup: () => void) => void) {
  maxValue.value = 0n;
  if (!vault) return;

  let cancelled = false;
  onCleanup(() => (cancelled = true));

  try {
    const availableLiquidityMicrogons = await props.wallet.getMaximumChannelLiquidity(vault);
    if (cancelled) return;

    maxValue.value = availableLiquidityMicrogons;
    if (insuranceAmount.value > availableLiquidityMicrogons) {
      insuranceAmount.value = availableLiquidityMicrogons;
    }
  } catch (error) {
    if (!cancelled) console.warn('Unable to load the Bitcoin channel capacity:', error);
  }
}

async function createChannel() {
  const vault = defaultVault.value;
  const liquidityMicrogons = insuranceAmount.value;
  if (!vault || liquidityMicrogons <= 0n || isCreatingChannel.value) return;

  const sessionKey = channelSessionKey;
  isCreatingChannelRequest.value = true;
  formError.value = '';
  try {
    const channel = await props.wallet.createChannel({ vault, liquidityMicrogons });
    if (props.open && sessionKey === channelSessionKey) sessionChannelUuid.value = channel.uuid;
  } catch (error) {
    if (props.open && sessionKey === channelSessionKey) {
      formError.value = error instanceof Error ? error.message : 'Unable to create the Bitcoin channel.';
    }
  } finally {
    isCreatingChannelRequest.value = false;
  }
}

function showPreviousChannel() {
  const channel = previousFundedChannel.value;
  if (channel) sessionChannelUuid.value = channel.uuid;
}

function showChannelForm() {
  sessionChannelUuid.value = undefined;
}

function keepOpenForRelatedConnector(event: PointerDownOutsideEvent) {
  const target = event.detail.originalEvent.target;
  if (!(target instanceof Element)) return;

  const connectorId = target.closest('[data-wallet-connector-id]')?.getAttribute('data-wallet-connector-id');
  if (connectorId && connectorId === props.connectorId) event.preventDefault();
}

Vue.onMounted(() => {
  progressRefreshInterval = setInterval(() => (progressNow.value = Date.now()), 1_000);
});

Vue.onUnmounted(() => {
  if (progressRefreshInterval) clearInterval(progressRefreshInterval);
});
</script>
