<!-- prettier-ignore -->
<template>
  <OverlayBase :isOpen="isOpen" :showCloseIcon="false" :enableTopBar="true" class="w-5/12">
    <template #overlayEffects>
      <div v-if="isOpen && isComplete" ref="confettiContainer" class="operations-confetti absolute inset-0">
        <span
          v-for="(piece, index) in confettiPieces"
          :key="index"
          class="operations-confetti-piece absolute left-1/2 top-1/2"
          :class="{
            'operations-confetti-diamond': index % 3 === 0,
            'operations-confetti-small': index % 5 === 0,
          }"
          :style="piece"
        />
      </div>
    </template>

    <template #title>
      <DialogTitle class="grow pl-3">
        {{ isComplete ? 'Operations Unlocked!' : 'Operations Approved!' }}
      </DialogTitle>
    </template>

    <div class="mx-2 py-5 font-light leading-6">
      <div class="space-y-3 pl-5 pr-10">
        <p v-if="isComplete">
          You now have access to Argon's mining and vaulting operations. Choose an operation to begin setting up the
          infrastructure that powers and stabilizes the network.
        </p>
        <p v-else>
          Your sponsor approved your Operations upgrade. We're registering your operational account on the network now.
        </p>

        <div v-if="!isComplete" class="pt-2">
          <ProgressBar :progress="registrationProgressPct" :hasError="!!registrationProgressError" />
          <div class="mt-3 text-sm text-slate-500">{{ registrationProgressLabel }}</div>

          <div v-if="registrationProgressError" class="mt-3 text-sm text-red-600">
            <div>{{ registrationProgressError }}</div>
            <button
              type="button"
              :disabled="isRegistering"
              class="border-argon-600 text-argon-600 mt-2 cursor-pointer rounded border px-3 py-1.5 font-semibold disabled:cursor-default disabled:opacity-50"
              @click="completeRegistration"
            >
              {{ isRegistering ? 'Completing...' : 'Try Again' }}
            </button>
          </div>
        </div>
      </div>

      <div v-if="isComplete" class="mt-6 flex flex-row items-center justify-between space-x-4 border-t border-slate-300 px-5 py-1">
        <button
          @click="closeOverlay"
          class="bg-argon-button border-argon-button-hover hover:bg-argon-button-hover inner-button-shadow mt-5 flex w-full cursor-pointer flex-row items-center justify-center space-x-2 rounded-md border px-6 py-2 font-bold text-white focus:outline-none"
        >
          Explore Operations
        </button>
      </div>
    </div>
  </OverlayBase>
</template>

<script setup lang="ts">
import * as Vue from 'vue';
import { gsap } from 'gsap';
import { DialogTitle } from 'reka-ui';
import type { IMemberInvite } from '@argonprotocol/apps-router';
import OverlayBase from './OverlayBase.vue';
import ProgressBar from '../components/ProgressBar.vue';
import basicEmitter from '../emitters/basicEmitter.ts';
import { getConfig } from '../stores/config.ts';
import { getMainchainClient } from '../stores/mainchain.ts';
import { getTransactionTracker } from '../stores/transactions.ts';
import { getUpstreamOperatorClient } from '../stores/upstreamOperator.ts';
import { getWalletKeys, useWallets } from '../stores/wallets.ts';
import { ensureOperationalAccountRegistered } from '../lib/OperationalAccount.ts';

const config = getConfig();
const transactionTracker = getTransactionTracker();
const upstreamOperatorClient = getUpstreamOperatorClient();
const walletKeys = getWalletKeys();
const wallets = useWallets();

const isOpen = Vue.ref(false);
const isComplete = Vue.ref(false);
const isRegistering = Vue.ref(false);
const invite = Vue.shallowRef<IMemberInvite | null>(null);
const registrationProgressPct = Vue.ref(0);
const registrationProgressLabel = Vue.ref('Preparing registration...');
const registrationProgressError = Vue.ref('');
const confettiContainer = Vue.ref<HTMLElement>();
const confettiColors = ['#9e3fb2', '#b000c8', '#c47bce', '#d899df', '#d7a83e', '#8a909d'];
const confettiPieces = Array.from(
  { length: 128 },
  (_, index) =>
    ({
      '--confetti-color': confettiColors[index % confettiColors.length],
    }) as Vue.CSSProperties,
);

let unsubscribeProgress: (() => void) | undefined;
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
      gsap.to(piece, { x: endX, duration, delay, ease: 'power2.out', force3D: true });
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
        .to(piece, { y: fallY, duration: duration * 0.66, ease: 'power2.in', force3D: true });
      gsap.to(piece, { rotation, duration, delay, ease: 'none', force3D: true });
      gsap.to(piece, {
        opacity: 0,
        duration: 0.5,
        delay: delay + duration - 0.5,
        ease: 'power1.in',
      });
    });
  }, confettiContainer.value);
}

async function markComplete() {
  if (isComplete.value) return;

  isComplete.value = true;
  registrationProgressPct.value = 100;
  registrationProgressLabel.value = 'Operations unlocked';
  await playConfetti();
}

async function completeRegistration() {
  if (isRegistering.value) return;

  unsubscribeProgress?.();
  unsubscribeProgress = undefined;
  isRegistering.value = true;
  registrationProgressPct.value = 0;
  registrationProgressLabel.value = 'Preparing registration...';
  registrationProgressError.value = '';

  try {
    invite.value = await upstreamOperatorClient.getMemberInvite();
    const client = await getMainchainClient(false);
    if (!invite.value?.accessProof) {
      await markComplete();
      return;
    }

    const txInfo = await ensureOperationalAccountRegistered({
      transactionTracker,
      walletKeys,
      accessProof: invite.value.accessProof,
      availableMicrogons: wallets.defaultArgonWallet.availableMicrogons,
      client,
    });
    if (!txInfo) {
      await markComplete();
      return;
    }

    unsubscribeProgress = txInfo.subscribeToProgress((args, error) => {
      registrationProgressPct.value = args.progressPct;
      registrationProgressLabel.value = args.progressMessage;
      registrationProgressError.value = error?.message ?? '';

      if (error || args.progressPct >= 100) {
        unsubscribeProgress?.();
        unsubscribeProgress = undefined;
        isRegistering.value = false;

        if (!error) void markComplete();
      }
    });
  } catch (error) {
    registrationProgressLabel.value = 'Upgrade needs attention';
    registrationProgressError.value =
      error instanceof Error && error.message ? error.message : 'Unable to complete the operations upgrade right now.';
  } finally {
    if (!unsubscribeProgress) isRegistering.value = false;
  }
}

async function closeOverlay() {
  config.setCertificationDetails({ dismissedWelcomeToOperationsOverlay: true });
  await config.save();
  isOpen.value = false;
}

basicEmitter.on('openWelcomeToOperationsOverlay', () => {
  if (config.certificationDetails?.dismissedWelcomeToOperationsOverlay) return;

  isOpen.value = true;
  void completeRegistration();
});

Vue.onBeforeUnmount(() => {
  unsubscribeProgress?.();
  confettiContext?.revert();
});
</script>

<style scoped>
.operations-confetti-piece {
  width: 9px;
  height: 17px;
  border-radius: 1px;
  background: var(--confetti-color);
  opacity: 0;
  will-change: transform, opacity;
}

.operations-confetti-diamond {
  width: 12px;
  height: 12px;
  border-radius: 0;
}

.operations-confetti-small {
  width: 8px;
  height: 12px;
}

@media (prefers-reduced-motion: reduce) {
  .operations-confetti {
    display: none;
  }
}
</style>
