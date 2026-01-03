<template>
  <div class="WelcomeTour Component" :style="stepVars">
    <div class="screen-overlay">
      <div class="cutout"></div>
    </div>

    <TourStepOne @cancelTour="cancelTour" @nextStep="loadStep(2)" :pos="tourPos" v-if="tour.currentStep === 1" />
    <TourStepTwo @previousStep="loadStep(1)" @nextStep="loadStep(3)" :pos="tourPos" v-if="tour.currentStep === 2" />
    <TourStepThree @previousStep="loadStep(2)" @nextStep="loadStep(4)" :pos="tourPos" v-if="tour.currentStep === 3" />
    <TourStepFour @previousStep="loadStep(3)" @nextStep="loadStep(5)" :pos="tourPos" v-if="tour.currentStep === 4" />
    <TourStepFive @previousStep="loadStep(4)" @nextStep="loadStep(6)" :pos="tourPos" v-if="tour.currentStep === 5" />
  </div>
</template>

<script setup lang="ts">
import * as Vue from 'vue';
import { ITourPos, useTour } from '../stores/tour';
import TourStepOne from './welcome-tour/StepOne.vue';
import TourStepTwo from './welcome-tour/StepTwo.vue';
import TourStepThree from './welcome-tour/StepThree.vue';
import TourStepFour from './welcome-tour/StepFour.vue';
import TourStepFive from './welcome-tour/StepFive.vue';
import { getConfig } from '../stores/config';
import { useController } from '../stores/controller';
import { ScreenKey } from '../interfaces/IConfig';

const controller = useController();
const config = getConfig();
const tour = useTour();

const startingScreenKey = controller.screenKey;

const stepVars = Vue.ref({});
const tourPos = Vue.ref<ITourPos>({ left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 });

function updateStepVars() {
  let rect: ITourPos = { left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 };

  if (tour.currentStep === 1) {
    rect = tour.getPositionCheck('miningTab');
  } else if (tour.currentStep === 2) {
    rect = tour.getPositionCheck('vaultingTab');
  } else if (tour.currentStep === 3) {
    rect = tour.getPositionCheck('currencyMenu');
  } else if (tour.currentStep === 4) {
    rect = tour.getPositionCheck('accountMenu');
  } else if (tour.currentStep === 5) {
    rect = tour.getPositionCheck('startButtons');
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
  if (step === 6) {
    step = 0;
    config.showWelcomeOverlay = false;
    await config.save();
  } else if (step === 1) {
    controller.setScreenKey(ScreenKey.Mining);
  } else if (step === 2) {
    controller.setScreenKey(ScreenKey.Vaulting);
  } else if (step === 5) {
    controller.setScreenKey(ScreenKey.Home);
  }

  tour.currentStep = step;
  if (step > 0) {
    updateStepVars();
  }
}

function cancelTour() {
  tour.currentStep = 0;
  controller.setScreenKey(startingScreenKey);
}

let interval: any = null;

Vue.onMounted(() => {
  loadStep(tour.currentStep);
  interval = setInterval(updateStepVars, 100);
});

Vue.onBeforeUnmount(() => {
  if (interval) clearInterval(interval);
});
</script>

<style lang="scss">
@reference "../main.css";

.WelcomeTour.Component {
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
