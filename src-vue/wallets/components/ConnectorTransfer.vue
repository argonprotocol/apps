<template>
  <PopoverRoot :open="props.open" :modal="true" @update:open="emit('update:open', $event)">
    <PopoverTrigger asChild><slot /></PopoverTrigger>
    <PopoverPortal>
      <PopoverContent
        side="bottom"
        align="center"
        :sideOffset="-20"
        :collisionPadding="30"
        :style="floatingZIndex"
        class="w-96 rounded-lg shadow-2xl"
        @pointerDownOutside="keepOpenForRelatedConnector"
      >
        <div class="flex max-h-[var(--reka-popover-content-available-height)] flex-col rounded-lg border border-black/50 bg-white text-left text-gray-700">
          <h2 class="z-20 mx-1 flex items-center gap-x-2.5 border-b border-slate-400/50 pt-3 pr-3 pb-2 pl-2 select-none">
            <span class="min-w-0 grow px-1 text-xl font-bold text-slate-800/70">
              {{ activeTransfer ? 'Sending' : 'Send' }} from
              {{ walletDisplayName }}
            </span>
            <ButtonCopy :address="connectedWallet?.address!" />
            <ButtonClose @close="emit('update:open', false)" />
          </h2>

          <div
            v-if="activeTransfer"
            class="flex min-h-0 flex-col gap-4 overflow-y-auto px-5 py-4 text-sm text-slate-700"
          >
            <p class="font-light">
              Moving
              <strong>
                {{ microgonToArgonNm(activeTransfer.transferState.amount).format('0,0.[00]') }}
                {{ activeTransfer.moveToken }}
              </strong>
              from
              <strong>{{ walletDisplayName }}</strong>
              to
              <strong>Internal App Wallet</strong>
              .
            </p>
            <p class="text-argon-700 text-center text-4xl font-bold">
              {{ numeral(progressView.progressPct).format('0.00') }}%
            </p>
            <ProgressBar
              :progress="progressView.progressPct"
              :hasError="!!progressView.error"
              :showLabel="false"
              class="h-4"
            />
            <div class="text-center font-medium">{{ progressView.stepLabel }}</div>
            <div class="text-center font-light text-slate-500">{{ progressView.detail }}</div>
            <div v-if="progressView.hint" class="text-center text-xs font-light text-slate-500">
              {{ progressView.hint }}
            </div>
            <div
              v-if="progressView.error"
              class="rounded-md border border-red-200 bg-red-50 px-3 py-2 [overflow-wrap:anywhere] whitespace-pre-wrap text-red-700"
            >
              {{ progressView.error }}
            </div>
            <button
              type="button"
              class="border-argon-700 bg-argon-600 hover:bg-argon-700 mt-2 w-full rounded border px-3 py-2 font-semibold text-white"
              @click="createAnotherTransaction"
            >
              Create Another Transaction
            </button>
          </div>

          <div v-else class="min-h-0 overflow-y-auto px-5 pb-4">
            <template v-if="showTransferForm">
              <WalletTransferForm
                :from=""
                :toOptions=""

                :tokensToMove="tokensToMove"
                :selectedMoveToken="selectedMoveToken"
                :maxValue="availableAmount"
                destinationLabel="Internal App Wallet"

                :feeEstimateWei="feeEstimateWei"
                :ethereumFeeEstimateError="ethereumFeeEstimateError"
                :ethereumBalanceWei="ethereumBalanceWei"
                :hasSufficientFeeBalance="hasSufficientFeeBalance"
                :isEstimatingFees="isEstimatingFees"
                :formError="formError"

                testIdPrefix="ConnectorTransfer"
                ref="transferForm"
              />
              <div class="mt-8 mb-2 flex flex-row gap-x-2">
                <button
                  :disabled="!canInitiateTransfer"
                  class="border-argon-700 bg-argon-600 grow cursor-pointer rounded-lg border px-5 py-1 text-white disabled:cursor-default disabled:border-gray-400 disabled:bg-gray-300 disabled:text-gray-500"
                  @click="initiateTransfer"
                >
                  &laquo; {{ isInitiatingTransfer ? 'Initiating Transfer...' : `Initiate Transfer` }}
                </button>
                <button
                  v-if="!isInitiatingTransfer"
                  class="border-argon-600 text-argon-600 cursor-pointer rounded-lg border px-5 py-1"
                  @click="emit('update:open', false)"
                >
                  Cancel
                </button>
              </div>
            </template>
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
</template>

<script setup lang="ts">
import * as Vue from 'vue';
import { bigIntMax, MoveToken } from '@argonprotocol/apps-core';
import { EvmContracts } from '@argonprotocol/mainchain';
import { ArrowPathIcon } from '@heroicons/vue/24/outline';
import {
  PopoverArrow,
  PopoverContent,
  PopoverPortal,
  PopoverRoot,
  PopoverTrigger,
  type PointerDownOutsideEvent,
} from 'reka-ui';
import ProgressBar from '../../components/ProgressBar.vue';
import type { IEthereumInboundActiveTransfer } from '../../lib/EthereumInboundTransferTracker.ts';
import { WalletType } from '../../lib/Wallet.ts';
import { createNumeralHelpers } from '../../lib/numeral.ts';
import numeral from '../../lib/numeral.ts';
import { useFloatingZIndex } from '../../overlays/helpers/OverlayZIndex.ts';
import { getCurrency } from '../../stores/currency.ts';
import { getEthereumMoveTracker } from '../../stores/moveFromEthereum.ts';
import { useWallets } from '../../stores/wallets.ts';
import { getCrosschainTransferProgressView } from './crosschainTransferView.ts';
import ButtonClose from './ButtonClose.vue';
import ButtonCopy from './ButtonCopy.vue';
import WalletTransferForm from './WalletTransferForm.vue';

const props = defineProps<{
  connectorId?: string;
  direction: 'right' | 'left';
  open: boolean;
  moveToken?: MoveToken.ARGN | MoveToken.ARGNOT;
  walletName?: string;
}>();
const emit = defineEmits<{ (event: 'update:open', value: boolean): void }>();

const wallets = useWallets();
const currency = getCurrency();
const inboundTracker = getEthereumMoveTracker();

const { microgonToArgonNm } = createNumeralHelpers(currency);

const transferForm = Vue.ref<InstanceType<typeof WalletTransferForm>>();

const floatingZIndex = useFloatingZIndex();
const selectedMoveToken = Vue.ref<MoveToken.ARGN | MoveToken.ARGNOT>(MoveToken.ARGN);
const tokensToMove = Vue.ref(0n);

const feeEstimateWei = Vue.ref<bigint>();
const ethereumFeeEstimateError = Vue.ref('');
const isEstimatingFees = Vue.ref(false);

const activeTransfer = Vue.ref<IEthereumInboundActiveTransfer>();
const formError = Vue.ref('');
const isInitiatingTransfer = Vue.ref(false);
const isRefreshingTokenData = Vue.ref(false);
const progressNow = Vue.ref(Date.now());
let progressRefreshInterval: ReturnType<typeof setInterval> | undefined;

const connectedWalletRecord = Vue.computed(() =>
  wallets.walletRecords.find(record => record.id === Number(props.connectorId) && record.walletType === 'ethereum'),
);

const connectedWallet = Vue.computed(() =>
  connectedWalletRecord.value ? wallets.getEthereumWalletRecord(connectedWalletRecord.value.id) : undefined,
);

const walletDisplayName = Vue.computed(
  () => props.walletName ?? connectedWalletRecord.value?.name ?? 'Ethereum Wallet',
);
const balancesAreLoaded = Vue.computed(() => wallets.isLoaded && !!connectedWallet.value?.balanceUpdatedAt);
const ethereumBalanceWei = Vue.computed(
  () => connectedWallet.value?.otherTokens.find(token => token.symbol === 'ETH')?.value ?? 0n,
);

function getAvailableAmount(moveToken: MoveToken.ARGN | MoveToken.ARGNOT) {
  const wallet = connectedWallet.value;
  const rawAmount =
    moveToken === MoveToken.ARGN ? (wallet?.availableMicrogons ?? 0n) : (wallet?.availableMicronots ?? 0n);
  const ethereumAddress = connectedWalletRecord.value?.address;
  if (!ethereumAddress) return 0n;
  const reserved = inboundTracker.getPendingAmount(ethereumAddress, moveToken, connectedWallet.value?.balanceUpdatedAt);
  return bigIntMax(rawAmount - reserved, 0n);
}

const availableAmount = Vue.computed(() => getAvailableAmount(selectedMoveToken.value));
const hasTokensToMove = Vue.computed(() =>
  ([MoveToken.ARGN, MoveToken.ARGNOT] as const).some(token => getAvailableAmount(token) > 0n),
);
const showTransferForm = Vue.computed(() => !balancesAreLoaded.value || hasTokensToMove.value);
const hasSufficientFeeBalance = Vue.computed(
  () => feeEstimateWei.value != null && ethereumBalanceWei.value >= feeEstimateWei.value,
);
const canInitiateTransfer = Vue.computed(
  () =>
    transferForm.value?.isReady &&
    !!connectedWalletRecord.value &&
    !isInitiatingTransfer.value &&
    !isEstimatingFees.value &&
    !ethereumFeeEstimateError.value &&
    feeEstimateWei.value != null &&
    hasSufficientFeeBalance.value &&
    tokensToMove.value > 0n &&
    tokensToMove.value <= availableAmount.value,
);
const progressView = Vue.computed(() =>
  getCrosschainTransferProgressView(activeTransfer.value?.transferState, progressNow.value),
);

async function initiateTransfer() {
  const ethereumWallet = connectedWalletRecord.value;
  if (!ethereumWallet || !canInitiateTransfer.value) return;
  isInitiatingTransfer.value = true;
  formError.value = '';
  try {
    const transfer = await inboundTracker.startMove({
      moveToken: selectedMoveToken.value,
      amountBaseUnits: tokensToMove.value * EvmContracts.MINTING_GATEWAY_RUNTIME_TO_ERC20_SCALE,
      targetWalletType: WalletType.argon,
      ethereumWallet,
    });
    if (transfer) activeTransfer.value = transfer;
  } catch (error) {
    formError.value = error instanceof Error ? error.message : 'Unable to start the transfer.';
  } finally {
    isInitiatingTransfer.value = false;
  }
}

async function createAnotherTransaction() {
  const current = activeTransfer.value;
  if (current?.transferState.needsAttention) {
    await inboundTracker.dismissFailedTransfer(current.id);
  } else if (current?.transferState.isComplete) {
    inboundTracker.clearCompletedTransfer(current.id);
  }
  activeTransfer.value = undefined;
  tokensToMove.value = availableAmount.value;
  formError.value = '';
}

async function refreshTokenData() {
  if (!connectedWalletRecord.value || isRefreshingTokenData.value) return;
  isRefreshingTokenData.value = true;
  try {
    await wallets.refreshEthereumWalletRecord(connectedWalletRecord.value.id);
  } finally {
    isRefreshingTokenData.value = false;
  }
}

async function updateFees(onCleanup: (cleanupFn: () => void) => void) {
  ethereumFeeEstimateError.value = '';
  isEstimatingFees.value = tokensToMove.value > 0n && !!connectedWalletRecord.value;
  if (tokensToMove.value <= 0n || !connectedWalletRecord.value) return;

  let cancelled = false;
  onCleanup(() => (cancelled = true));
  try {
    const ethereumFeeEstimate = await inboundTracker.estimateFeeWei({
      moveToken: selectedMoveToken.value,
      amountBaseUnits: tokensToMove.value * EvmContracts.MINTING_GATEWAY_RUNTIME_TO_ERC20_SCALE,
      targetWalletType: WalletType.argon,
      ethereumWallet: connectedWalletRecord.value,
    });
    if (!cancelled) {
      feeEstimateWei.value = ethereumFeeEstimate;
    }
  } catch (error) {
    if (!cancelled) {
      ethereumFeeEstimateError.value = error instanceof Error ? error.message : 'Unable to estimate the transfer fees.';
    }
  } finally {
    if (!cancelled) isEstimatingFees.value = false;
  }
}

function keepOpenForRelatedConnector(event: PointerDownOutsideEvent) {
  const target = event.detail.originalEvent.target;
  if (!(target instanceof Element)) return;
  if (target.closest('[data-wallet-connector-id]')?.getAttribute('data-wallet-connector-id') === props.connectorId)
    event.preventDefault();
}

Vue.watch(
  () => props.moveToken,
  token => (selectedMoveToken.value = token ?? MoveToken.ARGN),
  { immediate: true },
);
Vue.watch(
  () => props.open,
  open => {
    if (!open) activeTransfer.value = undefined;
  },
);
Vue.watch(
  () => [props.open, inboundTracker.data.latestTransferIdByToken[selectedMoveToken.value]] as const,
  ([open, transferId]) => {
    if (!open || !transferId) return;
    const transfer = inboundTracker.getTransfer(transferId);
    const sourceAddress = transfer?.persistedRecord?.sourceAddress ?? transfer?.sourceAddress;
    if (sourceAddress?.toLowerCase() === connectedWalletRecord.value?.address.toLowerCase()) {
      activeTransfer.value = transfer;
    }
  },
  { immediate: true },
);

Vue.watch(
  availableAmount,
  max => {
    if (tokensToMove.value === 0n || tokensToMove.value > max) tokensToMove.value = max;
  },
  { immediate: true },
);
Vue.onMounted(() => {
  progressRefreshInterval = setInterval(() => (progressNow.value = Date.now()), 1_000);
});
Vue.onUnmounted(() => {
  if (progressRefreshInterval) clearInterval(progressRefreshInterval);
});
</script>
