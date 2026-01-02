import * as Vue from 'vue';
import { defineStore } from 'pinia';
import { getConfig } from './config';

export interface ITourPos {
  left: number;
  top: number;
  right: number;
  bottom: number;
  width: number;
  height: number;
  blur?: number;
}

export const useTour = defineStore('tour', () => {
  const config = getConfig();

  const positionChecks: Record<string, () => ITourPos> = {};
  const currentStep = Vue.ref(0);
  const isDisabled = Vue.ref(false);

  void config.load().then(() => {
    Vue.watch(
      () => config.isPreparingMinerSetup,
      isPreparingMinerSetup => {
        isDisabled.value = isPreparingMinerSetup;
      },
    );
  });

  function start() {
    currentStep.value = 1;
  }

  function registerPositionCheck(id: string, checkFn: () => ITourPos) {
    positionChecks[id] = checkFn;
  }

  function getPositionCheck(id: string) {
    const pos = positionChecks[id]();
    const left = Math.max(pos.left, 0);
    const top = Math.max(pos.top, 0);
    const right = Math.min(pos.right, window.innerWidth);
    const bottom = Math.min(pos.bottom, window.innerHeight);
    const width = right - left;
    const height = bottom - top;

    return {
      top,
      left,
      right,
      bottom,
      width,
      height,
    };
  }

  return {
    currentStep,
    start,
    registerPositionCheck,
    getPositionCheck,
    isDisabled,
  };
});
