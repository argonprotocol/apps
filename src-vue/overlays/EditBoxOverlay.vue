<!-- prettier-ignore -->
<template>
  <div
    ref="modalElem"
    class="absolute bg-white border border-slate-500/60 rounded-md shadow-lg z-100 text-base"
    :style="[positionStyle, { cursor: isDragging ? 'grabbing' : 'default' }]"
  >
    <div class="flex flex-col">
      <div class="flex flex-row items-center justify-center text-xl font-bold font-sans text-argon-600/70 mx-2 text-center border-b border-slate-400/30">
        <ChevronLeftIcon v-if="previousId" class="w-5 h-5 text-argon-600/70 cursor-pointer opacity-50 hover:opacity-100" @click="goToPrevious" />
        <span @mousedown="onDragStart" class="grow pt-4 pb-1 cursor-grab">{{ titles[id as keyof typeof titles] }}</span>
        <ChevronRightIcon v-if="nextId" class="w-5 h-5 text-argon-600/70 cursor-pointer opacity-50 hover:opacity-100" @click="toToNext" />
      </div>

      <div class="flex flex-col grow text-md px-5 mt-4">
        <BotStartingBid v-if="id === 'startingBid'" @update:data="updateData" ref="editorInstance" />
        <BotMaximumBid v-else-if="id === 'maximumBid'" @update:data="updateData" ref="editorInstance" />
        <BotRebiddingStrategy v-else-if="id === 'rebiddingStrategy'" @update:data="updateData" ref="editorInstance" />
        <BotCapitalAllocation v-else-if="id === 'capitalAllocation'" @update:data="updateData" ref="editorInstance" />
        <BotExpectedGrowth v-else-if="id === 'expectedGrowth'" @update:data="updateData" ref="editorInstance" />
        <BotCloudMachine v-else-if="id === 'cloudMachine'" @update:data="updateData" ref="editorInstance" />

        <VaultProjectedUtilization v-else-if="id === 'projectedUtilization'" @update:data="updateData" ref="editorInstance" />
        <VaultBtcLockingFees v-else-if="id === 'btcLockingFees'" @update:data="updateData" ref="editorInstance" />
        <VaultPoolRevenueShare v-else-if="id === 'poolRevenueShare'" @update:data="updateData" ref="editorInstance" />
        <VaultTreasuryFunding v-else-if="id === 'treasuryFunding'" @update:data="updateData" ref="editorInstance" />
        <VaultSecuritizationRatio v-else-if="id === 'securitizationRatio'" @update:data="updateData" ref="editorInstance" />
        <VaultPersonalBtc v-else-if="id === 'personalBtc'" @update:data="updateData" ref="editorInstance" />
      </div>

      <div v-if="shouldHideSaveButton" class="flex flex-row justify-end pb-3 pr-3 space-x-3 mt-5 mx-2 border-t border-slate-400/50 pt-3">
        <button @click="cancelOverlay" class="text-slate-800/70 border border-slate-400 px-3 rounded-md cursor-pointer">Close</button>
      </div>
      <div v-else class="flex flex-row justify-end pb-3 pr-3 space-x-3 mt-5 mx-2 border-t border-slate-400/50 pt-3">
        <button @click="cancelOverlay" class="text-slate-800/70 border border-slate-400 px-3 rounded-md cursor-pointer">Cancel</button>
        <button @click="saveOverlay" class="text-white bg-argon-button border border-argon-600 px-3 rounded-md cursor-pointer">{{ saveButtonLabel }}</button>
      </div>
    </div>
  </div>
</template>

<script lang="ts">
import * as Vue from 'vue';
import { ChevronLeftIcon, ChevronRightIcon } from '@heroicons/vue/24/solid';

export interface IEditBoxChildExposed {
  beforeSave?: (stopSaveFn: () => void) => void | Promise<void>;
  beforeCancel?: (stopCancelFn: () => void) => void | Promise<void>;
  saveButtonLabel?: Vue.Ref<string>;
  shouldHideSaveButton?: Vue.Ref<boolean>;
}

export type IEditBoxOverlayTypeForMining =
  | 'maximumBid'
  | 'startingBid'
  | 'rebiddingStrategy'
  | 'capitalAllocation'
  | 'expectedGrowth'
  | 'cloudMachine';

export type IEditBoxOverlayTypeForVaulting =
  | 'treasuryFunding'
  | 'securitizationRatio'
  | 'poolRevenueShare'
  | 'btcLockingFees'
  | 'projectedUtilization'
  | 'personalBtc';

export type IEditBoxOverlayType = IEditBoxOverlayTypeForMining | IEditBoxOverlayTypeForVaulting;
</script>

<script setup lang="ts">
import BotStartingBid from './edit-box/BotStartingBid.vue';
import BotMaximumBid from './edit-box/BotMaximumBid.vue';
import BotRebiddingStrategy from './edit-box/BotRebiddingStrategy.vue';
import BotCapitalAllocation from './edit-box/BotCapitalAllocation.vue';
import BotExpectedGrowth from './edit-box/BotExpectedGrowth.vue';
import BotCloudMachine from './edit-box/BotCloudMachine.vue';
import VaultProjectedUtilization from './edit-box/VaultProjectedUtilization.vue';
import VaultBtcLockingFees from './edit-box/VaultBtcLockingFees.vue';
import VaultPoolRevenueShare from './edit-box/VaultPoolRevenueShare.vue';
import VaultSecuritizationRatio from './edit-box/VaultSecuritizationRatio.vue';
import VaultPersonalBtc from './edit-box/VaultPersonalBtc.vue';
import { useConfig } from '../stores/config';
import { JsonExt } from '@argonprotocol/apps-core';
import { IBiddingRules } from '@argonprotocol/apps-core';
import VaultTreasuryFunding from './edit-box/VaultTreasuryFunding.vue';

const props = defineProps<{
  id: IEditBoxOverlayType;
  position?: { top?: number; left?: number; width?: number };
  previousId?: IEditBoxOverlayType;
  nextId?: IEditBoxOverlayType;
}>();

const emit = defineEmits<{
  (e: 'close', id: IEditBoxOverlayType): void;
  (e: 'update:data'): void;
  (e: 'goTo', id: IEditBoxOverlayType | undefined): void;
}>();

const config = useConfig();

const editorInstance = Vue.ref<IEditBoxChildExposed | null>(null);
const saveButtonLabel = Vue.ref('Save');
const shouldHideSaveButton = Vue.ref(false);

let previousBiddingRules = JsonExt.stringify(config.biddingRules);
let lastBoundingClientRect: DOMRect | null = null;

const titles = {
  maximumBid: 'Maximum Bid',
  startingBid: 'Starting Bid',
  rebiddingStrategy: 'Rebidding Strategy',
  capitalAllocation: 'Capital Allocation',
  expectedGrowth: 'Expected Growth',
  cloudMachine: 'Mining Machine',

  projectedUtilization: 'Projected Utilization',
  btcLockingFees: 'Bitcoin Locking Fees',
  poolRevenueShare: 'Treasury Revenue Split',
  treasuryFunding: 'Internal Treasury Funding',
  securitizationRatio: 'Securitization Ratio',
  personalBtc: 'Internal Bitcoin Locking',
};

// --- Draggable Modal Logic ---
const hasDragged = Vue.ref(false);
const isDragging = Vue.ref(false);
const dragStart = Vue.ref({ x: 0, y: 0 });
const mouseStart = Vue.ref({ x: 0, y: 0 });
const modalElem = Vue.ref<HTMLElement | null>(null);

// Reactive position that can be mutated during dragging
const currentPosition = Vue.ref({ top: 0, left: 0, width: 0 });

// Initialize position from props
Vue.watchEffect(() => {
  if (props.position) {
    currentPosition.value = calculatePropsPosition();
  }
});

function calculatePropsPosition() {
  return {
    top: (props.position?.top || 0) - 22,
    left: (props.position?.left || 0) - 22,
    width: (props.position?.width || 0) + 44,
  };
}

const positionStyle = Vue.computed(() => {
  return {
    top: `${currentPosition.value.top}px`,
    left: `${currentPosition.value.left}px`,
    width: `${currentPosition.value.width}px`,
  };
});

function updateData() {
  emit('update:data');
}

async function cancelOverlay(e?: MouseEvent) {
  let stopCancel = false;
  let stopCancelFn = () => {
    stopCancel = true;
  };
  await editorInstance.value?.beforeCancel?.(stopCancelFn);
  if (stopCancel) return;

  config.biddingRules = JsonExt.parse<IBiddingRules>(previousBiddingRules);
  emit('close', props.id);
  e?.preventDefault();
  e?.stopPropagation();
}

function goToPrevious() {
  emit('goTo', props.previousId);
}

function toToNext() {
  emit('goTo', props.nextId);
}

async function saveOverlay() {
  let stopSave = false;
  let stopSaveFn = () => {
    stopSave = true;
  };
  await editorInstance.value?.beforeSave?.(stopSaveFn);
  if (stopSave) return;

  emit('close', props.id);
}

function handleKeydown(e: KeyboardEvent) {
  if (e.key === 'Escape') {
    cancelOverlay();
  }
}

function onDragStart(e: MouseEvent) {
  console.log('drag start');
  isDragging.value = true;
  hasDragged.value = true;
  mouseStart.value = { x: e.clientX, y: e.clientY };
  dragStart.value = { x: currentPosition.value.left, y: currentPosition.value.top };
  window.addEventListener('mousemove', onDragMove);
  window.addEventListener('mouseup', onDragEnd);
}

function constrainToViewport(x: number, y: number): { x: number; y: number } {
  if (!modalElem.value) return { x, y };

  const rect = modalElem.value.getBoundingClientRect();
  const modalWidth = rect.width;
  const modalHeight = rect.height;

  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const padding = 10;

  // Constrain the modal to stay within viewport bounds with padding
  const maxX = vw - modalWidth - padding;
  const maxY = vh - modalHeight - padding;

  return {
    x: Math.max(padding, Math.min(maxX, x)),
    y: Math.max(padding, Math.min(maxY, y)),
  };
}

function onDragMove(e: MouseEvent) {
  if (!isDragging.value) return;
  const dx = e.clientX - mouseStart.value.x;
  const dy = e.clientY - mouseStart.value.y;

  let newX = dragStart.value.x + dx;
  let newY = dragStart.value.y + dy;

  const constrained = constrainToViewport(newX, newY);
  currentPosition.value.left = constrained.x;
  currentPosition.value.top = constrained.y;
}

function onDragEnd() {
  isDragging.value = false;
  window.removeEventListener('mousemove', onDragMove);
  window.removeEventListener('mouseup', onDragEnd);
}

function handleResize(boundingClientRect: DOMRect) {
  const heightDiff = boundingClientRect.height - (lastBoundingClientRect?.height || 0);
  if (!hasDragged.value && heightDiff < 0) {
    const newTop = currentPosition.value.top + -heightDiff;
    const propsPosition = calculatePropsPosition();
    return {
      x: currentPosition.value.left,
      y: Math.min(newTop, propsPosition.top),
    };
  }
  return constrainToViewport(currentPosition.value.left, currentPosition.value.top);
}

const observer = new ResizeObserver(entries => {
  if (!modalElem.value) return;

  const boundingClientRect = modalElem.value.getBoundingClientRect();
  const constrained = handleResize(boundingClientRect);

  // Update position if it was constrained
  if (constrained.x !== currentPosition.value.left || constrained.y !== currentPosition.value.top) {
    currentPosition.value.left = constrained.x;
    currentPosition.value.top = constrained.y;
  }

  lastBoundingClientRect = boundingClientRect;
});

Vue.watch(
  () => editorInstance.value?.saveButtonLabel,
  label => {
    saveButtonLabel.value = label || 'Save';
  },
);

Vue.watch(
  () => editorInstance.value?.shouldHideSaveButton,
  value => {
    shouldHideSaveButton.value = value || false;
  },
);

Vue.onMounted(() => {
  if (modalElem.value) {
    observer.observe(modalElem.value);
  }
});

Vue.onBeforeMount(async () => {
  window.addEventListener('keydown', handleKeydown);
});

Vue.onBeforeUnmount(() => {
  if (observer && modalElem.value) {
    observer.unobserve(modalElem.value);
  }
  window.removeEventListener('keydown', handleKeydown);
});
</script>
