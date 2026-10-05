<template>
  <PopoverRoot :open="props.open" :modal="true" @update:open="emit('update:open', $event)">
    <PopoverTrigger asChild><slot /></PopoverTrigger>
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
              {{ activeTransfer ? 'Sending' : 'Send' }} from
              {{ walletDisplayName }}
            </span>
            <ButtonCopy :address="connectedWallet?.address!" />
            <div v-if="connectedWallet" class="relative shrink-0">
              <ConnectorMenu
                v-model:open="isMenuOpen"
                :wallet="connectedWallet"
                :connectorId="props.connectorId"
                direction="right"
                :showGuidance="!!props.transferGuidance && !activeTransfer && !walletNeedsFunding"
              >
                <button
                  type="button"
                  :aria-label="`${walletDisplayName} options`"
                  class="relative z-10 flex h-[34px] w-[34px] cursor-pointer items-center justify-center rounded-md border border-slate-400/60 text-sm/6 font-semibold text-slate-500/60 hover:border-slate-500/60 hover:bg-[#f1f3f7] focus:outline-none"
                >
                  <MoreIcon class="h-4" />
                </button>
              </ConnectorMenu>
              <ArrowCalloutButton
                v-if="
                  props.transferGuidance &&
                  (transferGuideStep !== 'transfer' || argonAmountToBuy > 0n) &&
                  !walletNeedsFunding &&
                  !isMenuOpen &&
                  !activeTransfer
                "
                guidance="Open this menu for the ARGN and ARGNOT Uniswap markets."
                direction="right"
                class="absolute top-1/2 right-full z-50 mr-3 -translate-y-1/2"
              />
            </div>
            <WalletGuideAnchor
              autoOpenGuidance
              side="left"
              :open="
                !!props.transferGuidance && !!activeTransfer && isCrosschainTransferActive(activeTransfer.transferState)
              "
              guidance="Close this window, then open Transfers Pending to watch your transfer."
              @close="emit('update:open', false)"
            >
              <ButtonClose data-testid="ConnectorTransfer.close()" @close="emit('update:open', false)" />
            </WalletGuideAnchor>
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
            <template v-if="connectedWallet">
              <WalletTransferForm
                :fromWallet="connectedWallet"
                :toWallets="[wallets.argonWallets.defaultArgonWallet]"
                testIdPrefix="ConnectorTransfer"
                ref="transferForm"
              />
              <div class="mt-4">
                <WalletGuideAnchor
                  autoOpenGuidance
                  :open="!!props.transferGuidance && walletNeedsFunding && !isMenuOpen"
                  label="Add ETH"
                  guidancePosition="top"
                  :guidance="
                    ethereumFundingShortfallWei != null && ethereumFundingShortfallWei > 0n
                      ? `Add about ${weiToEthNm(ethereumFundingShortfallWei).format('0.[000]')} ETH to this wallet. This covers buying the ARGN you need, estimated network fees, and about $5 of ETH left over. Use this link to learn how to add ETH.`
                      : 'Add ETH to this wallet to buy ARGN and pay network fees. Leave about $5 of ETH after your purchase and transfer. Use this link to learn how to add ETH.'
                  "
                  @close="emit('update:open', false)"
                >
                  <a
                    href="https://support.uniswap.org/hc/en-us/articles/25655102348813-How-to-buy-crypto-in-the-Uniswap-Wallet"
                    target="_blank"
                    rel="noopener noreferrer"
                    class="text-argon-600 hover:text-argon-700 underline"
                  >
                    How to add funds to Uniswap ↗
                  </a>
                </WalletGuideAnchor>
              </div>
              <div
                class="mt-8 mb-2 flex gap-x-2"
                :class="props.direction === 'right' ? 'flex-row-reverse' : 'flex-row'"
              >
                <button
                  v-if="!isInitiatingTransfer"
                  class="border-argon-600 text-argon-600 cursor-pointer rounded-lg border px-5 py-1"
                  @click="emit('update:open', false)"
                >
                  Cancel
                </button>
                <div class="grow">
                  <WalletGuideAnchor
                    :open="
                      showTransferGuidance &&
                      !!canInitiateTransfer &&
                      transferForm?.selectedMoveToken === MoveToken.ARGN
                    "
                    side="left"
                    :guidance="props.transferGuidance ?? ''"
                    @close="emit('update:open', false)"
                  >
                    <button
                      :disabled="!canInitiateTransfer"
                      class="border-argon-700 bg-argon-600 w-full cursor-pointer rounded-lg border px-5 py-1 text-white disabled:cursor-default disabled:border-gray-400 disabled:bg-gray-300 disabled:text-gray-500"
                      @click="initiateTransfer"
                    >
                      &laquo; {{ isInitiatingTransfer ? 'Initiating Transfer...' : `Initiate Transfer` }}
                    </button>
                  </WalletGuideAnchor>
                </div>
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
import { bigIntMax, MoveToken, raceWithTimeout } from '@argonprotocol/apps-core';
import { EvmContracts, MICROGONS_PER_ARGON } from '@argonprotocol/mainchain';
import BigNumber from 'bignumber.js';
import {
  PopoverArrow,
  PopoverContent,
  PopoverPortal,
  PopoverRoot,
  PopoverTrigger,
  type PointerDownOutsideEvent,
} from 'reka-ui';
import ProgressBar from '../../components/ProgressBar.vue';
import ArrowCalloutButton from '../../components/ArrowCalloutButton.vue';
import MoreIcon from '../../assets/more.svg';
import type { IEthereumInboundActiveTransfer } from '../../lib/EthereumInboundTransferTracker.ts';
import { createEthereumPublicClient } from '../../lib/EthereumClient.ts';
import { WalletType } from '../../lib/Wallet.ts';
import { createNumeralHelpers } from '../../lib/numeral.ts';
import numeral from '../../lib/numeral.ts';
import { useFloatingZIndex } from '../../overlays/helpers/OverlayZIndex.ts';
import { getCurrency } from '../../stores/currency.ts';
import { getConfig } from '../../stores/config.ts';
import { useCertificationController } from '../../stores/certificationController.ts';
import { getEthereumMoveTracker } from '../../stores/moveFromEthereum.ts';
import { useWallets } from '../../stores/wallets.ts';
import { getCrosschainTransferProgressView, isCrosschainTransferActive } from './crosschainTransferView.ts';
import ButtonClose from './ButtonClose.vue';
import ButtonCopy from './ButtonCopy.vue';
import WalletTransferForm from './WalletTransferForm.vue';
import WalletGuideAnchor from './WalletGuideAnchor.vue';
import ConnectorMenu from './ConnectorMenu.vue';

const props = defineProps<{
  connectorId?: string;
  direction: 'right' | 'left';
  open: boolean;
  moveToken?: MoveToken.ARGN | MoveToken.ARGNOT;
  walletName?: string;
  transferGuidance?: string;
}>();
const emit = defineEmits<{ (event: 'update:open', value: boolean): void }>();

const wallets = useWallets();
const currency = getCurrency();
const config = getConfig();
const controller = useCertificationController();
const inboundTracker = getEthereumMoveTracker();

const { microgonToArgonNm, weiToEthNm } = createNumeralHelpers(currency);

const transferForm = Vue.ref<InstanceType<typeof WalletTransferForm>>();

const floatingZIndex = useFloatingZIndex();
const activeTransfer = Vue.ref<IEthereumInboundActiveTransfer>();
const isInitiatingTransfer = Vue.ref(false);
const isMenuOpen = Vue.ref(false);
const transferGuideStep = Vue.ref<'funding' | 'transfer'>('funding');
const fundingFeePerGasWei = Vue.ref<bigint>();
const progressNow = Vue.ref(Date.now());
let progressRefreshInterval: ReturnType<typeof setInterval> | undefined;

const connectedWallet = Vue.computed(() => wallets.ethereumWallets.find(Number(props.connectorId)));
const ethereumBalanceWei = Vue.computed(
  () => connectedWallet.value?.data.otherTokens.find(token => token.symbol === 'ETH')?.value ?? 0n,
);
const argonAmountToBuy = Vue.computed(() =>
  bigIntMax(controller.remainingUniswapTransferMicrogons - (connectedWallet.value?.data.availableMicrogons ?? 0n), 0n),
);
const ethereumFundingShortfallWei = Vue.computed(() => {
  const balance = connectedWallet.value?.data;
  const argonUsdPrice = currency.priceIndex.argonUsdPrice;
  if (
    !balance?.balanceUpdatedAt ||
    balance.fetchErrorMsg ||
    !controller.isLoaded ||
    !currency.hasEthPrice ||
    !argonUsdPrice ||
    argonUsdPrice.lte(0) ||
    fundingFeePerGasWei.value == null
  )
    return;

  const purchaseUsd = BigNumber(argonAmountToBuy.value.toString()).dividedBy(MICROGONS_PER_ARGON).times(argonUsdPrice);
  // Budget 300k gas per remaining step: the Uniswap purchase and the Argon transfer.
  const feeAllowanceWei = fundingFeePerGasWei.value * (argonAmountToBuy.value > 0n ? 600_000n : 300_000n);
  const shortfallWei = purchaseUsd
    .plus(5)
    .times(currency.microgonsPer.USD.toString())
    .dividedBy(currency.microgonsPer.ETH.toString())
    .shiftedBy(18)
    .plus(feeAllowanceWei.toString())
    .minus(ethereumBalanceWei.value.toString());

  // Round the amount to add upward to the three ETH decimals shown in the guide.
  return bigIntMax(BigInt(shortfallWei.shiftedBy(-15).integerValue(BigNumber.ROUND_CEIL).toFixed()) * 10n ** 15n, 0n);
});
const walletNeedsFunding = Vue.computed(() => {
  const balance = connectedWallet.value?.data;
  if (!balance?.balanceUpdatedAt || balance.fetchErrorMsg) return false;
  return ethereumFundingShortfallWei.value != null
    ? ethereumFundingShortfallWei.value > 0n
    : argonAmountToBuy.value > 0n || ethereumBalanceWei.value === 0n;
});
const showTransferGuidance = Vue.computed(
  () =>
    !!props.transferGuidance &&
    transferGuideStep.value === 'transfer' &&
    !walletNeedsFunding.value &&
    argonAmountToBuy.value === 0n &&
    !isMenuOpen.value,
);

const walletDisplayName = Vue.computed(() => props.walletName ?? connectedWallet.value?.name ?? 'Ethereum Wallet');
const canInitiateTransfer = Vue.computed(
  () => transferForm.value?.isReady && !!connectedWallet.value && !isInitiatingTransfer.value,
);
const progressView = Vue.computed(() =>
  getCrosschainTransferProgressView(activeTransfer.value?.transferState, progressNow.value),
);

async function initiateTransfer() {
  const form = transferForm.value;
  const ethereumWallet = connectedWallet.value;
  const moveToken = form?.selectedMoveToken;
  const amount = form?.tokensToMove;
  if (
    !form ||
    !ethereumWallet ||
    !canInitiateTransfer.value ||
    amount == null ||
    (moveToken !== MoveToken.ARGN && moveToken !== MoveToken.ARGNOT)
  )
    return;
  isInitiatingTransfer.value = true;
  form.setFormError('');
  try {
    const transfer = await inboundTracker.startMove({
      moveToken,
      amountBaseUnits: amount * EvmContracts.MINTING_GATEWAY_RUNTIME_TO_ERC20_SCALE,
      targetWalletType: WalletType.argon,
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
    await inboundTracker.dismissFailedTransfer(current.id);
  } else if (current?.transferState.isComplete) {
    inboundTracker.clearCompletedTransfer(current.id);
  }
  activeTransfer.value = undefined;
}

function keepOpenForRelatedConnector(event: PointerDownOutsideEvent) {
  const target = event.detail.originalEvent.target;
  if (!(target instanceof Element)) return;
  if (target.closest('[data-wallet-connector-id]')?.getAttribute('data-wallet-connector-id') === props.connectorId)
    event.preventDefault();
}

Vue.watch(
  () => props.moveToken,
  async token => {
    await Vue.nextTick();
    transferForm.value?.setMoveToken(token ?? MoveToken.ARGN);
  },
  { immediate: true, flush: 'post' },
);
Vue.watch(isMenuOpen, open => {
  if (open && !walletNeedsFunding.value) {
    transferGuideStep.value = 'transfer';
  }
});
Vue.watch(
  () => [props.open, props.transferGuidance, config.ethereumExecutionRpcUrl] as const,
  async ([open, guidance, executionRpcUrl], _previous, onCleanup) => {
    if (!open || !guidance) return;
    let cancelled = false;
    onCleanup(() => (cancelled = true));
    try {
      const feePerGasWei = await raceWithTimeout(
        (async () => {
          const client = createEthereumPublicClient(undefined, executionRpcUrl);
          const fees = await client.estimateFeesPerGas();
          return fees.maxFeePerGas ?? fees.gasPrice ?? (await client.getGasPrice());
        })(),
        15_000,
        () => {
          throw new Error('Ethereum funding fee estimate timed out.');
        },
      );
      if (!cancelled) fundingFeePerGasWei.value = feePerGasWei;
    } catch (error) {
      if (!cancelled) console.warn('Unable to estimate Ethereum wallet funding fees.', error);
    }
  },
  { immediate: true },
);
Vue.watch(
  () => props.open,
  open => {
    if (!open) activeTransfer.value = undefined;
  },
);
Vue.onMounted(() => {
  progressRefreshInterval = setInterval(() => (progressNow.value = Date.now()), 1_000);
});
Vue.onUnmounted(() => {
  if (progressRefreshInterval) clearInterval(progressRefreshInterval);
});
</script>
