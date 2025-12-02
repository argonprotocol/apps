<template>
  <div class="BotTour Component" :style="stepVars">
    <div class="screen-overlay">
      <div class="cutout"></div>
    </div>

    <TourStepOne @cancelTour="loadStep(0)" @nextStep="loadStep(2)" :pos="tourPos" v-if="currentStep === 1" />
    <TourStepTwo @previousStep="loadStep(1)" @nextStep="loadStep(3)" :pos="tourPos" v-if="currentStep === 2" />
    <TourStepThree @previousStep="loadStep(2)" @nextStep="loadStep(4)" :pos="tourPos" v-if="currentStep === 3" />
    <TourStepFour @previousStep="loadStep(3)" @nextStep="loadStep(0)" :pos="tourPos" v-if="currentStep === 4" />
  </div>
</template>

<script setup lang="ts">
import * as Vue from 'vue';
import TourStepOne from './StepOne.vue';
import TourStepTwo from './StepTwo.vue';
import TourStepThree from './StepThree.vue';
import TourStepFour from './StepFour.vue';
import { ITourPos } from '../../stores/tour.ts';

const props = defineProps<{
  getPositionCheck: (name: string) => ITourPos;
}>();

const emit = defineEmits(['close', 'changeStep']);

const stepVars = Vue.ref({});
const tourPos = Vue.ref<ITourPos>({ left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 });
const currentStep = Vue.ref(1);

function updateStepVars() {
  let rect: ITourPos = { left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 };

  if (currentStep.value === 1) {
    rect = props.getPositionCheck('capitalToCommit');
  } else if (currentStep.value === 2) {
    rect = props.getPositionCheck('returnOnCapital');
  } else if (currentStep.value === 3) {
    rect = props.getPositionCheck('configBoxes');
  } else if (currentStep.value === 4) {
    rect = props.getPositionCheck('saveButton');
  }

  tourPos.value = rect;

  stepVars.value = {
    '--posLeft': `${rect.left}px`,
    '--posTop': `${rect.top}px`,
    '--posRight': `${rect.right}px`,
    '--posBottom': `${rect.bottom}px`,
    '--posWidth': `${rect.right - rect.left}px`,
    '--posHeight': `${rect.bottom - rect.top}px`,
    '--posBlur': `${rect.blur ?? 10}px`,
  };
}

async function loadStep(step: number) {
  if (step === 5) {
    step = 0;
  }

  currentStep.value = step;
  if (step === 0) {
    emit('close');
  } else {
    updateStepVars();
  }
  emit('changeStep', step);
}

let interval: any = null;

Vue.onMounted(() => {
  loadStep(currentStep.value);
  interval = setInterval(updateStepVars, 100);
});

Vue.onBeforeUnmount(() => {
  if (interval) clearInterval(interval);
});
</script>

<style lang="scss">
@reference "../main.css";

.BotTour.Component {
  .screen-overlay {
    @apply rounded-lg;
    position: fixed;
    top: 0;
    left: 0;
    width: 100%;
    height: 100%;
    z-index: 2000;
    background: transparent;
  }

  .cutout {
    position: absolute;
    top: var(--posTop);
    left: var(--posLeft);
    width: calc(var(--posRight) - var(--posLeft));
    height: calc(var(--posBottom) - var(--posTop));
    background: transparent;
    border-radius: 10px;
    box-shadow: 0 0 0 9999px rgba(0, 0, 0, 0.4);
    filter: blur(var(--posBlur));
    z-index: 2000;
  }

  [StepWrapper] {
    position: fixed;
    top: 0;
    left: 0;
    right: 0;
    bottom: 0;
    filter: drop-shadow(2px 2px 2px rgba(50, 50, 0, 0.6));
    pointer-events: none;
  }
}
</style>
