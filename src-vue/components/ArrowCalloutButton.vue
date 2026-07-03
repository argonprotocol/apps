<template>
  <div v-bind="attrs" :class="buttonClass" :style="buttonStyle">
    <span
      v-if="props.showArrow && props.direction !== 'right'"
      class="arrow-callout__point relative z-1 mr-[calc(-1.7*var(--arrow-callout-border))] w-[var(--arrow-callout-point-width)] flex-none bg-[var(--arrow-callout-stroke)] shadow-xl"
      aria-hidden="true"
    >
      <span
        class="arrow-callout__point-fill absolute inset-y-[var(--arrow-callout-point-inset)] right-0 left-[var(--arrow-callout-point-inset)] block bg-[var(--arrow-callout-fill)]"
      />
    </span>
    <span
      class="arrow-callout__body rounded-md border-[length:var(--arrow-callout-border)] border-[var(--arrow-callout-stroke)] bg-[var(--arrow-callout-fill)] px-8 py-[0.4rem] leading-none whitespace-nowrap shadow-lg"
      :class="[props.showArrow ? '' : 'border-l', props.direction === 'left' ? 'pl-[1.15rem]' : 'pr-[1.15rem]']"
    >
      <slot>{{ label }}</slot>
    </span>
    <span
      v-if="props.showArrow && props.direction === 'right'"
      class="arrow-callout__point arrow-callout__point--right relative z-1 ml-[calc(-1.7*var(--arrow-callout-border))] w-[var(--arrow-callout-point-width)] flex-none bg-[var(--arrow-callout-stroke)] shadow-xl"
      aria-hidden="true"
    >
      <span
        class="arrow-callout__point-fill arrow-callout__point-fill--right absolute inset-y-[var(--arrow-callout-point-inset)] right-[var(--arrow-callout-point-inset)] left-0 block bg-[var(--arrow-callout-fill)]"
      />
    </span>

    <HoverCardRoot v-model:open="isOpen" :openDelay="0" :disableHoverableContent="true" :disableClosingTrigger="true">
      <HoverCardTrigger
        :style="{ borderColor: props.strokeColor, backgroundColor: props.fillColor }"
        :class="hoverCardTriggerClass"
        class="group text-argon-600! pointer-events-auto absolute top-0 flex aspect-square h-full scale-105 cursor-pointer flex-row items-center justify-center rounded-full border shadow-xl"
      >
        <SparkleOutlineIcon :class="isOpen ? 'opacity-0' : 'w-5 group-hover:opacity-0'" />
        <SparkleFilledIcon
          class="absolute top-1/2 left-1/2 w-5 -translate-x-1/2 -translate-y-1/2"
          :class="isOpen ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'"
        />
      </HoverCardTrigger>
      <HoverCardPortal>
        <HoverCardContent :side="position" :sideOffset="-4" class="z-[5000]">
          <div
            v-if="props.guidance"
            :style="{ backgroundColor: props.fillColor }"
            class="border-argon-600/40 flex w-100 flex-col gap-2 rounded border shadow-xl"
          >
            <header class="bg-argon-600/10 px-5 py-3 font-bold">
              Task: {{ controller.activeGuideId ? operationalSteps[controller.activeGuideId]?.title : '' }}
            </header>

            <p class="px-5 pt-3">
              {{ props.guidance }}
            </p>

            <div class="flex flex-row gap-x-2 p-5 whitespace-nowrap">
              <button
                @click="cancelTask"
                class="border-argon-600/60 text-argon-600 hover:bg-argon-600/5 grow cursor-pointer rounded border px-5 py-1"
              >
                Cancel Task
              </button>
              <button
                class="border-argon-600/60 text-argon-600 hover:bg-argon-600/5 grow cursor-pointer rounded border px-5 py-1"
              >
                View Documentation
              </button>
            </div>
          </div>
          <HoverCardArrow
            :width="24"
            :height="12"
            class="stroke-argon-600/30 relative -top-px z-50 shadow-xl/50"
            :style="{ fill: '#F1D7F1' }"
          />
        </HoverCardContent>
      </HoverCardPortal>
    </HoverCardRoot>
  </div>
</template>

<script setup lang="ts">
import * as Vue from 'vue';
import SparkleOutlineIcon from '../assets/sparkle-outline.svg';
import SparkleFilledIcon from '../assets/sparkle-filled.svg';
import { twMerge } from 'tailwind-merge';
import { HoverCardArrow, HoverCardContent, HoverCardPortal, HoverCardRoot, HoverCardTrigger } from 'reka-ui';
import { useOperationsController, operationalSteps } from '../stores/operationsController.ts';

defineOptions({
  inheritAttrs: false,
});

const controller = useOperationsController();
const isOpen = Vue.ref(false);

const props = withDefaults(
  defineProps<{
    class?: string;
    direction?: 'left' | 'right';
    fillColor?: string;
    label?: string;
    guidance?: string;
    strokeColor?: string;
    showArrow?: boolean;
    position?: 'top' | 'bottom';
  }>(),
  {
    direction: 'left',
    fillColor: '#faeff8',
    label: 'Click Here',
    strokeColor: '#b100de',
    showArrow: true,
    position: 'bottom',
  },
);

const attrs = Vue.useAttrs();

const buttonClass = Vue.computed(() =>
  twMerge(
    'relative arrow-callout--attention inline-flex items-stretch font-extrabold text-fuchsia-700 text-lg',
    attrs.class as string,
    props.class,
  ),
);

const buttonStyle = Vue.computed(() => ({
  '--arrow-callout-fill': props.fillColor,
  '--arrow-callout-stroke': props.strokeColor,
  '--arrow-callout-border': '1.5px',
  '--arrow-callout-point-inset': '2px',
  '--arrow-callout-point-width': 'calc(0.6em + 0.6rem)',
}));

const hoverCardTriggerClass = Vue.computed(() =>
  props.direction === 'right' ? 'left-0 -translate-x-1/2' : 'right-0 translate-x-1/2',
);

function cancelTask() {
  controller.activeGuideId = null;
}
</script>

<style scoped>
.arrow-callout__point {
  clip-path: polygon(0 50%, 100% 0, 100% 100%);
}

.arrow-callout__point-fill {
  clip-path: polygon(0 50%, 100% 0, 100% 100%);
}

.arrow-callout__point--right {
  clip-path: polygon(0 0, 100% 50%, 0 100%);
}

.arrow-callout__point-fill--right {
  clip-path: polygon(0 0, 100% 50%, 0 100%);
}

.arrow-callout__body {
  border-left-width: 0;
}

.arrow-callout__body.border-l {
  border-left-width: var(--arrow-callout-border);
}

.arrow-callout--attention {
  animation: arrow-callout-nudge 1.8s ease-in-out infinite;
}

.arrow-callout--attention .arrow-callout__point,
.arrow-callout--attention .arrow-callout__body {
  animation: arrow-callout-glow 1.8s ease-in-out infinite;
}

@keyframes arrow-callout-nudge {
  0%,
  100% {
    transform: translateX(0);
  }
  18% {
    transform: translateX(-3px);
  }
  30% {
    transform: translateX(0);
  }
  42% {
    transform: translateX(-2px);
  }
  54% {
    transform: translateX(0);
  }
}

@keyframes arrow-callout-glow {
  0%,
  100% {
    filter: drop-shadow(0 0 0 rgba(166, 0, 212, 0));
  }
  25% {
    filter: drop-shadow(0 0 8px rgba(166, 0, 212, 0.28));
  }
}

:global(html[data-e2e-no-motion='1']) .arrow-callout--attention,
:global(html[data-e2e-no-motion='1']) .arrow-callout--attention .arrow-callout__point,
:global(html[data-e2e-no-motion='1']) .arrow-callout--attention .arrow-callout__body {
  animation: none !important;
}
</style>
