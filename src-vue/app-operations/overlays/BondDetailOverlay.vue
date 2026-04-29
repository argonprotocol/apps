<template>
  <OverlayBase
    :isOpen="true"
    data-testid="BondDetailOverlay"
    @close="emit('close')"
    @pressEsc="emit('close')"
    class="BondDetailOverlay min-h-48 w-200"
  >
    <template #title>
      <div class="mr-6 flex grow flex-row items-center gap-2">
        <span class="text-xl font-bold text-slate-800/80">Bond Details</span>
        <span
          v-if="bondLot.isOperator"
          class="bg-argon-600 inline-block rounded px-1.5 pb-px align-middle text-sm text-white"
        >
          YOURS
        </span>
        <span v-else class="inline-block rounded bg-slate-500 px-1.5 pb-px align-middle text-sm text-white">
          EXTERNAL
        </span>
      </div>
    </template>

    <BondDetail :summary="summary" />

    <div
      v-if="bondLotDetails?.isOwn"
      class="flex items-start justify-between gap-4 border-t border-slate-200 px-10 py-4"
    >
      <div class="text-sm text-slate-500">
        <template v-if="bondLotDetails.isReleasing">This bond lot is already being returned.</template>
        <template v-else>Liquidate this bond lot to schedule its return from Treasury Bonds.</template>
        <div v-if="liquidationError" class="mt-2 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-red-700">
          {{ liquidationError }}
        </div>
      </div>
      <button
        v-if="bondLotDetails.canRelease && !bondLotDetails.isReleasing && !isLiquidating"
        type="button"
        class="bg-argon-button hover:bg-argon-button-hover shrink-0 rounded px-5 py-2 text-sm font-semibold text-white"
        @click="liquidateBondLot"
      >
        Liquidate Bond Lot
      </button>
    </div>

    <div v-if="isLiquidating" class="space-y-3 border-t border-slate-200 px-10 py-5">
      <div class="text-sm font-medium text-slate-600">Liquidating bond lot...</div>
      <ProgressBar :progress="liquidationProgressPct" :hasError="!!liquidationError" />
      <div class="text-xs text-slate-500">{{ liquidationProgressLabel }}</div>
    </div>
  </OverlayBase>
</template>

<script setup lang="ts">
import * as Vue from 'vue';
import OverlayBase from '../../app-shared/overlays/OverlayBase.vue';
import BondDetail from './bitcoin-locking/BondDetail.vue';
import ProgressBar from '../../components/ProgressBar.vue';
import { type IBondMarketFrame } from '../../lib/BondMarket.ts';
import { getMyVault } from '../../stores/vaults.ts';
import { getMiningFrames, getMainchainClient } from '../../stores/mainchain.ts';
import { TreasuryBonds, type IFrameBondLot, type IFrameBondSummary } from '@argonprotocol/apps-core';
import { TICK_MILLIS } from '../../lib/Env.ts';
import dayjs from 'dayjs';
import utc from 'dayjs/plugin/utc';
import { getWalletKeys } from '../../stores/wallets.ts';
import { getTransactionTracker } from '../../stores/transactions.ts';
import { ExtrinsicType } from '../../lib/db/TransactionsTable.ts';
import { generateProgressLabel } from '../../lib/Utils.ts';

dayjs.extend(utc);

const myVault = getMyVault();
const miningFrames = getMiningFrames();
const walletKeys = getWalletKeys();
const transactionTracker = getTransactionTracker();

const props = defineProps<{
  bondLot: IFrameBondLot;
  bondFrame: IBondMarketFrame;
}>();

const emit = defineEmits<{
  (e: 'close'): void;
}>();

// Capture the current frame snapshot so the open detail view does not drift while the frame advances.
const bondLotAtOpen = props.bondLot;
const bondFrameAtOpen = props.bondFrame;

// When frame ends, fetch finalized earnings from runtime bond history.
const finalizedFrameRow = Vue.ref<{ earnings: bigint } | null>(null);
const isLiquidating = Vue.ref(false);
const liquidationError = Vue.ref('');
const liquidationProgressPct = Vue.ref(0);
const liquidationProgressLabel = Vue.ref('');

let unsubscribeLiquidationProgress: VoidFunction | undefined;

Vue.watch(
  () => myVault.data.currentFrameId,
  async newFrameId => {
    if (newFrameId > bondFrameAtOpen.frameId && finalizedFrameRow.value === null) {
      const client = await getMainchainClient(false);
      const history = await TreasuryBonds.getBondFrameHistory(client, myVault.vaultId!, bondLotAtOpen.accountId);
      const row = history.find(r => r.frameId === bondFrameAtOpen.frameId);
      if (row) {
        finalizedFrameRow.value = { earnings: row.earnings };
      }
    }
  },
);

const summary = Vue.computed<IFrameBondSummary>(() => {
  const keepPct = bondLotAtOpen.isOperator ? 100 : 100 - bondFrameAtOpen.sharingPct;
  const poolSharePct = TreasuryBonds.prorataToPercent(bondLotAtOpen.prorata);

  const baseArgs = {
    bondLotProrata: bondLotAtOpen.prorata,
    vaultBonds: bondFrameAtOpen.vaultBonds,
    globalBonds: bondFrameAtOpen.globalBonds,
    distributableBidPool: bondFrameAtOpen.distributableBidPool,
  };

  let totalEarnings: bigint;
  let vaultEarnings: bigint;
  if (finalizedFrameRow.value !== null) {
    totalEarnings = finalizedFrameRow.value.earnings;
    vaultEarnings = finalizedFrameRow.value.earnings;
  } else {
    totalEarnings = TreasuryBonds.projectedFrameEarnings({ ...baseArgs, earningsSharePct: 100 });
    vaultEarnings = TreasuryBonds.projectedFrameEarnings({ ...baseArgs, earningsSharePct: keepPct });
  }

  const startTick = miningFrames.getTickStart(bondFrameAtOpen.frameId);
  const endTick = miningFrames.getTickEnd(bondFrameAtOpen.frameId);

  return {
    bondLot: bondLotAtOpen,
    poolSharePct,
    totalEarnings,
    vaultEarnings,
    keepPct,
    frameStartDate: dayjs
      .utc(startTick * TICK_MILLIS)
      .local()
      .format('MMMM D, h:mm A'),
    frameEndDate: dayjs
      .utc((endTick + 1) * TICK_MILLIS)
      .local()
      .format('MMMM D, h:mm A'),
  };
});

const bondLotDetails = Vue.computed(() => bondLotAtOpen.details);

async function liquidateBondLot() {
  const details = bondLotDetails.value;
  if (!details?.isOwn || !details.canRelease || details.isReleasing || isLiquidating.value) return;

  liquidationError.value = '';
  liquidationProgressPct.value = 0;
  liquidationProgressLabel.value = 'Submitting transaction...';
  isLiquidating.value = true;

  try {
    const client = await getMainchainClient(false);
    const signer = await walletKeys.getVaultingKeypair();
    const tx = await TreasuryBonds.buildReleaseBondLotTx({ client, bondLot: details });
    const info = await transactionTracker.submitAndWatch({
      tx,
      txSigner: signer,
      extrinsicType: ExtrinsicType.TreasuryReleaseBondLot,
      metadata: {
        bondLotId: details.id,
        releasedBondMicrogons: details.bondMicrogons,
      },
    });

    unsubscribeLiquidationProgress?.();
    unsubscribeLiquidationProgress = info.subscribeToProgress((args, error) => {
      liquidationProgressPct.value = args.progressPct;
      liquidationProgressLabel.value = generateProgressLabel(args.confirmations, args.expectedConfirmations);

      if (error) {
        liquidationError.value = error.message;
        isLiquidating.value = false;
        unsubscribeLiquidationProgress?.();
        unsubscribeLiquidationProgress = undefined;
        return;
      }

      if (args.progressPct >= 100) {
        emit('close');
      }
    });
  } catch (error) {
    liquidationError.value = error instanceof Error ? error.message : 'Unable to liquidate bond lot.';
    isLiquidating.value = false;
    liquidationProgressPct.value = 0;
    liquidationProgressLabel.value = '';
  }
}

Vue.onUnmounted(() => {
  unsubscribeLiquidationProgress?.();
});
</script>
