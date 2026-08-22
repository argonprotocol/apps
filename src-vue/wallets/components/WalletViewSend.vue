<template>
  <div class="flex h-full grow flex-col text-black/90">
    <WalletHeader
      :name="activeTransfer ? 'Sending From Internal' : 'Send From Internal'"
      :showHome="true"
      :isDragging="props.isDragging"
      @dragStart="emit('dragStart', $event)"
      @goto="emit('goto', $event)"
      @close="emit('close')"
    />

    <div
      v-if="activeTransfer"
      class="flex min-h-0 grow flex-col gap-4 overflow-y-auto px-5 py-4 text-sm text-slate-700"
    >
      <p class="font-light">
        Moving
        <strong>
          {{ microgonToArgonNm(activeTransfer.transferState.amount ?? 0n).format('0,0.[00]') }}
          {{ activeTransfer.moveToken }}
        </strong>
        from
        <strong>Internal App Wallet</strong>
        to
        <strong>{{ selectedEthereumWalletRecord?.name }}</strong>
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

    <div v-else class="min-h-0 grow overflow-y-auto px-5 pb-4">
      <WalletTransferForm
        v-model:tokensToMove="tokensToMove"
        v-model:selectedMoveToken="selectedMoveToken"
        v-model:destination="selectedDestination"
        v-model:destinationAddress="destinationAddress"
        :maxValue="maxValue"
        :allowBtc="true"
        :destinationOptions="destinationOptions"
        :showDestinationAddress="
          selectedDestination === ARGON_ADDRESS_DESTINATION || selectedDestination === BITCOIN_ADDRESS_DESTINATION
        "
        :destinationAddressPlaceholder="
          selectedDestination === BITCOIN_ADDRESS_DESTINATION
            ? 'Enter Bitcoin network address'
            : 'Enter Argon network address'
        "
        :showEthereumFees="!!selectedEthereumWalletRecord"
        :feeEstimateWei="feeEstimateWei"
        :feeEstimateMicrogon="feeEstimateMicrogon"
        :feeEstimateMicronot="feeEstimateMicronot"
        :ethereumFeeEstimateError="ethereumFeeEstimateError"
        :ethereumBalanceWei="ethereumBalanceWei"
        :hasSufficientFeeBalance="hasSufficientFeeBalance"
        :isEstimatingFees="isEstimatingFees"
        :formError="formError"
        testIdPrefix="WalletViewSend"
        ref="transferForm"
      />

      <div class="mt-8 mb-2 flex flex-row gap-x-2">
        <button
          v-if="selectedEthereumWalletRecord"
          :disabled="!canInitiateTransfer"
          class="border-argon-700 bg-argon-600 grow cursor-pointer rounded-lg border px-5 py-1 text-white disabled:cursor-default disabled:border-gray-400 disabled:bg-gray-300 disabled:text-gray-500"
          @click="initiateTransfer"
        >
          {{ isInitiatingTransfer ? 'Initiating Transfer...' : 'Initiate Transfer' }} &raquo;
        </button>
        <button
          v-if="!isInitiatingTransfer"
          class="border-argon-600 text-argon-600 cursor-pointer rounded-lg border px-5 py-1"
          @click="emit('goto', 'main')"
        >
          Cancel
        </button>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import * as Vue from 'vue';
import { bigIntMax, MoveToken } from '@argonprotocol/apps-core';
import type { IWalletGuidanceContext } from '../../emitters/basicEmitter.ts';
import type { IEthereumMoveToken } from '../../lib/EthereumClient.ts';
import type { IEthereumOutboundActiveTransfer } from '../../lib/EthereumOutboundTransferTracker.ts';
import { WalletType } from '../../lib/Wallet.ts';
import { createNumeralHelpers } from '../../lib/numeral.ts';
import numeral from '../../lib/numeral.ts';
import { getCurrency } from '../../stores/currency.ts';
import { getEthereumOutboundTransferTracker } from '../../stores/moveToEthereum.ts';
import { useWallets } from '../../stores/wallets.ts';
import ProgressBar from '../../components/ProgressBar.vue';
import WalletHeader from './WalletHeader.vue';
import WalletTransferForm from './WalletTransferForm.vue';
import { getCrosschainTransferProgressView } from './crosschainTransferView.ts';
import type { IWalletConnectorTarget, IWalletView } from '../walletOverlayState.ts';

const ARGON_ADDRESS_DESTINATION = 'argonAddress';
const BITCOIN_ADDRESS_DESTINATION = 'bitcoinAddress';
const ETHEREUM_DESTINATION_PREFIX = 'ethereum:';

const props = defineProps<{
  isDragging: boolean;
  activeConnector?: IWalletConnectorTarget;
  showGuidance?: boolean;
  guidanceContext?: IWalletGuidanceContext;
}>();

const emit = defineEmits<{
  (event: 'dragStart', mouseEvent: MouseEvent): void;
  (event: 'goto', view: IWalletView): void;
  (event: 'selectDestinationConnector', connectorId: string | number | undefined): void;
  (event: 'close'): void;
}>();

const currency = getCurrency();
const wallets = useWallets();
const outboundTracker = getEthereumOutboundTransferTracker();
const { microgonToArgonNm } = createNumeralHelpers(currency);

const transferForm = Vue.ref<InstanceType<typeof WalletTransferForm>>();

const selectedDestination = Vue.ref('');
const destinationAddress = Vue.ref('');
const selectedMoveToken = Vue.ref<MoveToken>(MoveToken.ARGN);
const tokensToMove = Vue.ref(0n);
const maximumTransferOutAmount = Vue.ref<bigint>();
const feeEstimateWei = Vue.ref<bigint>();
const feeEstimateMicrogon = Vue.ref<bigint>();
const feeEstimateMicronot = Vue.ref<bigint>();
const ethereumFeeEstimateError = Vue.ref('');
const isEstimatingFees = Vue.ref(false);
const activeTransfer = Vue.ref<IEthereumOutboundActiveTransfer>();
const formError = Vue.ref('');
const isInitiatingTransfer = Vue.ref(false);
const progressNow = Vue.ref(Date.now());
let progressRefreshInterval: ReturnType<typeof setInterval> | undefined;

const destinationOptions = Vue.computed(() => {
  if (selectedMoveToken.value === MoveToken.BTC) {
    return [{ name: 'Bitcoin Network Address', value: BITCOIN_ADDRESS_DESTINATION }];
  }

  return [
    ...wallets.walletRecords
      .filter(walletRecord => walletRecord.walletType === 'ethereum')
      .map(walletRecord => ({
        name: walletRecord.name,
        value: getEthereumDestinationValue(walletRecord.id),
      })),
    {
      name: 'Argon Network Address',
      value: ARGON_ADDRESS_DESTINATION,
    },
  ];
});
const selectedEthereumWalletRecord = Vue.computed(() => {
  const walletRecordId = getSelectedEthereumWalletRecordId();
  if (walletRecordId === undefined) return;
  return wallets.walletRecords.find(
    walletRecord => walletRecord.id === walletRecordId && walletRecord.walletType === 'ethereum',
  );
});
const selectedEthereumWallet = Vue.computed(() =>
  selectedEthereumWalletRecord.value
    ? wallets.getEthereumWalletRecord(selectedEthereumWalletRecord.value.id)
    : undefined,
);
const selectedEthereumMoveToken = Vue.computed<IEthereumMoveToken | undefined>(() => {
  if (selectedMoveToken.value === MoveToken.BTC) return;
  return selectedMoveToken.value;
});
const ethereumBalanceWei = Vue.computed(
  () => selectedEthereumWallet.value?.otherTokens.find(token => token.symbol === 'ETH')?.value ?? 0n,
);

function getAvailableAmount(moveToken: MoveToken) {
  if (moveToken === MoveToken.BTC) return 0n;
  const wallet = wallets.defaultArgonWallet;
  const rawAmount = moveToken === MoveToken.ARGN ? wallet.availableMicrogons : wallet.availableMicronots;
  const ethereumAddress = selectedEthereumWalletRecord.value?.address;
  if (!ethereumAddress) return rawAmount;
  const reserved = outboundTracker.getPendingAmount(wallet.address, ethereumAddress, moveToken);
  return bigIntMax(rawAmount - reserved, 0n);
}

const availableAmount = Vue.computed(() => getAvailableAmount(selectedMoveToken.value));
const maxValue = Vue.computed(() =>
  selectedEthereumWalletRecord.value ? (maximumTransferOutAmount.value ?? 0n) : availableAmount.value,
);
const hasSufficientFeeBalance = Vue.computed(
  () => feeEstimateWei.value != null && ethereumBalanceWei.value >= feeEstimateWei.value,
);
const canInitiateTransfer = Vue.computed(
  () =>
    transferForm.value.isReady &&
    !!selectedEthereumWalletRecord.value &&
    !!selectedEthereumMoveToken.value &&
    !isInitiatingTransfer.value &&
    !isEstimatingFees.value &&
    !ethereumFeeEstimateError.value &&
    feeEstimateWei.value != null &&
    hasSufficientFeeBalance.value &&
    tokensToMove.value > 0n &&
    tokensToMove.value <= maxValue.value,
);
const progressView = Vue.computed(() =>
  getCrosschainTransferProgressView(activeTransfer.value?.transferState, progressNow.value),
);

function getEthereumDestinationValue(walletRecordId: number) {
  return ETHEREUM_DESTINATION_PREFIX + walletRecordId;
}

function getSelectedEthereumWalletRecordId() {
  if (!selectedDestination.value.startsWith(ETHEREUM_DESTINATION_PREFIX)) return;
  const walletRecordId = Number(selectedDestination.value.slice(ETHEREUM_DESTINATION_PREFIX.length));
  return Number.isFinite(walletRecordId) ? walletRecordId : undefined;
}

function getSelectedDestinationConnectorId() {
  if (selectedMoveToken.value === MoveToken.BTC) return 'bitcoin';
  return getSelectedEthereumWalletRecordId();
}

async function initiateTransfer() {
  const ethereumWallet = selectedEthereumWalletRecord.value;
  const moveToken = selectedEthereumMoveToken.value;
  if (!ethereumWallet || !moveToken || !canInitiateTransfer.value) return;
  isInitiatingTransfer.value = true;
  formError.value = '';
  try {
    const transfer = await outboundTracker.startMove({
      moveToken,
      amount: tokensToMove.value,
      availableAmount: availableAmount.value,
      sourceWalletType: WalletType.argon,
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
    await outboundTracker.dismissFailedTransfer(current.id);
  } else if (current?.transferState.isComplete) {
    outboundTracker.clearCompletedTransfer(current.id);
  }
  activeTransfer.value = undefined;
  tokensToMove.value = maxValue.value;
  formError.value = '';
}

async function updateFees(onCleanup: (cleanupFn: () => void) => void) {
  ethereumFeeEstimateError.value = '';
  const ethereumWallet = selectedEthereumWalletRecord.value;
  const moveToken = selectedEthereumMoveToken.value;
  isEstimatingFees.value = tokensToMove.value > 0n && !!ethereumWallet && !!moveToken;
  if (tokensToMove.value <= 0n || !ethereumWallet || !moveToken) {
    feeEstimateWei.value = undefined;
    feeEstimateMicrogon.value = undefined;
    feeEstimateMicronot.value = undefined;
    return;
  }

  let cancelled = false;
  onCleanup(() => (cancelled = true));
  try {
    const [ethereumFeeRange, argonFees] = await Promise.all([
      outboundTracker.estimateFeeRangeWei({
        moveToken,
        amount: tokensToMove.value,
        ethereumWallet,
      }),
      outboundTracker.estimateArgonFees({
        moveToken,
        amount: tokensToMove.value,
        sourceWalletType: WalletType.argon,
        ethereumWallet,
      }),
    ]);
    let microgonFeeEstimate = argonFees.transactionFeeMicrogons;
    let micronotFeeEstimate = 0n;
    if (moveToken === MoveToken.ARGN) {
      microgonFeeEstimate += argonFees.mintingAuthorityTip;
    } else {
      micronotFeeEstimate = argonFees.mintingAuthorityTip;
    }
    if (!cancelled) {
      feeEstimateWei.value = ethereumFeeRange?.[1];
      feeEstimateMicrogon.value = microgonFeeEstimate;
      feeEstimateMicronot.value = micronotFeeEstimate;
    }
  } catch (error) {
    if (!cancelled) {
      ethereumFeeEstimateError.value = error instanceof Error ? error.message : 'Unable to estimate the transfer fees.';
    }
  } finally {
    if (!cancelled) isEstimatingFees.value = false;
  }
}

Vue.watch(
  () => [props.activeConnector, destinationOptions.value] as const,
  ([activeConnector, options]) => {
    const requestedDestination =
      activeConnector?.network === 'ethereum' ? getEthereumDestinationValue(activeConnector.walletRecordId) : undefined;
    if (requestedDestination && options.some(option => option.value === requestedDestination)) {
      selectedDestination.value = requestedDestination;
      return;
    }
    if (options.some(option => option.value === selectedDestination.value)) return;
    selectedDestination.value = options[0]?.value ?? ARGON_ADDRESS_DESTINATION;
  },
  { immediate: true },
);

Vue.watch(
  () => [selectedMoveToken.value, selectedDestination.value] as const,
  () => emit('selectDestinationConnector', getSelectedDestinationConnectorId()),
  {
    immediate: true,
    flush: 'post',
  },
);

Vue.watch(
  () => [selectedDestination.value, selectedMoveToken.value, availableAmount.value] as const,
  async ([destination, token, available], _, onCleanup) => {
    maximumTransferOutAmount.value = undefined;
    formError.value = '';
    if (
      token === MoveToken.BTC ||
      destination === ARGON_ADDRESS_DESTINATION ||
      destination === BITCOIN_ADDRESS_DESTINATION ||
      available <= 0n
    )
      return;
    let cancelled = false;
    onCleanup(() => (cancelled = true));
    try {
      const maximum = await outboundTracker.getMaximumTransferOutAmount(available, token);
      if (!cancelled) maximumTransferOutAmount.value = maximum;
    } catch (error) {
      if (!cancelled)
        formError.value = error instanceof Error ? error.message : 'Unable to calculate the maximum transfer.';
    }
  },
  { immediate: true },
);

Vue.watch(
  () => [
    selectedDestination.value,
    selectedEthereumMoveToken.value,
    selectedEthereumMoveToken.value
      ? outboundTracker.data.latestTransferIdByToken[selectedEthereumMoveToken.value]
      : undefined,
  ],
  ([destination, _moveToken, transferId]) => {
    if (destination === ARGON_ADDRESS_DESTINATION || destination === BITCOIN_ADDRESS_DESTINATION || !transferId) {
      activeTransfer.value = undefined;
      return;
    }
    const transfer = outboundTracker.getTransfer(transferId);
    const transferDestination = transfer?.persistedRecord?.destinationAddress ?? transfer?.destinationAddress;
    if (transferDestination?.toLowerCase() === selectedEthereumWalletRecord.value?.address.toLowerCase()) {
      activeTransfer.value = transfer;
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
Vue.onMounted(() => {
  progressRefreshInterval = setInterval(() => (progressNow.value = Date.now()), 1_000);
});
Vue.onUnmounted(() => {
  if (progressRefreshInterval) clearInterval(progressRefreshInterval);
});
</script>
