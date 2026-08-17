<!-- prettier-ignore -->
<template>
  <div DashBox class="flex h-full flex-col">
    <div class="flex grow flex-col items-center justify-center">
      <section class="flex w-full -translate-y-4 flex-col items-center text-center">
        <header class="text-argon-600/70 text-2xl font-normal tracking-widest">MEMBER ONBOARDING</header>
        <h1 class="mt-2 text-4xl font-bold text-slate-800 opacity-80 xl:text-5xl">
          Grow Your Vault. Grow the Network.
        </h1>
        <p class="mt-3 max-w-4xl text-xl leading-relaxed text-slate-900/60">
          Set up member onboarding to invite friends, guide them through certification, and earn referral rewards.
        </p>

        <ul class="mt-10 flex w-[86%] max-w-310 flex-row gap-x-4">
          <li class="w-1/3 rounded-md border border-slate-600/30 px-4 pt-6 pb-4">
            <div class="mx-auto flex h-18 w-26 items-center justify-center">
              <GrowVaultIcon class="text-argon-600/60 h-18 w-26" />
            </div>
            <header class="mt-5 mb-1 font-bold text-slate-800">1. Invite Your Friends</header>
            <p class="mx-auto max-w-72 leading-relaxed text-slate-900/60">
              Invite friends to use your vault for Bitcoin locks and Argon Bonds.
            </p>
          </li>

          <li class="w-1/3 rounded-md border border-slate-600/30 px-4 pt-6 pb-4">
            <div class="mx-auto flex h-18 w-26 items-center justify-center">
              <CertificationCompleteIcon class="text-argon-600/60 h-18 w-26" />
            </div>
            <header class="mt-5 mb-1 font-bold text-slate-800">2. Show Them the Ropes</header>
            <p class="mx-auto max-w-72 leading-relaxed text-slate-900/60">Use your experience to guide them through certification.</p>
          </li>

          <li class="w-1/3 rounded-md border border-slate-600/30 px-4 pt-6 pb-4">
            <div class="text-argon-600/60 mx-auto flex h-18 w-26 items-center justify-center">
              <div class="relative flex size-14 items-center justify-center rounded-full border-2 border-current">
                <span class="pointer-events-none absolute inset-1 rounded-full border border-current"></span>
                <ArgonIcon class="h-8 w-auto" />
                <SparkleIcon class="absolute -top-1 -right-3 h-4 w-4" />
              </div>
            </div>
            <header class="mt-5 mb-1 font-bold text-slate-800">3. Earn Rewards</header>
            <p class="mx-auto max-w-72 leading-relaxed text-slate-900/60">
              You and new operators earn ₳{{
                microgonToArgonNm(controller.rewardConfig.operationalActivationReward).format('0,0.[00]')
              }} each. You earn ₳{{
                microgonToArgonNm(controller.rewardConfig.operationalReferralBonusReward).format('0,0.[00]')
              }} every {{ controller.rewardConfig.operationalReferralsPerBonusReward }}.
            </p>
          </li>
        </ul>

        <button
          data-testid="SetupMemberOnboarding"
          type="button"
          class="inner-button-shadow bg-argon-button border-argon-button-hover hover:bg-argon-button-hover mt-10 flex cursor-pointer items-center gap-3 rounded-md border px-12 py-3 text-lg font-bold text-white disabled:cursor-default disabled:opacity-40"
          @click="continueOnboarding"
        >
          Set Up Member Onboarding
          <PaperAirplaneIcon class="size-5" />
        </button>
      </section>
    </div>
  </div>
</template>

<script setup lang="ts">
import { PaperAirplaneIcon } from '@heroicons/vue/24/solid';
import ArgonIcon from '../../assets/wallets/networks/argon.svg?component';
import SparkleIcon from '../../assets/sparkle-outline.svg?component';
import { OnboardingSetupStatus } from '../../interfaces/IConfig.ts';
import { createNumeralHelpers } from '../../lib/numeral.ts';
import { useCertificationController } from '../../stores/certificationController.ts';
import { getConfig } from '../../stores/config.ts';
import { getCurrency } from '../../stores/currency.ts';
import CertificationCompleteIcon from './images/certification-complete.svg?component';
import GrowVaultIcon from './images/grow-vault.svg?component';

const config = getConfig();
const controller = useCertificationController();
const currency = getCurrency();
const { microgonToArgonNm } = createNumeralHelpers(currency);
function continueOnboarding() {
  config.onboardingSetupStatus = OnboardingSetupStatus.Checklist;
  void config.save();
}
</script>
