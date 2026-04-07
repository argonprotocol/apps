<template>
  <OverlayBase
    :isOpen="true"
    data-testid="BondDetailOverlay"
    @close="emit('close')"
    @esc="emit('close')"
    class="BondDetailOverlay min-h-48 w-200">
    <template #title>
      <div class="mr-6 flex grow flex-row items-center gap-2">
        <span class="text-xl font-bold text-slate-800/80">Bond Details</span>
        <span
          v-if="holder.isOperator"
          class="bg-argon-600 inline-block rounded px-1.5 pb-px align-middle text-sm text-white">
          YOURS
        </span>
        <span v-else class="inline-block rounded bg-slate-500 px-1.5 pb-px align-middle text-sm text-white">
          EXTERNAL
        </span>
      </div>
    </template>

    <BondDetail :summary="summary" />
  </OverlayBase>
</template>

<script setup lang="ts">
import * as Vue from 'vue';
import OverlayBase from '../../app-shared/overlays/OverlayBase.vue';
import BondDetail from './bitcoin-locking/BondDetail.vue';
import { getMyVault } from '../../stores/vaults.ts';
import { getMiningFrames, getMainchainClient } from '../../stores/mainchain.ts';
import { TreasuryPool, type IFrameBondHolder, type IFrameBondSummary } from '@argonprotocol/apps-core';
import { TICK_MILLIS } from '../../lib/Env.ts';
import dayjs from 'dayjs';
import utc from 'dayjs/plugin/utc';

dayjs.extend(utc);

const myVault = getMyVault();
const miningFrames = getMiningFrames();

const props = defineProps<{
  holder: IFrameBondHolder;
}>();

const emit = defineEmits<{
  (e: 'close'): void;
}>();

// Lock frame context at open time
const lockedFrameId = myVault.data.currentFrameId;
const lockedActiveCapital = myVault.data.currentFrameBondData.myVaultCapital;
const lockedGlobalCapital = myVault.data.currentFrameBondData.globalCapital;
const lockedSharingPct = myVault.data.currentFrameBondData.sharingPct;

// When frame ends, fetch finalized earnings from vaultPoolsByFrame
const finalizedFrameRow = Vue.ref<{ earnings: bigint; sharingPct: number } | null>(null);

Vue.watch(
  () => myVault.data.currentFrameId,
  async newFrameId => {
    if (newFrameId > lockedFrameId && finalizedFrameRow.value === null) {
      const client = await getMainchainClient(false);
      const operatorAddr = myVault.createdVault?.operatorAccountId ?? '';
      const history = await TreasuryPool.getBondFrameHistory(
        client,
        myVault.vaultId!,
        props.holder.accountId,
        operatorAddr,
      );
      const row = history.find(r => r.frameId === lockedFrameId);
      if (row) {
        finalizedFrameRow.value = { earnings: row.earnings, sharingPct: row.sharingPct };
      }
    }
  },
);

const summary = Vue.computed<IFrameBondSummary>(() => {
  const keepPct = props.holder.isOperator ? 100 : 100 - lockedSharingPct;
  const poolSharePct =
    lockedActiveCapital > 0n ? Number((props.holder.bondedAmount * 10000n) / lockedActiveCapital) / 100 : 0;

  const baseArgs = {
    funderBondedAmount: props.holder.bondedAmount,
    vaultActiveCapital: lockedActiveCapital,
    globalActiveCapital: lockedGlobalCapital,
    distributableBidPool: myVault.data.currentFrameBondData.distributableBidPool,
  };

  let totalEarnings: bigint;
  let vaultEarnings: bigint;
  if (finalizedFrameRow.value !== null) {
    const { earnings, sharingPct } = finalizedFrameRow.value;
    // getBondFrameHistory returns the operator's share (using keepPct) — reverse to get total
    const appliedPct = props.holder.isOperator ? 100 - sharingPct : sharingPct;
    totalEarnings = appliedPct > 0 ? (earnings * 100n) / BigInt(Math.round(appliedPct)) : 0n;
    vaultEarnings = props.holder.isOperator ? earnings : (totalEarnings * BigInt(Math.round(keepPct))) / 100n;
  } else {
    totalEarnings = TreasuryPool.projectedFrameEarnings({ ...baseArgs, earningsSharePct: 100 });
    vaultEarnings = TreasuryPool.projectedFrameEarnings({ ...baseArgs, earningsSharePct: keepPct });
  }

  const startTick = miningFrames.getTickStart(lockedFrameId);
  const endTick = miningFrames.getTickEnd(lockedFrameId);

  return {
    holder: props.holder,
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
</script>
