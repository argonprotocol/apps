<!-- prettier-ignore -->
<template>
  <div class="flex flex-col h-full w-full relative">
    <div v-if="!config.miningBotAccountPreviousHistory" @click="goBack" class="absolute flex flex-row gap-x-2 z-10 top-3 pb-3 pr-10 left-5 items-center text-slate-400/50 hover:text-slate-600 cursor-pointer">
      <ArrowLeftIcon class="size-4 " />
      <div>
        {{controller.backButtonTriggersHome ? 'Back to Home' : 'Back to Beginning'}}
      </div>
      <div class="absolute bottom-0 left-0 w-[200%] h-px bg-gradient-to-r from-slate-400/30 from-0% via-slate-400/30 via-50% to-transparent to-100%"></div>
    </div>
    <div class="relative px-[15%] pt-2 pb-12 grow max-h-220">
      <div class="flex flex-col grow h-full" :class="[isLaunchingMiningBot || !wallets.isLoaded ? 'opacity-30 pointer-events-none' : '']">

        <h1 class="text-4xl font-bold text-left mt-24 whitespace-nowrap text-argon-text-primary">
          Start Mining In Three Steps
        </h1>

        <p class="text-argon-text-primary leading-7 mt-6 mb-8">
          Setting up your mining operation only takes a few minutes. This page walks you through the entire process. We recommend
          completing each item in the order they're listed, but you're free to do as you please.
          <a target="_blank" href="https://argon.network/docs/mining-operations">Learn more about mining</a>.
        </p>

        <div class="h-px w-full bg-[#CCCEDA]" />

        <section
          @click="openServerConnectPanel"
          class="flex flex-row cursor-pointer py-5 grow items-center"
        >
          <div class="flex flex-row">
            <Checkbox :isChecked="wallets.isLoaded && hasMiningMachine" />
            <div class="px-4">
              <h2 class="text-2xl text-argon-600 font-bold">
                Connect a Cloud Machine
                <span v-if="config.isServerAdded && !config.isServerInstalled" class="installing-badge relative -top-0.5 text-base rounded bg-argon-600/80 px-2 py-0.5 text-white">INSTALLING</span>
                <ArrowCalloutButton
                  v-else-if="currentStep === 'ServerConnect'"
                  guidance="A cloud machine is required for your mining bot."
                  class="pointer-events-none absolute top-1/2 -right-3 -translate-y-1/2 translate-x-full z-50 -mt-0.5"
                />
              </h2>
              <p v-if="hasMiningMachine">
                <template v-if="config.serverAdd?.localComputer">This local computer will be used to run your mining software. We've already checked its requirements.</template>
                <template v-else-if="config.serverAdd?.digitalOcean">Your Digital Ocean API Key is ready to go. We will do all the work of creating and setting up your server.</template>
                <template v-else>Your custom server is connected and verified. We'll do the work of installing and configuring the software.</template>
              </p>
              <p v-else>
                Argon's mining software is runnable on cheap virtual cloud machines. We'll show you how to add one.
              </p>
            </div>
          </div>
        </section>

        <div class="h-px w-full bg-[#CCCEDA]" />

        <section
          @click="openBotCreateOverlay"
          class="flex flex-row cursor-pointer py-5 grow items-center hover:bg-argon-menu-hover"
          ref="botCreateOverlayReferenceElement"
        >
          <div class="flex flex-row">
            <Checkbox :isChecked="wallets.isLoaded && config.hasSavedBiddingRules" />
            <div class="px-4">
              <h2 class="text-2xl text-argon-600 font-bold relative inline-block">
                Confirm Your Bidding Rules
                <ArrowCalloutButton
                  v-if="currentStep === 'BiddingRules'"
                  guidance="We've already setup recommended bidding rules. All you need to do is confirm."
                  class="pointer-events-none absolute top-1/2 -right-3 -translate-y-1/2 translate-x-full z-50 -mt-0.5"
                />
              </h2>
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
          </div>
        </section>

        <div class="h-px w-full bg-[#CCCEDA]" />

        <section
          @click="openFundMiningAccountOverlay"
          class="flex flex-row cursor-pointer py-5 grow items-center"
        >
          <div class="flex flex-row">
            <Checkbox :isChecked="walletIsFullyFunded" />
            <div class="px-4">
              <h2 class="text-2xl text-argon-600 font-bold relative inline-block">
                {{ walletIsPartiallyFunded ? 'Finish' : '' }} Fund{{ walletIsPartiallyFunded ? 'ing' : '' }}
                Your Wallet
                <ArrowCalloutButton
                  v-if="currentStep === 'FundWallet' && !controller.overlayIsOpen"
                  guidance="You must fund your bidding bot before proceeding."
                  class="pointer-events-none absolute top-1/2 -right-3 -translate-y-1/2 translate-x-full z-50 -mt-0.5"
                />
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
                <template v-if="wallets.totalMiningMicrogons && wallets.miningBotWallet.availableMicronots">
                  and
                </template>
                <template v-if="wallets.miningBotWallet.availableMicronots">
                  {{ micronotToArgonotNm(wallets.miningBotWallet.availableMicronots || 0n).format('0,0.[00000000]') }} argonot{{
                    micronotToArgonotNm(wallets.miningBotWallet.availableMicronots || 0n).format('0.00000000') === '1.00000000' ? '' : 's'
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
          </div>
        </section>

        <div class="h-px w-full bg-[#CCCEDA]" />

        <button
          @click="launchMiningBot"
          :class="[
          walletIsFullyFunded && hasMiningMachine && !controller.overlayIsOpen
            ? 'text-white'
            : 'text-white/70 pointer-events-none opacity-30',
          isLaunchingMiningBot ? 'opacity-30 pointer-events-none' : '',
        ]"
          class="bg-argon-button border border-argon-button-hover text-2xl font-bold px-4 py-4 mt-10 rounded-md w-full cursor-pointer hover:bg-argon-button-hover hover:inner-button-shadow"
        >
          <template v-if="isLaunchingMiningBot">
            Launching Mining Bot...
          </template>
          <span v-else class="relative">
            Launch Mining Bot
            <ArrowCalloutButton
              v-if="currentStep === 'ClickButton'"
              guidance="You're almost done! Click this button to launch your vault."
              position="top"
              class="absolute top-1/2 -right-3 -translate-y-1/2 translate-x-full z-50"
            />
          </span>
        </button>
      </div>
    </div>
  </div>
  <BotCreatePanel @close="openBotCreate = false" v-if="openBotCreate" />
  <BotCreatePriceChangeOverlay v-if="!openBotCreate" />
</template>

<script setup lang="ts">
import * as Vue from 'vue';
import dayjs from 'dayjs';
import utc from 'dayjs/plugin/utc';
import basicEmitter from '../../emitters/basicEmitter';
import { Config, getConfig } from '../../stores/config';
import { getWalletKeys, useWallets } from '../../stores/wallets';
import { getCurrency } from '../../stores/currency';
import Checkbox from '../../components/Checkbox.vue';
import numeral, { createNumeralHelpers } from '../../lib/numeral';
import { bigIntMax } from '@argonprotocol/apps-core/src/utils';
import { ArrowLeftIcon } from '@heroicons/vue/24/outline';
import { getBiddingCalculator } from '../../stores/mainchain';
import BotReturns from '../../overlays-operations/bot/BotReturns.vue';
import BotCapital from '../../overlays-operations/bot/BotCapital.vue';
import BotCreatePanel from '../../panels/BotCreatePanel.vue';
import { OperationalStepId, OperationsTab, useOperationsController } from '../../stores/operationsController.ts';
import BotCreatePriceChangeOverlay from '../../overlays-operations/BotCreatePriceChangeOverlay.vue';
import { UnitOfMeasurement } from '../../lib/Currency.ts';
import { WalletType } from '../../lib/Wallet.ts';
import { MoveCapital } from '../../lib/MoveCapital.ts';
import { getMyVault } from '../../stores/vaults.ts';
import { getTransactionTracker } from '../../stores/transactions.ts';
import { MiningSetupStatus } from '../../interfaces/IConfig.ts';
import ArrowCalloutButton from '../../components/ArrowCalloutButton.vue';

dayjs.extend(utc);

const config = getConfig();
const wallets = useWallets();
const currency = getCurrency();
const controller = useOperationsController();
const calculator = getBiddingCalculator();
const walletKeys = getWalletKeys();
const transactionTracker = getTransactionTracker();

const { microgonToArgonNm, micronotToArgonotNm } = createNumeralHelpers(currency);

const openBotCreate = Vue.ref(false);
const botCreateOverlayReferenceElement = Vue.ref<HTMLElement | null>(null);
const alignOffsetForBotReturns = Vue.ref(0);
const alignOffsetForBotCapital = Vue.ref(0);

const capitalCommitment = Vue.ref(0n);

const isLaunchingMiningBot = Vue.ref(false);
const averageAPY = Vue.ref(0);

const serverConnectIsChecked = Vue.computed(() => {
  return wallets.isLoaded && hasMiningMachine.value;
});

const currentStep = Vue.computed(() => {
  if (controller.activeGuideId !== OperationalStepId.FirstMiningSeat) {
    return null;
  } else if (!serverConnectIsChecked.value) {
    return 'ServerConnect';
  } else if (!config.hasSavedBiddingRules) {
    return 'BiddingRules';
  } else if (!walletIsFullyFunded.value) {
    return 'FundWallet';
  } else {
    return 'ClickButton';
  }
});

const availableMicrogons = Vue.computed(() => {
  return wallets.miningHoldSpendableMicrogons + wallets.miningBotWallet.availableMicrogons;
});

const reservedMicronots = Vue.computed(() => {
  return wallets.miningHoldWallet.reservedMicronots + wallets.miningBotWallet.reservedMicronots;
});

const availableMicronots = Vue.computed(() => {
  return wallets.miningHoldWallet.availableMicronots + wallets.miningBotWallet.availableMicronots;
});

const walletIsPartiallyFunded = Vue.computed(() => {
  if (!config.hasSavedBiddingRules) {
    return false;
  }
  return (wallets.totalMiningMicrogons || availableMicronots.value) > 0n;
});

const additionalMicrogonsNeeded = Vue.computed(() => {
  return bigIntMax(config.biddingRules.initialMicrogonRequirement - wallets.totalMiningMicrogons, 0n);
});

const additionalMicronotsNeeded = Vue.computed(() => {
  return bigIntMax(
    config.biddingRules.initialMicronotRequirement - (availableMicronots.value + reservedMicronots.value),
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
  const x = config.serverAdd;
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
  basicEmitter.emit('openWalletOverlay', { walletType: WalletType.miningHold, screen: 'receive' });
}

function openServerConnectPanel() {
  if (config.isServerAdded) {
    basicEmitter.emit('openServerOverlay');
  } else {
    basicEmitter.emit('openServerConnectPanel');
  }
}

function goBack() {
  config.miningSetupStatus = MiningSetupStatus.None;
  if (controller.backButtonTriggersHome) {
    controller.setScreenKey(OperationsTab.Home);
  }
}

async function launchMiningBot() {
  if (isLaunchingMiningBot.value) return;

  isLaunchingMiningBot.value = true;

  const biddingRules = config.biddingRules;
  const micronotsAsMicrogons = currency.convertMicronotTo(availableMicronots.value, UnitOfMeasurement.Microgon);

  if (availableMicrogons.value > biddingRules.initialMicrogonRequirement) {
    biddingRules.initialMicrogonRequirement = availableMicrogons.value;
  }
  if (availableMicronots.value > biddingRules.initialMicronotRequirement) {
    biddingRules.initialMicronotRequirement = availableMicronots.value;
  }

  biddingRules.initialCapitalCommitment = availableMicrogons.value + micronotsAsMicrogons;

  const myVault = getMyVault();
  const moveCapital = new MoveCapital(walletKeys, transactionTracker, myVault);

  try {
    config.biddingRules = biddingRules;
    config.miningSetupStatus = MiningSetupStatus.Installing;
    await config.save();

    const miningHoldWallet = wallets.miningHoldWallet;
    const miningHoldSweepTxInfo = await moveCapital.moveAvailableMiningHoldToBot(
      miningHoldWallet,
      walletKeys,
      config as Config,
    );
    if (miningHoldSweepTxInfo) return;

    // If no sweep tx was queued, the bot still cannot move forward with setup.
    config.miningSetupStatus = MiningSetupStatus.Checklist;
    await config.save();
  } catch (error) {
    if (config.miningSetupStatus === MiningSetupStatus.Installing) {
      config.miningSetupStatus = MiningSetupStatus.Checklist;
      await config.save().catch(saveError => {
        console.error('[SetupChecklist] Failed to restore mining checklist after launch error', saveError);
      });
    }
    throw error;
  } finally {
    isLaunchingMiningBot.value = false;
  }
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
  await calculator.load();
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

.installing-badge {
  animation: installing-fade 1.2s ease-in-out infinite alternate;
}

@keyframes installing-fade {
  from {
    opacity: 0.3;
  }
  to {
    opacity: 1;
  }
}
</style>
