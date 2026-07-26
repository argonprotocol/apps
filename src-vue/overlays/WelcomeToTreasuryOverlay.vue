<!-- prettier-ignore -->
<template>
  <OverlayBase :isOpen="isOpen" :showCloseIcon="false" :enableTopBar="true" class="w-5/12">
    <template #overlayEffects>
      <div v-if="isOpen" ref="confettiContainer" class="treasury-confetti absolute inset-0">
        <span
          v-for="(piece, index) in confettiPieces"
          :key="index"
          class="treasury-confetti-piece absolute left-1/2 top-1/2"
          :class="{
            'treasury-confetti-diamond': index % 3 === 0,
            'treasury-confetti-small': index % 5 === 0,
          }"
          :style="piece"
        />
      </div>
    </template>
    <template #title>
      <DialogTitle class="grow pl-3">
        Treasury Unlocked!
      </DialogTitle>
    </template>
    <div class="mx-2 py-5 font-light leading-6">
      <div class="pl-5 pr-10 space-y-3">
        <p>
          You now have access to Argon's yield-generating instruments! Each tool has a different purpose, time horizon,
          and risk profile. Review its details before committing capital.
        </p>
      </div>

      <div class="mt-6 flex flex-row items-center justify-between space-x-4 border-t border-slate-300 px-5 py-1">
        <button
          @click="closeOverlay"
          class="mt-5 w-full flex flex-row items-center justify-center space-x-2 bg-argon-button border border-argon-button-hover hover:bg-argon-button-hover text-white font-bold inner-button-shadow px-6 py-2 rounded-md cursor-pointer focus:outline-none"
        >
          Explore Treasury
        </button>
      </div>
    </div>
  </OverlayBase>
</template>

<script setup lang="ts">
import * as Vue from 'vue';
import { gsap } from 'gsap';
import { DialogTitle } from 'reka-ui';
import OverlayBase from './OverlayBase.vue';
import { getConfig } from '../stores/config.ts';

const config = getConfig();

const isTreasuryApp = config.hasExtensionTreasury && !config.hasExtensionOperations;
const isOpen = Vue.ref(isTreasuryApp && config.showWelcomeOverlay);
const confettiContainer = Vue.ref<HTMLElement>();
const confettiColors = ['#9e3fb2', '#b000c8', '#c47bce', '#d899df', '#d7a83e', '#8a909d'];
const confettiPieces = Array.from(
  { length: 128 },
  (_, index) =>
    ({
      '--confetti-color': confettiColors[index % confettiColors.length],
    }) as Vue.CSSProperties,
);
let confettiContext: ReturnType<typeof gsap.context> | undefined;

async function playConfetti() {
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;

  await Vue.nextTick();
  if (!confettiContainer.value) return;

  confettiContext?.revert();
  confettiContext = gsap.context(() => {
    const pieces = Array.from(confettiContainer.value?.children ?? []);

    pieces.forEach((piece, index) => {
      const horizontalPosition = (index * 0.61803398875) % 1;
      const endX = (horizontalPosition - 0.5) * Math.min(window.innerWidth * 0.92, 1600);
      const launchY = -(210 + ((index * 47) % 260));
      const fallY = 330 + ((index * 137) % 260);
      const delay = ((index * 43) % 360) / 1000;
      const duration = 1.9 + ((index * 29) % 450) / 1000;
      const rotationDirection = index % 2 === 0 ? -1 : 1;
      const rotation = rotationDirection * (540 + ((index * 97) % 760));

      gsap.set(piece, {
        xPercent: -50,
        yPercent: -50,
        x: 0,
        y: 0,
        rotation: 0,
        scale: 0.4,
        opacity: 0,
        force3D: true,
      });

      gsap.to(piece, {
        x: endX,
        duration,
        delay,
        ease: 'power2.out',
        force3D: true,
      });
      gsap
        .timeline({ delay })
        .to(piece, {
          y: launchY,
          scale: 1,
          opacity: 1,
          duration: duration * 0.34,
          ease: 'power2.out',
          force3D: true,
        })
        .to(piece, {
          y: fallY,
          duration: duration * 0.66,
          ease: 'power2.in',
          force3D: true,
        });
      gsap.to(piece, {
        rotation,
        duration,
        delay,
        ease: 'none',
        force3D: true,
      });
      gsap.to(piece, {
        opacity: 0,
        duration: 0.5,
        delay: delay + duration - 0.5,
        ease: 'power1.in',
      });
    });
  }, confettiContainer.value);
}

Vue.onMounted(() => {
  void playConfetti();
});

Vue.onBeforeUnmount(() => {
  confettiContext?.revert();
});

async function closeOverlay() {
  config.showWelcomeOverlay = false;
  await config.save();
  isOpen.value = false;
}
</script>

<style scoped>
.treasury-confetti-piece {
  width: 9px;
  height: 17px;
  border-radius: 1px;
  background: var(--confetti-color);
  opacity: 0;
  will-change: transform, opacity;
}

.treasury-confetti-diamond {
  width: 12px;
  height: 12px;
  border-radius: 0;
}

.treasury-confetti-small {
  width: 8px;
  height: 12px;
}

@media (prefers-reduced-motion: reduce) {
  .treasury-confetti {
    display: none;
  }
}
</style>
