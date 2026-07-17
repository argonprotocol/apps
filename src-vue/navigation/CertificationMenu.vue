<!-- prettier-ignore -->
<template>
  <div v-if="isCertificationMenuVisible" ref="rootRef">
    <div AlertMenu v-if="isShowingCompletionTooltip" class="fixed z-50 pt-[12px]" :style="alertMenuStyle">
      <Arrow
        class="absolute top-0 h-3.5 w-6"
        :style="alertArrowStyle"
        fill="white"
      />
      <Arrow
        class="absolute top-0 h-3.5 w-6"
        :style="alertArrowStyle"
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

    <div AlertMenu v-else-if="isShowingActivatedTooltip" class="fixed z-50 pt-[12px]" :style="alertMenuStyle">
      <Arrow
        class="absolute top-0 h-3.5 w-6"
        :style="alertArrowStyle"
        fill="white"
      />
      <Arrow
        class="absolute top-0 h-3.5 w-6"
        :style="alertArrowStyle"
        fill="color-mix(in oklab, var(--color-argon-600) 5%, transparent)"
      />
      <div class="rounded border border-argon-400/50 bg-white pt-0.5 pl-0.5 shadow-xl">
        <div class="relative w-108 rounded bg-argon-600/5 px-5 pt-3 pb-5" style="text-shadow: 1px 1px 0 white">
          <div class="mb-2 flex items-center justify-between border-b border-argon-300/20 pb-2">
            <div class="text-xl font-bold text-argon-600">Operations Activated</div>
            <button
              @click="dismissActivatedTooltip"
              class="cursor-pointer rounded-full p-1 text-argon-600/70 hover:bg-white/70 hover:text-argon-800"
              aria-label="Close tooltip"
            >
              <XMarkIcon class="h-5 w-5 stroke-[2.5]" />
            </button>
          </div>
          <p class="mt-1 text-argon-600">
            Your upstream approved operations access. Mining and Vaulting are now available in the sidebar.
          </p>
          <div class="mt-4 flex justify-end">
            <button
              type="button"
              class="bg-argon-button hover:bg-argon-button-hover rounded-lg px-4 py-2 text-sm font-semibold text-white"
              @click="openActivatedAction"
            >
              Show Mining &amp; Vaulting
            </button>
          </div>
        </div>
      </div>
    </div>

    <div AlertMenu v-else-if="isShowingUpgradeTooltip" class="fixed z-50 pt-[12px]" :style="alertMenuStyle">
      <Arrow
        class="absolute top-0 h-3.5 w-6"
        :style="alertArrowStyle"
        fill="white"
      />
      <Arrow
        class="absolute top-0 h-3.5 w-6"
        :style="alertArrowStyle"
        fill="color-mix(in oklab, var(--color-argon-600) 5%, transparent)"
      />
      <div class="rounded border border-argon-400/50 bg-white pt-0.5 pl-0.5 shadow-xl">
        <div class="relative w-108 rounded bg-argon-600/5 px-5 pt-3 pb-5" style="text-shadow: 1px 1px 0 white">
          <div class="mb-2 flex items-center justify-between border-b border-argon-300/20 pb-2">
            <div class="text-xl font-bold text-argon-600">Upgrade to Operations</div>
            <button
              @click="dismissUpgradeTooltip"
              class="cursor-pointer rounded-full p-1 text-argon-600/70 hover:bg-white/70 hover:text-argon-800"
              aria-label="Close tooltip"
            >
              <XMarkIcon class="h-5 w-5 stroke-[2.5]" />
            </button>
          </div>
          <p class="mt-1 text-argon-600">
            Treasury certification is complete. Request approval from
            <span class="font-semibold">{{ upstreamOperatorName }}</span>
            to unlock mining and vaulting.
          </p>
          <div class="mt-4 flex justify-end">
            <button
              type="button"
              class="bg-argon-button hover:bg-argon-button-hover rounded-lg px-4 py-2 text-sm font-semibold text-white"
              @click="openNetworkTabFromTooltip"
            >
              Open Network Tab
            </button>
          </div>
        </div>
      </div>
    </div>

    <div AlertMenu v-else-if="isShowingBonusTooltip" class="fixed z-50 pt-[12px]" :style="alertMenuStyle">
      <Arrow
        class="absolute top-0 h-3.5 w-6"
        :style="alertArrowStyle"
        fill="white"
      />
      <Arrow
        class="absolute top-0 h-3.5 w-6"
        :style="alertArrowStyle"
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
            A bonus of {{ operationalActivationRewardLabel }} has been set aside in Argon's Treasury for your benefit. It
            will be claimable once your account becomes fully operational. Open the menu above to learn more.
          </p>
        </div>
      </div>
    </div>

    <div
      v-if="!config.hasExtensionTreasury"
      class="flex h-[30px] cursor-pointer flex-row items-center justify-center overflow-hidden rounded-md border border-slate-400/50 text-base font-semibold whitespace-nowrap text-argon-600/70 hover:border-slate-400/50 hover:bg-slate-400/10 focus:outline-none data-[state=open]:border-slate-400/60 data-[state=open]:bg-slate-400/10"
      @click="openUpgradeToTreasuryOverlay"
    >
      <div class="relative flex flex-row items-center gap-1.5 whitespace-nowrap pl-2.5 pr-3 pt-px">
        <DiamondIcon class="h-5 relative -top-0.5 mr-1 text-argon-600/80" />
        Upgrade to Treasury
      </div>
    </div>
    <div
      v-else-if="isShowingUpgradeButton"
      class="flex h-[30px] cursor-pointer flex-row items-center justify-center overflow-hidden rounded-md border border-slate-400/50 text-base font-semibold whitespace-nowrap text-argon-600/70 hover:border-slate-400/50 hover:bg-slate-400/10 focus:outline-none data-[state=open]:border-slate-400/60 data-[state=open]:bg-slate-400/10"
      @click="openUpgradeToOperationsOverlay"
    >
      <div class="relative flex flex-row items-center gap-1.5 whitespace-nowrap pl-2.5 pr-3 pt-px">
        Upgrade to Operations
      </div>
    </div>
    <NavigationMenuItem
      v-else
      value="certification"
      class="pointer-events-auto"
      @mouseenter="onMenuEnter"
      @mouseleave="onMenuLeave"
    >
      <NavigationMenuTrigger
        Trigger
        class="flex h-[30px] cursor-pointer flex-row items-center justify-center overflow-hidden rounded-md border border-slate-400/50 text-base font-semibold whitespace-nowrap text-argon-600/70 hover:border-slate-400/50 hover:bg-slate-400/10 focus:outline-none data-[state=open]:border-slate-400/60 data-[state=open]:bg-slate-400/10"
        @focus="onMenuEnter"
      >
        <div class="relative flex flex-row items-center gap-1.5 whitespace-nowrap pl-2.5 pr-3 pt-px">
          <CheckBadgeIcon v-if="!isUnlockTrack" class="relative top-px h-[17px] w-[17px]" aria-hidden="true" />
          <span>{{ isUnlockTrack ? 'Treasury' : 'Operator' }} Certification</span>
          <span class="font-mono">({{ completedStepCount }}/{{ currentStepIds.length }})</span>
        </div>
      </NavigationMenuTrigger>

      <NavigationMenuContent
        class="data-[motion=from-start]:animate-enterFromLeft data-[motion=from-end]:animate-enterFromRight data-[motion=to-start]:animate-exitToLeft data-[motion=to-end]:animate-exitToRight absolute top-0 left-0 w-full sm:w-auto"
        @mouseenter="onMenuEnter"
        @mouseleave="onMenuLeave"
      >
        <div class="relative">
          <div class="w-fit bg-argon-menu-bg flex shrink flex-col rounded p-1 text-gray-900 shadow-lg ring-1 ring-gray-900/20">
            <div class="max-w-160 pt-4 pb-2">
              <div class="border-b border-slate-500/30 px-5 pb-3">
                <p class="font-light">
                  {{ checklistDescription }}
                </p>
              </div>
              <ul class="mt-3 mb-1 flex flex-col divide-y divide-slate-600/15 text-base font-semibold whitespace-nowrap">
                <li
                  v-for="stepId in currentStepIds"
                  :key="stepId"
                  @click="openStep(stepId, $event)"
                  class="flex cursor-pointer flex-row items-center gap-x-2 py-3 pl-5 pr-2"
                  :class="controller.isCertificationStepUnlocked(stepId) ? 'hover:bg-argon-600/5' : 'bg-slate-50/80 text-slate-500'"
                >
                  <Checkbox
                    class="shrink-0"
                    :size="7"
                    :isChecked="controller.isCertificationStepComplete(stepId) || controller.isCertificationStepUnderway(stepId)"
                    :isPulsing="controller.isCertificationStepUnderway(stepId)"
                  />
                  <span class="grow pr-3">{{ formatStepTitle(stepId) }}</span>
                  <span
                    v-if="controller.isCertificationStepUnderway(stepId)"
                    class="rounded-full border border-argon-300 bg-argon-50 px-2 py-1 text-xs font-medium text-argon-700"
                  >
                    Underway
                  </span>
                  <span
                    v-if="controller.getCertificationBlocker(stepId)"
                    class="rounded-full border border-slate-300 bg-white px-2 py-1 text-xs font-medium text-slate-500"
                  >
                    Requires: {{ controller.getCertificationBlocker(stepId)?.title }}
                  </span>
                  <a
                    :href="operationalSteps[stepId].documentationLink"
                    target="_blank"
                    class="rounded-full px-3 text-right font-light text-argon-600 hover:bg-white hover:text-argon-700!"
                  >
                    Open Docs
                  </a>
                </li>
              </ul>
              <div class="border-t border-slate-500/30 px-5 pt-4 pb-2">
                <a href="https://argon.network/docs/operator-certification" target="_blank" class="font-light text-argon-600 hover:text-argon-700!">
                  Learn more about Argon certification.
                </a>
              </div>
            </div>
          </div>
        </div>
      </NavigationMenuContent>
    </NavigationMenuItem>
  </div>
</template>

<script setup lang="ts">
import * as Vue from 'vue';
import { NavigationMenuContent, NavigationMenuItem, NavigationMenuTrigger } from 'reka-ui';
import { XMarkIcon, CheckBadgeIcon } from '@heroicons/vue/24/outline';
import { MICROGONS_PER_ARGON } from '@argonprotocol/apps-core';
import basicEmitter from '../emitters/basicEmitter.ts';
import { TopTab } from '../interfaces/IConfig.ts';
import { getConfig } from '../stores/config.ts';
import { getCurrency } from '../stores/currency.ts';
import Checkbox from '../components/Checkbox.vue';
import Arrow from '../components/Arrow.vue';
import { createNumeralHelpers } from '../lib/numeral.ts';
import {
  OperationalStepId,
  operationsCertificationStepIds,
  operationalSteps,
  treasuryCertificationStepIds,
  useCertificationController,
} from '../stores/certificationController.ts';
import DiamondIcon from '../assets/diamond.svg';

const config = getConfig();
const controller = useCertificationController();
const currency = getCurrency();

const { microgonToArgonNm } = createNumeralHelpers(currency);

const rootRef = Vue.ref<HTMLElement>();
const alertMenuStyle = Vue.ref<Record<string, string>>({});
const alertArrowStyle = Vue.ref<Record<string, string>>({});
const isOpen = Vue.ref(false);
let mouseLeaveTimeoutId: ReturnType<typeof setTimeout> | undefined = undefined;

const completionNoticeStepId = Vue.computed(() => controller.pendingCompletionNoticeStepId);
const completionNoticeStepTitle = Vue.computed(() => {
  return completionNoticeStepId.value ? operationalSteps[completionNoticeStepId.value].title : '';
});
const isUnlockTrack = Vue.computed(() => {
  return !controller.chainProgress.isUpgradedToOperations;
});
const isCertificationMenuVisible = Vue.computed(() => {
  return !controller.isOperationalRewardsFlowActive;
});

const currentStepIds = Vue.computed(() => {
  return isUnlockTrack.value ? treasuryCertificationStepIds : operationsCertificationStepIds;
});

const completedStepCount = Vue.computed(() => {
  return currentStepIds.value.filter(stepId => controller.isCertificationStepComplete(stepId)).length;
});

const isShowingCompletionTooltip = Vue.computed(() => {
  return !!completionNoticeStepId.value && !isOpen.value && isCertificationMenuVisible.value;
});

const isShowingActivatedTooltip = Vue.computed(() => {
  return (
    controller.chainProgress.isUpgradedToOperations &&
    !controller.chainProgress.isOperational &&
    !config.certificationDetails?.dismissedOperationsActivatedOverlay &&
    !isOpen.value &&
    !completionNoticeStepId.value &&
    !controller.isOperationalRewardsFlowActive
  );
});

const isShowingUpgradeButton = Vue.computed(() => {
  return (
    config.hasExtensionTreasury &&
    !controller.chainProgress.isUpgradedToOperations &&
    controller.completedTreasuryCertificationStepCount === treasuryCertificationStepIds.length &&
    !completionNoticeStepId.value &&
    !controller.isOperationalRewardsFlowActive
  );
});

const isShowingUpgradeTooltip = Vue.computed(() => {
  return (
    isShowingUpgradeButton.value && !config.certificationDetails?.dismissedOperationsUpgradeOverlay && !isOpen.value
  );
});

const isShowingBonusTooltip = Vue.computed(() => {
  return (
    !!config.certificationDetails?.showBonusTooltip &&
    !isOpen.value &&
    !!config.upstreamOperator?.name &&
    !completionNoticeStepId.value &&
    !isShowingActivatedTooltip.value &&
    !isShowingUpgradeTooltip.value &&
    !controller.isOperationalRewardsFlowActive
  );
});
const upstreamOperatorName = Vue.computed(() => {
  return config.upstreamOperator?.name || 'your upstream operator';
});
const operationalActivationRewardLabel = Vue.computed(() => {
  return formatArgon(controller.rewardConfig.operationalActivationReward);
});

const checklistDescription = Vue.computed(() => {
  if (isUnlockTrack.value) {
    return 'Complete the Treasury Certification steps below to be eligible for your Upstream Operator to upgrade you to the Operations app.';
  }

  const withUpstream = controller.chainProgress.hasUpstreamAccount ? ' (along with your upstream operator)' : '';
  return `Complete the following operations steps, and you'll earn${withUpstream} a ${operationalActivationRewardLabel.value} bonus from the Argon Treasury.`;
});

function updateAlertMenuPosition() {
  const rect = rootRef.value?.getBoundingClientRect();
  if (!rect) return;

  const arrowWidth = 24;
  const rightOffset = Math.max(8, Math.round(rect.width / 2 - arrowWidth / 2));

  alertMenuStyle.value = {
    top: `${Math.round(rect.bottom + 6)}px`,
    left: `${Math.round(rect.right)}px`,
    transform: 'translateX(-100%)',
  };
  alertArrowStyle.value = {
    right: `${rightOffset}px`,
  };
}

function dismissCompletionNotice() {
  controller.dismissCompletionNotice();
}

function dismissMessage() {
  config.setCertificationDetails({ showBonusTooltip: false });
  void config.save();
}

function dismissUpgradeTooltip() {
  config.setCertificationDetails({ dismissedOperationsUpgradeOverlay: true });
  void config.save();
}

function dismissActivatedTooltip() {
  config.setCertificationDetails({ dismissedOperationsActivatedOverlay: true });
  void config.save();
}

function openNetworkTabFromTooltip() {
  dismissUpgradeTooltip();
  controller.setTab(TopTab.Network);
}

function openActivatedAction() {
  dismissActivatedTooltip();
  basicEmitter.emit('highlightOperationsNavigation');
}

function openUpgradeToOperationsOverlay() {
  basicEmitter.emit('openUpgradeToOperationsOverlay');
}

function openUpgradeToTreasuryOverlay() {
  basicEmitter.emit('openUpgradeToTreasuryOverlay');
}

function onMenuEnter() {
  if (mouseLeaveTimeoutId) {
    clearTimeout(mouseLeaveTimeoutId);
  }

  mouseLeaveTimeoutId = undefined;
  controller.clearCompletionNotices();
  isOpen.value = true;
}

function onMenuLeave() {
  if (mouseLeaveTimeoutId) {
    clearTimeout(mouseLeaveTimeoutId);
  }

  mouseLeaveTimeoutId = setTimeout(() => {
    isOpen.value = false;
  }, 100);
}

function openStep(stepId: OperationalStepId, event: MouseEvent) {
  const clickTarget = event.target;
  if (clickTarget instanceof HTMLElement && clickTarget.closest('a')) {
    return;
  }

  isOpen.value = false;
  controller.clearCompletionNotices();
  config.setCertificationDetails({ showBonusTooltip: false });
  basicEmitter.emit('openOperationalOverlay', stepId);
}

function formatStepTitle(stepId: OperationalStepId) {
  const requirement = controller.getCertificationStepRequirementText(stepId);
  if (!requirement) {
    return operationalSteps[stepId].title;
  }

  if (stepId === OperationalStepId.LiquidLock) {
    return `Liquid Lock ${requirement.replace(' bitcoin', ' of Bitcoin')}`;
  }
  if (stepId === OperationalStepId.ActivateVault) {
    return `Create a ${requirement.replace(' securitization', '')} Vault`;
  }
  if ([OperationalStepId.TreasuryTransfer, OperationalStepId.OperationalTransfer].includes(stepId)) {
    return `Transfer ${requirement}`;
  }
  if (stepId === OperationalStepId.AcquireBonds) {
    return `Acquire ${requirement.replace(' bonds', ' of Treasury Bonds')}`;
  }
  if (stepId === OperationalStepId.FirstMiningSeat) {
    return `Win ${requirement.replace(' seats', ' Mining Seats').replace(' seat', ' Mining Seat')}`;
  }

  return operationalSteps[stepId].title;
}

Vue.watch(
  () =>
    isShowingCompletionTooltip.value ||
    isShowingActivatedTooltip.value ||
    isShowingUpgradeTooltip.value ||
    isShowingBonusTooltip.value,
  isShowingAlert => {
    if (!isShowingAlert) return;
    void Vue.nextTick().then(updateAlertMenuPosition);
  },
  { immediate: true },
);

Vue.watch(isCertificationMenuVisible, isVisible => {
  if (isVisible) {
    return;
  }

  isOpen.value = false;
});

Vue.onMounted(() => {
  window.addEventListener('resize', updateAlertMenuPosition);
});

Vue.onBeforeUnmount(() => {
  window.removeEventListener('resize', updateAlertMenuPosition);
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
@reference "../main.css";

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
</style>
