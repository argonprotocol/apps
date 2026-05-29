<template>
  <OverlayBase :isOpen="!!props.request" :overflowScroll="false" class="w-[420px]" @close="closeOverlay">
    <template #title>
      {{
        props.request?.direction === 'transferOutOfArgon'
          ? `Move To ${props.request.networkName}`
          : `Move From ${props.request?.networkName}`
      }}
    </template>

    <div
      v-if="isTransferOutOfArgonProcessing(transferOutOfArgon) || isTransferToArgonProcessing(transferToArgon)"
      class="flex flex-col gap-4 p-5 text-sm text-slate-700"
    >
      <p
        v-if="isTransferOutOfArgonProcessing(transferOutOfArgon) && transferOutOfArgon"
        class="font-light text-slate-700"
      >
        Moving
        <strong>
          {{ formatTokenAmount(transferOutOfArgon.transferState.amount ?? 0n) }} {{ props.request?.moveToken }}
        </strong>
        from your
        <strong>{{ getArgonWalletLabel(transferOutOfArgon.transferState.sourceWalletType) }}</strong>
        to your
        <strong>{{ props.request?.networkName }}</strong>
        wallet.
      </p>

      <p v-else-if="transferToArgon" class="font-light text-slate-700">
        Moving
        <strong>{{ props.request?.moveToken }}</strong>
        from your
        <strong>{{ props.request?.networkName }}</strong>
        wallet into your
        <strong>{{ getArgonWalletLabel(transferToArgon.transferState.targetWalletType) }}</strong>
        .
      </p>

      <p class="font-light text-slate-500 italic">You can close this panel without disrupting the process.</p>

      <div class="text-argon-700 text-center text-4xl font-bold">
        {{ numeral(processingProgress.progressPct).format('0.00') }}%
      </div>

      <ProgressBar
        :progress="processingProgress.progressPct"
        :hasError="!!processingProgress.error"
        :showLabel="false"
        class="h-4"
      />

      <div class="text-center font-light text-slate-500">
        {{ processingProgress.progressLabel }}
        <template v-if="processingProgress.remainingCollateralMicrogons">
          (
          {{
            microgonToArgonNm(processingProgress.remainingCollateralMicrogons).formatIfElse('< 1_000', '0,0.00', '0,0')
          }}
          ARGN remaining)
        </template>
      </div>

      <div
        v-if="processingProgress.error"
        class="min-w-0 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm leading-5 [overflow-wrap:anywhere] break-words whitespace-pre-wrap text-red-700"
      >
        {{ processingProgress.error }}
      </div>

      <div v-if="!isSubmittingTransfer(transferOutOfArgon, transferToArgon)" class="flex justify-end">
        <div v-if="shouldShowRetryTransfer(transferOutOfArgon)" class="flex justify-end gap-3">
          <button
            data-testid="WalletTransferOverlay.close()"
            type="button"
            class="rounded border border-slate-300 px-4 py-2 text-sm text-slate-600 hover:bg-slate-50"
            @click="closeOverlay"
          >
            Close
          </button>
          <button
            type="button"
            class="bg-argon-button hover:bg-argon-button-hover rounded-md px-4 py-2 text-sm font-semibold text-white"
            @click="retryTransfer"
          >
            Retry
          </button>
        </div>

        <button
          v-else
          data-testid="WalletTransferOverlay.close()"
          type="button"
          class="bg-argon-button hover:bg-argon-button-hover rounded-md px-4 py-2 text-sm font-semibold text-white"
          @click="closeOverlay"
        >
          Done
        </button>
      </div>
    </div>

    <div v-else-if="props.request" class="flex flex-col gap-4 p-5 text-sm text-slate-700">
      <p v-if="props.request.direction === 'transferOutOfArgon'" class="font-light text-slate-700">
        Send
        <strong>{{ props.request.moveToken }}</strong>
        from your
        <strong>{{ getArgonWalletLabel(props.request.walletType) }}</strong>
        to your
        <strong>{{ props.request.networkName }}</strong>
        wallet.
      </p>

      <p v-else class="font-light text-slate-700">
        Send
        <strong>{{ props.request.moveToken }}</strong>
        from your
        <strong>{{ props.request.networkName }}</strong>
        wallet into your
        <strong>{{ getArgonWalletLabel(props.request.walletType) }}</strong>
        .
      </p>

      <div data-testid="WalletTransferOverlay.amount">
        <label class="mb-1.5 block text-sm font-medium text-slate-600">Amount to move</label>
        <InputToken
          v-model="amount"
          :min="0n"
          :max="props.request.availableAmount"
          :suffix="` ${props.request.moveToken}`"
          class="w-full"
        />
        <div class="mt-1 text-xs text-slate-400">
          Available: {{ formatTokenAmount(props.request.availableAmount) }} {{ props.request.moveToken }}
        </div>
      </div>

      <div class="rounded-md border border-slate-200 bg-slate-50 px-3 py-2 text-xs text-slate-600">
        <template v-if="props.request.direction === 'transferOutOfArgon' && transferOutOfArgonFeeEstimateWei != null">
          Estimated Ethereum fee range:
          <strong>
            <template v-if="transferOutOfArgonFeeEstimateWei[0] === transferOutOfArgonFeeEstimateWei[1]">
              {{ formatEvmNativeFeeWei(transferOutOfArgonFeeEstimateWei[0]) }}
            </template>
            <template v-else>
              {{ formatEvmNativeFeeWei(transferOutOfArgonFeeEstimateWei[0]) }} -
              {{ formatEvmNativeFeeWei(transferOutOfArgonFeeEstimateWei[1]) }}
            </template>
            {{ props.request.feeTokenSymbol }}
          </strong>
        </template>
        <template v-else-if="props.request.direction === 'transferOutOfArgon' && isEstimatingTransferOutOfArgonFee">
          Estimating final {{ props.request.networkName }} network fee...
        </template>
        <template v-else-if="props.request.direction === 'transferOutOfArgon'">
          {{
            transferOutOfArgonFeeEstimateError ||
            `Unable to estimate the final ${props.request.networkName} fee right now.`
          }}
        </template>
        <template v-else-if="transferToArgonFeeEstimateWei != null">
          Estimated network fee:
          <strong>
            {{ formatEvmNativeFeeWei(transferToArgonFeeEstimateWei) }}
            {{ props.request.feeTokenSymbol }}
          </strong>
        </template>
        <template v-else-if="isEstimatingTransferToArgonFee">
          Estimating {{ props.request.networkName }} network fee...
        </template>
        <template v-else>
          {{ props.request.networkName }} network fees are paid when the transfer is submitted.
        </template>
      </div>

      <div
        v-if="
          props.request.direction === 'transferOutOfArgon' &&
          transferOutOfArgonFeeEstimateWei != null &&
          getExternalFeeBalanceWei(props.request.networkName) < transferOutOfArgonFeeEstimateWei[1]
        "
        class="rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm leading-5 text-amber-900"
      >
        Your {{ props.request.networkName }} wallet has
        {{ formatEvmNativeFeeWei(getExternalFeeBalanceWei(props.request.networkName)) }}
        {{ props.request.feeTokenSymbol }}, but this transfer likely needs between
        {{ formatEvmNativeFeeWei(transferOutOfArgonFeeEstimateWei[0]) }}
        and
        {{ formatEvmNativeFeeWei(transferOutOfArgonFeeEstimateWei[1]) }}
        {{ props.request.feeTokenSymbol }} for the final network transaction.
      </div>

      <div
        v-if="formError"
        class="min-w-0 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm leading-5 [overflow-wrap:anywhere] break-words whitespace-pre-wrap text-red-700"
      >
        {{ formError }}
      </div>

      <div class="flex justify-end gap-3">
        <button
          type="button"
          class="rounded border border-slate-300 px-4 py-2 text-sm text-slate-600 hover:bg-slate-50"
          @click="closeOverlay"
        >
          Cancel
        </button>
        <button
          :disabled="!canSubmit"
          type="button"
          class="bg-argon-button hover:bg-argon-button-hover rounded-md px-4 py-2 text-sm font-semibold text-white disabled:opacity-40"
          @click="submitTransfer"
        >
          Submit
        </button>
      </div>
    </div>
  </OverlayBase>
</template>

<script setup lang="ts">
import * as Vue from 'vue';
import { MoveToken } from '@argonprotocol/apps-core';
import { EvmContracts } from '@argonprotocol/mainchain';
import InputToken from '../../../components/InputToken.vue';
import ProgressBar from '../../../components/ProgressBar.vue';
import type {
  IArgonWalletType,
  IEthereumInboundTransferState,
  IEthereumMoveToken,
} from '../../../interfaces/IEthereumInboundTransferTracker.ts';
import type { IEthereumInboundActiveTransfer } from '../../../lib/EthereumInboundTransferTracker.ts';
import type {
  IEthereumOutboundActiveTransfer,
  IEthereumOutboundTransferState,
} from '../../../lib/EthereumOutboundTransferTracker.ts';
import { formatEvmNativeFeeWei } from '../../../lib/Utils.ts';
import { createNumeralHelpers } from '../../../lib/numeral.ts';
import numeral from '../../../lib/numeral.ts';
import { getCurrency } from '../../../stores/currency.ts';
import { getEthereumMoveTracker } from '../../../stores/moveFromEthereum.ts';
import { getEthereumOutboundTransferTracker } from '../../../stores/moveToEthereum.ts';
import { useWallets } from '../../../stores/wallets.ts';
import OverlayBase from '../OverlayBase.vue';
import { loadEthereumChainConfig } from '../../../lib/EthereumClient.ts';

const props = defineProps<{
  request?: {
    direction: 'transferToArgon' | 'transferOutOfArgon';
    moveToken: IEthereumMoveToken;
    availableAmount: bigint;
    walletType: IArgonWalletType;
    networkName: string;
    feeTokenSymbol: string;
  };
}>();

const emit = defineEmits<{
  (e: 'close'): void;
}>();

const currency = getCurrency();
const wallets = useWallets();
const { microgonToArgonNm, micronotToArgonotNm } = createNumeralHelpers(currency);

type ITransferProgressView = {
  progressPct: number;
  progressLabel: string;
  error: string;
  remainingCollateralMicrogons?: bigint;
};

const amount = Vue.ref<bigint>(0n);
const formError = Vue.ref('');
const currentTimeMs = Vue.ref(Date.now());
const transferOutOfArgonFeeEstimateWei = Vue.ref<readonly [bigint, bigint]>();
const transferOutOfArgonFeeEstimateError = Vue.ref('');
const isEstimatingTransferOutOfArgonFee = Vue.ref(false);
const transferToArgonFeeEstimateWei = Vue.ref<bigint>();
const isEstimatingTransferToArgonFee = Vue.ref(false);
const hasActiveEthereumTransferConfig = Vue.ref(false);

const transferOutOfArgon = Vue.computed(() => {
  if (!props.request || props.request.direction !== 'transferOutOfArgon' || !hasActiveEthereumTransferConfig.value) {
    return;
  }

  const transferOutOfArgonTracker = getEthereumOutboundTransferTracker();
  return transferOutOfArgonTracker.getLatestTransfer(props.request.moveToken);
});

const transferToArgon = Vue.computed(() => {
  if (!props.request || props.request.direction !== 'transferToArgon' || !hasActiveEthereumTransferConfig.value) {
    return;
  }

  const transferToArgonTracker = getEthereumMoveTracker();
  const transferId = transferToArgonTracker.data.latestTransferIdByToken[props.request.moveToken];
  return transferId ? transferToArgonTracker.getTransfer(transferId) : undefined;
});

const canSubmit = Vue.computed(
  () =>
    !!props.request &&
    hasActiveEthereumTransferConfig.value &&
    amount.value > 0n &&
    amount.value <= props.request.availableAmount,
);
const processingProgress = Vue.computed(() => {
  if (isTransferOutOfArgonProcessing(transferOutOfArgon.value)) {
    return getTransferOutOfArgonProgress(transferOutOfArgon.value);
  }

  if (isTransferToArgonProcessing(transferToArgon.value)) {
    return getTransferToArgonProgress(transferToArgon.value, currentTimeMs.value);
  }

  return { progressPct: 0, progressLabel: '', error: '' } satisfies ITransferProgressView;
});

let progressTimer: ReturnType<typeof setInterval> | undefined;

Vue.watch(
  () => props.request,
  request => {
    formError.value = '';

    if (!request) {
      amount.value = 0n;
      transferOutOfArgonFeeEstimateWei.value = undefined;
      transferOutOfArgonFeeEstimateError.value = '';
      isEstimatingTransferOutOfArgonFee.value = false;
      transferToArgonFeeEstimateWei.value = undefined;
      isEstimatingTransferToArgonFee.value = false;
      clearProgressTimer();
      return;
    }

    void refreshEthereumTransferConfig();

    if (amount.value === 0n || amount.value > request.availableAmount) {
      amount.value = request.availableAmount;
    }
  },
  { immediate: true },
);

Vue.watch(
  () =>
    [props.request?.direction, props.request?.moveToken, amount.value, hasActiveEthereumTransferConfig.value] as const,
  async ([direction, moveToken, nextAmount, hasActiveEthereumTransferConfig], _, onCleanup) => {
    transferOutOfArgonFeeEstimateWei.value = undefined;
    transferOutOfArgonFeeEstimateError.value = '';

    if (direction !== 'transferOutOfArgon' || !moveToken || nextAmount <= 0n) {
      isEstimatingTransferOutOfArgonFee.value = false;
      return;
    }
    if (!hasActiveEthereumTransferConfig) {
      transferOutOfArgonFeeEstimateError.value = 'Ethereum transfer gateway is not configured on this network.';
      isEstimatingTransferOutOfArgonFee.value = false;
      return;
    }

    let isCancelled = false;
    onCleanup(() => {
      isCancelled = true;
    });

    isEstimatingTransferOutOfArgonFee.value = true;

    try {
      const transferOutOfArgonTracker = getEthereumOutboundTransferTracker();
      const feeEstimateWei = await transferOutOfArgonTracker.estimateFeeRangeWei({
        moveToken,
        amount: nextAmount,
      });

      if (!isCancelled) {
        transferOutOfArgonFeeEstimateWei.value = feeEstimateWei;
      }
    } catch (error) {
      if (!isCancelled) {
        transferOutOfArgonFeeEstimateError.value =
          error instanceof Error ? error.message : 'Unable to estimate the final Ethereum fee right now.';
        console.warn('[WalletTransferOverlay] Unable to estimate transfer-out-of-Argon fee', error);
      }
    } finally {
      if (!isCancelled) {
        isEstimatingTransferOutOfArgonFee.value = false;
      }
    }
  },
  { immediate: true, flush: 'post' },
);

Vue.watch(
  () =>
    [
      props.request?.direction,
      props.request?.moveToken,
      props.request?.walletType,
      amount.value,
      hasActiveEthereumTransferConfig.value,
    ] as const,
  async ([direction, moveToken, walletType, nextAmount, hasActiveEthereumTransferConfig], _, onCleanup) => {
    transferToArgonFeeEstimateWei.value = undefined;

    if (direction !== 'transferToArgon' || !moveToken || !walletType || nextAmount <= 0n) {
      isEstimatingTransferToArgonFee.value = false;
      return;
    }
    if (!hasActiveEthereumTransferConfig) {
      isEstimatingTransferToArgonFee.value = false;
      return;
    }

    let isCancelled = false;
    onCleanup(() => {
      isCancelled = true;
    });

    isEstimatingTransferToArgonFee.value = true;

    try {
      const transferToArgonTracker = getEthereumMoveTracker();
      const feeEstimateWei = await transferToArgonTracker.estimateFeeWei({
        moveToken,
        amountBaseUnits: nextAmount * EvmContracts.MINTING_GATEWAY_RUNTIME_TO_ERC20_SCALE,
        targetWalletType: walletType,
      });

      if (!isCancelled) {
        transferToArgonFeeEstimateWei.value = feeEstimateWei;
      }
    } catch (error) {
      if (!isCancelled) {
        console.warn('[WalletTransferOverlay] Unable to estimate transfer-to-Argon fee', error);
      }
    } finally {
      if (!isCancelled) {
        isEstimatingTransferToArgonFee.value = false;
      }
    }
  },
  { immediate: true, flush: 'post' },
);

Vue.watch(
  () => transferToArgon.value?.transferState.argonReadiness?.pollMs,
  () => {
    const pollMs =
      transferToArgon.value?.transferState.phase === 'confirmingArgon'
        ? transferToArgon.value.transferState.argonReadiness?.pollMs
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

async function submitTransfer() {
  if (!props.request || !canSubmit.value) {
    return;
  }

  formError.value = '';

  try {
    if (!hasActiveEthereumTransferConfig.value) {
      throw new Error('Ethereum transfer gateway is not configured on this network.');
    }

    if (props.request.direction === 'transferOutOfArgon') {
      const transferOutOfArgonTracker = getEthereumOutboundTransferTracker();
      await transferOutOfArgonTracker.startMove({
        moveToken: props.request.moveToken,
        amount: amount.value,
        sourceWalletType: props.request.walletType,
      });
      return;
    }

    const transferToArgonTracker = getEthereumMoveTracker();
    await transferToArgonTracker.startMove({
      moveToken: props.request.moveToken,
      amountBaseUnits: amount.value * EvmContracts.MINTING_GATEWAY_RUNTIME_TO_ERC20_SCALE,
      targetWalletType: props.request.walletType,
    });
  } catch (error) {
    formError.value = error instanceof Error ? error.message : 'Unable to start the transfer.';
  }
}

async function retryTransfer() {
  if (!props.request || props.request.direction !== 'transferOutOfArgon') {
    return;
  }

  if (!hasActiveEthereumTransferConfig.value) {
    formError.value = 'Ethereum transfer gateway is not configured on this network.';
    return;
  }

  const transferOutOfArgonTracker = getEthereumOutboundTransferTracker();
  await transferOutOfArgonTracker.startMove({
    moveToken: props.request.moveToken,
    amount: transferOutOfArgon.value?.transferState.amount ?? amount.value,
    sourceWalletType: props.request.walletType,
  });
}

function closeOverlay() {
  const transfer = props.request?.direction === 'transferOutOfArgon' ? transferOutOfArgon.value : transferToArgon.value;

  if (transfer && !transfer.transferState.isSubmitting && !transfer.transferState.hasPersistedTransfer) {
    if (props.request?.direction === 'transferOutOfArgon') {
      const transferOutOfArgonTracker = getEthereumOutboundTransferTracker();
      transferOutOfArgonTracker.clearCompletedTransfer(transfer.transferId);
    } else {
      const transferToArgonTracker = getEthereumMoveTracker();
      transferToArgonTracker.clearCompletedTransfer(transfer.transferId);
    }
  }

  emit('close');
}

function clearProgressTimer() {
  if (!progressTimer) {
    return;
  }

  clearInterval(progressTimer);
  progressTimer = undefined;
}

async function refreshEthereumTransferConfig() {
  try {
    hasActiveEthereumTransferConfig.value = Boolean(await loadEthereumChainConfig());
  } catch (error) {
    console.warn('[WalletTransferOverlay] Unable to load Ethereum chain config', error);
    hasActiveEthereumTransferConfig.value = false;
  }
}

function formatTokenAmount(value: bigint) {
  return props.request?.moveToken === MoveToken.ARGNOT
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

function getExternalFeeBalanceWei(networkName?: string) {
  if (networkName === 'Ethereum') {
    return wallets.ethereumWallet.otherTokens.find(x => x.symbol === 'ETH')?.value ?? 0n;
  }

  if (networkName === 'Base') {
    return wallets.baseWallet.otherTokens.find(x => x.symbol === 'ETH')?.value ?? 0n;
  }

  return 0n;
}

function isTransferOutOfArgonProcessing(transfer: IEthereumOutboundActiveTransfer | undefined) {
  if (!transfer) {
    return false;
  }

  const { transferState } = transfer;
  return (
    transferState.isSubmitting || transferState.hasPersistedTransfer || transferState.phase === 'confirmedOnEthereum'
  );
}

function isTransferToArgonProcessing(transfer: IEthereumInboundActiveTransfer | undefined) {
  if (!transfer) {
    return false;
  }

  const { transferState } = transfer;
  return transferState.isSubmitting || transferState.hasPersistedTransfer || transferState.phase === 'confirmedOnArgon';
}

function isSubmittingTransfer(
  transferOut: IEthereumOutboundActiveTransfer | undefined,
  transferIn: IEthereumInboundActiveTransfer | undefined,
) {
  if (isTransferOutOfArgonProcessing(transferOut)) {
    return !!transferOut?.transferState.isSubmitting;
  }

  if (isTransferToArgonProcessing(transferIn)) {
    return !!transferIn?.transferState.isSubmitting;
  }

  return false;
}

function shouldShowRetryTransfer(transfer: IEthereumOutboundActiveTransfer | undefined) {
  return !!transfer?.transferState.hasPersistedTransfer && !transfer.transferState.isSubmitting;
}

function getTransferOutOfArgonProgress(transfer: IEthereumOutboundActiveTransfer | undefined): ITransferProgressView {
  if (!transfer) {
    return { progressPct: 0, progressLabel: '', error: '' };
  }

  return {
    progressPct: getTransferOutOfArgonProgressPct(transfer.transferState),
    progressLabel: getTransferOutOfArgonProgressLabel(transfer.transferState),
    remainingCollateralMicrogons:
      transfer.transferState.phase === 'awaitingCollateralization' && !transfer.transferState.isCollateralizingOnArgon
        ? transfer.transferState.remainingCollateralMicrogons
        : undefined,
    error: transfer.transferState.error,
  };
}

function getTransferOutOfArgonProgressPct(transferState: IEthereumOutboundTransferState): number {
  switch (transferState.phase) {
    case 'preparing':
      return 5;
    case 'confirmingArgon':
      return 25;
    case 'awaitingCollateralization':
      return 55;
    case 'confirmingEthereum':
      return 85;
    case 'confirmedOnEthereum':
      return 100;
    default:
      return 0;
  }
}

function getTransferOutOfArgonProgressLabel(transferState: IEthereumOutboundTransferState) {
  switch (transferState.phase) {
    case 'preparing':
      return 'Preparing transfer...';
    case 'confirmingArgon':
      return 'Confirming on Argon...';
    case 'awaitingCollateralization':
      return transferState.isCollateralizingOnArgon
        ? 'Collateralizing transfer on Argon...'
        : (transferState.awaitingCollateralizationLabel ?? 'Waiting for transfer collateralization on Argon...');
    case 'confirmingEthereum':
      return 'Finalizing on destination network...';
    case 'confirmedOnEthereum':
      return 'Confirmed on destination network.';
    default:
      return '';
  }
}

function getTransferToArgonProgress(
  transfer: IEthereumInboundActiveTransfer | undefined,
  now: number,
): ITransferProgressView {
  if (!transfer) {
    return { progressPct: 0, progressLabel: '', error: '' };
  }

  return {
    progressPct: getTransferToArgonProgressPct(transfer.transferState, now),
    progressLabel: getTransferToArgonProgressLabel(transfer.transferState),
    error: transfer.transferState.error,
  };
}

function getTransferToArgonProgressPct(transferState: IEthereumInboundTransferState, now: number): number {
  switch (transferState.phase) {
    case 'preparing':
      return 5;
    case 'confirmingEthereum':
      return 30;
    case 'confirmingArgon':
      return getTransferToArgonArgonProgress(transferState.argonReadiness, now);
    case 'confirmedOnArgon':
      return 100;
    default:
      return 0;
  }
}

function getTransferToArgonProgressLabel(transferState: IEthereumInboundTransferState) {
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

function getTransferToArgonArgonProgress(argonReadiness: IEthereumInboundTransferState['argonReadiness'], now: number) {
  if (!argonReadiness) {
    return 75;
  }

  const elapsedMs = now - argonReadiness.startedAt;
  const expectedProgress = Math.min(20, Math.floor((elapsedMs * 20) / Math.max(1, argonReadiness.estimatedDurationMs)));
  return Math.min(92, 70 + Math.max(3, expectedProgress));
}
</script>
