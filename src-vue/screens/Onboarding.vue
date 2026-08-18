<!-- prettier-ignore -->
<template>
  <div class="relative isolate h-full w-full">
    <template v-if="config.hasExtensionOperations">
      <SetupInstalling
        v-if="config.onboardingSetupStatus === OnboardingSetupStatus.Installing"
        :operatorName="controller.onboardingOperatorNameDraft"
      />
      <SetupChecklist
        v-else-if="config.onboardingSetupStatus === OnboardingSetupStatus.Checklist"
        @activate="activateOnboarding"
      />
      <BlankSlate v-else-if="config.onboardingSetupStatus === OnboardingSetupStatus.None" />
      <Dashboard v-else />
    </template>

    <section v-else-if="config.hasExtensionTreasury" box class="grow">
      <div class="text-argon-600/60 relative z-10 mt-0">
        <LockedIcon class="mx-auto w-10" />
        <div class="mt-7 text-center text-5xl font-bold">LOCKED</div>
        <div
          class="border-argon-600/10 mx-auto mt-6 w-fit border-y px-3 py-6 text-center text-2xl leading-normal font-bold text-slate-800/80"
        >
          You Must Complete Your Operator<br />
          Certification to Unlock Additional Features
        </div>
        <div class="mt-6 text-center">
          <a :href="`${NetworkConfig.websiteHost}/docs/desktop-app/treasury-extension`">Learn more</a>
        </div>
      </div>
    </section>
  </div>
</template>

<script setup lang="ts">
import { NetworkConfig } from '@argonprotocol/apps-core';
import LockedIcon from '../assets/locked.svg?component';
import { OnboardingSetupStatus } from '../interfaces/IConfig.ts';
import { useCertificationController } from '../stores/certificationController.ts';
import { getConfig } from '../stores/config.ts';
import BlankSlate from './onboarding-screen/BlankSlate.vue';
import Dashboard from './onboarding-screen/Dashboard.vue';
import SetupChecklist from './onboarding-screen/SetupChecklist.vue';
import SetupInstalling from './onboarding-screen/SetupInstalling.vue';

const config = getConfig();
const controller = useCertificationController();

function activateOnboarding(operatorName: string) {
  controller.onboardingOperatorNameDraft = operatorName;
  config.onboardingSetupStatus = OnboardingSetupStatus.Installing;
  void config.save();
}
</script>

<style scoped>
@reference "../main.css";

[box] {
  @apply min-h-20 rounded border-[1px] border-slate-400/30 bg-white py-2 shadow;
}
</style>
