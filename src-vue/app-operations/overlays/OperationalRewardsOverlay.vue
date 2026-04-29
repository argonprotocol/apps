<template>
  <OverlayBase
    :isOpen="isOpen"
    :showGoBack="currentScreen === 'claim'"
    :overflowScroll="true"
    @close="closeOverlay"
    @pressEsc="closeOverlay"
    @goBack="goBack"
    class="max-h-[calc(100vh-2rem)] pb-6"
    :class="currentScreen === 'overview' ? 'w-7/12' : 'w-[680px]'"
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

    <Congratulations v-else-if="currentScreen === 'congratulations'" @close="closeOverlay" @goTo="goTo" />

    <Claim v-else-if="currentScreen === 'claim'" :isActive="isOpen && currentScreen === 'claim'" @goTo="goTo" />

    <Overview
      v-else
      :isActive="isOpen && currentScreen === 'overview'"
      :section="currentSection"
      :sectionRequestId="sectionRequestId"
      @goTo="goTo"
    />
  </OverlayBase>
</template>

<script setup lang="ts">
import * as Vue from 'vue';
import OverlayBase from '../../app-shared/overlays/OverlayBase.vue';
import basicEmitter from '../../emitters/basicEmitter.ts';
import { getConfig } from '../../stores/config.ts';
import { useOperationsController } from '../../stores/operationsController.ts';
import Activate from './operational-rewards/Activate.vue';
import Congratulations from './operational-rewards/Congratulations.vue';
import Claim from './operational-rewards/Claim.vue';
import Overview from './operational-rewards/Overview.vue';

type OperationalRewardsScreen = 'activate' | 'congratulations' | 'overview' | 'claim';
type OperationalRewardsSection = 'create' | 'unlock' | 'outbound';

const config = getConfig();
const controller = useOperationsController();

const isOpen = Vue.ref(false);
const currentScreen = Vue.ref<OperationalRewardsScreen>('overview');
const currentSection = Vue.ref<OperationalRewardsSection>();
const sectionRequestId = Vue.ref(0);

const title = Vue.computed(() => {
  if (currentScreen.value === 'activate') return 'Activate & Claim Reward';
  if (currentScreen.value === 'congratulations') return 'Congratulations!';
  if (currentScreen.value === 'claim') return 'Claim Rewards';
  return 'Operator Referrals';
});

function closeOverlay() {
  if (currentScreen.value !== 'activate') {
    markRewardsSeen();
  }
  isOpen.value = false;
}

function goBack() {
  goTo('overview');
}

function goTo(screen: OperationalRewardsScreen, section?: OperationalRewardsSection) {
  let nextScreen = screen;
  if (nextScreen === 'activate' && !controller.isOperationalActivationReady) {
    if (!controller.isFullyOperational) return;
    nextScreen = 'congratulations';
  }

  if (nextScreen !== 'activate' && nextScreen !== 'congratulations') {
    markRewardsSeen();
  }

  currentScreen.value = nextScreen;
  currentSection.value = section;
  sectionRequestId.value += 1;
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
  goTo(payload?.screen ?? (controller.isFullyOperational ? 'congratulations' : 'activate'), payload?.section);
});
</script>
