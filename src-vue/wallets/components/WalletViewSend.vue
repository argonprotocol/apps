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
        <strong>{{ selectedEthereumWallet?.name }}</strong>
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
        :fromWallet="wallets.argonWallets.defaultArgonWallet"
        :toWallets="toWallets"
        testIdPrefix="WalletViewSend"
        ref="transferForm"
        @selectDestinationWallet="selectDestinationWallet"
      />

      <div class="mt-8 mb-2 flex flex-row gap-x-2">
        <button
          v-if="!isInitiatingTransfer"
          class="border-argon-600 text-argon-600 cursor-pointer rounded-lg border px-5 py-1"
          @click="emit('goto', 'main')"
        >
          Cancel
        </button>
        <button
          v-if="selectedEthereumWallet"
          :disabled="!canInitiateTransfer"
          class="border-argon-700 bg-argon-600 grow cursor-pointer rounded-lg border px-5 py-1 text-white disabled:cursor-default disabled:border-gray-400 disabled:bg-gray-300 disabled:text-gray-500"
          @click="initiateTransfer"
        >
          {{ isInitiatingTransfer ? 'Initiating Transfer...' : 'Initiate Transfer' }} &raquo;
        </button>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import * as Vue from 'vue';
import { MoveToken } from '@argonprotocol/apps-core';
import type { IWalletGuidanceContext } from '../../emitters/basicEmitter.ts';
import type { IEthereumOutboundActiveTransfer } from '../../lib/EthereumOutboundTransferTracker.ts';
import { WalletType } from '../../lib/Wallet.ts';
import type { WalletForEthereum } from '../../lib/WalletForEthereum.ts';
import { createNumeralHelpers } from '../../lib/numeral.ts';
import numeral from '../../lib/numeral.ts';
import { getCurrency } from '../../stores/currency.ts';
import { getEthereumOutboundTransferTracker } from '../../stores/moveToEthereum.ts';
import { useWallets } from '../../stores/wallets.ts';
import ProgressBar from '../../components/ProgressBar.vue';
import WalletHeader from './WalletHeader.vue';
import WalletTransferForm, { type ITransferWallet } from './WalletTransferForm.vue';
import { getCrosschainTransferProgressView } from './crosschainTransferView.ts';
import type { IWalletConnector, IWalletView } from '../walletOverlayState.ts';

const props = defineProps<{
  isDragging: boolean;
  activeConnector?: IWalletConnector;
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

const selectedDestinationWallet = Vue.ref<ITransferWallet>();
const activeTransfer = Vue.ref<IEthereumOutboundActiveTransfer>();
const isInitiatingTransfer = Vue.ref(false);
const progressNow = Vue.ref(Date.now());
let progressRefreshInterval: ReturnType<typeof setInterval> | undefined;

const toWallets = Vue.computed<ITransferWallet[]>(() => {
  const ethereumWallets = [...wallets.ethereumWallets.persistedWallets];
  const activeConnector = props.activeConnector;
  if (isEthereumWallet(activeConnector)) {
    ethereumWallets.sort(
      (walletA, walletB) => Number(walletB.id === activeConnector.id) - Number(walletA.id === activeConnector.id),
    );
  }
  return [...ethereumWallets, wallets.argonWallets.defaultArgonWallet, wallets.bitcoinWallet];
});
const selectedEthereumWallet = Vue.computed(() =>
  isEthereumWallet(selectedDestinationWallet.value) ? selectedDestinationWallet.value : undefined,
);
const canInitiateTransfer = Vue.computed(
  () => transferForm.value?.isReady && !!selectedEthereumWallet.value && !isInitiatingTransfer.value,
);
const progressView = Vue.computed(() =>
  getCrosschainTransferProgressView(activeTransfer.value?.transferState, progressNow.value),
);

function selectDestinationWallet(wallet: ITransferWallet | undefined) {
  selectedDestinationWallet.value = wallet;
  emit('selectDestinationConnector', isEthereumWallet(wallet) ? wallet.id : wallet?.type);
}

function isEthereumWallet(wallet: ITransferWallet | IWalletConnector | undefined): wallet is WalletForEthereum {
  return wallet?.type === WalletType.ethereum;
}

async function initiateTransfer() {
  const form = transferForm.value;
  const ethereumWallet = selectedEthereumWallet.value;
  const moveToken = form?.selectedMoveToken;
  const amount = form?.tokensToMove;
  const availableAmount = form?.availableAmount;
  if (
    !form ||
    !ethereumWallet ||
    !canInitiateTransfer.value ||
    amount == null ||
    availableAmount == null ||
    (moveToken !== MoveToken.ARGN && moveToken !== MoveToken.ARGNOT)
  )
    return;
  isInitiatingTransfer.value = true;
  form.setFormError('');
  try {
    const transfer = await outboundTracker.startMove({
      moveToken,
      amount,
      availableAmount,
      sourceWalletType: WalletType.argon,
      ethereumWallet,
    });
    if (transfer) activeTransfer.value = transfer;
  } catch (error) {
    transferForm.value?.setFormError(error instanceof Error ? error.message : 'Unable to start the transfer.');
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
}

Vue.onMounted(() => {
  progressRefreshInterval = setInterval(() => (progressNow.value = Date.now()), 1_000);
});
Vue.onUnmounted(() => {
  if (progressRefreshInterval) clearInterval(progressRefreshInterval);
});
</script>
