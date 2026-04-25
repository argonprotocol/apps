<!-- prettier-ignore -->
<template>
  <div>
    <div v-if="isShowingCompletionTooltip" class="z-50 absolute top-6 right-[46px] pt-[12px]">
      <Arrow
        class="absolute top-0 right-6 h-3.5 w-6"
        fill="white"
      />
      <Arrow
        class="absolute top-0 right-6 h-3.5 w-6"
        fill="color-mix(in oklab, var(--color-argon-600) 5%, transparent)"
      />
      <div class="rounded border border-argon-400/50 bg-white pt-0.5 pl-0.5 shadow-xl">
        <div class="relative w-108 rounded bg-argon-600/5 px-5 pt-3 pb-5" style="text-shadow: 1px 1px 0 white">
          <div class="mb-2 flex items-center justify-between border-b border-argon-300/20 pb-2">
            <div class="text-xl font-bold text-argon-600">Step Completed</div>
            <button
              @click="dismissCompletionNotice"
              class="cursor-pointer rounded-full p-1 text-argon-600/70 hover:bg-white/70 hover:text-argon-800"
              aria-label="Close tooltip"
            >
              <XMarkIcon class="h-5 w-5 stroke-[2.5]" />
            </button>
          </div>
          <p class="mt-1 text-argon-600">
            <span class="font-semibold">{{ completionNoticeStepTitle }}</span> is now complete. Open the menu above to
            see your updated progress.
          </p>
        </div>
      </div>
    </div>

    <div v-else-if="isShowingBonusTooltip" class="z-50 absolute top-6 right-[46px] pt-[12px]">
      <Arrow
        class="absolute top-0 right-6 w-6 h-3.5"
        fill="white"
      />
      <Arrow
        class="absolute top-0 right-6 w-6 h-3.5"
        fill="color-mix(in oklab, var(--color-argon-600) 5%, transparent)"
      />
      <div class="bg-white border border-argon-400/50 rounded shadow-xl pt-0.5 pl-0.5">
        <div class="relative bg-argon-600/5 w-108 rounded px-5 pb-5 pt-3" style="text-shadow: 1px 1px 0 white">
          <div class="flex items-center justify-between border-b border-argon-300/20 pb-2 mb-2">
            <div class="font-bold text-argon-600 text-xl">Collect Your Treasury Bonus</div>
            <button
              @click="dismissMessage"
              class="cursor-pointer rounded-full p-1 text-argon-600/70 hover:bg-white/70 hover:text-argon-800"
              aria-label="Close tooltip"
            >
              <XMarkIcon class="h-5 w-5 stroke-[2.5]" />
            </button>
          </div>
          <p class="text-argon-600 mt-1">
            A bonus of {{ operationalReferralRewardLabel }} has been set aside in Argon's Treasury for your benefit. It
            will be claimable once your account becomes fully operational. Open the menu above to learn more.
          </p>
        </div>
      </div>
    </div>

    <div ref="rootRef" @mouseenter="onMouseEnter" @mouseleave="onMouseLeave">
      <DropdownMenuRoot :openDelay="0" :closeDelay="0" class="relative pointer-events-auto" v-model:open="isOpen">
        <DropdownMenuTrigger
          Trigger
          :aria-label="controller.isFullyOperational ? 'Operational rewards' : 'Operational progress'"
          class="flex flex-row items-center justify-center overflow-hidden text-argon-600/70 cursor-pointer border rounded-md hover:bg-slate-400/10 h-[30px] focus:outline-none hover:border-slate-400/50"
          :class="[
            isOpen ? 'border-slate-400/60 bg-slate-400/10' : 'border-slate-400/50',
            controller.isFullyOperational ? 'w-[42px]' : 'font-mono text-base font-semibold',
          ]"
        >
          <template v-if="controller.isFullyOperational">
            <div class="relative flex h-full w-full items-center justify-center">
              <div class="menu-moon">
                <div class="menu-moon-crater left-[3px] top-[5px]" />
                <div class="menu-moon-crater h-[2.5px] w-[2.5px] right-[4px] bottom-[5px]" />
                <div v-if="hasInviteMoonBase" class="menu-moon-base" />
              </div>
              <RocketIcon class="menu-moon-rocket" aria-hidden="true" />
            </div>
          </template>

          <div v-else class="relative flex flex-row items-center pl-2.5 pr-3 pt-px">
            <RocketIcon class="h-[17px] relative top-[2px] mr-[5px] -rotate-45" aria-hidden="true" />
            {{ controller.completedCertificationStepCount }}/{{ controller.certificationStepCount }}
          </div>
        </DropdownMenuTrigger>

        <DropdownMenuPortal>
          <DropdownMenuContent
            @mouseenter="onMouseEnter"
            @mouseleave="onMouseLeave"
            @pointerDownOutside="clickOutside"
            :align="'end'"
            :alignOffset="0"
            :sideOffset="-3"
            class="data-[side=bottom]:animate-slideUpAndFade data-[side=right]:animate-slideLeftAndFade data-[side=left]:animate-slideRightAndFade data-[side=top]:animate-slideDownAndFade z-50 data-[state=open]:transition-all"
          >
            <div class="relative">
              <div class="w-fit bg-argon-menu-bg flex shrink flex-col rounded p-1 text-gray-900 shadow-lg ring-1 ring-gray-900/20">
                <div v-if="controller.isFullyOperational" class="w-[26rem] px-4 pt-4 pb-4">
                  <div class="border-b border-slate-300/50 pb-2.5">
                    <div class="text-lg font-bold text-slate-700">Operator Referrals</div>
                    <div class="mt-0.5 text-sm text-slate-500">
                      Earn {{ operationalReferralRewardLabel }} for both you and each referral who completes the operational checklist. Every
                      {{ controller.rewardConfig.referralBonusEveryXOperationalSponsees }} referred triggers a
                      {{ referralBonusRewardLabel }} bonus!
                    </div>
                  </div>

                  <OperationalInviteSlots
                    class="mt-3"
                    mode="menu"
                    :progress="controller.inviteSlotProgress"
                    :rewardConfig="controller.rewardConfig"
                    :invites="controller.operationalInvites"
                    @select="openInviteHub"
                  />

                  <div class="mt-4 ">
                    <div StatsBox box class="mt-2 grid grid-cols-3 overflow-hidden text-center">
                      <Tooltip
                        v-for="stat in referralStats"
                        :key="stat.label"
                        asChild
                        side="bottom"
                        :content="stat.tooltip">
                        <div StatWrapper class="border-r border-slate-200/70 px-3 py-2.5 last:border-r-0">
                          <div Stat class="text-2xl! leading-none">{{ stat.value }}</div>
                          <div class="mt-1.5 text-xs font-semibold tracking-widest text-slate-400 uppercase">{{ stat.label }}</div>
                        </div>
                      </Tooltip>
                    </div>
                  </div>

                  <div
                    v-if="hasUnclaimedRewards"
                    class="mt-3 flex items-center justify-between gap-3 rounded-xl border border-slate-200 bg-slate-50/70 px-3 py-2">
                    <div class="min-w-0">
                      <div class="text-sm font-semibold text-slate-800">{{ pendingReferralRewardLabel }} unclaimed</div>
                      <div class="text-xs text-slate-500">Choose where to send rewards.</div>
                    </div>
                    <button
                      type="button"
                      class="text-argon-700 shrink-0 rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-sm font-semibold hover:border-slate-400"
                      @click="openRewardsClaim()"
                    >
                      Claim
                    </button>
                  </div>

                  <div class="mt-4 flex items-center justify-end border-t border-slate-300/50 pt-3">
                    <button
                      type="button"
                      class="text-argon-700 rounded-lg border border-slate-300 px-3 py-1.5 text-sm font-semibold hover:border-slate-400 hover:bg-white"
                      @click="openInviteHub()"
                    >
                      Manage Referral Codes
                    </button>
                  </div>
                </div>

                <div v-else class="max-w-160 pt-4 pb-2">
                  <p class="font-light px-5 ">
                    Complete the following seven steps, and you'll earn
                    (along with your sponsor) a {{ operationalReferralRewardLabel }} bonus from the Argon Treasury.
                  </p>
                  <ul class="flex flex-col mt-3 mb-1 text-base font-semibold divide-y divide-slate-600/15 whitespace-nowrap">
                    <li
                      v-for="[stepId, step] of Object.entries(operationalSteps)"
                      @click="openOverlay(stepId as OperationalStepId, $event)"
                      class="flex flex-row items-center gap-x-2 py-3 pl-5 pr-2 cursor-pointer"
                      :class="controller.isCertificationStepUnlocked(stepId as OperationalStepId) ? 'hover:bg-argon-600/5' : 'bg-slate-50/80 text-slate-500'"
                    >
                      <Checkbox
                        :size="7"
                        :isChecked="
                          controller.isCertificationStepComplete(stepId as OperationalStepId) ||
                          controller.isCertificationStepUnderway(stepId as OperationalStepId)
                        "
                        :isPulsing="controller.isCertificationStepUnderway(stepId as OperationalStepId)"
                      />
                      <span class="grow">{{ step.title }}</span>
                      <span
                        v-if="controller.isCertificationStepUnderway(stepId as OperationalStepId)"
                        class="rounded-full border border-argon-300 bg-argon-50 px-2 py-1 text-xs font-medium text-argon-700"
                      >
                        Underway
                      </span>
                      <span
                        v-if="controller.getCertificationBlocker(stepId as OperationalStepId)"
                        class="rounded-full border border-slate-300 bg-white px-2 py-1 text-xs font-medium text-slate-500"
                      >
                        Requires: {{ controller.getCertificationBlocker(stepId as OperationalStepId)?.title }}
                      </span>
                      <a :href="step.documentationLink" target="_blank" class="px-3 text-right text-argon-600 font-light hover:bg-white hover:text-argon-700! rounded-full">Open Docs</a>
                    </li>
                  </ul>
                  <div class="pt-4 pb-2 px-5 border-t border-slate-500/30">
                    <a href="https://argon.network/docs/operator-certification" target="_blank" class="text-argon-600 hover:text-argon-700! font-light">
                      Learn more about the Argon's Operator Certification.
                    </a>
                  </div>
                </div>
              </div>
            </div>
            <DropdownMenuArrow :width="18" :height="10" class="mt-[0px] fill-white stroke-gray-300" />
          </DropdownMenuContent>
        </DropdownMenuPortal>
      </DropdownMenuRoot>
    </div>
  </div>
</template>

<script setup lang="ts">
import * as Vue from 'vue';
import { MICROGONS_PER_ARGON } from '@argonprotocol/apps-core';
import {
  DropdownMenuArrow,
  DropdownMenuContent,
  DropdownMenuPortal,
  DropdownMenuRoot,
  DropdownMenuTrigger,
  PointerDownOutsideEvent,
} from 'reka-ui';
import { XMarkIcon } from '@heroicons/vue/24/outline';
import RocketIcon from '../../assets/rocket.svg?component';
import basicEmitter from '../../emitters/basicEmitter.ts';
import { getConfig } from '../../stores/config.ts';
import { getCurrency } from '../../stores/currency.ts';
import Checkbox from '../../components/Checkbox.vue';
import Arrow from '../../components/Arrow.vue';
import Tooltip from '../../components/Tooltip.vue';
import OperationalInviteSlots from '../components/OperationalInviteSlots.vue';
import { createNumeralHelpers } from '../../lib/numeral.ts';
import { OperationalStepId, operationalSteps, useOperationsController } from '../../stores/operationsController.ts';

const config = getConfig();
const controller = useOperationsController();
const currency = getCurrency();

const { microgonToArgonNm } = createNumeralHelpers(currency);

const isOpen = Vue.ref(false);
const rootRef = Vue.ref<HTMLElement>();
const completionNoticeStepId = Vue.computed(() => controller.pendingCompletionNoticeStepId);
const completionNoticeStepTitle = Vue.computed(() => {
  return completionNoticeStepId.value ? operationalSteps[completionNoticeStepId.value].title : '';
});
const isShowingCompletionTooltip = Vue.computed(() => {
  return !!completionNoticeStepId.value && !isOpen.value && !controller.isFullyOperational;
});
const isShowingBonusTooltip = Vue.computed(() => {
  const showBonusTooltip = config.certificationDetails?.showBonusTooltip;
  return (
    showBonusTooltip &&
    !isOpen.value &&
    !!config.upstreamOperator?.inviteSecret &&
    !completionNoticeStepId.value &&
    !controller.isFullyOperational
  );
});
const operationalReferralRewardLabel = Vue.computed(() => {
  return formatArgon(controller.rewardConfig.operationalReferralReward);
});
const referralBonusRewardLabel = Vue.computed(() => {
  return formatArgon(controller.rewardConfig.referralBonusReward);
});
const earnedReferralRewardLabel = Vue.computed(() => {
  return formatArgon(controller.inviteSlotProgress.rewardsEarnedAmount);
});
const claimedReferralRewardLabel = Vue.computed(() => {
  return formatArgon(controller.inviteSlotProgress.rewardsCollectedAmount);
});
const pendingReferralRewardLabel = Vue.computed(() => {
  return formatArgon(controller.pendingRewardsAmount);
});
const hasUnclaimedRewards = Vue.computed(() => {
  return controller.pendingRewardsAmount > 0n;
});
const referralBonusProgressLabel = Vue.computed(() => {
  const bonusEvery = Math.max(controller.rewardConfig.referralBonusEveryXOperationalSponsees, 1);
  return `${controller.inviteSlotProgress.operationalReferralsCount % bonusEvery}/${bonusEvery}`;
});
const referralStats = Vue.computed(() => {
  return [
    {
      label: 'Earned',
      value: earnedReferralRewardLabel.value,
      tooltip: `${claimedReferralRewardLabel.value} has been claimed. ${pendingReferralRewardLabel.value} is unclaimed.`,
    },
    {
      label: 'Next Bonus',
      value: referralBonusRewardLabel.value,
      tooltip: `Every ${controller.rewardConfig.referralBonusEveryXOperationalSponsees} referred operators earns this bonus.`,
    },
    {
      label: 'Bonus Progress',
      value: referralBonusProgressLabel.value,
      tooltip: 'Your progress toward the next referral bonus.',
    },
  ];
});
const hasInviteMoonBase = Vue.computed(() => {
  return (
    controller.inviteSlotProgress.unactivatedReferrals > 0 ||
    controller.inviteSlotProgress.operationalReferralsCount > 0 ||
    controller.inviteSlotProgress.referralPending
  );
});
let mouseLeaveTimeoutId: ReturnType<typeof setTimeout> | undefined = undefined;

function dismissCompletionNotice() {
  controller.dismissCompletionNotice();
}

function dismissMessage() {
  config.setCertificationDetails({ showBonusTooltip: false });
  void config.save();
}

function onMouseEnter() {
  if (mouseLeaveTimeoutId) {
    clearTimeout(mouseLeaveTimeoutId);
  }

  mouseLeaveTimeoutId = undefined;
  controller.clearCompletionNotices();
  isOpen.value = true;
}

function onMouseLeave() {
  if (mouseLeaveTimeoutId) {
    clearTimeout(mouseLeaveTimeoutId);
  }

  mouseLeaveTimeoutId = setTimeout(() => {
    isOpen.value = false;
  }, 100);
}

function clickOutside(e: PointerDownOutsideEvent) {
  const isChildOfTrigger = !!(e.target as HTMLElement)?.closest('[Trigger]');
  if (!isChildOfTrigger) return;

  isOpen.value = true;
  setTimeout(() => {
    isOpen.value = true;
  }, 200);
  e.detail.originalEvent.stopPropagation();
  e.detail.originalEvent.preventDefault();
  e.stopPropagation();
  e.preventDefault();
  return false;
}

function openOverlay(stepId: OperationalStepId, event: MouseEvent) {
  const clickTarget = event.target;
  if (clickTarget instanceof HTMLElement && clickTarget.closest('a')) {
    return;
  }

  openOperationalOverlay(stepId);
}

function openOperationalOverlay(stepId: OperationalStepId) {
  isOpen.value = false;
  controller.clearCompletionNotices();
  config.setCertificationDetails({ showBonusTooltip: false });
  basicEmitter.emit('openOperationalOverlay', stepId);
}

function openInviteHub(section?: 'create' | 'unlock' | 'outbound') {
  isOpen.value = false;
  basicEmitter.emit('openOperationalRewardsOverlay', { screen: 'overview', section });
}

function openRewardsClaim() {
  isOpen.value = false;
  basicEmitter.emit('openOperationalRewardsOverlay', { screen: 'claim' });
}

Vue.watch(isOpen, value => {
  if (value) {
    controller.clearCompletionNotices();
    if (controller.isFullyOperational) {
      void controller.loadOperationalInvites().catch(() => undefined);
    }
  }
});

function formatArgon(amount: bigint) {
  const wholeArgon = BigInt(MICROGONS_PER_ARGON);
  return `₳${microgonToArgonNm(amount).format(amount % wholeArgon === 0n ? '0,0' : '0,0.00')}`;
}

defineExpose({
  $el: rootRef,
});
</script>

<style scoped>
@reference "../../main.css";

[data-reka-collection-item] {
  @apply cursor-pointer pr-3 text-right focus:outline-none;

  &[data-disabled] {
    opacity: 0.3;
    pointer-events: none;
  }
  [ItemWrapper] {
    @apply font-bold whitespace-nowrap text-gray-900;
  }
}

.menu-moon {
  @apply relative h-[17px] w-[17px] rounded-full border border-slate-400/40 bg-linear-to-br from-slate-100 to-slate-300 shadow-[inset_0_1px_0_rgba(255,255,255,0.7)];
}

.menu-moon-crater {
  @apply absolute h-[3px] w-[3px] rounded-full bg-slate-500/20;
}

.menu-moon-base {
  @apply bg-argon-700/35 absolute bottom-[2px] left-1/2 h-[3px] w-[9px] -translate-x-1/2 rounded-full;
}

.menu-moon-rocket {
  @apply text-argon-600 absolute top-[3px] left-1/2 h-[13px] w-[13px] -translate-x-1/2 -rotate-18;
}
</style>
