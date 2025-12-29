<template>
  <div class="relative flex flex-row items-center font-mono whitespace-nowrap">
    <Motion :initial="{ opacity: 0 }" :animate="{ opacity: 1 }" :transition="{ duration: 0.5 }" class="pr-1">
      <Motion
        :initial="{ width: 0 }"
        :animate="{ width: 'auto' }"
        :transition="{
          duration: 1.5,
          ease: 'easeInOut',
          delay: 0.2,
        }"
        class="overflow-hidden">
        <label class="cursor-text select-auto">{{ typedText }}</label>
      </Motion>
    </Motion>
    <div class="grow overflow-hidden">
      <div ref="dotsElement" class="inline-block text-right">{{ dots }}</div>
    </div>
    <label v-if="isSuccess" class="top-0 cursor-text pl-2 font-bold text-green-600 select-auto">SUCCESS</label>
    <label v-else-if="isFailure" class="top-0 cursor-text pl-2 font-bold text-red-600 select-auto">FAILURE</label>
  </div>
</template>

<script setup lang="ts">
import * as Vue from 'vue';
import { Motion } from 'motion-v';
import { createDeferred } from '@argonprotocol/apps-core';

const dots = Vue.ref('');
const typedText = Vue.ref('');
const slotContent = Vue.ref('');
const slot = Vue.useSlots();
const dotsElement = Vue.ref<HTMLDivElement | null>(null);
const animationIsComplete = createDeferred<void>();

let animationInterval: any = null;

function startAnimation() {
  if (slot.default) {
    // Extract text content from slot
    const slotElement = slot.default();
    if (Array.isArray(slotElement)) {
      slotContent.value = slotElement
        .map(node => {
          if (typeof node === 'string') return node;
          if (node && typeof node === 'object' && 'children' in node) {
            return node.children;
          }
          return '';
        })
        .join('');
    } else if (typeof slotElement === 'string') {
      slotContent.value = slotElement;
    }

    // Start typing animation
    animateText();
  }
}

function animateText() {
  let index = 0;
  const text = slotContent.value;

  animationInterval = setInterval(() => {
    if (index < text.length) {
      typedText.value = text.slice(0, index + 1);
      index++;
    } else {
      clearInterval(animationInterval);
      animateDots();
    }
  }, 20); // Adjust speed as needed
}

function animateDots() {
  animationInterval = setInterval(() => {
    const dotsRect = dotsElement.value?.getBoundingClientRect();
    const parentRect = dotsElement.value?.parentElement?.getBoundingClientRect();
    const dotsWidth = dotsRect?.width || 0;
    const parentWidth = parentRect?.width || 0;

    if (dotsWidth < parentWidth) {
      dots.value += '.';
    } else {
      clearInterval(animationInterval);
      animateDotBlink();
      animationIsComplete.resolve();
    }
  }, 30);
}

async function animateDotBlink() {
  let isShowing = false;

  await new Promise(resolve => setTimeout(resolve, 100));
  dots.value = dots.value.slice(0, -8);

  animationInterval = setInterval(() => {
    if (isShowing) {
      dots.value = dots.value.slice(0, -8);
    } else {
      dots.value += '........';
    }
    isShowing = !isShowing;
  }, 200);
}

function stopAnimation() {
  clearInterval(animationInterval);
  dots.value = '.'.repeat(50);
}

const isFailure = Vue.inject('diagnosticIsFailure') as Vue.Ref<boolean>;
const isSuccess = Vue.inject('diagnosticIsSuccess') as Vue.Ref<boolean>;
const isRunning = Vue.inject('diagnosticIsRunning') as Vue.Ref<boolean>;

// Inject registration functions
const registerChild = Vue.inject('registerDiagnosticChild') as (promise: Promise<void>) => void;
const unregisterChild = Vue.inject('unregisterDiagnosticChild') as () => void;

// Register this component as a child of DiagnosticStep when mounted
Vue.onMounted(() => {
  if (registerChild) {
    registerChild(animationIsComplete.promise);
  }
});

// Unregister when component is unmounted
Vue.onUnmounted(() => {
  if (unregisterChild) {
    unregisterChild();
  }
});

Vue.watch(
  isRunning,
  (isTrue: boolean) => {
    if (isTrue) {
      startAnimation();
    } else {
      stopAnimation();
    }
  },
  { immediate: true },
);
</script>
