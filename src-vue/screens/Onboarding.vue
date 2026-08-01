<!-- prettier-ignore -->
<template>
  <div class="flex h-full grow flex-col">
    <template v-if="config.hasExtensionOperations">
      <div v-if="!config.isServerInstalled" class="flex h-full items-center justify-center text-slate-500">
        Finish installing your server before managing member invites.
      </div>

      <div v-else-if="inviteLoadError" class="flex h-full items-center justify-center text-red-600">
        {{ inviteLoadError }}
      </div>

      <div v-else-if="!controller.hasLoadedOperationalInvites" class="flex h-full items-center justify-center">
        <div class="text-2xl font-bold text-slate-600/40 uppercase">Loading...</div>
      </div>

      <BlankSlate v-else-if="!controller.operationalInvites.length" />
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
import * as Vue from 'vue';
import { NetworkConfig } from '@argonprotocol/apps-core';
import LockedIcon from '../assets/locked.svg?component';
import { useCertificationController } from '../stores/certificationController.ts';
import { getConfig } from '../stores/config.ts';
import BlankSlate from './onboarding-screen/BlankSlate.vue';
import Dashboard from './onboarding-screen/Dashboard.vue';

const config = getConfig();
const controller = useCertificationController();
const inviteLoadError = Vue.ref('');

Vue.watch(
  [() => config.hasExtensionOperations, () => config.isServerInstalled, () => config.serverDetails.ipAddress],
  async ([hasExtensionOperations, isServerInstalled, ipAddress]) => {
    if (!hasExtensionOperations || !isServerInstalled || !ipAddress) return;

    inviteLoadError.value = '';
    try {
      await controller.loadOperationalInvites();
    } catch {
      inviteLoadError.value = 'Unable to load member invites right now.';
    }
  },
  { immediate: true },
);
</script>

<style scoped>
@reference "../main.css";

[box] {
  @apply min-h-20 rounded border-[1px] border-slate-400/30 bg-white py-2 shadow;
}
</style>
