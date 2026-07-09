<template>
  <OverlayBase
    :isOpen="isOpen"
    :overflowScroll="true"
    @close="closeOverlay"
    @pressEsc="closeOverlay"
    class="w-[680px] pb-6"
  >
    <template #title>
      <div class="grow text-[30px] leading-none font-bold text-slate-800">{{ title }}</div>
    </template>

    <Activate
      v-if="currentScreen === 'activate'"
      :isActive="isOpen && currentScreen === 'activate'"
      @close="closeOverlay"
      @goTo="goTo"
    />

    <Congratulations v-else-if="currentScreen === 'congratulations'" @close="closeOverlay" />

    <Claim v-else :isActive="isOpen && currentScreen === 'claim'" @close="closeOverlay" />
  </OverlayBase>
</template>

<script setup lang="ts">
import * as Vue from 'vue';
import OverlayBase from './OverlayBase.vue';
import basicEmitter from '../emitters/basicEmitter.ts';
import { getConfig } from '../stores/config.ts';
import { useCertificationController } from '../stores/certificationController.ts';
import Activate from './operational-rewards/Activate.vue';
import Congratulations from './operational-rewards/Congratulations.vue';
import Claim from './operational-rewards/Claim.vue';

type OperationalRewardsScreen = 'activate' | 'congratulations' | 'claim';

const config = getConfig();
const controller = useCertificationController();

const isOpen = Vue.ref(false);
const currentScreen = Vue.ref<OperationalRewardsScreen>('claim');

const title = Vue.computed(() => {
  if (currentScreen.value === 'activate') return 'Activate & Claim Reward';
  if (currentScreen.value === 'congratulations') return 'Certification Complete';
  return 'Claim Rewards';
});

function closeOverlay() {
  if (currentScreen.value !== 'activate') {
    markRewardsSeen();
  }
  isOpen.value = false;
}

function goTo(screen: OperationalRewardsScreen) {
  let nextScreen = screen;
  if (nextScreen === 'activate' && !controller.isOperationalActivationReady) {
    if (!controller.isFullyOperational) return;
    nextScreen = 'congratulations';
  }

  if (nextScreen !== 'activate' && nextScreen !== 'congratulations') {
    markRewardsSeen();
  }

  currentScreen.value = nextScreen;
  isOpen.value = true;
}

function markRewardsSeen() {
  if (config.certificationDetails?.showRewardsCelebration === false) {
    return;
  }

  config.setCertificationDetails({
    showRewardsCelebration: false,
    showBonusTooltip: false,
  });
  void config.save();
}

Vue.watch(
  () => controller.isOperationalActivationReady,
  isOperationalActivationReady => {
    if (!isOperationalActivationReady || isOpen.value) {
      return;
    }

    controller.clearCompletionNotices();
    goTo('activate');
  },
  { immediate: true },
);

Vue.watch(
  () => controller.isFullyOperational,
  isFullyOperational => {
    if (!isFullyOperational || config.certificationDetails?.showRewardsCelebration === false || isOpen.value) {
      return;
    }

    controller.clearCompletionNotices();
    goTo('congratulations');
  },
  { immediate: true },
);

basicEmitter.on('openOperationalRewardsOverlay', payload => {
  if (!controller.isFullyOperational && !controller.isOperationalActivationReady) {
    return;
  }

  controller.clearCompletionNotices();
  goTo(payload?.screen ?? (controller.isFullyOperational ? 'congratulations' : 'activate'));
});
</script>
