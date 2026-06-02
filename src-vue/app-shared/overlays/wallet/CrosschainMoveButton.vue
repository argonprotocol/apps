<template>
  <HoverCardRoot :open="isHovered && !!pendingTransfer" :openDelay="0">
    <HoverCardTrigger :asChild="true">
      <button
        :data-testid="getMoveButtonTestId()"
        type="button"
        :disabled="isMoveDisabled"
        class="absolute top-1/2 -right-6 h-10 -translate-y-1/2 cursor-pointer disabled:cursor-default disabled:opacity-40"
        @mouseenter="isHovered = true"
        @mouseleave="isHovered = false"
        @click="openTransferOverlay"
      >
        <div class="absolute top-0 left-0 h-full w-9/12 bg-gradient-to-r from-white to-transparent" />
        <div v-if="isTransferSubmitting" spinner class="absolute top-1/2 right-4 h-5 w-5 -translate-y-1/2 border-3" />
        <div v-else class="text-argon-600 absolute top-1/2 right-4 -translate-y-1/2 text-sm font-bold">MOVE</div>
        <MoveArrow class="pointer-events-none h-full" />
      </button>
    </HoverCardTrigger>

    <HoverCardPortal>
      <HoverCardContent
        v-if="pendingTransfer"
        side="top"
        align="end"
        :sideOffset="12"
        class="pointer-events-none z-[2000] w-[360px] rounded-md border border-slate-300 bg-white px-5 py-4 text-sm text-slate-700 shadow-2xl"
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
            <strong>{{ props.moveToken }}</strong>
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
import ProgressBar from '../../../components/ProgressBar.vue';
import type {
  IArgonWalletType,
  IEthereumInboundTransferState,
  IEthereumMoveToken,
} from '../../../interfaces/IEthereumInboundTransferTracker.ts';
import { hydrateCrosschainTransferProgress } from '../../../lib/CrosschainTransferProgress.ts';
import type { IEthereumOutboundTransferState } from '../../../lib/EthereumOutboundTransferTracker.ts';
import type { IEthereumInboundActiveTransfer } from '../../../lib/EthereumInboundTransferTracker.ts';
import MoveArrow from '../../../assets/move-arrow.svg';
import { formatEvmNativeFeeWei } from '../../../lib/Utils.ts';
import { createNumeralHelpers } from '../../../lib/numeral.ts';
import numeral from '../../../lib/numeral.ts';
import { getCurrency } from '../../../stores/currency.ts';
import { getEthereumMoveTracker } from '../../../stores/moveFromEthereum.ts';
import { getEthereumOutboundTransferTracker } from '../../../stores/moveToEthereum.ts';
import { loadEthereumChainConfig } from '../../../lib/EthereumClient.ts';

const props = defineProps<{
  moveToken: IEthereumMoveToken;
  availableAmount: bigint;
  direction: 'transferToArgon' | 'transferOutOfArgon';
  networkName: string;
  feeTokenSymbol: string;
}>();

const emit = defineEmits<{
  (e: 'openTransferOverlay'): void;
}>();

const currency = getCurrency();
const { microgonToArgonNm, micronotToArgonotNm } = createNumeralHelpers(currency);

type ITransferProgressView = {
  progressPct: number;
  stepLabel: string;
  detail: string;
  hint?: string;
  error: string;
  remainingMintingAuthorizationMicrogons?: bigint;
};

const isHovered = Vue.ref(false);
const hasActiveEthereumTransferConfig = Vue.ref(false);
const progressNow = Vue.ref(Date.now());

let progressRefreshInterval: ReturnType<typeof setInterval> | undefined;

const inboundTransfer = Vue.computed(() => {
  if (props.direction !== 'transferToArgon' || !hasActiveEthereumTransferConfig.value) {
    return;
  }

  const ethereumMoveTracker = getEthereumMoveTracker();
  const transferId = ethereumMoveTracker.data.latestTransferIdByToken[props.moveToken];
  if (!transferId) {
    return;
  }

  const transfer = ethereumMoveTracker.getTransfer(transferId);
  if (!transfer || !isTransferPending(transfer.transferState)) {
    return;
  }

  return transfer;
});

const outboundTransfer = Vue.computed(() => {
  if (props.direction !== 'transferOutOfArgon' || !hasActiveEthereumTransferConfig.value) {
    return;
  }

  const ethereumOutboundTransferTracker = getEthereumOutboundTransferTracker();
  const transfer = ethereumOutboundTransferTracker.getLatestTransfer(props.moveToken);
  if (!transfer || !isTransferPending(transfer.transferState)) {
    return;
  }

  return transfer;
});

const pendingTransfer = Vue.computed(() => outboundTransfer.value ?? inboundTransfer.value);
const isTransferSubmitting = Vue.computed(() => {
  if (!hasActiveEthereumTransferConfig.value) {
    return false;
  }

  if (props.direction === 'transferOutOfArgon') {
    const ethereumOutboundTransferTracker = getEthereumOutboundTransferTracker();
    return ethereumOutboundTransferTracker.getTransferStateForToken(props.moveToken).isSubmitting;
  }

  const ethereumMoveTracker = getEthereumMoveTracker();
  return ethereumMoveTracker.getTransferStateForToken(props.moveToken).isSubmitting;
});
const isMoveDisabled = Vue.computed(() => {
  if (!hasActiveEthereumTransferConfig.value) {
    return true;
  }

  if (props.direction === 'transferOutOfArgon') {
    const ethereumOutboundTransferTracker = getEthereumOutboundTransferTracker();
    const transferState = ethereumOutboundTransferTracker.getTransferStateForToken(props.moveToken);
    return !transferState.hasPersistedTransfer && !transferState.isSubmitting && props.availableAmount <= 0n;
  }

  const ethereumMoveTracker = getEthereumMoveTracker();
  const transferState = ethereumMoveTracker.getTransferStateForToken(props.moveToken);
  return !transferState.hasPersistedTransfer && props.availableAmount <= 0n;
});
const progressView = Vue.computed(() => {
  if (outboundTransfer.value) {
    return getTransferProgressView(outboundTransfer.value.transferState, progressNow.value);
  }
  if (inboundTransfer.value) {
    return getTransferProgressView(inboundTransfer.value.transferState, progressNow.value);
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
  isHovered.value = false;
  emit('openTransferOverlay');
}

async function refreshEthereumTransferConfig() {
  try {
    hasActiveEthereumTransferConfig.value = Boolean(await loadEthereumChainConfig());
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
    case 'investment':
      return 'Argon wallet';
    case 'miningHold':
      return 'Mining wallet';
    case 'vaulting':
      return 'Vaulting wallet';
    default:
      return 'selected wallet';
  }
}

function isTransferPending(transferState: {
  isSubmitting: boolean;
  hasPersistedTransfer: boolean;
  needsAcknowledgement: boolean;
}) {
  return transferState.isSubmitting || transferState.hasPersistedTransfer || transferState.needsAcknowledgement;
}

function getTransferProgressView(
  transferState: IEthereumOutboundTransferState | IEthereumInboundTransferState,
  nowMs: number,
): ITransferProgressView {
  const displayProgress = hydrateCrosschainTransferProgress(transferState.progress.steps, nowMs);
  return {
    progressPct: displayProgress.overallProgressPct,
    stepLabel: displayProgress.currentStepLabel,
    detail: displayProgress.currentStepDetail ?? '',
    hint: displayProgress.currentStepHint,
    remainingMintingAuthorizationMicrogons: displayProgress.currentStepRemainingMintingAuthorizationMicrogons,
    error: transferState.error,
  };
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
