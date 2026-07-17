<!-- prettier-ignore -->
<template>
  <OverlayBase :isOpen="isOpen" @close="closeOverlay" @goBack="goBack" :showGoBack="!!currentStepId" class="w-7/12">
    <template #title>
      <div class="flex flex-row grow items-center gap-x-3 pr-4">
        <DialogTitle>
          {{ currentStepId ? formatStepTitle(currentStepId) : overlayTitle }}
        </DialogTitle>
        <span
          v-if="currentStepId"
          class="inline-flex rounded-full px-3 py-1 text-sm font-semibold"
          :class="{
            'border border-slate-300 bg-slate-100 text-slate-500/70': controller.getCertificationStepStatus(currentStepId) === 'complete',
            'border border-argon-300 bg-argon-50 text-argon-700': controller.getCertificationStepStatus(currentStepId) === 'underway',
            'bg-slate-100 text-slate-600': controller.getCertificationStepStatus(currentStepId) === 'not_started',
          }"
        >
          {{ controller.getCertificationStepStatusLabel(currentStepId) }}
        </span>
      </div>
    </template>
    <div v-if="!currentStepId">
      <p class="font-light px-5 pt-5">
        {{ overlayDescription }}
      </p>
      <ul class="flex flex-col mt-3 mb-1 mx-3 text-base font-semibold divide-y divide-slate-600/15">
        <li
          v-for="stepId in currentStepIds"
          :key="stepId"
          @click="openStep(stepId, $event)"
          class="flex flex-row items-center gap-x-2 py-3 pl-3 pr-2 cursor-pointer"
          :class="controller.isCertificationStepUnlocked(stepId) ? 'hover:bg-argon-600/5' : 'bg-slate-50/80 text-slate-500'"
        >
          <Checkbox
            class="shrink-0"
            :size="7"
            :isChecked="controller.isCertificationStepComplete(stepId) || controller.isCertificationStepUnderway(stepId)"
            :isPulsing="controller.isCertificationStepUnderway(stepId)"
          />
          <span class="grow">{{ formatStepTitle(stepId) }}</span>
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
          <a :href="operationalSteps[stepId].documentationLink" target="_blank" class="px-3 text-right text-argon-600 font-light hover:bg-white hover:text-argon-700! rounded-full">Open Docs</a>
        </li>
      </ul>
      <div class="pt-4 pb-4 px-3 mx-3 border-t border-slate-500/30">
        <a href="https://argon.network/docs/operator-certification" target="_blank" class="text-argon-600 hover:text-argon-700! font-light">
          Learn more about the Argon's Operator Certification.
        </a>
      </div>
    </div>
    <div v-else class="px-5 pt-5 pb-6">
      <div
        v-if="currentBlockingStep"
        class="mb-4 border-l-2 border-argon-300 pl-3 text-slate-600"
      >
        <p class="text-sm font-semibold">
          Complete {{ currentBlockingStep.title }} before starting this step.
        </p>
        <button
          @click="openStep(currentBlockingStep.id)"
          class="mt-1 cursor-pointer text-sm font-semibold text-argon-600 hover:text-argon-700!"
        >
          Go to {{ currentBlockingStep.title }}
        </button>
      </div>
      <component :is="operationalSteps[currentStepId].component" />
      <div class="flex flex-row items-center gap-x-3 whitespace-nowrap mt-3">
        <button
          @click="openDocumentationLink(operationalSteps[currentStepId].documentationLink)"
          :class="[controller.activeGuideId === currentStepId ? 'grow' : 'w-1/2']"
          class="text-argon-600! border border-argon-600 mt-5 inline-flex flex-row items-center justify-center rounded-lg px-8 py-2 font-bold ml-1 hover:bg-argon-300/10 cursor-pointer"
        >
          <ArrowTopRightOnSquareIcon class="mr-2 w-5" />
          View Documentation
        </button>
        <button
          v-if="controller.isCertificationStepComplete(currentStepId)"
          class="w-1/2 border border-slate-300 bg-slate-100 mt-5 inline-flex flex-row items-center justify-center rounded-lg px-8 py-2 font-bold text-slate-500/40 ml-1 cursor-not-allowed"
          disabled
        >
          <CheckCircleIcon class="size-5 mr-2 relative" />
          Step Completed
        </button>
        <template v-else>
          <button
            v-if="controller.activeGuideId === currentStepId"
            @click="cancelTask()"
            class="grow text-argon-600! border border-argon-600 mt-5 inline-flex flex-row items-center justify-center rounded-lg px-8 py-2 font-bold ml-1 hover:bg-argon-300/10 cursor-pointer"
          >
            <ArrowTopRightOnSquareIcon class="mr-2 w-5" />
            Cancel Task
          </button>
          <button
            v-else-if="controller.isCertificationStepUnderway(currentStepId)"
            class="w-1/2 border border-argon-300 bg-argon-50 mt-5 inline-flex flex-row items-center justify-center rounded-lg px-8 py-2 font-bold text-argon-700 ml-1 cursor-not-allowed"
            disabled
          >
            <CheckCircleIcon class="size-5 mr-2 relative" />
            Task Underway
          </button>
          <button
            v-else
            @click="startTask()"
            :class="[currentBlockingStep ? 'cursor-not-allowed border-slate-300 bg-slate-100 text-slate-400!' : 'cursor-pointer border-argon-700 bg-argon-600 text-white! hover:bg-argon-700']"
            :disabled="!!currentBlockingStep"
            class="mt-5 inline-flex w-1/2 flex-row items-center justify-center rounded-lg border px-8 py-2 font-bold ml-1"
          >
            <template v-if="currentBlockingStep">Complete Required Step First</template>
            <template v-else>
              Start Task
              <ChevronDoubleRightIcon class="size-5 ml-2 relative" :class="currentBlockingStep ? 'text-slate-400' : 'text-white'" />
            </template>
          </button>
        </template>
      </div>
    </div>
  </OverlayBase>
</template>

<script setup lang="ts">
import * as Vue from 'vue';
import OverlayBase from './OverlayBase.vue';
import { DialogTitle } from 'reka-ui';
import basicEmitter from '../emitters/basicEmitter.ts';
import Checkbox from '../components/Checkbox.vue';
import { ArrowTopRightOnSquareIcon, CheckCircleIcon, ChevronDoubleRightIcon } from '@heroicons/vue/24/outline';
import {
  useCertificationController,
  OperationalStepId,
  operationalSteps,
  operationsCertificationStepIds,
  treasuryCertificationStepIds,
} from '../stores/certificationController.ts';
import { useBasics } from '../stores/basics.ts';
import { getConfig } from '../stores/config.ts';
import { MiningSetupStatus, TopTab, VaultingSetupStatus } from '../interfaces/IConfig.ts';
import { WalletType } from '../lib/Wallet.ts';
import { open as tauriOpenUrl } from '@tauri-apps/plugin-shell';

const basics = useBasics();
const config = getConfig();
const controller = useCertificationController();

const isOpen = Vue.ref(false);
const currentStepId = Vue.ref<OperationalStepId | null>(null);
const currentTrack = Vue.ref<'treasury' | 'operations'>('treasury');
const currentStepIds = Vue.computed(() => {
  return currentTrack.value === 'treasury' ? treasuryCertificationStepIds : operationsCertificationStepIds;
});
const currentBlockingStep = Vue.computed(() => {
  return currentStepId.value ? controller.getCertificationBlocker(currentStepId.value) : null;
});
const overlayTitle = Vue.computed(() => {
  return currentTrack.value === 'treasury' ? 'Treasury Certification' : 'Operations Certification';
});
const overlayDescription = Vue.computed(() => {
  if (currentTrack.value === 'treasury') {
    return 'Complete the following treasury steps to unlock operations certification.';
  }

  const withUpstream = controller.chainProgress.hasUpstreamAccount ? ' (along with your upstream operator)' : '';
  return `Complete the following operations steps, and you'll earn${withUpstream} a ₳500 bonus from the Argon Treasury.`;
});

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

function openStep(stepId: OperationalStepId, event?: MouseEvent) {
  const clickTarget = event?.target;
  if (clickTarget instanceof HTMLElement && clickTarget.closest('a')) {
    return;
  }

  currentStepId.value = stepId;
}

function goBack(): void {
  currentStepId.value = null;
}

function closeOverlay() {
  isOpen.value = false;
  currentStepId.value = null;
  basics.overlayIsOpen = false;
}

function startTask() {
  if (!currentStepId.value || currentBlockingStep.value) return;

  const stepId = currentStepId.value;
  closeOverlay();

  setTimeout(() => {
    controller.activeGuideId = stepId;

    if (stepId === OperationalStepId.ActivateVault) {
      if (controller.selectedTab === TopTab.Vaulting) {
        controller.backButtonTriggersHome = true;
        config.vaultingSetupStatus = VaultingSetupStatus.Checklist;
      }
      return;
    }

    if (stepId === OperationalStepId.AcquireBonds) {
      controller.setTab(TopTab.ArgonBonds);
      return;
    }

    if (stepId === OperationalStepId.LiquidLock) {
      controller.setTab(TopTab.BitcoinLocks);
      return;
    }

    if ([OperationalStepId.TreasuryTransfer, OperationalStepId.OperationalTransfer].includes(stepId)) {
      controller.setTab(TopTab.Dashboard);
      basicEmitter.emit('openWalletOverlay', { walletType: WalletType.defaultArgon });
      return;
    }

    if (controller.selectedTab === TopTab.Mining) {
      controller.backButtonTriggersHome = true;
      if (config.miningSetupStatus === MiningSetupStatus.None) {
        config.miningSetupStatus = MiningSetupStatus.Checklist;
      }
    }
  });
}

function cancelTask() {
  closeOverlay();
  controller.activeGuideId = null;
}

function openDocumentationLink(link: string) {
  void tauriOpenUrl(link);
}

basicEmitter.on('openOperationalOverlay', (stepId: OperationalStepId) => {
  if (controller.isOperationalActivationReady) {
    closeOverlay();
    basicEmitter.emit('openOperationalRewardsOverlay', { screen: 'activate' });
    return;
  }

  currentTrack.value = treasuryCertificationStepIds.some(id => id === stepId) ? 'treasury' : 'operations';
  isOpen.value = true;
  currentStepId.value = stepId;
  basics.overlayIsOpen = true;
});
</script>
