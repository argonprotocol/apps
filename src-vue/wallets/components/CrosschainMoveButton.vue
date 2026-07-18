<template>
  <HoverCardRoot :open="isHovered && !!activeTransfer" :openDelay="0">
    <HoverCardTrigger :asChild="true">
      <button
        :data-testid="getMoveButtonTestId()"
        type="button"
        :aria-disabled="isMoveDisabled"
        :title="isMoveDisabled ? `No ${props.moveToken} available to jump` : `Jump ${props.moveToken}`"
        class="absolute top-1/2 left-[calc(100%+40px)] z-30 h-10 -translate-x-1/2 -translate-y-1/2 cursor-pointer"
        @mouseenter="isHovered = true"
        @mouseleave="isHovered = false"
        @click="openTransferOverlay"
      >
        <div v-if="hasPendingTransfer" spinner class="absolute top-1/2 right-4 h-5 w-5 -translate-y-1/2 border-3" />
        <div v-else class="text-argon-600 absolute inset-0 flex items-center justify-center text-sm font-bold">
          <span class="relative right-1.5">{{ WALLET_JUMP_LABEL }}</span>
        </div>
        <MoveArrow class="pointer-events-none h-full" />
        <ArrowCalloutButton
          v-if="showInboundArgonGuide"
          guidance="Click JUMP to move your Uniswap ARGN into this Argon wallet."
          class="absolute top-1/2 left-full z-50 ml-3 -translate-y-1/2"
        />
      </button>
    </HoverCardTrigger>

    <HoverCardPortal>
      <HoverCardContent
        v-if="activeTransfer"
        side="top"
        align="end"
        :sideOffset="12"
        :style="floatingZIndex"
        class="pointer-events-none w-[360px] rounded-md border border-slate-300 bg-white px-5 py-4 text-sm text-slate-700 shadow-2xl"
      >
        <div class="flex flex-col gap-4">
          <div class="text-xl font-bold">
            {{
              props.direction === 'transferOutOfArgon'
                ? `Move To ${props.networkName}`
                : `Move From ${props.networkName}`
            }}
          </div>

          <p v-if="outboundTransfer" class="font-light text-slate-700">
            Moving
            <strong>{{ formatTokenAmount(outboundTransfer.transferState.amount ?? 0n) }} {{ props.moveToken }}</strong>
            from your
            <strong>{{ getArgonWalletLabel(outboundTransfer.transferState.sourceWalletType) }}</strong>
            to your
            <strong>{{ props.networkName }}</strong>
            wallet.
          </p>

          <p v-else-if="inboundTransfer" class="font-light text-slate-700">
            Moving
            <strong>{{ formatTokenAmount(inboundTransfer.transferState.amount) }} {{ props.moveToken }}</strong>
            from your
            <strong>{{ props.networkName }}</strong>
            wallet into your
            <strong>{{ getArgonWalletLabel(inboundTransfer.transferState.targetWalletType) }}</strong>
            .
          </p>

          <div class="text-argon-700 text-center text-4xl font-bold">
            {{ numeral(progressView.progressPct).format('0.00') }}%
          </div>

          <ProgressBar
            :progress="progressView.progressPct"
            :hasError="!!progressView.error"
            :showLabel="false"
            class="h-4"
          />

          <div class="text-center font-medium text-slate-700">
            {{ progressView.stepLabel }}
          </div>

          <div class="text-center font-light text-slate-500">
            {{ progressView.detail }}
            <template v-if="progressView.remainingMintingAuthorizationMicrogons">
              (
              {{
                microgonToArgonNm(progressView.remainingMintingAuthorizationMicrogons).formatIfElse(
                  '< 1_000',
                  '0,0.00',
                  '0,0',
                )
              }}
              ARGN remaining)
            </template>
          </div>

          <div v-if="progressView.hint" class="text-center text-xs font-light text-slate-500">
            {{ progressView.hint }}
          </div>

          <div
            v-if="outboundTransfer?.transferState.ethereumFeeEstimateWei != null"
            class="rounded-md border border-slate-200 bg-slate-50 px-3 py-2 text-xs text-slate-600"
          >
            Estimated network fee:
            <strong>
              {{ formatEvmNativeFeeWei(outboundTransfer.transferState.ethereumFeeEstimateWei) }}
              {{ props.feeTokenSymbol }}
            </strong>
          </div>

          <div
            v-if="progressView.error"
            class="min-w-0 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm leading-5 [overflow-wrap:anywhere] break-words whitespace-pre-wrap text-red-700"
          >
            {{ progressView.error }}
          </div>
        </div>

        <HoverCardArrow :width="26" :height="12" class="-mt-px fill-white stroke-slate-300" />
      </HoverCardContent>
    </HoverCardPortal>
  </HoverCardRoot>
</template>

<script setup lang="ts">
import * as Vue from 'vue';
import { MoveToken } from '@argonprotocol/apps-core';
import { HoverCardArrow, HoverCardContent, HoverCardPortal, HoverCardRoot, HoverCardTrigger } from 'reka-ui';
import ProgressBar from '../../components/ProgressBar.vue';
import type { IArgonWalletType, IEthereumMoveToken } from '../../interfaces/IEthereumInboundTransferTracker.ts';
import type { IEthereumInboundActiveTransfer } from '../../lib/EthereumInboundTransferTracker.ts';
import { useFloatingZIndex } from '../../overlays/helpers/OverlayZIndex.ts';
import MoveArrow from '../../assets/move-arrow.svg';
import { formatEvmNativeFeeWei } from '../../lib/Utils.ts';
import { createNumeralHelpers } from '../../lib/numeral.ts';
import numeral from '../../lib/numeral.ts';
import { getConfig } from '../../stores/config.ts';
import { getCurrency } from '../../stores/currency.ts';
import { getEthereumMoveTracker } from '../../stores/moveFromEthereum.ts';
import { getEthereumOutboundTransferTracker } from '../../stores/moveToEthereum.ts';
import { loadEthereumChainConfig } from '../../lib/EthereumClient.ts';
import { WALLET_JUMP_LABEL } from '../walletOverlayState.ts';
import {
  getCrosschainTransferProgressView,
  isCrosschainTransferVisible,
  isCrosschainTransferPending,
  type ITransferProgressView,
} from './crosschainTransferView.ts';
import ArrowCalloutButton from '../../components/ArrowCalloutButton.vue';
import { useCertificationController } from '../../stores/certificationController.ts';

const props = defineProps<{
  moveToken: IEthereumMoveToken;
  availableAmount: bigint;
  direction: 'transferToArgon' | 'transferOutOfArgon';
  networkName: string;
  feeTokenSymbol: string;
}>();
const config = getConfig();
const controller = useCertificationController();

const emit = defineEmits<{
  (e: 'openTransferOverlay'): void;
}>();

const currency = getCurrency();
const { microgonToArgonNm, micronotToArgonotNm } = createNumeralHelpers(currency);

const isHovered = Vue.ref(false);
const floatingZIndex = useFloatingZIndex();
const hasActiveEthereumTransferConfig = Vue.ref(false);
const progressNow = Vue.ref(Date.now());

let progressRefreshInterval: ReturnType<typeof setInterval> | undefined;

const inboundTransfer = Vue.computed(() => {
  if (props.direction !== 'transferToArgon') {
    return;
  }

  const ethereumMoveTracker = getEthereumMoveTracker();
  const transferId = ethereumMoveTracker.data.latestTransferIdByToken[props.moveToken];
  if (!transferId) {
    return;
  }

  const transfer = ethereumMoveTracker.getTransfer(transferId);
  if (!transfer || !isCrosschainTransferVisible(transfer.transferState)) {
    return;
  }

  return transfer;
});

const outboundTransfer = Vue.computed(() => {
  if (props.direction !== 'transferOutOfArgon') {
    return;
  }

  const ethereumOutboundTransferTracker = getEthereumOutboundTransferTracker();
  const transfer = ethereumOutboundTransferTracker.getLatestTransfer(props.moveToken);
  if (!transfer || !isCrosschainTransferVisible(transfer.transferState)) {
    return;
  }

  return transfer;
});

const activeTransfer = Vue.computed(() => outboundTransfer.value ?? inboundTransfer.value);
const hasVisibleTransfer = Vue.computed(() => !!activeTransfer.value);
const hasPendingTransfer = Vue.computed(() => isCrosschainTransferPending(activeTransfer.value?.transferState));
const isMoveDisabled = Vue.computed(() => {
  if (!hasActiveEthereumTransferConfig.value && !hasVisibleTransfer.value) {
    return true;
  }

  if (props.direction === 'transferOutOfArgon') {
    const ethereumOutboundTransferTracker = getEthereumOutboundTransferTracker();
    const transferState = ethereumOutboundTransferTracker.getTransferStateForToken(props.moveToken);
    return (
      !hasVisibleTransfer.value &&
      !transferState.hasPersistedTransfer &&
      !transferState.isSubmitting &&
      props.availableAmount <= 0n
    );
  }

  const ethereumMoveTracker = getEthereumMoveTracker();
  const transferState = ethereumMoveTracker.getTransferStateForToken(props.moveToken);
  return (
    !hasVisibleTransfer.value &&
    !transferState.hasPersistedTransfer &&
    !transferState.isSubmitting &&
    props.availableAmount <= 0n
  );
});
const showInboundArgonGuide = Vue.computed(() => {
  return (
    props.direction === 'transferToArgon' && props.moveToken === MoveToken.ARGN && controller.isTransferGuideActive
  );
});
const progressView = Vue.computed(() => {
  if (activeTransfer.value) {
    return getCrosschainTransferProgressView(activeTransfer.value.transferState, progressNow.value);
  }

  return { progressPct: 0, stepLabel: '', detail: '', error: '' } satisfies ITransferProgressView;
});
const refreshEthereumTransferConfigOnFocus = () => {
  void refreshEthereumTransferConfig();
};

Vue.onUnmounted(() => {
  if (progressRefreshInterval) {
    clearInterval(progressRefreshInterval);
  }
  window.removeEventListener('focus', refreshEthereumTransferConfigOnFocus);
});

Vue.onMounted(() => {
  void refreshEthereumTransferConfig();
  progressRefreshInterval = setInterval(() => {
    progressNow.value = Date.now();
  }, 1_000);
  window.addEventListener('focus', refreshEthereumTransferConfigOnFocus);
});

function openTransferOverlay() {
  if (isMoveDisabled.value) {
    return;
  }

  isHovered.value = false;
  emit('openTransferOverlay');
}

async function refreshEthereumTransferConfig() {
  try {
    hasActiveEthereumTransferConfig.value = Boolean(await loadEthereumChainConfig(config.ethereumExecutionRpcUrl));
  } catch (error) {
    console.warn('[CrosschainMoveButton] Unable to load Ethereum chain config', error);
    hasActiveEthereumTransferConfig.value = false;
  }
}

function getMoveButtonTestId() {
  return props.direction === 'transferToArgon'
    ? `EthereumTop.startMoveFromEthereum(${props.moveToken})`
    : `ArgonTop.startMoveToEthereum(${props.moveToken})`;
}

function formatTokenAmount(value: bigint) {
  return props.moveToken === MoveToken.ARGNOT
    ? micronotToArgonotNm(value).format('0,0.[00]')
    : microgonToArgonNm(value).format('0,0.[00]');
}

function getArgonWalletLabel(walletType?: IArgonWalletType) {
  switch (walletType) {
    case 'defaultArgon':
      return 'Argon wallet';
    default:
      return 'selected wallet';
  }
}
</script>

<style>
[spinner] {
  border-radius: 50%;
  display: block;
  border-style: solid;
  border-color: rgba(166, 0, 212, 0.15) rgba(166, 0, 212, 0.25) rgba(166, 0, 212, 0.35) rgba(166, 0, 212, 0.5);
  animation: rotation 1s linear infinite;
}

@keyframes rotation {
  0% {
    transform: translateY(-50%) rotate(0deg);
  }
  100% {
    transform: translateY(-50%) rotate(360deg);
  }
}
</style>
