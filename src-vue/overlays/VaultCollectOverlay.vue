<!-- prettier-ignore -->
<template>
  <OverlayBase
    :isOpen="isOpen"
    :showCloseIcon="true"
    :title="overlayTitle"
    @close="closeOverlay"
    class="">
    <div box class="flex flex-col gap-y-6 px-5 py-3">
      <div
        v-if="!showCollectSection && !showMintingAuthorizeSection"
        class="rounded-md border border-slate-200 bg-slate-50 px-4 py-5 text-sm text-slate-600">
        No vault actions are currently available.
      </div>

      <section v-if="showCollectSection" class="flex flex-col gap-y-3">
        <div v-if="collectRevenue">
          <p>
            Your vault has
            <strong>
              {{ currency.symbol }}{{ microgonToMoneyNm(collectRevenue).formatIfElse('< 1_000', '0,0.00', '0,0') }}
            </strong>
            in uncollected revenue.
            <CountdownClock :time="nextCollectDueDate" v-slot="{ hours, minutes, days, seconds }">
              <template v-if="hours || minutes || days || seconds">
                You must collect this within
                <span>
                  <span v-if="days > 0">{{ days }} day{{ days === 1 ? '' : 's' }}</span>
                  <span v-else-if="hours || minutes > 0">
                    <span class="mr-2" v-if="hours">{{ hours }} hour{{ hours === 1 ? '' : 's' }}</span>
                    <span v-if="minutes">{{ minutes }} minute{{ minutes === 1 ? '' : 's' }}</span>
                  </span>
                  <span v-else-if="seconds">{{ seconds }} second{{ seconds === 1 ? '' : 's' }}</span>
                </span>;
                if not,
                <strong>
                  {{ currency.symbol
                  }}{{ microgonToMoneyNm(myVault.data.expiringCollectAmount).formatIfElse('< 1_000', '0,0.00', '0,0') }}
                </strong>
                will be lost forever. Where should this capital be placed?
              </template>
            </CountdownClock>
          </p>

          <InputMenu
            v-model="moveTo"
            :options="[
              { name: 'Vaulting Account', value: MoveTo.VaultingHold },
              { name: 'Mining Account', value: MoveTo.MiningHold },
            ]"
            class="mt-5 flex max-w-2/3" />
        </div>

        <p v-if="manualPendingCosignCount">
          {{ collectRevenue ? 'Also, you' : 'You' }} have
          <strong>
            {{ manualPendingCosignCount }} transaction{{ manualPendingCosignCount === 1 ? '' : 's' }}
          </strong>
          that must be signed. Failure to do so within
          <CountdownClock :time="nextCosignDueDate" v-slot="{ hours, minutes, days }">
            <span v-if="days > 0">{{ days }} day{{ days === 1 ? '' : 's' }}</span>
            <template v-else>
              <span class="mr-2" v-if="hours">{{ hours }} hour{{ hours === 1 ? '' : 's' }}</span>
              <span v-if="minutes">{{ minutes }} minute{{ minutes === 1 ? '' : 's' }}</span>
            </template>
          </CountdownClock>
          will result in your vault forfeiting
          <strong>
            {{ currency.symbol }}{{ microgonToMoneyNm(manualPendingCosignSum).formatIfElse('< 1_000', '0,0.00', '0,0') }}
          </strong>
          in securitization.
        </p>

        <div
          v-if="councilApprovalCount"
          class="rounded-md bg-slate-50 px-4 py-3 text-sm text-slate-700">
          <p>
            <template v-if="collectRevenue || manualPendingCosignCount">This transaction will also record </template>
            <template v-else>The next transaction will record </template>
            <strong>
              {{ councilApprovalCount }} council approval{{ councilApprovalCount === 1 ? '' : 's' }}
            </strong>
            for pending Ethereum gateway updates.
          </p>
        </div>

        <div v-if="collectError" class="rounded-md border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
          {{ collectError }}
        </div>

        <button
          @click="submitCollect"
          :disabled="isCollectBusy || !hasCollectWork"
          class="bg-argon-600 hover:bg-argon-700 mt-2 mb-1 cursor-pointer rounded-md px-6 py-2 text-lg font-bold text-white disabled:cursor-default disabled:opacity-40">
          {{ collectButtonLabel }}
        </button>

        <div v-if="showCollectProgress" class="rounded-md border border-slate-200 bg-slate-50 px-4 py-4">
          <div class="mb-3 text-sm font-semibold text-slate-700">
            {{
              activeCollectTransactionCount === 1
                ? 'Submitting...'
                : `Submitting ${activeCollectTransactionCount} transactions...`
            }}
          </div>

          <ProgressBar :progress="collectProgressPct" :showLabel="false" class="h-4" />

          <div class="mt-3 text-sm text-slate-500">
            {{ collectProgressLabel || 'Preparing transaction...' }}
          </div>
        </div>
      </section>

      <section v-if="showMintingAuthorizeSection" class="flex flex-col gap-y-3 border-t border-slate-200 pt-6">
        <div>
          <div class="text-lg font-semibold text-slate-800">Authorize Crosschain Transfers</div>
          <p v-if="isMintingAuthorizeBusy && pendingAuthorizedTransferCount > 0" class="mt-2 text-sm text-slate-600">
            Authorizing
            <strong>
              {{ pendingAuthorizedTransferCount }} crosschain transfer{{
                pendingAuthorizedTransferCount === 1 ? '' : 's'
              }}
            </strong>
            <template v-if="pendingAuthorizedTransferRewardAmount > 0n">
              for
              <strong>
                {{ currency.symbol
                }}{{ microgonToMoneyNm(pendingAuthorizedTransferRewardAmount).formatIfElse('< 1_000', '0,0.00', '0,0') }}
              </strong>.
            </template>
            <span v-else>.</span>
          </p>

          <p v-else-if="mintingAuthorizeOpportunityCount > 0" class="mt-2 text-sm text-slate-600">
            You have
            <strong>
              {{ mintingAuthorizeOpportunityCount }} crosschain authorization{{ mintingAuthorizeOpportunityCount === 1 ? '' : 's' }}
            </strong>
            ready on Argon
            <template v-if="mintingAuthorizeRewardAmount > 0n">
              for
              <strong>
                {{ currency.symbol
                }}{{ microgonToMoneyNm(mintingAuthorizeRewardAmount).formatIfElse('< 1_000', '0,0.00', '0,0') }}
              </strong>.
            </template>
            <span v-else>.</span>
          </p>

          <p v-else class="mt-2 text-sm text-slate-600">No crosschain authorizations are currently available.</p>
        </div>

        <div
          v-if="mintingAuthorizeUpdateMessage"
          class="rounded-md border border-sky-200 bg-sky-50 px-4 py-3 text-sm text-sky-700">
          {{ mintingAuthorizeUpdateMessage }}
        </div>

        <div v-if="mintingAuthorizeError" class="rounded-md border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
          {{ mintingAuthorizeError }}
        </div>

        <button
          @click="submitMintingAuthorize"
          :disabled="isMintingAuthorizeBusy || authorizedTransferCount === 0"
          class="bg-argon-600 hover:bg-argon-700 mt-2 mb-1 cursor-pointer rounded-md px-6 py-2 text-lg font-bold text-white disabled:cursor-default disabled:opacity-40">
          {{ mintingAuthorizeButtonLabel }}
        </button>

        <div v-if="showMintingAuthorizeProgress" class="rounded-md border border-slate-200 bg-slate-50 px-4 py-4">
          <div class="mb-3 text-sm font-semibold text-slate-700">
            {{
              activeMintingAuthorizeTransactionCount === 1
                ? 'Submitting crosschain authorization on Argon...'
                : `Submitting ${activeMintingAuthorizeTransactionCount} crosschain authorizations on Argon...`
            }}
          </div>

          <ProgressBar :progress="mintingAuthorizeProgressPct" :showLabel="false" class="h-4" />

          <div class="mt-3 text-sm text-slate-500">
            {{ mintingAuthorizeProgressLabel || 'Preparing transaction...' }}
          </div>
        </div>
      </section>
    </div>
  </OverlayBase>
</template>

<script setup lang="ts">
import * as Vue from 'vue';
import dayjs from 'dayjs';
import utc from 'dayjs/plugin/utc';
import CountdownClock from '../components/CountdownClock.vue';
import { getMyVault } from '../stores/vaults.ts';
import { getCurrency } from '../stores/currency.ts';
import { createNumeralHelpers } from '../lib/numeral.ts';
import ProgressBar from '../components/ProgressBar.vue';
import OverlayBase from './OverlayBase.vue';
import InputMenu from '../components/InputMenu.vue';
import { MoveTo } from '@argonprotocol/apps-core';
import { TransactionInfo } from '../lib/TransactionInfo.ts';
import type { IMintingAuthorityAuthorizeMetadata } from '../lib/MintingAuthorities.ts';
import type { IVaultCollectMetadata } from '../lib/VaultCollectBuilder.ts';

dayjs.extend(utc);

const emit = defineEmits<{
  close: [];
}>();

const myVault = getMyVault();
const currency = getCurrency();
const { microgonToMoneyNm } = createNumeralHelpers(currency);

const isOpen = Vue.ref(true);
const moveTo = Vue.ref<MoveTo>(MoveTo.VaultingHold);

const collectRevenue = Vue.ref(0n);
const councilApprovalCount = Vue.ref(0);
const authorizedTransferCount = Vue.ref(0);
const authorizedTransferRewardAmount = Vue.ref(0n);
const pendingAuthorizedTransferCount = Vue.ref(0);
const pendingAuthorizedTransferRewardAmount = Vue.ref(0n);
const manualPendingCosignCount = Vue.ref(0);
const manualPendingCosignSum = Vue.ref(0n);
const nextCollectDueDate = Vue.ref(dayjs.utc(0));
const nextCosignDueDate = Vue.ref(dayjs.utc(0));
const registeredMintingAuthorityCount = Vue.ref(0);

const isSubmittingCollect = Vue.ref(false);
const collectProgressPct = Vue.ref(0);
const collectProgressLabel = Vue.ref('');
const collectError = Vue.ref('');
const activeCollectTransactionCount = Vue.ref(0);

const isSubmittingMintingAuthorize = Vue.ref(false);
const mintingAuthorizeProgressPct = Vue.ref(0);
const mintingAuthorizeProgressLabel = Vue.ref('');
const mintingAuthorizeError = Vue.ref('');
const mintingAuthorizeUpdateMessage = Vue.ref('');
const activeMintingAuthorizeTransactionCount = Vue.ref(0);

const latestMyPendingBitcoinCosignTxInfo = Vue.computed(() => {
  return Array.from(myVault.data.myPendingBitcoinCosignTxInfosByUtxoId.values()).at(-1);
});

const activeCollectTxInfos = Vue.computed(() => {
  const txInfos: TransactionInfo[] = [];
  const pendingCollectTxInfo = myVault.data.pendingCollectTxInfo;
  if (pendingCollectTxInfo && !pendingCollectTxInfo.isPostProcessed) {
    txInfos.push(pendingCollectTxInfo);
  }

  const pendingBitcoinCosignTxInfo = latestMyPendingBitcoinCosignTxInfo.value;
  if (pendingBitcoinCosignTxInfo && !pendingBitcoinCosignTxInfo.isPostProcessed) {
    txInfos.push(pendingBitcoinCosignTxInfo);
  }

  return getUniqueTransactionInfos(txInfos);
});

const activeMintingAuthorizeTxInfos = Vue.computed(() => {
  return getUniqueTransactionInfos([
    ...myVault.mintingAuthorities.data.pendingMintingAuthorizeTxInfosByTransferId.values(),
  ]) as TransactionInfo<IMintingAuthorityAuthorizeMetadata>[];
});

const activeCollectActionType = Vue.computed<IVaultCollectMetadata['actionType'] | undefined>(() => {
  const pendingCollectTxInfo = myVault.data.pendingCollectTxInfo;
  if (pendingCollectTxInfo && !pendingCollectTxInfo.isPostProcessed) {
    return pendingCollectTxInfo.tx.metadataJson.actionType;
  }

  const pendingBitcoinCosignTxInfo = latestMyPendingBitcoinCosignTxInfo.value;
  if (pendingBitcoinCosignTxInfo && !pendingBitcoinCosignTxInfo.isPostProcessed) {
    return 'cosignBitcoin';
  }
});

const hasCollectWork = Vue.computed(() => {
  return collectRevenue.value > 0n || manualPendingCosignCount.value > 0 || councilApprovalCount.value > 0;
});

const isCollectBusy = Vue.computed(() => {
  return isSubmittingCollect.value || activeCollectTxInfos.value.length > 0;
});

const isMintingAuthorizeBusy = Vue.computed(() => {
  return isSubmittingMintingAuthorize.value || activeMintingAuthorizeTxInfos.value.length > 0;
});

const showCollectSection = Vue.computed(() => {
  return hasCollectWork.value || isCollectBusy.value || !!collectError.value;
});

const showMintingAuthorizeSection = Vue.computed(() => {
  return (
    registeredMintingAuthorityCount.value > 0 &&
    (authorizedTransferCount.value > 0 ||
      isMintingAuthorizeBusy.value ||
      !!mintingAuthorizeError.value ||
      !!mintingAuthorizeUpdateMessage.value)
  );
});

const showCollectProgress = Vue.computed(() => {
  return isCollectBusy.value || collectProgressPct.value > 0;
});

const showMintingAuthorizeProgress = Vue.computed(() => {
  return isMintingAuthorizeBusy.value || mintingAuthorizeProgressPct.value > 0;
});

const mintingAuthorizeOpportunityCount = Vue.computed(() => {
  return authorizedTransferCount.value;
});

const mintingAuthorizeRewardAmount = Vue.computed(() => {
  return authorizedTransferRewardAmount.value;
});

const overlayTitle = Vue.computed(() => {
  if (isCollectBusy.value) {
    return getCollectActionTitle(activeCollectActionType.value);
  }
  if (collectRevenue.value > 0n && manualPendingCosignCount.value > 0) {
    return 'Collect Revenue and Cosign';
  }
  if (collectRevenue.value > 0n) {
    return 'Collect Revenue';
  }
  return 'Vault Approvals';
});

const collectButtonLabel = Vue.computed(() => {
  if (isCollectBusy.value) {
    return getCollectBusyLabel(activeCollectActionType.value);
  }
  if (collectRevenue.value > 0n && manualPendingCosignCount.value === 0 && councilApprovalCount.value === 0) {
    return 'Collect Revenue';
  }
  if (collectRevenue.value === 0n && manualPendingCosignCount.value > 0 && councilApprovalCount.value === 0) {
    return 'Sign Bitcoin Transactions';
  }
  if (collectRevenue.value === 0n && manualPendingCosignCount.value === 0 && councilApprovalCount.value > 0) {
    return 'Approve Council Updates';
  }
  return 'Submit Vault Actions';
});

const mintingAuthorizeButtonLabel = Vue.computed(() => {
  if (isMintingAuthorizeBusy.value) {
    return 'Submitting...';
  }
  if (mintingAuthorizeOpportunityCount.value === 1) {
    return 'Crosschain Transfer Authorization';
  }
  if (mintingAuthorizeOpportunityCount.value === 0) {
    return 'Crosschain Transfer Authorizations';
  }
  return `${mintingAuthorizeOpportunityCount.value} Crosschain Transfer Authorizations`;
});

function closeOverlay() {
  isOpen.value = false;
  emit('close');
}

function syncNoticeState() {
  const notice = myVault.collectBuilder.getNotice();
  collectRevenue.value = notice?.collectRevenue ?? 0n;
  councilApprovalCount.value = notice?.councilApprovalCount ?? 0;
  authorizedTransferCount.value = notice?.authorizedTransferCount ?? 0;
  authorizedTransferRewardAmount.value = notice?.authorizedTransferRewardAmount ?? 0n;
  pendingAuthorizedTransferCount.value = notice?.pendingAuthorizedTransferCount ?? 0;
  pendingAuthorizedTransferRewardAmount.value = notice?.pendingAuthorizedTransferRewardAmount ?? 0n;
  manualPendingCosignCount.value = notice?.signatureCount ?? 0;
  manualPendingCosignSum.value = notice?.signaturePenalty ?? 0n;
  nextCollectDueDate.value = dayjs.utc(notice?.nextCollectDueDate ?? 0);
  nextCosignDueDate.value = dayjs.utc(notice?.nextCosignDueDate ?? 0);
  registeredMintingAuthorityCount.value = myVault.mintingAuthorities.data.authorities.length;
}

Vue.watch(
  () => [
    myVault.data.pendingCollectRevenue,
    myVault.data.nextCollectDueDate,
    myVault.data.nextCosignDueDate,
    myVault.data.expiringCollectAmount,
    myVault.globalCouncil.data.pendingApprovals.length,
    myVault.mintingAuthorities.data.authorities.length,
    myVault.mintingAuthorities.data.pendingMintingAuthorizations.length,
    myVault.mintingAuthorities.data.pendingMintingAuthorizeTxInfosByTransferId.size,
    myVault.data.pendingCosignUtxosById.size,
    myVault.data.myPendingBitcoinCosignTxInfosByUtxoId.size,
  ],
  () => {
    syncNoticeState();
  },
  { immediate: true },
);

async function submitCollect() {
  if (isCollectBusy.value || !hasCollectWork.value) {
    return;
  }

  isSubmittingCollect.value = true;
  collectError.value = '';
  collectProgressLabel.value = 'Preparing transaction...';

  try {
    await myVault.collect({ moveTo: moveTo.value });
  } catch (error) {
    collectError.value = error instanceof Error ? error.message : `${error}`;
    isSubmittingCollect.value = false;
    collectProgressPct.value = 0;
    collectProgressLabel.value = '';
  }
}

async function submitMintingAuthorize() {
  if (isMintingAuthorizeBusy.value || authorizedTransferCount.value === 0) {
    return;
  }

  isSubmittingMintingAuthorize.value = true;
  mintingAuthorizeError.value = '';
  mintingAuthorizeUpdateMessage.value = '';
  mintingAuthorizeProgressLabel.value = 'Preparing transaction...';

  try {
    await myVault.mintingAuthorities.authorize();
  } catch (error) {
    mintingAuthorizeError.value = error instanceof Error ? error.message : `${error}`;
    isSubmittingMintingAuthorize.value = false;
    mintingAuthorizeProgressPct.value = 0;
    mintingAuthorizeProgressLabel.value = '';
  }
}

Vue.watch(
  activeCollectTxInfos,
  (txInfos, _, onCleanup) => {
    trackTransactionProgress({
      txInfos,
      isSubmitting: isSubmittingCollect,
      progressPct: collectProgressPct,
      progressLabel: collectProgressLabel,
      activeTransactionCount: activeCollectTransactionCount,
      error: collectError,
      onIdle: maybeCloseOverlay,
      onCleanup,
    });
  },
  { immediate: true },
);

Vue.watch(
  activeMintingAuthorizeTxInfos,
  (txInfos, previousTxInfos, onCleanup) => {
    if (!txInfos.length && previousTxInfos?.length) {
      const mintingAuthorizeCompletionMessage = getMintingAuthorizeCompletionMessage(previousTxInfos);
      if (mintingAuthorizeCompletionMessage) {
        mintingAuthorizeError.value = '';
        mintingAuthorizeUpdateMessage.value = mintingAuthorizeCompletionMessage;
      }
    }

    trackTransactionProgress({
      txInfos,
      isSubmitting: isSubmittingMintingAuthorize,
      progressPct: mintingAuthorizeProgressPct,
      progressLabel: mintingAuthorizeProgressLabel,
      activeTransactionCount: activeMintingAuthorizeTransactionCount,
      error: mintingAuthorizeError,
      onIdle: maybeCloseOverlay,
      onCleanup,
    });
  },
  { immediate: true },
);

function maybeCloseOverlay() {
  syncNoticeState();
  if (
    activeCollectTxInfos.value.length === 0 &&
    activeMintingAuthorizeTxInfos.value.length === 0 &&
    collectRevenue.value === 0n &&
    manualPendingCosignCount.value === 0 &&
    councilApprovalCount.value === 0 &&
    authorizedTransferCount.value === 0 &&
    !collectError.value &&
    !mintingAuthorizeUpdateMessage.value &&
    !mintingAuthorizeError.value
  ) {
    closeOverlay();
  }
}

function trackTransactionProgress(args: {
  txInfos: TransactionInfo[];
  isSubmitting: Vue.Ref<boolean>;
  progressPct: Vue.Ref<number>;
  progressLabel: Vue.Ref<string>;
  activeTransactionCount: Vue.Ref<number>;
  error: Vue.Ref<string>;
  onIdle: () => void;
  onCleanup: (cleanupFn: () => void) => void;
}) {
  const { txInfos, isSubmitting, progressPct, progressLabel, activeTransactionCount, error, onIdle, onCleanup } = args;

  if (txInfos.length > 0) {
    const progressByTxId = new Map(
      txInfos.map(txInfo => [
        txInfo.tx.id,
        {
          progressPct: 0,
          progressMessage: 'Preparing transaction...',
        },
      ]),
    );

    error.value = '';
    isSubmitting.value = true;
    activeTransactionCount.value = txInfos.length;

    for (const txInfo of txInfos) {
      const unsubscribe = txInfo.subscribeToProgress((progressArgs, progressError) => {
        progressByTxId.set(txInfo.tx.id, {
          progressPct: progressArgs.progressPct,
          progressMessage: progressArgs.progressMessage,
        });

        const slowestProgress = Array.from(progressByTxId.values()).reduce((slowest, current) => {
          if (!slowest || current.progressPct < slowest.progressPct) {
            return current;
          }
          return slowest;
        });

        progressPct.value = slowestProgress?.progressPct ?? 0;
        progressLabel.value =
          txInfos.length > 1
            ? `${slowestProgress?.progressMessage ?? 'Preparing transaction...'} (${txInfos.length} transactions in progress)`
            : (slowestProgress?.progressMessage ?? '');

        if (progressError) {
          error.value = progressError.message;
        }
      });
      onCleanup(unsubscribe);
    }

    return;
  }

  activeTransactionCount.value = 0;
  if (!isSubmitting.value) {
    return;
  }

  isSubmitting.value = false;
  progressPct.value = 0;
  progressLabel.value = '';
  onIdle();
}

function getUniqueTransactionInfos(txInfos: TransactionInfo[]) {
  const uniqueTxInfos = new Map<number, TransactionInfo>();
  for (const txInfo of txInfos) {
    if (txInfo.isPostProcessed) {
      continue;
    }
    uniqueTxInfos.set(txInfo.tx.id, txInfo);
  }

  return [...uniqueTxInfos.values()].sort((left, right) => left.tx.createdAt.getTime() - right.tx.createdAt.getTime());
}

function getCollectActionTitle(actionType?: IVaultCollectMetadata['actionType']) {
  if (actionType === 'collectRevenue') {
    return 'Collect Revenue';
  }
  if (actionType === 'cosignBitcoin') {
    return 'Sign Bitcoin Transactions';
  }
  return 'Vault Approvals';
}

function getCollectBusyLabel(actionType?: IVaultCollectMetadata['actionType']) {
  if (actionType === 'collectRevenue') {
    return 'Collecting Revenue...';
  }
  if (actionType === 'cosignBitcoin') {
    return 'Signing Bitcoin Transactions...';
  }
  if (actionType === 'approveCouncil') {
    return 'Approving Council Updates...';
  }
  return 'Submitting...';
}

function getMintingAuthorizeCompletionMessage(txInfos: TransactionInfo[]) {
  let attemptedCount = 0;
  let completedCount = 0;
  let earnedRewardAmount = 0n;

  for (const txInfo of txInfos as TransactionInfo<{
    authorizations: Array<{ mintingAuthorityTip: bigint }>;
  }>[]) {
    const errorCode = txInfo.tx.blockExtrinsicErrorJson?.errorCode;
    if (errorCode && errorCode !== 'TransferOutAlreadyReady' && errorCode !== 'InvalidTransferCollateralUpdate') {
      return '';
    }

    const authorizations = txInfo.tx.metadataJson.authorizations;
    const completedForTx = txInfo.tx.blockExtrinsicErrorJson
      ? (txInfo.tx.blockExtrinsicErrorJson.batchInterruptedIndex ?? 0)
      : authorizations.length;

    attemptedCount += authorizations.length;
    completedCount += completedForTx;
    earnedRewardAmount += authorizations
      .slice(0, completedForTx)
      .reduce((sum, { mintingAuthorityTip }) => sum + mintingAuthorityTip, 0n);
  }

  if (completedCount === attemptedCount) {
    return '';
  }

  if (completedCount > 0) {
    return `Authorized ${completedCount} of ${attemptedCount} crosschain transfer${
      attemptedCount === 1 ? '' : 's'
    }, earning ${currency.symbol}${microgonToMoneyNm(earnedRewardAmount).formatIfElse('< 1_000', '0,0.00', '0,0')}. Any missed authorizations will stay available as needed.`;
  }

  return 'Another minting authority claimed this opportunity before your transaction landed. Any remaining minting authorizations will stay available.';
}
</script>
