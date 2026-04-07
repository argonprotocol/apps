<!-- prettier-ignore -->
<template>
  <OverlayBase :isOpen="isOpen" @close="closeOverlay" @goBack="closeOverlay" class="w-120 h-fit">
    <template #title>
      <div class="flex flex-row grow items-center gap-x-3 pr-4">
        <DialogTitle>
          Task Finished!
        </DialogTitle>
      </div>
    </template>
    <p class="font-light px-5 pt-5">
      Congratulations! You've completed the <em class="italic">{{ currentStepId && operationalSteps[currentStepId]?.title }}</em> task.
      <template v-if="currentStepId === OperationalStepId.BackupMnemonic">
        The 12-word recovery phrase has been copied to your clipboard. Paste these words into a secure place for safekeeping.
      </template>
    </p>
    <div class="flex flex-row items-center gap-x-3 whitespace-nowrap px-5 pt-5 pb-6">
      <button
        @click="closeOverlay"
        class="grow text-argon-600! border border-argon-600 mt-5 inline-flex flex-row items-center justify-center rounded-lg px-8 py-2 font-bold ml-1 hover:bg-argon-300/10 cursor-pointer"
      >
        Close Overlay
      </button>
    </div>
  </OverlayBase>
</template>

<script setup lang="ts">
import * as Vue from 'vue';
import OverlayBase from '../../app-shared/overlays/OverlayBase.vue';
import { DialogTitle } from 'reka-ui';
import basicEmitter from '../../emitters/basicEmitter.ts';
import { useOperationsController, operationalSteps, OperationalStepId } from '../../stores/operationsController.ts';
import { useBasics } from '../../stores/basics.ts';

const basics = useBasics();
const controller = useOperationsController();

const isOpen = Vue.ref(false);
const currentStepId = Vue.computed(() => {
  return controller.activeGuideId;
});

function closeOverlay() {
  controller.activeGuideId = null;
  isOpen.value = false;
  basics.overlayIsOpen = false;
}

basicEmitter.on('openOperationalFinishOverlay', () => {
  isOpen.value = true;
  basics.overlayIsOpen = true;
});
</script>
