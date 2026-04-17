<template>
  <OverlayBase
    :isOpen="isOpen"
    :showGoBack="currentScreen === 'claim'"
    :overflowScroll="true"
    @close="closeOverlay"
    @esc="closeOverlay"
    @goBack="goBack"
    class="max-h-[calc(100vh-2rem)] pb-6"
    :class="currentScreen === 'overview' ? 'w-7/12' : 'w-[680px]'">
    <template #title>
      <div class="grow text-[30px] leading-none font-bold text-slate-800">{{ title }}</div>
    </template>

    <Congratulations v-if="currentScreen === 'congratulations'" @close="closeOverlay" @goTo="goTo" />

    <Claim v-else-if="currentScreen === 'claim'" :isActive="isOpen && currentScreen === 'claim'" @goTo="goTo" />

    <Overview
      v-else
      :isActive="isOpen && currentScreen === 'overview'"
      :section="currentSection"
      :sectionRequestId="sectionRequestId"
      @goTo="goTo" />
  </OverlayBase>
</template>

<script setup lang="ts">
import * as Vue from 'vue';
import OverlayBase from '../../app-shared/overlays/OverlayBase.vue';
import basicEmitter from '../../emitters/basicEmitter.ts';
import { getConfig } from '../../stores/config.ts';
import { useOperationsController } from '../../stores/operationsController.ts';
import Congratulations from './operational-rewards/Congratulations.vue';
import Claim from './operational-rewards/Claim.vue';
import Overview from './operational-rewards/Overview.vue';

type OperationalRewardsScreen = 'congratulations' | 'overview' | 'claim';
type OperationalRewardsSection = 'create' | 'unlock' | 'outbound';

const config = getConfig();
const controller = useOperationsController();

const isOpen = Vue.ref(false);
const currentScreen = Vue.ref<OperationalRewardsScreen>('overview');
const currentSection = Vue.ref<OperationalRewardsSection>();
const sectionRequestId = Vue.ref(0);

const title = Vue.computed(() => {
  if (currentScreen.value === 'congratulations') return 'Congratulations!';
  if (currentScreen.value === 'claim') return 'Claim Rewards';
  return 'Operator Referrals';
});

function closeOverlay() {
  markRewardsSeen();
  isOpen.value = false;
}

function goBack() {
  goTo('overview');
}

function goTo(screen: OperationalRewardsScreen, section?: OperationalRewardsSection) {
  if (screen !== 'congratulations') {
    markRewardsSeen();
  }

  currentScreen.value = screen;
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
  if (!controller.isFullyOperational) {
    return;
  }

  controller.clearCompletionNotices();
  goTo(payload?.screen ?? 'congratulations', payload?.section);
});
</script>
