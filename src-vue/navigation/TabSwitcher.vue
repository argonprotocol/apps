<!-- prettier-ignore -->
<template>
  <section
    ref="toggleRef"
    class="pointer-events-auto flex w-fit flex-row rounded border border-[#b8b9bd] bg-[#E9EBF1] text-center text-slate-600"
  >
    <div
      Item
      class="border-r border-slate-400"
      @click="goto(ScreenKey.Mining)"
      :class="{ selected: controller.screenKey === ScreenKey.Mining }">
      <div Wrapper class="relative inline px-2 text-center">
        <div :class="{ invisible: controller.screenKey === ScreenKey.Mining }">Mining</div>
        <div v-if="controller.screenKey === ScreenKey.Mining" class="absolute top-0 left-0 h-full w-full font-bold">
          Mining
        </div>
      </div>
    </div>
    <div
      Item Home
      class="border-r border-slate-400"
      @click="goto(ScreenKey.Home)"
      :class="{ selected: controller.screenKey === ScreenKey.Home }">
      <div Wrapper class="relative inline px-1 text-center">
        <div :class="{ invisible: controller.screenKey === ScreenKey.Home }">
          <HomeIcon class="relative top-[1.5px] h-5 opacity-60" />
        </div>
        <div
          v-if="controller.screenKey === ScreenKey.Home"
          class="absolute top-0 left-0 h-full w-full text-center font-bold">
          <HomeIcon class="text-argon-600 relative top-[1.5px] mx-auto h-5" />
        </div>
      </div>
    </div>
    <div Item @click="goto(ScreenKey.Vaulting)" :class="{ selected: controller.screenKey === ScreenKey.Vaulting }">
      <div Wrapper class="relative inline px-1 text-center">
        <div :class="{ invisible: controller.screenKey === ScreenKey.Vaulting }">Vaulting</div>
        <div v-if="controller.screenKey === ScreenKey.Vaulting" class="absolute top-0 left-0 h-full w-full font-bold">
          Vaulting
        </div>
      </div>
    </div>
  </section>
</template>

<script setup lang="ts">
import * as Vue from 'vue';
import { ScreenKey } from '../interfaces/IConfig.ts';
import { useController } from '../stores/controller.ts';
import { ITourPos, useTour } from '../stores/tour.ts';
import HomeIcon from '../assets/home.svg?component';
import { getConfig } from '../stores/config.ts';

const tour = useTour();
const controller = useController();
const config = getConfig();

const toggleRef = Vue.ref<HTMLElement | null>(null);

function goto(screenKey: ScreenKey) {
  if (controller.backButtonTriggersHome) {
    controller.backButtonTriggersHome = false;
    if (screenKey === ScreenKey.Mining) {
      config.isPreparingMinerSetup = false;
    } else if (screenKey === ScreenKey.Vaulting) {
      config.isPreparingVaultSetup = false;
    }
  }
  controller.setScreenKey(screenKey);
}

tour.registerPositionCheck('miningTab', (): ITourPos => {
  const rect = toggleRef.value?.getBoundingClientRect().toJSON() || { left: 0, right: 0, top: 0, bottom: 0 };
  rect.left -= 20;
  rect.right += 20;
  rect.top -= 10;
  rect.bottom += 10;
  return rect;
});

tour.registerPositionCheck('vaultingTab', () => {
  const rect = toggleRef.value?.getBoundingClientRect().toJSON() || { left: 0, right: 0, top: 0, bottom: 0 };
  rect.left -= 20;
  rect.right += 20;
  rect.top -= 10;
  rect.bottom += 10;
  return rect;
});
</script>

<style scoped>
@reference "../main.css";

section {
  position: relative;
  box-shadow: inset 1px 1px 2px rgba(0, 0, 0, 0.2);
  white-space: nowrap;
  &[disabled='true'] {
    pointer-events: none;
  }
  &[isRunning='true'] li {
    opacity: 0.5 !important;
  }
  [Item] {
    z-index: 1;
    cursor: pointer;
    padding: 4px 30px;
    transition: opacity 0.3s ease;
    position: relative;
    &[Home] {
      padding: 4px 14px;
    }
    [Wrapper] {
      display: block;
      width: 100%;
      height: 100%;
      position: relative;
      z-index: 2;
    }
  }
  [Item].selected {
    @apply text-argon-600;
  }
  [Item].selected:after {
    content: '';
    width: calc(100% + 2px);
    height: calc(100% + 2px);
    position: absolute;
    top: -1px;
    left: -1px;
    background: white;
    border-radius: 5px;
    border: 1px solid #979797;
    box-shadow: 0 1px rgba(0, 0, 0, 0.1);
    cursor: default;
    transition: left 0.3s ease;
    z-index: 1;
  }
  [Item]:not(.selected) {
    opacity: 0.3;
  }
  [Item]:last-child.selected:after {
    left: -1px;
  }
}
</style>
