<!-- prettier-ignore -->
<template>
  <ServerConnectionStatus
    v-if="controller.operationalInviteLoadError && !controller.operationalInvites.length"
    featureName="Member onboarding"
    isBlocking
    isUnavailable
  >
    <template #icon><OnboardingIcon class="h-full w-full" /></template>
  </ServerConnectionStatus>

  <div v-else-if="!controller.hasLoadedOperationalInvites" class="flex h-full items-center justify-center">
    <div class="text-2xl font-bold text-slate-600/40 uppercase">Loading...</div>
  </div>

  <div v-else class="flex h-full grow flex-col">
    <ServerConnectionStatus
      v-if="config.isServerInstalling || controller.operationalInviteLoadError"
      featureName="Member onboarding"
      :isUnavailable="!!controller.operationalInviteLoadError"
    >
      <template #icon><OnboardingIcon class="h-full w-full" /></template>
    </ServerConnectionStatus>

    <TooltipProvider :disableHoverableContent="true">
      <section class="flex h-[14%] flex-row gap-x-2">
        <TooltipRoot>
          <TooltipTrigger as="div" box stat-box class="group flex w-[20%] flex-col !py-4">
            <span>
              {{ currency.symbol
              }}{{ microgonToMoneyNm(controller.operationalOverview.rewardsEarnedAmount).format('0,0.00') }}
            </span>
            <label>Rewards Earned</label>
          </TooltipTrigger>
          <TooltipContent
            side="bottom"
            :sideOffset="-10"
            align="start"
            :collisionPadding="9"
            class="z-50 w-xs rounded-md border border-gray-800/20 bg-white p-4 text-slate-900/60 shadow-2xl"
          >
            All operational rewards earned by this account, including rewards already collected.
            <TooltipArrow
              :width="27"
              :height="15"
              class="-mt-px fill-white stroke-gray-800/20 stroke-[0.5px]"
            />
          </TooltipContent>
        </TooltipRoot>

        <TooltipRoot>
          <TooltipTrigger as="div" box stat-box class="group flex w-[20%] flex-col !py-4">
            <span>
              {{ currency.symbol
              }}{{ microgonToMoneyNm(controller.operationalOverview.pendingRewardsAmount).format('0,0.00') }}
            </span>
            <label>Rewards Unclaimed</label>
          </TooltipTrigger>
          <TooltipContent
            side="bottom"
            :sideOffset="-10"
            align="center"
            :collisionPadding="9"
            class="z-50 w-xs rounded-md border border-gray-800/20 bg-white p-4 text-center text-slate-900/60 shadow-2xl"
          >
            Operational rewards that have been earned but have not been collected.
            <TooltipArrow
              :width="27"
              :height="15"
              class="-mt-px fill-white stroke-gray-800/20 stroke-[0.5px]"
            />
          </TooltipContent>
        </TooltipRoot>

        <TooltipRoot>
          <TooltipTrigger as="div" box stat-box class="group flex w-[20%] flex-col !py-4">
            <span>{{ controller.operationalOverview.availableUpgradeCodeCount }}</span>
            <label>Upgrade Codes Ready</label>
          </TooltipTrigger>
          <TooltipContent
            side="bottom"
            :sideOffset="-10"
            align="center"
            :collisionPadding="9"
            class="z-50 w-xs rounded-md border border-gray-800/20 bg-white p-4 text-center text-slate-900/60 shadow-2xl"
          >
            Operations upgrade codes currently available to approve certified treasury members.
            <TooltipArrow
              :width="27"
              :height="15"
              class="-mt-px fill-white stroke-gray-800/20 stroke-[0.5px]"
            />
          </TooltipContent>
        </TooltipRoot>

        <TooltipRoot>
          <TooltipTrigger as="div" box stat-box class="group flex w-[20%] flex-col !py-4">
            <span>{{ controller.operationalOverview.pendingInviteCount }}</span>
            <label>Pending Invites</label>
          </TooltipTrigger>
          <TooltipContent
            side="bottom"
            :sideOffset="-10"
            align="center"
            :collisionPadding="9"
            class="z-50 w-xs rounded-md border border-gray-800/20 bg-white p-4 text-center text-slate-900/60 shadow-2xl"
          >
            Non-expired invites from members who have not yet contributed Bitcoin or bonds.
            <TooltipArrow
              :width="27"
              :height="15"
              class="-mt-px fill-white stroke-gray-800/20 stroke-[0.5px]"
            />
          </TooltipContent>
        </TooltipRoot>

        <TooltipRoot>
          <TooltipTrigger as="div" box stat-box class="group flex w-[20%] flex-col !py-4">
            <span>{{ controller.operationalOverview.activeMemberCount }}</span>
            <label>Active Members</label>
          </TooltipTrigger>
          <TooltipContent
            side="bottom"
            :sideOffset="-10"
            align="end"
            :collisionPadding="9"
            class="z-50 w-xs rounded-md border border-gray-800/20 bg-white p-4 text-right text-slate-900/60 shadow-2xl"
          >
            Members who have contributed Bitcoin or bonds to your vault.
            <TooltipArrow
              :width="27"
              :height="15"
              class="-mt-px fill-white stroke-gray-800/20 stroke-[0.5px]"
            />
          </TooltipContent>
        </TooltipRoot>
      </section>
    </TooltipProvider>

    <section box class="mt-2 flex min-h-0 grow flex-col px-2">
      <header class="flex items-center gap-3 border-b border-slate-400/30 px-2 py-2">
        <button
          data-testid="Onboarding.editOperatorName"
          type="button"
          class="ml-auto cursor-pointer text-base font-light text-slate-700 hover:opacity-80"
          @click="basicEmitter.emit('openOperationalProfileOverlay', { screen: 'settings' })"
        >
          Settings
        </button>
        <div class="h-5 w-px bg-slate-600/30" />
        <button
          type="button"
          :disabled="!canViewRewards"
          class="cursor-pointer text-base font-light text-slate-700 hover:opacity-80 disabled:cursor-default disabled:opacity-35"
          @click="openRewards"
        >
          View Rewards
        </button>
        <div class="h-5 w-px bg-slate-600/30" />
        <span class="relative">
          <button
            data-testid="SendMemberInvite"
            type="button"
            :disabled="!canSendInvite"
            class="cursor-pointer text-base font-light text-slate-700 hover:opacity-80 disabled:cursor-default disabled:opacity-35"
            @click="
              showCreateInviteGuidance = false;
              basicEmitter.emit('openMemberInviteOverlay');
            "
          >
            Create Invite
          </button>
          <ArrowCalloutButton
            v-if="showCreateInviteGuidance"
            direction="right"
            guidanceTitle="Create Your First Invite"
            guidance="Create your first member invite here."
            :showGuidanceActions="false"
            class="absolute top-1/2 left-0 z-50 -translate-x-[calc(100%+0.75rem)] -translate-y-1/2"
          />
        </span>
      </header>

      <div v-if="controller.operationalInvites.length" class="min-h-0 grow px-5 py-4">
        <MemberInvites />
      </div>
      <div v-else-if="showInviteBlankSlate" class="flex min-h-0 grow items-center justify-center px-8 pb-16">
        <div class="flex max-w-xl flex-col items-center text-center">
          <OnboardingIcon class="text-argon-600/60 mb-6 h-28" />
          <div class="text-xl font-bold text-slate-800">Get started by sending your first invite</div>
          <p class="mt-2 text-sm leading-6 text-slate-500">
            Invite people into your vault, track their certification progress, and approve operations access when they
            are ready.
          </p>
          <button
            type="button"
            :disabled="!canSendInvite"
            class="bg-argon-button hover:bg-argon-button-hover mt-7 cursor-pointer rounded-md border border-transparent px-8 py-2.5 text-base font-bold text-white disabled:cursor-default disabled:opacity-40"
            @click="showCreateInviteGuidance = true"
          >
            Get Started
          </button>
        </div>
      </div>
    </section>
  </div>
</template>

<script setup lang="ts">
import * as Vue from 'vue';
import { NetworkConfig } from '@argonprotocol/apps-core';
import { TooltipArrow, TooltipContent, TooltipProvider, TooltipRoot, TooltipTrigger } from 'reka-ui';
import OnboardingIcon from '../../assets/onboarding.svg?component';
import ArrowCalloutButton from '../../components/ArrowCalloutButton.vue';
import basicEmitter from '../../emitters/basicEmitter.ts';
import { createNumeralHelpers } from '../../lib/numeral.ts';
import { useCertificationController } from '../../stores/certificationController.ts';
import { getConfig } from '../../stores/config.ts';
import { getCurrency } from '../../stores/currency.ts';
import { getMyVault } from '../../stores/vaults.ts';
import MemberInvites from './components/MemberInvites.vue';
import ServerConnectionStatus from '../../components/ServerConnectionStatus.vue';

const config = getConfig();
const controller = useCertificationController();
const currency = getCurrency();
const myVault = getMyVault();
const { microgonToMoneyNm } = createNumeralHelpers(currency);

const showCreateInviteGuidance = Vue.ref(false);
let loadInvitesPromise: Promise<unknown> | undefined;

const canViewRewards = Vue.computed(() => {
  return (
    controller.operationalOverview.isOperationalActivationReady || controller.operationalOverview.isFullyOperational
  );
});

const canSendInvite = Vue.computed(() => {
  return (
    config.isServerInstalled &&
    controller.hasLoadedOperationalInvites &&
    !controller.operationalInviteLoadError &&
    !!myVault.createdVault
  );
});

const showInviteBlankSlate = Vue.computed(() => {
  return controller.hasLoadedOperationalInvites && controller.operationalInvites.length === 0;
});

function openRewards() {
  if (controller.operationalOverview.isOperationalActivationReady) {
    basicEmitter.emit('openOperationalRewardsOverlay', { screen: 'activate' });
    return;
  }

  if (controller.operationalOverview.isFullyOperational) {
    basicEmitter.emit('openOperationalRewardsOverlay', { screen: 'claim' });
  }
}

function loadInvites(): Promise<unknown> {
  if (loadInvitesPromise) return loadInvitesPromise;

  const promise = controller
    .loadOperationalInvites()
    .catch(() => undefined)
    .finally(() => {
      loadInvitesPromise = undefined;
    });
  loadInvitesPromise = promise;

  return promise;
}

Vue.watch(
  [() => config.isLoaded, () => config.isServerInstalled, () => config.serverDetails.ipAddress],
  ([isConfigLoaded, isServerInstalled, ipAddress], _previous, onCleanup) => {
    if (!isConfigLoaded || !isServerInstalled || !ipAddress) return;

    void loadInvites();
    const interval = setInterval(
      () => {
        if (document.visibilityState !== 'visible') return;
        void loadInvites();
      },
      Math.max(NetworkConfig.tickMillis, 5_000),
    );

    onCleanup(() => clearInterval(interval));
  },
  { immediate: true },
);
</script>

<style scoped>
@reference "../../main.css";

[box] {
  @apply min-h-20 rounded border-[1px] border-slate-400/30 bg-white py-2 shadow;
}

[stat-box] {
  @apply text-argon-600 flex flex-col items-center justify-center;

  span {
    @apply font-mono text-3xl font-bold;
  }

  label {
    @apply group-hover:text-argon-600/60 mt-1 text-sm text-gray-500;
  }
}
</style>
