<template>
  <div class="px-6 pt-6 text-slate-700">
    <div v-if="!isProcessing" class="space-y-4">
      <div class="px-5 pt-2 pb-1">
        <div class="text-base leading-6 text-slate-700">
          Your completed Argon Operational Certification has earned you ₳{{
            microgonToArgonNm(controller.rewardConfig.operationalReferralReward).format('0,0.[00]')
          }}
          ready to claim from the Argon Treasury.*
          <template v-if="hasTreasuryReserveShortfall && claimableNow !== undefined">
            The Argon Treasury currently has ₳{{ microgonToArgonNm(claimableNow).format('0,0.[00]') }}
            available to claim. More funds will be available after the next Mining Auction completes
            <template v-if="nextReserveRefreshAt">
              <CountdownClock :time="nextReserveRefreshAt" v-slot="{ days, hours, minutes, seconds, isFinished }">
                <template v-if="isFinished">soon.</template>
                <template v-else-if="days > 0">in {{ days }} {{ days === 1 ? 'day' : 'days' }}.</template>
                <template v-else-if="hours > 0">in {{ hours }} {{ hours === 1 ? 'hour' : 'hours' }}.</template>
                <template v-else-if="minutes > 0">
                  in {{ minutes }} {{ minutes === 1 ? 'minute' : 'minutes' }}.
                </template>
                <template v-else>in {{ seconds }} {{ seconds === 1 ? 'second' : 'seconds' }}.</template>
              </CountdownClock>
            </template>
            <template v-else>soon.</template>
          </template>
        </div>
      </div>

      <div class="px-5">
        <div class="text-base font-semibold text-slate-800">Send reward to</div>
        <InputMenu
          v-model="rewardAccount"
          :options="rewardAccountOptions"
          :selectFirst="true"
          class="mt-3 flex w-full" />
        <div
          v-if="hasRewardAccountFeeShortfall"
          class="mt-3 rounded-xl border border-amber-200 bg-amber-50/70 px-3 py-2 text-xs leading-5 text-amber-800">
          This account needs ~₳{{ microgonToArgonNm(rewardFeeEstimate ?? 0n).format('0,0.[00]') }} available to submit
          the activation. Choose a different account or add funds before activating.
        </div>
      </div>

      <div class="mt-5 border-t border-slate-300 p-5 text-sm text-slate-500">
        *By accepting this reward, you commit to the future of Argon by locking in a minimum of ₳{{
          microgonToArgonNm(controller.rewardConfig.operationalMinimumVaultSecuritization).format('0,0.[00]')
        }}
        to your Vault's Bitcoin Security for one year.
      </div>
      <div
        v-if="runtimeNotice"
        class="rounded-xl border border-amber-200 bg-amber-50/70 px-4 py-3 text-sm leading-6 text-amber-800">
        {{ runtimeNotice }}
      </div>

      <div v-if="transactionError" class="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
        {{ transactionError }}
      </div>

      <div class="flex items-center justify-end gap-3">
        <button
          type="button"
          class="rounded-lg px-4 py-2 text-sm font-semibold text-slate-500 hover:bg-slate-100 hover:text-slate-700"
          @click="emit('close')">
          Not Now
        </button>
        <button
          type="button"
          :disabled="!canSubmitRewardClaim"
          class="bg-argon-button hover:bg-argon-button-hover rounded-lg px-5 py-2.5 text-sm font-semibold text-white disabled:cursor-default disabled:opacity-40"
          @click="activateAndClaimReward">
          <template v-if="claimableNow === undefined">Activate and Claim Reward</template>
          <template v-else>Activate and Claim ₳{{ microgonToArgonNm(claimableNow).format('0,0.[00]') }}</template>
        </button>
      </div>
    </div>

    <div v-else class="bg-white px-8 py-8">
      <div class="text-center text-lg font-semibold text-slate-800">
        {{ activationProgressTitle }}
      </div>
      <p v-if="!isActivationComplete" class="mx-auto mt-3 max-w-xl text-center text-sm leading-6 text-slate-500">
        Argon is activating your certification and claiming the reward. You can close this overlay without interrupting
        it.
      </p>
      <p v-else class="mx-auto mt-3 max-w-xl text-center text-sm leading-6 text-slate-500">
        You've activated your Argon Operational Certification. The claimed reward should now be in the account you
        selected.
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

      <div v-if="isActivationComplete || transactionError" class="mt-7 flex justify-end">
        <button
          type="button"
          class="bg-argon-button hover:bg-argon-button-hover rounded-lg px-5 py-2.5 text-sm font-semibold text-white"
          @click="emit('goTo', isActivationComplete ? 'congratulations' : 'activate')">
          {{ isActivationComplete ? 'Continue' : 'Try Again' }}
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
  buildOperationalActivationRewardClaimTx,
  getOperationalRewardsClaimAvailability,
} from '../../../lib/OperationalAccount.ts';
import { ExtrinsicType } from '../../../lib/db/TransactionsTable.ts';
import { getCurrency } from '../../../stores/currency.ts';
import { getMainchainClient, getMiningFrames } from '../../../stores/mainchain.ts';
import { useOperationsController } from '../../../stores/operationsController.ts';
import { getTransactionTracker } from '../../../stores/transactions.ts';
import { getWalletKeys, useWallets } from '../../../stores/wallets.ts';

dayjs.extend(utc);

type RewardAccount = 'miningHold' | 'vaulting';

const props = defineProps<{
  isActive: boolean;
}>();

const emit = defineEmits<{
  close: [];
  goTo: [screen: 'activate' | 'congratulations'];
}>();

const controller = useOperationsController();
const currency = getCurrency();
const wallets = useWallets();
const walletKeys = getWalletKeys();
const transactionTracker = getTransactionTracker();

const { microgonToArgonNm } = createNumeralHelpers(currency);

const rewardAccount = Vue.ref<RewardAccount>('vaulting');
const treasuryReserves = Vue.ref<bigint>();
const claimableNow = Vue.ref<bigint>();
const canClaimRewards = Vue.ref(true);
const rewardFeeEstimate = Vue.ref<bigint>();
const nextReserveRefreshAt = Vue.ref<Dayjs>();
const runtimeNotice = Vue.ref('');
const transactionError = Vue.ref('');
const progressPct = Vue.ref(0);
const progressLabel = Vue.ref('');
const isProcessing = Vue.ref(false);

let unsubscribeProgress: (() => void) | undefined;
let feeEstimateRunId = 0;

const rewardAccountOptions = Vue.computed<IOption[]>(() => [
  { name: 'Vaulting Account', value: 'vaulting' },
  { name: 'Mining Account', value: 'miningHold' },
]);

const selectedRewardAccount = Vue.computed(() => {
  if (rewardAccount.value === 'miningHold') return wallets.miningHoldWallet;
  return wallets.vaultingWallet;
});

const hasRewardAccountFeeShortfall = Vue.computed(() => {
  return (
    rewardFeeEstimate.value !== undefined && selectedRewardAccount.value.availableMicrogons < rewardFeeEstimate.value
  );
});

const hasTreasuryReserveShortfall = Vue.computed(() => {
  return (
    treasuryReserves.value !== undefined && treasuryReserves.value < controller.rewardConfig.operationalReferralReward
  );
});

const canSubmitRewardClaim = Vue.computed(() => {
  return (
    canClaimRewards.value &&
    !isProcessing.value &&
    controller.isOperationalActivationReady &&
    !hasRewardAccountFeeShortfall.value &&
    !!selectedRewardAccount.value.address &&
    claimableNow.value !== undefined &&
    claimableNow.value >= BigInt(MICROGONS_PER_ARGON)
  );
});

const isActivationComplete = Vue.computed(() => {
  return (progressPct.value >= 100 || controller.isFullyOperational) && !transactionError.value;
});

const activationProgressTitle = Vue.computed(() => {
  if (transactionError.value) return 'Activation needs attention';
  if (isActivationComplete.value) return 'Activation complete';
  return 'Activation submitted';
});

async function activateAndClaimReward() {
  if (!canSubmitRewardClaim.value) return;

  try {
    const rewardClaimAmount = claimableNow.value;
    if (rewardClaimAmount === undefined) return;

    transactionError.value = '';
    progressPct.value = 0;
    progressLabel.value = 'Preparing transaction...';
    isProcessing.value = true;

    const client = await getMainchainClient(false);
    const tx = await buildOperationalActivationRewardClaimTx(rewardClaimAmount, client);
    const signer = await getRewardSigner();
    const txInfo = await transactionTracker.submitAndWatch({
      tx,
      txSigner: signer,
      extrinsicType: ExtrinsicType.OperationalActivateAndClaim,
      metadata: {
        rewardAccount: rewardAccount.value,
        vaultLockMicrogons: controller.rewardConfig.operationalMinimumVaultSecuritization,
        rewardMicrogons: controller.rewardConfig.operationalReferralReward,
        claimedMicrogons: rewardClaimAmount,
      },
    });

    unsubscribeProgress?.();
    unsubscribeProgress = txInfo.subscribeToProgress((args, error) => {
      progressPct.value = args.progressPct;
      progressLabel.value = args.progressMessage;
      if (error) {
        transactionError.value = error.message;
        isProcessing.value = false;
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

Vue.watch([() => props.isActive, rewardAccount, claimableNow], () => {
  void updateRewardFeeEstimate();
});

Vue.onUnmounted(() => {
  feeEstimateRunId += 1;
  unsubscribeProgress?.();
});

async function getRewardSigner() {
  if (rewardAccount.value === 'miningHold') return await walletKeys.getMiningHoldKeypair();
  return await walletKeys.getVaultingKeypair();
}

async function loadAvailability() {
  transactionError.value = '';
  const availability = await getOperationalRewardsClaimAvailability(walletKeys);
  let availableRewards = 0n;
  if (availability.canClaimRewards) {
    availableRewards =
      availability.treasuryReserves === undefined ||
      availability.treasuryReserves > controller.rewardConfig.operationalReferralReward
        ? controller.rewardConfig.operationalReferralReward
        : availability.treasuryReserves;
  }
  const wholeArgon = BigInt(MICROGONS_PER_ARGON);

  treasuryReserves.value = availability.treasuryReserves;
  claimableNow.value = availableRewards - (availableRewards % wholeArgon);
  canClaimRewards.value = availability.canClaimRewards;
  runtimeNotice.value = availability.canClaimRewards
    ? ''
    : 'This feature will be activated with the next mainchain runtime upgrade.';

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

async function updateRewardFeeEstimate() {
  const runId = ++feeEstimateRunId;
  rewardFeeEstimate.value = undefined;

  if (
    !props.isActive ||
    !canClaimRewards.value ||
    !selectedRewardAccount.value.address ||
    claimableNow.value === undefined ||
    claimableNow.value < BigInt(MICROGONS_PER_ARGON)
  ) {
    return;
  }

  try {
    const client = await getMainchainClient(false);
    const tx = await buildOperationalActivationRewardClaimTx(claimableNow.value, client);
    const fee = await tx.paymentInfo(selectedRewardAccount.value.address);
    if (runId === feeEstimateRunId) {
      rewardFeeEstimate.value = fee.partialFee.toBigInt();
    }
  } catch {
    if (runId === feeEstimateRunId) {
      rewardFeeEstimate.value = undefined;
    }
  }
}
</script>
