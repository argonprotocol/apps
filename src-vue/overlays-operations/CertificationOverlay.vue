<!-- prettier-ignore -->
<template>
  <OverlayBase :isOpen="isOpen" @close="closeOverlay" @goBack="goBack" :showGoBack="!!currentKey" class="w-7/12">
    <template #title>
      <DialogTitle class="grow">
        {{ currentKey ? steps[currentKey].title : 'Operator Certification Process' }}
      </DialogTitle>
    </template>
    <div v-if="!currentKey">
      <p class="font-light px-5 pt-5">
        Complete the following seven steps, and you'll earn
        (along with your sponsor) a ₳500 bonus from the Argon Treasury.
      </p>
      <ul class="flex flex-col mt-3 mb-1 mx-3 text-base font-semibold divide-y divide-slate-600/15">
        <li v-for="[key, step] of Object.entries(steps)" @click="openStep(key)" class="flex flex-row items-center gap-x-2 hover:bg-argon-600/5 py-3 pl-3 pr-2 cursor-pointer">
          <Checkbox :size="7" :isChecked="step.isCompleted" />
          <span class="grow">{{ step.title }}</span>
          <a :href="step.documentationLink" target="_blank" class="px-3 text-right text-argon-600 font-light hover:bg-white hover:text-argon-700! rounded-full">Open Docs</a>
        </li>
      </ul>
      <div class="pt-4 pb-4 px-3 mx-3 border-t border-slate-500/30">
        <a href="https://argon.network/docs/operator-certification" target="_blank" class="text-argon-600 hover:text-argon-700! font-light">
          Learn more about the Argon's Operator Certification.
        </a>
      </div>
    </div>
    <div v-else class="px-5 py-5">
      <component :is="steps[currentKey].component" />
    </div>
  </OverlayBase>
</template>

<script setup lang="ts">
import * as Vue from 'vue';
import OverlayBase from '../overlays-shared/OverlayBase.vue';
import { DialogTitle } from 'reka-ui';
import basicEmitter from '../emitters/basicEmitter.ts';
import Checkbox from '../components/Checkbox.vue';
import BootstrapToNode from './certification/BootstrapToNode.vue';
import TransferFromUniswap from './certification/TransferFromUniswap.vue';
import ActivateVault from './certification/ActivateVault.vue';
import LiquidLock from './certification/LiquidLock.vue';
import AcquireBonds from './certification/AcquireBonds.vue';
import WinMiningSeats from './certification/WinMiningSeats.vue';
import WinMoreMiningSeats from './certification/WinMoreMiningSeats.vue';

const steps = {
  one: {
    title: 'Bootstrap from Existing Node',
    documentationLink: 'https://argon.network/docs/operator-certification/bootstrap-to-node',
    isCompleted: true,
    component: BootstrapToNode,
  },
  two: {
    title: 'Transfer Tokens from Uniswap',
    documentationLink: 'https://argon.network/docs/operator-certification/transfer-from-uniswap',
    isCompleted: false,
    component: TransferFromUniswap,
  },
  three: {
    title: 'Activate Stabilization Vault',
    documentationLink: 'https://argon.network/docs/operator-certification/activate-vault',
    isCompleted: false,
    component: ActivateVault,
  },
  four: {
    title: 'Liquid Lock ₳2,000 or More In Bitcoin',
    documentationLink: 'https://argon.network/docs/operator-certification/liquid-lock',
    isCompleted: false,
    component: LiquidLock,
  },
  five: {
    title: 'Acquire Treasury Bonds',
    documentationLink: 'https://argon.network/docs/operator-certification/acquire-bonds',
    isCompleted: false,
    component: AcquireBonds,
  },
  six: {
    title: 'Win a First Mining Seat',
    documentationLink: 'https://argon.network/docs/operator-certification/win-first-mining-seat',
    isCompleted: false,
    component: WinMiningSeats,
  },
  seven: {
    title: 'Win a Second Mining Seat',
    documentationLink: 'https://argon.network/docs/operator-certification/win-more-mining-seats',
    isCompleted: false,
    component: WinMoreMiningSeats,
  },
} as const;

const isOpen = Vue.ref(false);
type StepKey = keyof typeof steps;
const currentKey = Vue.ref<StepKey | ''>('');

function openStep(key: string) {
  currentKey.value = key as StepKey;
}

function goBack(): void {
  currentKey.value = '';
}

function closeOverlay() {
  isOpen.value = false;
}

basicEmitter.on('openCertificationOverlay', async () => {
  isOpen.value = true;
});
</script>
