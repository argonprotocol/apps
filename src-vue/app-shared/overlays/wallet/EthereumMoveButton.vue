<template>
  <PopoverRoot :open="isOpen" @update:open="onOpenChange">
    <PopoverTrigger :asChild="true">
      <button
        :data-testid="`EthereumTop.startMoveFromEthereum(${props.moveToken})`"
        type="button"
        :disabled="isMoveDisabled"
        class="absolute top-1/2 -right-6 h-10 -translate-y-1/2 cursor-pointer disabled:cursor-default disabled:opacity-40"
        @click="startMove"
      >
        <div class="absolute top-0 left-0 h-full w-9/12 bg-gradient-to-r from-white to-transparent" />
        <div v-if="isTransferSubmitting" spinner class="absolute top-1/2 right-4 h-5 w-5 -translate-y-1/2 border-3" />
        <div v-else class="text-argon-600 absolute top-1/2 right-4 -translate-y-1/2 text-sm font-bold">MOVE</div>
        <MoveArrow class="pointer-events-none h-full" />
      </button>
    </PopoverTrigger>
    <PopoverPortal>
      <PopoverContent
        v-if="isOpen && activeTransfer"
        side="top"
        align="end"
        :sideOffset="12"
        class="z-[2000] w-[360px] rounded-md border border-slate-300 bg-white px-5 py-4 text-sm text-slate-700 shadow-2xl"
      >
        <div class="flex flex-col gap-4">
          <div class="text-xl font-bold">Move From Ethereum</div>

          <p class="font-light text-slate-700">
            Moving
            <strong>{{ activeTransfer.moveToken }}</strong>
            into your
            <strong>{{ getTargetWalletLabel(activeTransfer.transferState.targetWalletType) }}</strong>
            .
          </p>

          <p class="font-light text-slate-500 italic">You can close this panel without disrupting the process.</p>

          <div class="text-argon-700 text-center text-4xl font-bold">
            {{ numeral(transferView.progressPct).format('0.00') }}%
          </div>

          <ProgressBar
            :progress="transferView.progressPct"
            :hasError="!!transferView.error"
            :showLabel="false"
            class="h-4"
          />

          <div class="text-center font-light text-slate-500">{{ transferView.progressLabel }}</div>

          <div
            v-if="transferView.error"
            class="min-w-0 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm leading-5 [overflow-wrap:anywhere] break-words whitespace-pre-wrap text-red-700"
          >
            {{ transferView.error }}
          </div>

          <div v-if="!activeTransfer.transferState.isSubmitting" class="flex justify-end">
            <button
              data-testid="EthereumMoveOverlay.close()"
              type="button"
              class="bg-argon-button hover:bg-argon-button-hover rounded-md px-4 py-2 text-sm font-semibold text-white"
              @click="closePopover()"
            >
              Done
            </button>
          </div>
        </div>
        <PopoverArrow :width="26" :height="12" class="-mt-px fill-white stroke-slate-300" />
      </PopoverContent>
    </PopoverPortal>
  </PopoverRoot>
</template>

<script setup lang="ts">
import * as Vue from 'vue';
import { MoveToken } from '@argonprotocol/apps-core';
import { MINTING_GATEWAY_RUNTIME_TO_ERC20_SCALE } from '@argonprotocol/mainchain';
import { PopoverArrow, PopoverContent, PopoverPortal, PopoverRoot, PopoverTrigger } from 'reka-ui';
import ProgressBar from '../../../components/ProgressBar.vue';
import {
  type IEthereumInboundActiveTransfer,
  type IEthereumInboundTransferState,
} from '../../../lib/EthereumInboundTransferTracker.ts';
import { WalletType } from '../../../lib/Wallet.ts';
import numeral from '../../../lib/numeral.ts';
import { getEthereumMoveTracker } from '../../../stores/moveFromEthereum.ts';
import MoveArrow from '../../../assets/move-arrow.svg';

const props = defineProps<{
  moveToken: MoveToken.ARGN | MoveToken.ARGNOT;
  availableAmount: bigint;
  open?: boolean;
  targetWalletType?: WalletType.investment | WalletType.miningHold | WalletType.vaulting;
}>();

const emit = defineEmits<{
  (e: 'update:open', value: boolean): void;
}>();

const ethereumMoveTracker = getEthereumMoveTracker();
const activeTransferId = Vue.ref<string>();
const activeTransfer = Vue.computed(() =>
  activeTransferId.value ? ethereumMoveTracker.getTransfer(activeTransferId.value) : undefined,
);
const isOpen = Vue.computed(() => !!props.open && !!activeTransfer.value);
const isTransferSubmitting = Vue.computed(
  () => ethereumMoveTracker.getTransferStateForToken(props.moveToken).isSubmitting,
);
const isMoveDisabled = Vue.computed(() => {
  const transferState = ethereumMoveTracker.getTransferStateForToken(props.moveToken);
  return !transferState.hasPersistedTransfer && props.availableAmount <= 0n;
});

const currentTimeMs = Vue.ref(Date.now());
const transferView = Vue.computed(() => getTransferProgressView(activeTransfer.value, currentTimeMs.value));

let progressTimer: ReturnType<typeof setInterval> | undefined;

Vue.watch(
  () => props.open,
  isOpen => {
    if (!isOpen && activeTransferId.value) {
      closePopover(false);
    }
  },
);

Vue.watch(
  () => activeTransfer.value?.transferState.argonReadiness?.pollMs,
  () => {
    const pollMs =
      activeTransfer.value?.transferState.phase === 'confirmingArgon'
        ? activeTransfer.value.transferState.argonReadiness?.pollMs
        : undefined;

    if (!pollMs) {
      clearProgressTimer();
      return;
    }

    currentTimeMs.value = Date.now();
    clearProgressTimer();
    progressTimer = setInterval(() => {
      currentTimeMs.value = Date.now();
    }, pollMs);
  },
  { immediate: true },
);

Vue.onUnmounted(() => {
  clearProgressTimer();
});

async function startMove() {
  if (!props.targetWalletType) {
    return;
  }

  const transfer = await ethereumMoveTracker.startMove({
    moveToken: props.moveToken,
    amountBaseUnits: props.availableAmount * MINTING_GATEWAY_RUNTIME_TO_ERC20_SCALE,
    targetWalletType: props.targetWalletType,
  });

  if (!transfer) {
    return;
  }

  activeTransferId.value = transfer.transferId;
  emit('update:open', true);
}

function onOpenChange(isOpen: boolean) {
  if (isOpen) {
    return;
  }

  closePopover();
}

function closePopover(shouldEmit = true) {
  const transferId = activeTransferId.value;
  activeTransferId.value = undefined;
  if (shouldEmit) {
    emit('update:open', false);
  }

  if (transferId) {
    ethereumMoveTracker.clearCompletedTransfer(transferId);
  }
}

function clearProgressTimer() {
  if (!progressTimer) {
    return;
  }

  clearInterval(progressTimer);
  progressTimer = undefined;
}

function getTargetWalletLabel(targetWalletType?: WalletType.investment | WalletType.miningHold | WalletType.vaulting) {
  switch (targetWalletType) {
    case WalletType.investment:
      return 'Argon wallet';
    case WalletType.miningHold:
      return 'Mining wallet';
    case WalletType.vaulting:
      return 'Vaulting wallet';
    default:
      return 'selected wallet';
  }
}

function getTransferProgressView(
  transfer: IEthereumInboundActiveTransfer | undefined,
  currentTimeMs: number,
): { progressPct: number; progressLabel: string; error: string } {
  if (!transfer) {
    return { progressPct: 0, progressLabel: '', error: '' };
  }

  const { transferState } = transfer;
  return {
    progressPct: getTransferProgressPct(transferState, currentTimeMs),
    progressLabel: getTransferProgressLabel(transferState),
    error: transferState.error,
  };
}

function getTransferProgressPct(transferState: IEthereumInboundTransferState, currentTimeMs: number): number {
  switch (transferState.phase) {
    case 'preparing':
      return 5;
    case 'confirmingEthereum':
      return 30;
    case 'confirmingArgon':
      return getArgonConfirmationProgress(transferState.argonReadiness, currentTimeMs);
    case 'confirmedOnArgon':
      return 100;
    default:
      return 0;
  }
}

function getTransferProgressLabel(transferState: IEthereumInboundTransferState): string {
  switch (transferState.phase) {
    case 'preparing':
      return 'Preparing transfer...';
    case 'confirmingEthereum':
      return 'Confirming on Ethereum...';
    case 'confirmingArgon':
      return 'Confirming on Argon...';
    case 'confirmedOnArgon':
      return 'Confirmed on Argon.';
    default:
      return '';
  }
}

function getArgonConfirmationProgress(
  argonReadiness: IEthereumInboundTransferState['argonReadiness'],
  currentTimeMs: number,
) {
  if (!argonReadiness) {
    return 75;
  }

  const elapsedMs = currentTimeMs - argonReadiness.startedAt;
  const expectedProgress = Math.min(20, Math.floor((elapsedMs * 20) / Math.max(1, argonReadiness.estimatedDurationMs)));

  return Math.min(92, 70 + Math.max(3, expectedProgress));
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
