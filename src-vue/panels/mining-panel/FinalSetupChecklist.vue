<!-- prettier-ignore -->
<template>
  <div class="flex flex-col h-full w-full relative">
    <div v-if="!config.miningAccountPreviousHistory" @click="goBack" class="absolute flex flex-row gap-x-2 z-10 top-3 pb-3 pr-10 left-5 items-center text-slate-400/50 hover:text-slate-600 cursor-pointer">
      <ArrowLeftIcon class="size-4 " />
      <div>
        Back to Start
      </div>
      <div class="absolute bottom-0 left-0 w-[200%] h-px bg-gradient-to-r from-slate-400/30 from-0% via-slate-400/30 via-50% to-transparent to-100%"></div>
    </div>
    <div class="relative px-[15%] pt-2 pb-10">
      <div :class="[isLaunchingMiningBot || !wallets.isLoaded ? 'opacity-30 pointer-events-none' : '']">

        <h1 class="text-4xl font-bold text-left mt-24 mb-4 whitespace-nowrap text-argon-text-primary">
          Four Steps Are Required to Begin Mining
        </h1>

        <p class="mb-4 text-argon-text-primary leading-7">
          Setting up your mining operation only takes a few minutes. This page walks you through the entire process. We recommend
          completing each item in the order they're listed, but you're free to do as you please.
        </p>

        <section
          @click="openHowMiningWorksOverlay"
          class="flex flex-row cursor-pointer mt-8 border-t border-[#CCCEDA] py-6 hover:bg-argon-menu-hover"
        >
          <Checkbox :isChecked="config.hasReadMiningInstructions" />
          <div class="px-4">
            <h2 class="text-2xl text-[#A600D4] font-bold">Learn How Mining Works</h2>
            <p v-if="!config.hasReadMiningInstructions">
              Read an overview of what mining is, how it works, and the core concepts you'll need to understand.
            </p>
            <p v-else>
              You skimmed the basics of what mining is, how it works, and the core concepts you'll need to understand.
            </p>
          </div>
        </section>

        <section
          @click="openBotCreateOverlay"
          class="flex flex-row cursor-pointer border-t border-[#CCCEDA] py-6 hover:bg-argon-menu-hover"
          ref="botCreateOverlayReferenceElement"
        >
          <Checkbox :isChecked="wallets.isLoaded && config.hasSavedBiddingRules" />
          <div class="px-4">
            <h2 class="text-2xl text-[#A600D4] font-bold">Configure Your Mining Bot</h2>
            <p v-if="!config.hasSavedBiddingRules">
              Decide how much capital you want to commit, your starting bid, maximum bid, and other basic settings.
            </p>
            <p v-else>
              Your bidding rules expect a 
              <BotCapital align="start" :alignOffset="alignOffsetForBotCapital">
                <span @mouseenter="alignOffsetForBotCapital = calculateAlignOffset($event, botCreateOverlayReferenceElement, 'start')" class="underline decoration-dashed underline-offset-4 decoration-slate-600/80 cursor-pointer">
                  capital commitment of
                  {{ currency.symbol }}{{ microgonToArgonNm(capitalCommitment || 0n).formatIfElse('< 100_000_000', '0,0.00', '0,0.[00]') }} 
                </span>
              </BotCapital>
              with an
              <BotReturns align="end" :alignOffset="alignOffsetForBotReturns">
                <span @mouseenter="alignOffsetForBotReturns = calculateAlignOffset($event, botCreateOverlayReferenceElement, 'end')" class="inline-block underline decoration-dashed underline-offset-4 decoration-slate-600/80 cursor-pointer">
                  average expected return of {{ numeral(averageAPY).formatIfElseCapped('>=100', '0,0', '0,0.00', 999_999) }}%
                </span>
              </BotReturns>
              (APY).
            </p>
          </div>
        </section>

        <section
          @click="openFundMiningAccountOverlay"
          class="flex flex-row cursor-pointer border-t border-b border-[#CCCEDA] py-6"
        >
          <Checkbox :isChecked="walletIsFullyFunded" />
          <div class="px-4">
            <h2 class="text-2xl text-[#A600D4] font-bold">
              {{ walletIsPartiallyFunded ? 'Finish' : '' }} Fund{{ walletIsPartiallyFunded ? 'ing' : '' }}
              Your Wallet
            </h2>
            <p v-if="walletIsFullyFunded">
              Your account has been fully funded with enough argons and argonots to begin bidding.
            </p>
            <p v-else-if="walletIsPartiallyFunded">
              Your account already has
              <template v-if="wallets.totalMiningMicrogons">
                {{ microgonToArgonNm(wallets.totalMiningMicrogons).format('0,0.[00000000]') }} argon{{
                  microgonToArgonNm(wallets.totalMiningMicrogons).format('0.00000000') === '1.00000000' ? '' : 's'
                }}
              </template>
              <template v-if="wallets.totalMiningMicrogons && wallets.miningWallet.availableMicronots">
                and
              </template>
              <template v-if="wallets.miningWallet.availableMicronots">
                {{ micronotToArgonotNm(wallets.miningWallet.availableMicronots || 0n).format('0,0.[00000000]') }} argonot{{
                  micronotToArgonotNm(wallets.miningWallet.availableMicronots || 0n).format('0.00000000') === '1.00000000' ? '' : 's'
                }}
              </template>.

              However you <strong class="opacity-80">still need</strong> another

              <template v-if="additionalMicrogonsNeeded">
                {{ microgonToArgonNm(additionalMicrogonsNeeded).format('0,0.[00000000]') }} argon{{
                  microgonToArgonNm(additionalMicrogonsNeeded).format('0.00000000') === '1.00000000' ? '' : 's'
                }}
              </template>
              <template v-if="additionalMicrogonsNeeded && additionalMicronotsNeeded">
                and
              </template>
              <template v-if="additionalMicronotsNeeded">
                {{ micronotToArgonotNm(additionalMicronotsNeeded).format('0,0.[00000000]') }} argonot{{
                  micronotToArgonotNm(additionalMicronotsNeeded).format('0.00000000') === '1.00000000' ? '' : 's'
                }}
              </template>.
              Complete this step by moving the missing tokens to your account.
            </p>
            <p v-else-if="config.hasSavedBiddingRules">
              Your account needs a minimum of
              {{ microgonToArgonNm(config.biddingRules?.initialMicrogonRequirement || 0n).format('0,0.[00000000]') }} argon{{
                microgonToArgonNm(config.biddingRules?.initialMicrogonRequirement || 0n).format('0.00000000') === '1.00000000' ? '' : 's'
              }}
              and
              {{
                micronotToArgonotNm(config.biddingRules?.initialMicronotRequirement || 0n).format('0,0.[00000000]')
              }}
              argonot{{
                  micronotToArgonotNm(config.biddingRules?.initialMicronotRequirement || 0n).format('0.00000000') === '1.00000000' ? '' : 's'
                }}
                to submit auction bids.
              </p>
              <p v-else>
                Your account needs both argons and argonots in order to submit auction bids and start mining.
              </p>
            </div>
          </section>

        <section
          @click="openServerConnectOverlay"
          class="flex flex-row cursor-pointer border-b border-[#CCCEDA] py-6"
        >
          <Checkbox :isChecked="wallets.isLoaded && hasMiningMachine" />
          <div class="px-4">
            <h2 class="text-2xl text-[#A600D4] font-bold">Connect a Mining Machine</h2>
            <p v-if="hasMiningMachine">
              <template v-if="config.serverCreation?.localComputer">This local computer will be used to run your mining software. We've already checked its requirements.</template>
              <template v-else-if="config.serverCreation?.digitalOcean">Your Digital Ocean API Key is ready to go. We will do all the work of creating and setting up your server.</template>
              <template v-else>Your custom server is connected and verified. We'll do the work of installing and configuring the software.</template>
            </p>
            <p v-else>
              Argon's mining software is runnable on cheap virtual cloud machines. We'll show you how to add one.
            </p>
          </div>
        </section>
      </div>

      <button
        @click="launchMiningBot"
        :class="[
          walletIsFullyFunded && hasMiningMachine && !controller.walletOverlayIsOpen
            ? 'text-white'
            : 'text-white/70 pointer-events-none opacity-30',
          isLaunchingMiningBot ? 'opacity-30 pointer-events-none' : '',
        ]"
        class="bg-argon-button border border-argon-button-hover mt-8 text-2xl font-bold px-4 py-4 rounded-md w-full cursor-pointer hover:bg-argon-button-hover hover:inner-button-shadow"
      >
        {{ isLaunchingMiningBot ? 'Launching Mining Bot...' : 'Launch Mining Bot' }}
      </button>
    </div>
  </div>
  <BotCreateOverlay @close="openBotCreate = false" v-if="openBotCreate" />
</template>

<script setup lang="ts">
import * as Vue from 'vue';
import dayjs from 'dayjs';
import utc from 'dayjs/plugin/utc';
import basicEmitter from '../../emitters/basicEmitter';
import { useConfig } from '../../stores/config';
import { useWallets } from '../../stores/wallets';
import { useCurrency } from '../../stores/currency';
import Checkbox from '../../components/Checkbox.vue';
import { useInstaller } from '../../stores/installer';
import numeral, { createNumeralHelpers } from '../../lib/numeral';
import { bigIntMax } from '@argonprotocol/apps-core/src/utils';
import { ArrowLeftIcon } from '@heroicons/vue/24/outline';
import { getBiddingCalculator, getBiddingCalculatorData } from '../../stores/mainchain';
import BotReturns from '../../overlays/bot/BotReturns.vue';
import BotCapital from '../../overlays/bot/BotCapital.vue';
import BotCreateOverlay from '../../overlays/BotCreateOverlay.vue';
import { useController } from '../../stores/controller';

dayjs.extend(utc);

const config = useConfig();
const installer = useInstaller();
const wallets = useWallets();
const currency = useCurrency();
const controller = useController();
const calculator = getBiddingCalculator();
const calculatorData = getBiddingCalculatorData();
const openBotCreate = Vue.ref(false);

const { microgonToArgonNm, micronotToArgonotNm } = createNumeralHelpers(currency);

const botCreateOverlayReferenceElement = Vue.ref<HTMLElement | null>(null);
const alignOffsetForBotReturns = Vue.ref(0);
const alignOffsetForBotCapital = Vue.ref(0);

const capitalCommitment = Vue.ref(0n);

const isLaunchingMiningBot = Vue.ref(false);
const averageAPY = Vue.ref(0);

const walletIsPartiallyFunded = Vue.computed(() => {
  if (!config.hasSavedBiddingRules) {
    return false;
  }

  return (wallets.totalMiningMicrogons || wallets.miningWallet.availableMicronots) > 0n;
});

const additionalMicrogonsNeeded = Vue.computed(() => {
  return bigIntMax(config.biddingRules.initialMicrogonRequirement - wallets.totalMiningMicrogons, 0n);
});

const additionalMicronotsNeeded = Vue.computed(() => {
  return bigIntMax(
    config.biddingRules.initialMicronotRequirement -
      wallets.miningWallet.availableMicronots -
      wallets.miningWallet.reservedMicronots,
    0n,
  );
});

const walletIsFullyFunded = Vue.computed(() => {
  if (!config.hasSavedBiddingRules) {
    return false;
  }

  if (additionalMicrogonsNeeded.value > 0n) {
    return false;
  }

  if (additionalMicronotsNeeded.value > 0n) {
    return false;
  }

  return true;
});

const hasMiningMachine = Vue.computed(() => {
  const x = config.serverCreation;
  return !!x?.customServer || !!x?.localComputer || !!x?.digitalOcean;
});

function calculateAlignOffset(event: MouseEvent, parentElement: HTMLElement | null, align: 'start' | 'end') {
  const element = event.target as HTMLElement;
  if (!element || !parentElement) {
    return 0;
  }

  const elementRect = element.getBoundingClientRect();
  const parentRect = parentElement.getBoundingClientRect();

  // Calculate the difference between the right edge of element and the right edge of botCreateOverlayReferenceElement
  const elementRightEdge = elementRect.left + (align === 'start' ? 0 : elementRect.width);
  const parentRightEdge = parentRect.left + (align === 'start' ? 0 : parentRect.width);
  const offset = elementRightEdge - parentRightEdge;

  return align === 'start' ? -offset : offset;
}

function openBotCreateOverlay() {
  openBotCreate.value = true;
}

function openFundMiningAccountOverlay() {
  basicEmitter.emit('openWalletOverlay', { walletId: 'mining', screen: 'receive' });
}

function openServerConnectOverlay() {
  basicEmitter.emit('openServerConnectOverlay');
}

function openHowMiningWorksOverlay() {
  basicEmitter.emit('openHowMiningWorksOverlay');
}

function goBack() {
  config.isPreparingMinerSetup = false;
}

async function launchMiningBot() {
  if (isLaunchingMiningBot.value) {
    return;
  }
  isLaunchingMiningBot.value = true;
  config.isMinerReadyToInstall = true;
  // in case the entry was skipped
  config.isPreparingMinerSetup = true;
  const biddingRules = config.biddingRules;
  if (wallets.miningWallet.availableMicrogons > biddingRules.initialMicrogonRequirement) {
    biddingRules.initialMicrogonRequirement = wallets.miningWallet.availableMicrogons;
  }
  if (wallets.miningWallet.availableMicronots > biddingRules.initialMicronotRequirement) {
    biddingRules.initialMicronotRequirement = wallets.miningWallet.availableMicronots;
  }
  const micronotsAsMicrogons = currency.micronotToMicrogon(wallets.miningWallet.availableMicronots);
  const capitalCommitment = wallets.miningWallet.availableMicrogons + micronotsAsMicrogons;
  biddingRules.initialCapitalCommitment = capitalCommitment;

  config.biddingRules = biddingRules;
  await config.save();
  await installer.run();
  isLaunchingMiningBot.value = false;
}

async function updateAPYs() {
  calculator.updateBiddingRules(config.biddingRules);
  calculator.calculateBidAmounts();
  averageAPY.value = calculator.averageAPY;

  const projections = calculator.runProjections(config.biddingRules, 'maximum');
  capitalCommitment.value = config.biddingRules.initialCapitalCommitment || projections.capitalCommitment;
}

Vue.watch(config.biddingRules, () => updateAPYs(), { deep: true });

Vue.onMounted(async () => {
  await calculatorData.load();
  await updateAPYs();
});
</script>

<style scoped>
@reference "../../main.css";

section:hover {
  background: linear-gradient(to right, transparent 0%, #f7edf8 10%, #f7edf8 90%, transparent 100%);
}

section p {
  @apply mt-1 ml-0.5 opacity-60;
}
</style>
