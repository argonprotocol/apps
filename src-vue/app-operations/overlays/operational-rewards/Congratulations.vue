<template>
  <div class="px-6 pt-6">
    <div
      class="relative overflow-hidden rounded-2xl border border-[#CCCEDA] bg-white px-8 pt-10 pb-8 text-center shadow-[0_1px_0_rgba(15,23,42,0.03)]">
      <ConfettiIcon class="text-argon-400/60 pointer-events-none absolute top-2 left-1/2 w-[92%] -translate-x-1/2" />

      <div class="relative z-10">
        <div class="mb-4 flex items-center justify-center text-xs tracking-widest text-slate-500 uppercase">
          <div class="h-px w-24 bg-slate-300" />
          <div class="px-4">Rewards Unlocked</div>
          <div class="h-px w-24 bg-slate-300" />
        </div>

        <div class="text-argon-700 text-5xl leading-none font-bold">You’re Fully Operational</div>

        <p class="mt-5 text-base leading-7 text-slate-700">
          Your account now qualifies for operational rewards from the Argon Treasury.
        </p>

        <p class="text-md mt-3 leading-7 text-slate-600">
          You can now sponsor the next operator into Argon by creating a private referral code and sharing it directly
          with someone you trust.
        </p>
      </div>
    </div>

    <div class="mt-6 grid grid-cols-2 gap-4">
      <div
        v-for="chip in celebrationChips"
        :key="chip.label"
        class="border-argon-300/60 bg-argon-600/5 rounded-2xl border px-5 py-5 text-center shadow-[inset_0_1px_0_rgba(255,255,255,0.9)]">
        <div class="text-argon-700/70 text-xs font-semibold tracking-widest uppercase">
          {{ chip.label }}
        </div>
        <div class="text-argon-700 mt-2 text-4xl font-bold">
          {{ chip.value }}
        </div>
        <div class="mt-2 text-sm leading-6 text-slate-500">
          {{ chip.copy }}
        </div>
      </div>
    </div>

    <div class="mt-5 rounded-2xl border border-slate-200 bg-white px-5 py-4">
      <div class="text-sm font-semibold text-slate-800">What happens next</div>
      <div class="mt-2 text-sm leading-6 text-slate-600">
        Create a referral code, copy the link, and send it to the operator you want to sponsor. If they become fully
        operational, both of you can receive a one-time Treasury payout of up to
        {{ operationalReferralRewardLabel }}.
      </div>
    </div>

    <div class="mt-5 rounded-xl border border-emerald-200 bg-emerald-50/70 px-4 py-3 text-sm text-emerald-800">
      If you joined through a referral code, your sponsor can also receive a one-time Treasury payout.
    </div>

    <div class="mt-7 flex items-center justify-end gap-3">
      <button
        type="button"
        class="rounded-lg px-4 py-2 text-sm font-semibold text-slate-500 hover:bg-slate-100 hover:text-slate-700"
        @click="emit('close')">
        Not Now
      </button>
      <button
        type="button"
        class="bg-argon-button hover:bg-argon-button-hover rounded-lg px-5 py-2.5 text-sm font-semibold text-white"
        @click="emit('goTo', 'overview', 'create')">
        Open Referral Codes
      </button>
    </div>
  </div>
</template>

<script setup lang="ts">
import * as Vue from 'vue';
import { MICROGONS_PER_ARGON } from '@argonprotocol/apps-core';
import { useOperationsController } from '../../../stores/operationsController.ts';
import { getCurrency } from '../../../stores/currency.ts';
import { createNumeralHelpers } from '../../../lib/numeral.ts';
import ConfettiIcon from '../../../assets/confetti.svg?component';

const emit = defineEmits<{
  close: [];
  goTo: [screen: 'overview', section?: 'create'];
}>();

const controller = useOperationsController();
const currency = getCurrency();

const { microgonToArgonNm } = createNumeralHelpers(currency);

const operationalReferralRewardLabel = Vue.computed(() => {
  return formatArgon(controller.rewardConfig.operationalReferralReward);
});
const earnedReferralRewardLabel = Vue.computed(() => {
  return formatArgon(controller.inviteSlotProgress.rewardsEarnedAmount);
});
const claimedReferralRewardLabel = Vue.computed(() => {
  return formatArgon(controller.inviteSlotProgress.rewardsCollectedAmount);
});
const pendingRewardLabel = Vue.computed(() => {
  return formatArgon(controller.pendingRewardsAmount);
});
const celebrationChips = Vue.computed(() => {
  return [
    {
      label: 'Rewards',
      value: earnedReferralRewardLabel.value,
      copy: `${claimedReferralRewardLabel.value} has been claimed. ${pendingRewardLabel.value} is waiting for you to claim.`,
    },
    {
      label: 'Referral Code Unlocked',
      value: '1',
      copy: 'You can now sponsor one new operator with a private referral link.',
    },
  ];
});

function formatArgon(amount: bigint) {
  const wholeArgon = BigInt(MICROGONS_PER_ARGON);
  return `₳${microgonToArgonNm(amount).format(amount % wholeArgon === 0n ? '0,0' : '0,0.00')}`;
}
</script>
