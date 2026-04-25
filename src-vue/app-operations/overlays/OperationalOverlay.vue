<!-- prettier-ignore -->
<template>
  <OverlayBase :isOpen="isOpen" @close="closeOverlay" @goBack="goBack" :showGoBack="!!currentStepId" class="w-7/12">
    <template #title>
      <div class="flex flex-row grow items-center gap-x-3 pr-4">
        <DialogTitle>
          {{ currentStepId ? operationalSteps[currentStepId].title : 'Operator Certification Process' }}
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
        Complete the following seven steps, and you'll earn
        (along with your sponsor) a ₳500 bonus from the Argon Treasury.
      </p>
      <ul class="flex flex-col mt-3 mb-1 mx-3 text-base font-semibold divide-y divide-slate-600/15">
        <li
          v-for="[stepId, step] of Object.entries(operationalSteps)"
          @click="openStep(stepId as OperationalStepId)"
          class="flex flex-row items-center gap-x-2 py-3 pl-3 pr-2 cursor-pointer"
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
      <div class="pt-4 pb-4 px-3 mx-3 border-t border-slate-500/30">
        <a href="https://argon.network/docs/operator-certification" target="_blank" class="text-argon-600 hover:text-argon-700! font-light">
          Learn more about the Argon's Operator Certification.
        </a>
        <button
          @click="openOperationalInvites()"
          class="text-argon-600! border border-argon-600 mt-4 inline-flex flex-row items-center justify-center rounded-lg px-6 py-2 font-bold hover:bg-argon-300/10 cursor-pointer"
        >
          Manage Invite Codes
        </button>
      </div>
    </div>
    <div v-else class="px-5 pt-5 pb-6">
      <div
        v-if="currentBlockingStep"
        class="mb-5 mx-2 rounded-xl border border-amber-300 bg-amber-50 px-4 py-3 text-amber-950"
      >
        <p class="font-semibold">
          Complete {{ currentBlockingStep.title }} before starting this step.
        </p>
        <button
          @click="openStep(currentBlockingStep.id)"
          class="mt-2 cursor-pointer text-sm font-semibold text-amber-800 underline underline-offset-2 hover:text-amber-900"
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
import OverlayBase from '../../app-shared/overlays/OverlayBase.vue';
import { DialogTitle } from 'reka-ui';
import basicEmitter from '../../emitters/basicEmitter.ts';
import Checkbox from '../../components/Checkbox.vue';
import { ArrowTopRightOnSquareIcon, CheckCircleIcon, ChevronDoubleRightIcon } from '@heroicons/vue/24/outline';
import { useOperationsController, OperationalStepId, operationalSteps } from '../../stores/operationsController.ts';
import { useBasics } from '../../stores/basics.ts';

const basics = useBasics();
const controller = useOperationsController();

const isOpen = Vue.ref(false);
const currentStepId = Vue.ref<OperationalStepId | null>(null);
const currentBlockingStep = Vue.computed(() =>
  currentStepId.value ? controller.getCertificationBlocker(currentStepId.value) : null,
);

function openStep(key: OperationalStepId) {
  currentStepId.value = key;
}

function goBack(): void {
  currentStepId.value = null;
}

function closeOverlay() {
  isOpen.value = false;
  basics.overlayIsOpen = false;
}

function startTask() {
  if (currentBlockingStep.value) return;
  closeOverlay();
  setTimeout(() => {
    controller.activeGuideId = currentStepId.value;
  });
}

function cancelTask() {
  closeOverlay();
  controller.activeGuideId = null;
}

function openDocumentationLink(link: string) {
  window.open(link, '_blank', 'noopener,noreferrer');
}

function openOperationalInvites() {
  closeOverlay();
  basicEmitter.emit('openOperationalRewardsOverlay', { screen: 'overview' });
}

basicEmitter.on('openOperationalOverlay', async (stepId: OperationalStepId) => {
  isOpen.value = true;
  currentStepId.value = stepId;
  basics.overlayIsOpen = true;
});
</script>
