<template>
  <div class="px-6 pt-6">
    <div
      class="relative overflow-hidden rounded-2xl border border-[#CCCEDA] bg-white px-8 pt-10 pb-8 text-center shadow-[0_1px_0_rgba(15,23,42,0.03)]">
      <div class="relative z-10">
        <div class="mb-4 flex items-center justify-center text-xs tracking-widest text-slate-500 uppercase">
          <div class="h-px w-24 bg-slate-300" />
          <div class="px-4">Certification Activated</div>
          <div class="h-px w-24 bg-slate-300" />
        </div>

        <div class="text-argon-700 text-5xl leading-none font-bold">So What’s Next?</div>

        <p class="mt-5 text-base leading-7 text-slate-700">
          You've earned one exclusive referral code. Share it with someone you trust. When they complete the Argon
          Operational Certification, you both earn ₳{{
            microgonToArgonNm(controller.rewardConfig.operationalReferralReward).format('0,0.[00]')
          }}.
        </p>

        <div class="text-argon-700 mt-6 text-4xl leading-tight font-bold">
          Every {{ controller.rewardConfig.referralBonusEveryXOperationalSponsees }} successful referrals earns a ₳{{
            microgonToArgonNm(controller.rewardConfig.referralBonusReward).format('0,0.[00]')
          }}
          bonus.
        </div>

        <p class="text-md mt-3 leading-7 text-slate-600">
          Spread what you learned and bring more operators into Argon. You can unlock more referral codes by adding
          Bitcoin to your vault, earning more mining seats, or onboarding successful operators.
        </p>
      </div>
    </div>

    <div class="mt-6 grid grid-cols-2 gap-4">
      <div
        class="border-argon-300/60 bg-argon-600/5 rounded-2xl border px-5 py-5 text-center shadow-[inset_0_1px_0_rgba(255,255,255,0.9)]">
        <div class="text-argon-700/70 text-xs font-semibold tracking-widest uppercase">Rewards</div>
        <div class="text-argon-700 mt-2 text-4xl font-bold">
          ₳{{ microgonToArgonNm(controller.inviteSlotProgress.rewardsEarnedAmount).format('0,0.[00]') }}
        </div>
        <div class="mt-2 text-sm leading-6 text-slate-500">
          ₳{{ microgonToArgonNm(controller.inviteSlotProgress.rewardsCollectedAmount).format('0,0.[00]') }} has been
          claimed. ₳{{ microgonToArgonNm(controller.pendingRewardsAmount).format('0,0.[00]') }} is waiting for you to
          claim.
        </div>
      </div>

      <div
        class="border-argon-300/60 bg-argon-600/5 rounded-2xl border px-5 py-5 text-center shadow-[inset_0_1px_0_rgba(255,255,255,0.9)]">
        <div class="text-argon-700/70 text-xs font-semibold tracking-widest uppercase">Referral Code Unlocked</div>
        <div class="text-argon-700 mt-2 text-4xl font-bold">1</div>
        <div class="mt-2 text-sm leading-6 text-slate-500">
          You can now sponsor one new operator with a private referral link.
        </div>
      </div>
    </div>

    <div
      v-if="sponsorRewardName"
      class="border-argon-300/60 bg-argon-600/5 mt-5 rounded-2xl border px-5 py-4 shadow-[inset_0_1px_0_rgba(255,255,255,0.9)]">
      <div class="text-argon-700/70 text-xs font-semibold tracking-widest uppercase">Sponsor Reward</div>
      <div class="mt-2 text-sm leading-6 text-slate-600">
        {{ sponsorRewardName }} also received ₳{{
          microgonToArgonNm(controller.rewardConfig.operationalReferralReward).format('0,0.[00]')
        }}
        because you activated your certification through their referral code.
      </div>
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
        @click="goToPrimaryAction">
        {{ primaryActionLabel }}
      </button>
    </div>
  </div>
</template>

<script setup lang="ts">
import * as Vue from 'vue';
import { useOperationsController } from '../../../stores/operationsController.ts';
import { getConfig } from '../../../stores/config.ts';
import { getCurrency } from '../../../stores/currency.ts';
import { createNumeralHelpers } from '../../../lib/numeral.ts';

const emit = defineEmits<{
  close: [];
  goTo: [screen: 'claim' | 'overview', section?: 'create'];
}>();

const controller = useOperationsController();
const config = getConfig();
const currency = getCurrency();

const { microgonToArgonNm } = createNumeralHelpers(currency);

const primaryActionLabel = Vue.computed(() => {
  return 'Open Referral Codes';
});
const sponsorRewardName = Vue.computed(() => {
  const upstreamOperator = config.upstreamOperator;
  if (!upstreamOperator?.operationalReferral) return '';

  return upstreamOperator.name.trim();
});

function goToPrimaryAction() {
  emit('goTo', 'overview', 'create');
}
</script>
