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
        v-if="!showCollectSection && !showSponsorSection"
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
            <template v-if="collectRevenue || manualPendingCosignCount">This submit will also record</template>
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

      <section v-if="showSponsorSection" class="flex flex-col gap-y-3 border-t border-slate-200 pt-6">
        <div>
          <div class="text-lg font-semibold text-slate-800">Sponsor Crosschain Transfers</div>
          <p class="mt-2 text-sm text-slate-600">
            You have
            <strong>
              {{ sponsorOpportunityCount }} sponsorship opportunit{{ sponsorOpportunityCount === 1 ? 'y' : 'ies' }}
            </strong>
            ready on Argon
            <template v-if="sponsorRewardAmount > 0n">
              for
              <strong>
                {{ currency.symbol
                }}{{ microgonToMoneyNm(sponsorRewardAmount).formatIfElse('< 1_000', '0,0.00', '0,0') }}
              </strong>.
            </template>
            <span v-else>.</span>
          </p>
        </div>

        <div
          v-if="sponsorUpdateMessage"
          class="rounded-md border border-sky-200 bg-sky-50 px-4 py-3 text-sm text-sky-700">
          {{ sponsorUpdateMessage }}
        </div>

        <div v-if="sponsorError" class="rounded-md border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
          {{ sponsorError }}
        </div>

        <button
          @click="submitSponsor"
          :disabled="isSponsorBusy || authorizedTransferCount === 0"
          class="bg-argon-600 hover:bg-argon-700 mt-2 mb-1 cursor-pointer rounded-md px-6 py-2 text-lg font-bold text-white disabled:cursor-default disabled:opacity-40">
          {{ sponsorButtonLabel }}
        </button>

        <div v-if="showSponsorProgress" class="rounded-md border border-slate-200 bg-slate-50 px-4 py-4">
          <div class="mb-3 text-sm font-semibold text-slate-700">
            {{
              activeSponsorTransactionCount === 1
                ? 'Submitting sponsorship on Argon...'
                : `Submitting ${activeSponsorTransactionCount} sponsorship transactions on Argon...`
            }}
          </div>

          <ProgressBar :progress="sponsorProgressPct" :showLabel="false" class="h-4" />

          <div class="mt-3 text-sm text-slate-500">
            {{ sponsorProgressLabel || 'Preparing transaction...' }}
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
import CountdownClock from '../../components/CountdownClock.vue';
import { getMyVault } from '../../stores/vaults.ts';
import { getCurrency } from '../../stores/currency.ts';
import { createNumeralHelpers } from '../../lib/numeral.ts';
import ProgressBar from '../../components/ProgressBar.vue';
import OverlayBase from '../../app-shared/overlays/OverlayBase.vue';
import InputMenu from '../../components/InputMenu.vue';
import { MoveTo } from '@argonprotocol/apps-core';
import { TransactionInfo } from '../../lib/TransactionInfo.ts';
import type { IMintingAuthorityAuthorizeMetadata } from '../../lib/MintingAuthorities.ts';

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

const isSubmittingSponsor = Vue.ref(false);
const sponsorProgressPct = Vue.ref(0);
const sponsorProgressLabel = Vue.ref('');
const sponsorError = Vue.ref('');
const sponsorUpdateMessage = Vue.ref('');
const activeSponsorTransactionCount = Vue.ref(0);

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

const activeSponsorTxInfos = Vue.computed(() => {
  return getUniqueTransactionInfos([
    ...myVault.mintingAuthorities.data.pendingMintingAuthorizeTxInfosByTransferId.values(),
  ]) as TransactionInfo<IMintingAuthorityAuthorizeMetadata>[];
});

const hasCollectWork = Vue.computed(() => {
  return collectRevenue.value > 0n || manualPendingCosignCount.value > 0 || councilApprovalCount.value > 0;
});

const isCollectBusy = Vue.computed(() => {
  return isSubmittingCollect.value || activeCollectTxInfos.value.length > 0;
});

const isSponsorBusy = Vue.computed(() => {
  return isSubmittingSponsor.value || activeSponsorTxInfos.value.length > 0;
});

const showCollectSection = Vue.computed(() => {
  return hasCollectWork.value || isCollectBusy.value || !!collectError.value;
});

const showSponsorSection = Vue.computed(() => {
  return (
    registeredMintingAuthorityCount.value > 0 &&
    (authorizedTransferCount.value > 0 || isSponsorBusy.value || !!sponsorError.value || !!sponsorUpdateMessage.value)
  );
});

const showCollectProgress = Vue.computed(() => {
  return isCollectBusy.value || collectProgressPct.value > 0;
});

const showSponsorProgress = Vue.computed(() => {
  return isSponsorBusy.value || sponsorProgressPct.value > 0;
});

const activeSponsorOpportunityCount = Vue.computed(() => {
  return activeSponsorTxInfos.value.reduce((sum, txInfo) => {
    return sum + txInfo.tx.metadataJson.authorizations.length;
  }, 0);
});

const activeSponsorRewardAmount = Vue.computed(() => {
  return activeSponsorTxInfos.value.reduce((sum, txInfo) => {
    return (
      sum +
      txInfo.tx.metadataJson.authorizations.reduce((txSum, { mintingAuthorityTip }) => txSum + mintingAuthorityTip, 0n)
    );
  }, 0n);
});

const sponsorOpportunityCount = Vue.computed(() => {
  return authorizedTransferCount.value || activeSponsorOpportunityCount.value;
});

const sponsorRewardAmount = Vue.computed(() => {
  return authorizedTransferRewardAmount.value || activeSponsorRewardAmount.value;
});

const overlayTitle = Vue.computed(() => {
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
    return 'Submitting...';
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

const sponsorButtonLabel = Vue.computed(() => {
  if (isSponsorBusy.value) {
    return 'Submitting...';
  }
  if (sponsorOpportunityCount.value === 1) {
    return 'Sponsor Crosschain Transfer';
  }
  if (sponsorOpportunityCount.value === 0) {
    return 'Sponsor Crosschain Transfers';
  }
  return `Sponsor ${sponsorOpportunityCount.value} Crosschain Transfers`;
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

async function submitSponsor() {
  if (isSponsorBusy.value || authorizedTransferCount.value === 0) {
    return;
  }

  isSubmittingSponsor.value = true;
  sponsorError.value = '';
  sponsorUpdateMessage.value = '';
  sponsorProgressLabel.value = 'Preparing transaction...';

  try {
    await myVault.mintingAuthorities.authorize();
  } catch (error) {
    sponsorError.value = error instanceof Error ? error.message : `${error}`;
    isSubmittingSponsor.value = false;
    sponsorProgressPct.value = 0;
    sponsorProgressLabel.value = '';
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
  activeSponsorTxInfos,
  (txInfos, previousTxInfos, onCleanup) => {
    if (!txInfos.length && previousTxInfos?.length) {
      const sponsorCompletionMessage = getSponsorCompletionMessage(previousTxInfos);
      if (sponsorCompletionMessage) {
        sponsorError.value = '';
        sponsorUpdateMessage.value = sponsorCompletionMessage;
      }
    }

    trackTransactionProgress({
      txInfos,
      isSubmitting: isSubmittingSponsor,
      progressPct: sponsorProgressPct,
      progressLabel: sponsorProgressLabel,
      activeTransactionCount: activeSponsorTransactionCount,
      error: sponsorError,
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
    activeSponsorTxInfos.value.length === 0 &&
    collectRevenue.value === 0n &&
    manualPendingCosignCount.value === 0 &&
    councilApprovalCount.value === 0 &&
    authorizedTransferCount.value === 0 &&
    !collectError.value &&
    !sponsorUpdateMessage.value &&
    !sponsorError.value
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

function getSponsorCompletionMessage(txInfos: TransactionInfo[]) {
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
    return `Sponsored ${completedCount} of ${attemptedCount} opportunit${
      attemptedCount === 1 ? 'y' : 'ies'
    }, earning ${currency.symbol}${microgonToMoneyNm(earnedRewardAmount).formatIfElse('< 1_000', '0,0.00', '0,0')}. Any missed opportunities will stay available if they still need sponsorship.`;
  }

  return 'Another sponsor claimed this opportunity before your transaction landed. Any remaining sponsorship opportunities will stay available.';
}
</script>
