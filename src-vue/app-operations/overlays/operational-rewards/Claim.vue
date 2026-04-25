<template>
  <div class="px-6 pt-6 text-slate-700">
    <div v-if="!isProcessing" class="space-y-5">
      <div class="rounded-2xl border border-slate-200 bg-white px-5 py-4">
        <div class="text-lg font-semibold text-slate-800">Claim Operational Rewards</div>
        <div class="mt-2 text-sm leading-6 text-slate-500">
          You can claim up to {{ claimableRewardLabel }} of your rewards from the Argon Treasury Reserves right now.
        </div>
      </div>

      <div StatsBox box class="grid grid-cols-3 overflow-hidden text-center">
        <div StatWrapper class="border-r border-slate-200/70 px-4 py-4">
          <div Stat class="text-3xl! leading-none">{{ pendingRewardLabel }}</div>
          <div class="mt-2 text-xs font-semibold tracking-widest text-slate-400 uppercase">Pending</div>
        </div>

        <div StatWrapper class="border-r border-slate-200/70 px-4 py-4">
          <div Stat class="text-3xl! leading-none">{{ treasuryReserveLabel }}</div>
          <div class="mt-2 text-xs font-semibold tracking-widest text-slate-400 uppercase">Treasury Reserves</div>
        </div>

        <div StatWrapper class="px-4 py-4">
          <div Stat class="text-3xl! leading-none">{{ claimableRewardLabel }}</div>
          <div class="mt-2 text-xs font-semibold tracking-widest text-slate-400 uppercase">Claimable Now</div>
        </div>
      </div>

      <div class="rounded-2xl border border-slate-200 bg-slate-50/50 px-5 py-4">
        <div class="text-sm font-semibold text-slate-800">Send rewards to</div>
        <InputMenu v-model="claimAccount" :options="claimAccountOptions" :selectFirst="true" class="mt-3 flex w-full" />
        <div class="mt-3 text-xs leading-5 text-slate-500">Rewards will be transferred to this account.</div>
        <div
          v-if="hasClaimFeeShortfall"
          class="mt-3 rounded-xl border border-amber-200 bg-amber-50/70 px-3 py-2 text-xs leading-5 text-amber-800">
          This account needs ~{{ formatArgon(claimFeeEstimate ?? 0n) }} available to pay the network fee. Choose a
          different account or add funds before claiming.
        </div>
      </div>

      <div
        v-if="runtimeNotice"
        class="rounded-xl border border-amber-200 bg-amber-50/70 px-4 py-3 text-sm leading-6 text-amber-800">
        {{ runtimeNotice }}
      </div>

      <div
        v-if="hasTreasuryReserveShortfall"
        class="rounded-xl border border-amber-200 bg-amber-50/70 px-4 py-3 text-sm leading-6 text-amber-800">
        The Argon Treasury cannot cover all pending rewards right now. Treasury reserves are added after every mining
        frame ends.
        <span v-if="nextReserveRefreshAt">
          This mining frame ends
          <CountdownClock :time="nextReserveRefreshAt" v-slot="{ days, hours, minutes, seconds, isFinished }">
            <template v-if="isFinished">soon.</template>
            <template v-else-if="days > 0">in {{ days }} {{ days === 1 ? 'day' : 'days' }}.</template>
            <template v-else-if="hours > 0">in {{ hours }} {{ hours === 1 ? 'hour' : 'hours' }}.</template>
            <template v-else-if="minutes > 0">in {{ minutes }} {{ minutes === 1 ? 'minute' : 'minutes' }}.</template>
            <template v-else>in {{ seconds }} {{ seconds === 1 ? 'second' : 'seconds' }}.</template>
          </CountdownClock>
        </span>
      </div>

      <div v-if="transactionError" class="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
        {{ transactionError }}
      </div>

      <div class="flex items-center justify-end gap-3">
        <button
          type="button"
          class="rounded-lg px-4 py-2 text-sm font-semibold text-slate-500 hover:bg-slate-100 hover:text-slate-700"
          @click="emit('goTo', 'overview')">
          Back to Rewards
        </button>
        <button
          type="button"
          :disabled="!canClaim"
          class="bg-argon-button hover:bg-argon-button-hover rounded-lg px-5 py-2.5 text-sm font-semibold text-white disabled:cursor-default disabled:opacity-40"
          @click="claimRewards">
          Claim {{ claimableRewardLabel }}
        </button>
      </div>
    </div>

    <div v-else class="rounded-2xl border border-slate-200 bg-white px-8 py-8">
      <div class="text-center text-lg font-semibold text-slate-800">
        {{ claimProgressTitle }}
      </div>
      <p v-if="!isClaimComplete" class="mx-auto mt-3 max-w-xl text-center text-sm leading-6 text-slate-500">
        Your reward claim has been submitted to the Argon network. You can close this overlay without disrupting the
        transaction.
      </p>
      <p v-else class="mx-auto mt-3 max-w-xl text-center text-sm leading-6 text-slate-500">
        Your claim finalized. The claimed rewards should now be available in the account you selected.
      </p>

      <div class="text-argon-700 mt-8 text-center text-4xl font-bold">{{ numeral(progressPct).format('0.00') }}%</div>

      <ProgressBar :progress="progressPct" :showLabel="false" class="mt-4 h-4" />

      <div class="mt-4 text-center text-sm text-slate-500">
        {{ progressLabel }}
      </div>

      <div
        v-if="transactionError"
        class="mt-5 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
        {{ transactionError }}
      </div>

      <div v-if="isClaimComplete || transactionError" class="mt-7 flex justify-end">
        <button
          type="button"
          class="bg-argon-button hover:bg-argon-button-hover rounded-lg px-5 py-2.5 text-sm font-semibold text-white"
          @click="emit('goTo', 'overview')">
          Back to Rewards
        </button>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import * as Vue from 'vue';
import dayjs, { type Dayjs } from 'dayjs';
import utc from 'dayjs/plugin/utc';
import { MICROGONS_PER_ARGON } from '@argonprotocol/apps-core';
import CountdownClock from '../../../components/CountdownClock.vue';
import InputMenu, { type IOption } from '../../../components/InputMenu.vue';
import ProgressBar from '../../../components/ProgressBar.vue';
import numeral, { createNumeralHelpers } from '../../../lib/numeral.ts';
import {
  buildOperationalRewardsClaimTx,
  getOperationalRewardsClaimAvailability,
} from '../../../lib/OperationalAccount.ts';
import { ExtrinsicType } from '../../../lib/db/TransactionsTable.ts';
import { getCurrency } from '../../../stores/currency.ts';
import { getMainchainClient, getMiningFrames } from '../../../stores/mainchain.ts';
import { getTransactionTracker } from '../../../stores/transactions.ts';
import { getWalletKeys, useWallets } from '../../../stores/wallets.ts';

dayjs.extend(utc);

type ClaimAccount = 'miningHold' | 'vaulting';

const props = defineProps<{
  isActive: boolean;
}>();

const emit = defineEmits<{
  goTo: [screen: 'overview'];
}>();

const currency = getCurrency();
const wallets = useWallets();
const walletKeys = getWalletKeys();
const transactionTracker = getTransactionTracker();
const { microgonToArgonNm } = createNumeralHelpers(currency);

const claimAccount = Vue.ref<ClaimAccount>('miningHold');

const pendingRewards = Vue.ref(0n);
const treasuryReserves = Vue.ref<bigint>();
const claimableNow = Vue.ref(0n);

const claimFeeEstimate = Vue.ref<bigint>();
const nextReserveRefreshAt = Vue.ref<Dayjs>();

const runtimeNotice = Vue.ref('');
const transactionError = Vue.ref('');

const progressPct = Vue.ref(0);
const progressLabel = Vue.ref('');
const isProcessing = Vue.ref(false);

let unsubscribeProgress: (() => void) | undefined;
let feeEstimateRunId = 0;

const claimAccountOptions = Vue.computed<IOption[]>(() => [
  { name: 'Mining Account', value: 'miningHold', microgons: wallets.miningHoldWallet.availableMicrogons },
  { name: 'Vaulting Account', value: 'vaulting', microgons: wallets.vaultingWallet.availableMicrogons },
]);

const selectedClaimAccount = Vue.computed(() => {
  if (claimAccount.value === 'vaulting') return wallets.vaultingWallet;
  return wallets.miningHoldWallet;
});

const pendingRewardLabel = Vue.computed(() => formatArgon(pendingRewards.value));

const treasuryReserveLabel = Vue.computed(() => {
  return treasuryReserves.value === undefined ? 'Pending' : formatArgon(treasuryReserves.value);
});

const claimableRewardLabel = Vue.computed(() => formatArgon(claimableNow.value));

const hasTreasuryReserveShortfall = Vue.computed(() => {
  return treasuryReserves.value !== undefined && treasuryReserves.value < pendingRewards.value;
});

const hasClaimFeeShortfall = Vue.computed(() => {
  return claimFeeEstimate.value !== undefined && selectedClaimAccount.value.availableMicrogons < claimFeeEstimate.value;
});

const canClaim = Vue.computed(() => {
  return !isProcessing.value && !hasClaimFeeShortfall.value && claimableNow.value >= BigInt(MICROGONS_PER_ARGON);
});

const isClaimComplete = Vue.computed(() => {
  return progressPct.value >= 100 && !transactionError.value;
});

const claimProgressTitle = Vue.computed(() => {
  if (transactionError.value) return 'Claim needs attention';
  if (isClaimComplete.value) return 'Claim complete';
  return 'Claim submitted';
});

async function loadAvailability() {
  transactionError.value = '';
  const availability = await getOperationalRewardsClaimAvailability(walletKeys);

  pendingRewards.value = availability.pendingRewards;
  treasuryReserves.value = availability.treasuryReserves;
  claimableNow.value = availability.claimableNow;
  runtimeNotice.value =
    availability.treasuryReserves === undefined
      ? 'This feature will be activated with the next mainchain runtime upgrade.'
      : '';

  nextReserveRefreshAt.value = undefined;
  if (hasTreasuryReserveShortfall.value) {
    try {
      const miningFrames = getMiningFrames();
      await miningFrames.load();
      nextReserveRefreshAt.value = dayjs.utc(miningFrames.getFrameDate(miningFrames.currentFrameId + 1).getTime());
    } catch {
      nextReserveRefreshAt.value = undefined;
    }
  }
}

async function claimRewards() {
  if (!canClaim.value) return;

  try {
    transactionError.value = '';
    progressPct.value = 0;
    progressLabel.value = 'Preparing transaction...';
    isProcessing.value = true;

    const client = await getMainchainClient(false);
    const tx = await buildOperationalRewardsClaimTx(claimableNow.value, client);
    const signer = await getClaimSigner();
    const txInfo = await transactionTracker.submitAndWatch({
      tx,
      txSigner: signer,
      extrinsicType: ExtrinsicType.OperationalClaimRewards,
      metadata: {
        amount: claimableNow.value,
        claimAccount: claimAccount.value,
      },
    });

    unsubscribeProgress?.();
    unsubscribeProgress = txInfo.subscribeToProgress((args, error) => {
      progressPct.value = args.progressPct;
      progressLabel.value = args.progressMessage;
      if (error) {
        transactionError.value = error.message;
      }
      if (args.progressPct >= 100 && !error) {
        void loadAvailability();
      }
    });
  } catch (error) {
    transactionError.value = error instanceof Error ? error.message : `${error}`;
    isProcessing.value = false;
    progressPct.value = 0;
    progressLabel.value = '';
  }
}

Vue.watch(
  () => props.isActive,
  isActive => {
    if (!isActive) return;

    void loadAvailability().catch(error => {
      transactionError.value = error instanceof Error ? error.message : `${error}`;
    });
  },
  { immediate: true },
);

Vue.watch([() => props.isActive, claimAccount, claimableNow], () => {
  void updateClaimFeeEstimate();
});

Vue.onUnmounted(() => {
  feeEstimateRunId += 1;
  unsubscribeProgress?.();
});

function formatArgon(amount: bigint) {
  const wholeArgon = BigInt(MICROGONS_PER_ARGON);
  return `₳${microgonToArgonNm(amount).format(amount % wholeArgon === 0n ? '0,0' : '0,0.00')}`;
}

async function getClaimSigner() {
  if (claimAccount.value === 'vaulting') return await walletKeys.getVaultingKeypair();
  return await walletKeys.getMiningHoldKeypair();
}

async function updateClaimFeeEstimate() {
  const runId = ++feeEstimateRunId;
  claimFeeEstimate.value = undefined;

  if (!props.isActive || claimableNow.value < BigInt(MICROGONS_PER_ARGON) || !selectedClaimAccount.value.address) {
    return;
  }

  try {
    const client = await getMainchainClient(false);
    const tx = await buildOperationalRewardsClaimTx(claimableNow.value, client);
    const fee = await tx.paymentInfo(selectedClaimAccount.value.address);
    if (runId === feeEstimateRunId) {
      claimFeeEstimate.value = fee.partialFee.toBigInt();
    }
  } catch {
    if (runId === feeEstimateRunId) {
      claimFeeEstimate.value = undefined;
    }
  }
}
</script>
