<template>
  <HoverCardRoot :openDelay="0" :closeDelay="0" class="pointer-events-auto relative" v-model:open="isOpen">
    <HoverCardTrigger Trigger class="cursor-pointer">
      <div
        v-if="!wallets.isLoaded"
        class="text-argon-700 flex h-[30px] flex-row items-center gap-x-2 rounded-md border border-slate-400/50 px-4 py-0.5 hover:border-slate-400/50 hover:bg-slate-400/10 focus:outline-none">
        Loading...
      </div>
      <div
        v-else-if="status === Status.WaitingForSetup || status === Status.WaitingForFunding"
        class="text-argon-600/70 flex h-[30px] flex-row items-center gap-x-2 rounded-md border px-4 py-0.5 hover:border-slate-400/50 hover:bg-slate-400/10 focus:outline-none"
        :class="[isOpen ? 'border-slate-400/60 bg-slate-400/10' : 'border-slate-400/50']">
        <div ref="eyeballsElem" class="-ml-0.5 flex h-5 flex-row items-center gap-x-0.5">
          <div Eye class="border-argon-600/70 relative h-full w-3 rounded-[100%] border">
            <div
              Eyeball
              :style="{
                left: `calc(${eyeballXPosition}% + ${eyeballXPosition / 50 - 1}px)`,
                top: `${eyeballYPosition}%`,
                transform: `translate(-${eyeballXPosition}%, -${eyeballYPosition}%)`,
              }"
              class="bg-argon-600/70 absolute h-[7px] w-[7px] rounded-full" />
          </div>
          <div Eye class="border-argon-600/70 relative h-full w-3 rounded-[100%] border">
            <div
              Eyeball
              :style="{
                left: `calc(${eyeballXPosition}% + ${eyeballXPosition / 50 - 1}px)`,
                top: `${eyeballYPosition}%`,
                transform: `translate(-${eyeballXPosition}%, -${eyeballYPosition}%)`,
              }"
              class="bg-argon-600/70 absolute h-[7px] w-[7px] rounded-full" />
          </div>
        </div>
        Waiting for {{ status === Status.WaitingForSetup ? 'Setup' : 'Funding' }}
      </div>
      <div
        v-else-if="status === Status.Funded || status === Status.FullyFunded"
        class="text-argon-600/70 flex h-[30px] flex-row items-center gap-x-2 rounded-md border px-3 py-0.5 hover:border-slate-400/50 hover:bg-slate-400/10 focus:outline-none"
        :class="[isOpen ? 'border-slate-400/60 bg-slate-400/10' : 'border-slate-400/50']">
        <div class="text-argon-600 relative h-5 w-5 opacity-70">
          <StatusHappy />
          <Motion
            :animate="{ opacity: [0, 1, 0] }"
            :transition="{
              duration: 3,
              ease: 'easeInOut',
              repeat: Infinity,
              repeatDelay: 4,
              times: [0, 0.5, 1],
            }"
            class="absolute top-0 left-0 h-full w-full">
            <StatusSmiling />
          </Motion>
        </div>
        {{ status === Status.Funded ? 'Funded' : 'Fully Funded' }}!
      </div>
      <div v-else-if="wallets.isLoaded" class="group cursor-pointer">
        <div
          v-if="status === Status.Underfunded"
          class="inner-button-shadow flex flex-row items-center gap-x-2 rounded-md border border-red-600 bg-red-500 px-4 py-0.5 text-white">
          <div class="h-4 w-4">
            <StatusSad />
          </div>
          Underfunded
        </div>

        <div
          v-else-if="status === Status.Overfunded"
          class="inner-button-shadow flex flex-row items-center gap-x-2 rounded-md border border-yellow-600/60 bg-yellow-600/70 px-4 py-0.5 text-white">
          <div class="h-4 w-4">
            <StatusNeutral />
          </div>
          Overfunded
        </div>
      </div>
      <div v-else class="px-2 text-gray-900">Loading...</div>
    </HoverCardTrigger>

    <HoverCardPortal>
      <HoverCardContent
        @pointerDownOutside="clickOutside"
        :align="'end'"
        :alignOffset="0"
        :sideOffset="-3"
        class="data-[side=bottom]:animate-slideUpAndFade data-[side=right]:animate-slideLeftAndFade data-[side=left]:animate-slideRightAndFade data-[side=top]:animate-slideDownAndFad z-50 data-[state=open]:transition-all">
        <div
          class="text-md flex max-w-140 shrink flex-col rounded bg-white p-1 text-gray-900 shadow-lg ring-1 ring-gray-900/20">
          <div
            v-if="!config.isMinerInstalled && !hasVault"
            class="flex w-110 flex-col gap-y-2 rounded-md px-4 py-4 text-slate-900/80">
            <p>
              Once your mining bot has been setup, this is where you'll be notified of important alerts such as when
              your bot's capital runs low.
            </p>
            <table class="mt-3 w-full text-left whitespace-nowrap">
              <thead>
                <tr>
                  <th class="w-[20%]">Token</th>
                  <th class="w-[40%] text-right">Mining Wallet</th>
                  <th class="w-[40%] text-right">Vaulting Wallet</th>
                </tr>
              </thead>
              <tbody>
                <tr @click="openFundMiningAccountOverlay" class="group cursor-pointer">
                  <td class="group-hover:text-argon-600 group-hover:bg-argon-100/20">ARGN</td>
                  <td class="group-hover:text-argon-600 group-hover:bg-argon-100/20 text-right">
                    {{ microgonToArgonNm(wallets.totalMiningMicrogons).format('0,0.[00]') }}
                  </td>
                  <td class="group-hover:text-argon-600 group-hover:bg-argon-100/20 text-right">
                    {{ microgonToArgonNm(wallets.vaultingWallet.availableMicrogons).format('0,0.[00]') }}
                  </td>
                </tr>
                <tr @click="openFundVaultingAccountOverlay" class="group cursor-pointer">
                  <td class="group-hover:text-argon-600 group-hover:bg-argon-100/20">ARGNOT</td>
                  <td class="group-hover:text-argon-600 group-hover:bg-argon-100/20 text-right">
                    {{ micronotToArgonotNm(wallets.totalMiningMicronots).format('0,0.[00]') }}
                  </td>
                  <td class="group-hover:text-argon-600 group-hover:bg-argon-100/20 text-right">
                    {{ micronotToArgonotNm(wallets.vaultingWallet.availableMicronots).format('0,0.[00]') }}
                  </td>
                </tr>
              </tbody>
            </table>
            <motion
              as="div"
              :animate="{
                backgroundPosition: ['0% 0', '200% 0'],
              }"
              :transition="{
                duration: 2,
                ease: 'linear',
                repeat: Infinity,
                repeatType: 'loop',
              }"
              :style="{
                background: `linear-gradient(to right, #a600d4 0%, #EABDF7FF 50%, #a600d4 100%)`,
                backgroundSize: '200% 100%',
              }"
              class="mt-1 h-2.5 w-full rounded-sm opacity-50" />
          </div>

          <div
            v-else-if="config.hasSavedBiddingRules"
            :class="[installer.isRunning ? 'pointer-events-none opacity-50' : '']">
            <div v-if="miningStatus === 'Funded'" class="rounded-md bg-slate-400/10 px-6 py-5">
              <header class="flex flex-row items-center gap-x-1 text-lg font-bold whitespace-nowrap text-slate-600">
                <CheckboxIcon class="relative -left-0.5 h-7 w-7" />
                <span>Your Mining Account Is Fully Funded</span>
              </header>
              <p class="mt-px py-1 opacity-80">
                Your account has
                {{
                  micronotToArgonotNm(wallets.totalMiningMicronots).formatIfElse('< 100', '0,0.[000000]', '0,0.[00]')
                }}
                argonot{{
                  micronotToArgonotNm(wallets.totalMiningMicronots).formatIfElse(
                    '< 100',
                    '0,0.[000000]',
                    '0,0.[00]',
                  ) === '1'
                    ? ''
                    : 's'
                }}
                and
                {{ microgonToArgonNm(wallets.totalMiningMicrogons).formatIfElse('< 100', '0,0.[000000]', '0,0.[00]') }}
                argon{{
                  microgonToArgonNm(wallets.totalMiningMicrogons).formatIfElse('< 100', '0,0.[000000]', '0,0.[00]') ===
                  '1'
                    ? ''
                    : 's'
                }}
                ({{
                  microgonToArgonNm(
                    wallets.miningWallet.availableMicrogons - (config.biddingRules.sidelinedMicrogons ?? 0n),
                  ).formatIfElse('< 100', '0,0.[000000]', '0,0.[00]')
                }}
                are currently available to spend), which gives your bot enough capital to fully operate. However, you
                can always add more capital.
              </p>
              <div class="mt-1 flex flex-row items-center gap-x-3">
                <div class="text-argon-600 cursor-pointer" @click="openFundMiningAccountOverlay">Add More Capital</div>
                <div class="h-4 w-px bg-slate-400/80"></div>
                <div class="text-argon-600 cursor-pointer" @click="openBotCreateOverlay">Modify Bidding Rules</div>
              </div>
            </div>
            <div v-else-if="miningStatus === 'Underfunded'" class="rounded-md bg-red-100/70 px-4 py-4">
              <header class="flex flex-row items-center gap-x-2 text-lg font-bold whitespace-nowrap text-red-600">
                <StatusSad class="h-5 w-5" />
                <span>Your Mining Account Is Lacking Funds</span>
              </header>
              <p class="mt-px py-1 opacity-80">
                Your account needs
                <template v-if="miningMicrogonsNeeded > 0n">
                  {{ micronotToArgonotNm(miningMicrogonsNeeded).formatIfElse('< 100', '0,0.[000000]', '0,0.[00]') }}
                  argon{{
                    microgonToArgonNm(miningMicrogonsNeeded).formatIfElse('< 100', '0,0.[000000]', '0,0.[00]') === '1'
                      ? ''
                      : 's'
                  }}
                </template>
                <template v-if="miningMicrogonsNeeded > 0n && miningMicronotsNeeded > 0n">and</template>
                <template v-if="miningMicronotsNeeded > 0n">
                  {{ microgonToArgonNm(miningMicronotsNeeded).formatIfElse('< 100', '0,0.[000000]', '0,0.[00]') }}
                  argonot{{
                    micronotToArgonotNm(miningMicronotsNeeded).formatIfElse('< 100', '0,0.[000000]', '0,0.[00]') === '1'
                      ? ''
                      : 's'
                  }}
                </template>
                in order to fully operate according to your bidding rules.
              </p>
              <div class="mt-2 flex flex-row gap-x-2">
                <button
                  @click="openFundMiningAccountOverlay"
                  class="cursor-pointer rounded-md border border-red-600 px-4 py-1.5 font-bold text-red-700/70 hover:bg-red-600/10">
                  Transfer Tokens Into Account
                </button>
              </div>
            </div>
            <div v-else class="rounded-md bg-yellow-100/70 px-4 py-4">
              <header class="flex flex-row items-center gap-x-2 text-lg font-bold whitespace-nowrap text-yellow-600">
                <StatusNeutral class="h-5 w-5" />
                <span>Your Mining Account Has Excess Funds</span>
              </header>
              <p class="mt-px py-1 opacity-80">
                Your account has an extra
                {{
                  microgonToArgonNm(config.biddingRules.sidelinedMicrogons ?? 0n).formatIfElse(
                    '< 100',
                    '0,0.[000000]',
                    '0,0.[00]',
                  )
                }}
                argon{{
                  microgonToArgonNm(config.biddingRules.sidelinedMicrogons ?? 0n).formatIfElse(
                    '< 100',
                    '0,0.[000000]',
                    '0,0.[00]',
                  ) === '1'
                    ? ''
                    : 's'
                }}
                sitting unused. This isn't causing harm, but it's also not generating yield on your asset.
              </p>
              <div class="mt-2 flex flex-row gap-x-2">
                <button
                  class="cursor-pointer rounded-md border border-red-600 px-4 py-1.5 font-bold text-red-700/70 hover:bg-red-600/10">
                  Add Capital to Bidding Budget
                </button>
              </div>
            </div>
          </div>

          <template v-if="config.hasSavedBiddingRules && config.hasSavedVaultingRules">
            <div class="my-1 h-px bg-gray-300/60" />
          </template>

          <template v-if="config.hasSavedVaultingRules">
            <div v-if="vaultingStatus === 'Funded'" class="rounded-md px-4 py-4">
              <header class="flex flex-row items-center gap-x-2 text-lg font-bold whitespace-nowrap text-lime-600">
                <StatusHappy class="h-5 w-5" />
                <span>Your Vaulting Account Is Looking Good</span>
              </header>
              <p class="mt-px py-1 opacity-80">
                Your vaulting account has enough funds to operate. No further action is required at this time. However,
                you can always improve your vault with more funds.
              </p>
              <div class="mt-2 flex flex-row gap-x-2">
                <button
                  @click="openFundVaultingAccountOverlay"
                  class="cursor-pointer rounded-md border border-lime-600 px-4 py-1.5 font-bold text-lime-700/70 hover:bg-lime-600/10">
                  Transfer More Tokens Into Vault
                </button>
              </div>
            </div>
            <div v-else-if="vaultingStatus === 'Underfunded'" class="rounded-md bg-red-100/70 px-4 py-4">
              <header class="flex flex-row items-center gap-x-2 text-lg font-bold whitespace-nowrap text-red-600">
                <StatusSad class="h-5 w-5" />
                <span>Your Vaulting Account Is Lacking Funds</span>
              </header>
              <p class="mt-px py-1 opacity-80">
                Your accounts needs
                {{
                  microgonToArgonNm(
                    config.vaultingRules.baseMicrogonCommitment - wallets.totalVaultingMicrogons,
                  ).formatIfElse('< 100', '0,0.[000000]', '0,0.[00]')
                }}
                argons in order to fully operate your vault efficiently.
              </p>
              <div class="mt-2 flex flex-row gap-x-2">
                <button
                  @click="openFundVaultingAccountOverlay"
                  class="cursor-pointer rounded-md border border-red-600 px-4 py-1.5 font-bold text-red-700/70 hover:bg-red-600/10">
                  Transfer Tokens Into Account
                </button>
              </div>
            </div>
            <div v-else-if="vaultingStatus === 'WaitingForFunding'" class="rounded-md bg-yellow-500/10 px-4 py-4">
              <header class="flex flex-row items-center gap-x-2 text-lg font-bold whitespace-nowrap text-yellow-600">
                <StatusNeutral class="h-5 w-5" />
                <span>Your Vaulting is Waiting for Funding</span>
              </header>
              <p class="mt-px py-1 opacity-80">
                Your accounts needs
                {{
                  microgonToArgonNm(
                    config.vaultingRules.baseMicrogonCommitment - wallets.totalVaultingMicrogons,
                  ).formatIfElse('< 100', '0,0.[000000]', '0,0.[00]')
                }}
                argons in order to complete your initial vault setup.
              </p>
              <div class="mt-2 flex flex-row gap-x-2">
                <button
                  @click="openFundVaultingAccountOverlay"
                  class="cursor-pointer rounded-md border border-yellow-600 px-4 py-1.5 font-bold text-yellow-700/70 hover:bg-yellow-600/10">
                  Transfer Tokens Into Account
                </button>
              </div>
            </div>
            <div v-else-if="vaultingStatus === 'Overfunded'" class="rounded-md bg-yellow-500/10 px-4 py-4">
              <header class="flex flex-row items-center gap-x-2 text-lg font-bold whitespace-nowrap text-yellow-600">
                <StatusNeutral class="h-5 w-5" />
                <span>Your Vaulting Account Has Excess Funds</span>
              </header>
              <p class="mt-px py-1 opacity-80">
                Your account has an extra
                {{
                  microgonToArgonNm(
                    wallets.vaultingWallet.availableMicrogons - config.vaultingRules.baseMicrogonCommitment,
                  ).formatIfElse('< 100', '0,0.[000000]', '0,0.[00]')
                }}
                argon{{
                  microgonToArgonNm(
                    wallets.vaultingWallet.availableMicrogons - config.vaultingRules.baseMicrogonCommitment,
                  ).formatIfElse('< 100', '0,0.[000000]', '0,0.[00]') === '1'
                    ? ''
                    : 's'
                }}
                sitting unused. This isn't causing harm, but they're also not generating yield.
              </p>
              <div class="mt-2 flex flex-row gap-x-2">
                <button
                  class="cursor-pointer rounded-md border border-yellow-600 px-4 py-1.5 font-bold text-yellow-700/70 hover:bg-yellow-600/10">
                  Add to Vault's Working Capital
                </button>
              </div>
            </div>
          </template>
        </div>
        <HoverCardArrow :width="18" :height="10" class="mt-[0px] fill-white stroke-gray-300" />
      </HoverCardContent>
    </HoverCardPortal>
  </HoverCardRoot>
</template>

<script setup lang="ts">
import * as Vue from 'vue';
import {
  HoverCardArrow,
  HoverCardContent,
  HoverCardPortal,
  HoverCardRoot,
  HoverCardTrigger,
  PointerDownOutsideEvent,
} from 'reka-ui';
import { useWallets } from '../stores/wallets';
import { useConfig } from '../stores/config';
import { useCurrency } from '../stores/currency';
import StatusSad from '../assets/status-sad.svg';
import StatusNeutral from '../assets/status-neutral.svg';
import StatusHappy from '../assets/status-happy.svg';
import StatusSmiling from '../assets/status-smiling.svg';
import CheckboxIcon from '../assets/checkbox.svg';
import { Motion } from 'motion-v';
import basicEmitter from '../emitters/basicEmitter';
import { createNumeralHelpers } from '../lib/numeral';
import { useInstaller } from '../stores/installer';
import { useMyVault } from '../stores/vaults';
import { getBiddingCalculator } from '../stores/mainchain.ts';
import { bigIntMax } from '@argonprotocol/apps-core';

enum Status {
  WaitingForSetup = 'WaitingForSetup',
  WaitingForFunding = 'WaitingForFunding',
  Underfunded = 'Underfunded',
  Overfunded = 'Overfunded',
  Funded = 'Funded',
  FullyFunded = 'FullyFunded',
}
const statusOrder: Status[] = [
  Status.WaitingForSetup,
  Status.WaitingForFunding,
  Status.Funded,
  Status.Underfunded,
  Status.Overfunded,
];

const config = useConfig();
const wallets = useWallets();
const currency = useCurrency();
const installer = useInstaller();
const myVault = useMyVault();
const calculator = getBiddingCalculator();

const { microgonToArgonNm, micronotToArgonotNm } = createNumeralHelpers(currency);

const isOpen = Vue.ref(false);

const eyeballsElem = Vue.ref<HTMLElement | null>(null);

const requiredMicrogonsForGoal = Vue.ref(0n);
const requiredMicronotsForGoal = Vue.ref(0n);
const miningMicronotsNeeded = Vue.computed(() => {
  return bigIntMax(requiredMicronotsForGoal.value - wallets.totalMiningMicronots, 0n);
});

const miningMicrogonsNeeded = Vue.computed(() => {
  return bigIntMax(requiredMicrogonsForGoal.value - wallets.totalMiningMicrogons, 0n);
});

const hasVault = Vue.computed(() => {
  return myVault.data.createdVault;
});

const miningStatus = Vue.computed<Status>(() => {
  if (!config.hasSavedBiddingRules || !config.isMinerInstalled) {
    return Status.WaitingForSetup;
  } else if (!config.isMinerReadyToInstall && wallets.miningWallet.availableMicrogons === 0n) {
    return Status.WaitingForFunding;
  } else if (miningMicrogonsNeeded.value > 0n || miningMicrogonsNeeded.value > 0n) {
    return Status.Underfunded;
  }
  return Status.Funded;
});

const vaultingStatus = Vue.computed<Status>(() => {
  if (!config.hasSavedVaultingRules) {
    return Status.WaitingForSetup;
  } else if (!config.isVaultReadyToCreate && wallets.vaultingWallet.availableMicrogons === 0n) {
    return Status.WaitingForFunding;
  }

  return Status.Funded;
});

const status = Vue.computed<Status>(() => {
  if (miningStatus.value === Status.Funded && vaultingStatus.value === Status.Funded) {
    return Status.FullyFunded;
  }

  const indexOfMiningStatus = statusOrder.indexOf(miningStatus.value);
  const indexOfVaultingStatus = statusOrder.indexOf(vaultingStatus.value);
  const indexOfStatus = Math.max(indexOfMiningStatus, indexOfVaultingStatus);

  return statusOrder[indexOfStatus];
});

function openFundMiningAccountOverlay() {
  isOpen.value = false;
  basicEmitter.emit('openWalletOverlay', { walletId: 'mining', screen: 'receive' });
}

function openFundVaultingAccountOverlay() {
  isOpen.value = false;
  basicEmitter.emit('openWalletOverlay', { walletId: 'vaulting', screen: 'receive' });
}

function openBotCreateOverlay() {
  isOpen.value = false;
  basicEmitter.emit('openBotEditOverlay');
}

const eyeballXPosition = Vue.ref(50);
const eyeballYPosition = Vue.ref(50);

// Mouse tracking functions
const handleMouseMove = (event: MouseEvent) => {
  if (!eyeballsElem.value) return;

  const eyeballsRect = eyeballsElem.value.getBoundingClientRect();
  const eyeballsCenterX = eyeballsRect.left + eyeballsRect.width / 2;
  const eyeballsCenterY = eyeballsRect.top + eyeballsRect.height / 2;

  const cursorX = event.clientX;
  const cursorY = event.clientY;

  // Calculate viewport dimensions
  const viewportWidth = window.innerWidth;
  const viewportHeight = window.innerHeight;

  // Calculate distances from eyeballs center
  const distanceFromCenterX = cursorX - eyeballsCenterX;
  const distanceFromCenterY = cursorY - eyeballsCenterY;

  // Calculate max distances - X uses shorter distance for consistent sensitivity, Y uses direction-based
  const maxDistanceX = Math.min(eyeballsCenterX, viewportWidth - eyeballsCenterX);
  const maxDistanceY = distanceFromCenterY < 0 ? eyeballsCenterY : viewportHeight - eyeballsCenterY;

  // Map to eyeball positions relative to eyeballs center (50 = center)
  const xPercent = 50 + (distanceFromCenterX / maxDistanceX) * 50;
  const yPercent = 50 + (distanceFromCenterY / maxDistanceY) * 50;
  eyeballXPosition.value = Math.max(0, Math.min(100, xPercent));
  eyeballYPosition.value = Math.max(0, Math.min(100, yPercent));
};

function clickOutside(e: PointerDownOutsideEvent) {
  const isChildOfTrigger = !!(e.target as HTMLElement)?.closest('[Trigger]');
  if (!isChildOfTrigger) return;

  isOpen.value = true;
  setTimeout(() => {
    isOpen.value = true;
  }, 200);
  e.detail.originalEvent.stopPropagation();
  e.detail.originalEvent.preventDefault();
  e.stopPropagation();
  e.preventDefault();
  return false;
}

let loadSubscription: { unsubscribe: () => void };

Vue.onMounted(async () => {
  document.addEventListener('mousemove', handleMouseMove);
  await config.isLoadedPromise;

  loadSubscription = calculator.onLoad(() => {
    const projections = calculator.runProjections(config.biddingRules, 'maximum');
    requiredMicrogonsForGoal.value = projections.microgonRequirement;
    requiredMicronotsForGoal.value = projections.micronotRequirement;
  });
  void calculator.load();
});

Vue.onUnmounted(() => {
  loadSubscription.unsubscribe();
  document.removeEventListener('mousemove', handleMouseMove);
});
</script>

<style scoped>
@reference "../main.css";

th {
  @apply border-b border-dashed border-gray-300/80 py-2 text-gray-400;
}

td {
  @apply border-b border-dashed border-gray-300/80 py-2;
}
</style>
