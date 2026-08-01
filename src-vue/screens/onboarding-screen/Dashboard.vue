<!-- prettier-ignore -->
<template>
  <div class="flex h-full grow flex-col">
    <TooltipProvider :disableHoverableContent="true">
      <section class="flex h-[14%] flex-row gap-x-2">
        <TooltipRoot>
          <TooltipTrigger as="div" box stat-box class="group flex w-[20%] flex-col !py-4">
            <span>₳{{ microgonToArgonNm(controller.operationalOverview.rewardsEarnedAmount).format('0,0.[00]') }}</span>
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
            <span>₳{{ microgonToArgonNm(controller.operationalOverview.pendingRewardsAmount).format('0,0.[00]') }}</span>
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
      <header class="flex items-center justify-end gap-3 border-b border-slate-400/30 px-2 py-2">
        <button
          type="button"
          :disabled="!canViewRewards"
          class="cursor-pointer text-base font-light text-slate-700 hover:opacity-80 disabled:cursor-default disabled:opacity-35"
          @click="openRewards"
        >
          View Rewards
        </button>
        <template v-if="supportsFlexibleAssets">
          <div class="h-5 w-px bg-slate-600/30" />
          <button
            type="button"
            :disabled="!myVault.createdVault"
            class="cursor-pointer text-base font-light text-slate-700 hover:opacity-80 disabled:cursor-default disabled:opacity-35"
            @click="basicEmitter.emit('openBackfillOverlay')"
          >
            Manage Flexible Assets
          </button>
        </template>
        <div class="h-5 w-px bg-slate-600/30" />
        <button
          data-testid="SendMemberInvite"
          type="button"
          :disabled="!canSendInvite"
          class="cursor-pointer text-base font-light text-slate-700 hover:opacity-80 disabled:cursor-default disabled:opacity-35"
          @click="basicEmitter.emit('openMemberInviteOverlay')"
        >
          Send Invite
        </button>
      </header>

      <div class="min-h-0 grow px-5 py-4">
        <MemberInvites />
      </div>
    </section>
  </div>
</template>

<script setup lang="ts">
import * as Vue from 'vue';
import { TooltipArrow, TooltipContent, TooltipProvider, TooltipRoot, TooltipTrigger } from 'reka-ui';
import basicEmitter from '../../emitters/basicEmitter.ts';
import { supportsFlexibleAssetsRuntime } from '../../lib/MyVault.ts';
import { createNumeralHelpers } from '../../lib/numeral.ts';
import { useCertificationController } from '../../stores/certificationController.ts';
import { getConfig } from '../../stores/config.ts';
import { getCurrency } from '../../stores/currency.ts';
import { getMainchainClient } from '../../stores/mainchain.ts';
import { getMyVault } from '../../stores/vaults.ts';
import MemberInvites from './components/MemberInvites.vue';

const config = getConfig();
const controller = useCertificationController();
const currency = getCurrency();
const myVault = getMyVault();
const { microgonToArgonNm } = createNumeralHelpers(currency);

const supportsFlexibleAssets = Vue.ref(false);

const canViewRewards = Vue.computed(() => {
  return (
    controller.operationalOverview.isOperationalActivationReady || controller.operationalOverview.isFullyOperational
  );
});

const canSendInvite = Vue.computed(() => {
  return config.isServerInstalled && controller.hasLoadedOperationalInvites && !!myVault.createdVault;
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

Vue.onMounted(async () => {
  const client = await getMainchainClient(false);
  supportsFlexibleAssets.value = supportsFlexibleAssetsRuntime(client);
});
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
