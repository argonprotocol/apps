<!-- prettier-ignore -->
<template>
  <div class="flex flex-col h-full w-full relative">
    <div @click="goBack" class="absolute flex flex-row gap-x-2 z-10 top-3 pb-3 pr-10 left-5 items-center text-slate-400/50 hover:text-slate-600 cursor-pointer">
      <ArrowLeftIcon class="size-4 " />
      <div>
        {{controller.backButtonTriggersHome ? 'Back to Home' : 'Back to Beginning'}}
      </div>
      <div class="absolute bottom-0 left-0 w-[200%] h-px bg-gradient-to-r from-slate-400/30 from-0% via-slate-400/30 via-50% to-transparent to-100%"></div>
    </div>
    <div class="relative px-[15%] pt-2 pb-12 grow max-h-220">
      <div class="flex flex-col grow h-full">

        <h1 class="text-4xl font-bold text-left mt-24 whitespace-nowrap text-argon-text-primary">
          Start Vaulting In Three Steps
        </h1>

        <p class="text-argon-text-primary leading-7 mt-6 mb-8">
          Creating a new Stabilization Vault is easy. This page walks you through the entire process. The biggest
          task is figuring out how much capital you want to commit, which you'll do in Vault Settings (the second item on
          this checklist). <a target="_blank" href="https://argon.network/docs/vaulting-operations">Learn more about
          vaulting</a>.
        </p>

        <div class="h-px w-full bg-[#CCCEDA]" />

        <section
          @click="openServerConnectPanel"
          class="flex flex-row cursor-pointer py-5 grow items-center"
        >
          <div class="flex flex-row">
            <Checkbox :isChecked="serverConnectIsChecked" />
            <div class="px-4">
              <h2 class="text-2xl text-[#A600D4] font-bold relative inline-block">
                Connect a Cloud Machine
                <span v-if="config.isServerAdded && !config.isServerInstalled" class="installing-badge relative -top-0.5 text-base rounded bg-argon-600/80 px-2 py-0.5 text-white">INSTALLING</span>
                <ArrowCalloutButton
                  v-else-if="currentStep === 'ServerConnect'"
                  guidance="A cloud machine is required for your vault."
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
          @click="openVaultCreateOverlay"
          ref="VaultCreateOverlayReferenceElement"
          class="flex flex-row cursor-pointer py-5 grow items-center hover:bg-argon-menu-hover"
        >
          <div class="flex flex-row">
            <Checkbox :isChecked="config.hasSavedVaultingRules" />
            <div class="px-4">
              <h2 class="text-2xl text-[#A600D4] font-bold relative inline-block">
                Confirm Your Vault Settings
                <ArrowCalloutButton
                  v-if="currentStep === 'VaultingRules'"
                  guidance="We've already setup recommended vault settings. All you need to do is confirm."
                  class="pointer-events-none absolute top-1/2 -right-3 -translate-y-1/2 translate-x-full z-50 -mt-0.5"
                />
              </h2>
              <p v-if="!config.hasSavedVaultingRules">
                Decide how much capital to commit, your distribution between securitization and treasury pools, and other basic settings.
              </p>
              <p v-else>
                You setup your vaulting rules and <VaultCapital align="start" :alignOffset="alignOffsetForCapital">
                  <span @mouseenter="alignOffsetForCapital = calculateAlignOffset($event, VaultCreateOverlayReferenceElement, 'start')" class="underline decoration-dashed underline-offset-4 decoration-slate-600/80 cursor-pointer">
                    committed
                    {{ currency.symbol }}{{ microgonToArgonNm(config.vaultingRules?.baseMicrogonCommitment || 0n).format('0,0.[00]') }} in capital
                  </span>
              </VaultCapital>
                with an
                <VaultReturns align="end" :alignOffset="alignOffsetForReturns">
                  <span @mouseenter="alignOffsetForReturns = calculateAlignOffset($event, VaultCreateOverlayReferenceElement, 'end')" class="inline-block underline decoration-dashed underline-offset-4 decoration-slate-600/80 cursor-pointer">
                    average expected return of {{ numeral(averageAPY).formatIfElseCapped('>=100', '0,0', '0,0.00', 999_999)
                    }}%
                  </span>
                </VaultReturns>
                (APY).
              </p>
            </div>
          </div>
        </section>

        <div class="h-px w-full bg-[#CCCEDA]" />

        <section
          @click="openFundVaultingAccountOverlay"
          class="flex flex-row cursor-pointer py-5 grow items-center"
        >
          <div class="flex flex-row">
            <Checkbox :isChecked="walletIsFullyFunded" />
            <div class="px-4">
              <h2 class="text-2xl text-[#A600D4] font-bold relative inline-block">
                {{ walletIsPartiallyFunded ? 'Finish' : '' }} Fund{{ walletIsPartiallyFunded ? 'ing' : '' }}
                Your Wallet
                <ArrowCalloutButton
                  v-if="currentStep === 'FundWallet' && !controller.overlayIsOpen"
                  guidance="You must fund your vault before proceeding."
                  class="pointer-events-none absolute top-1/2 -right-3 -translate-y-1/2 translate-x-full z-50 -mt-0.5"
                />
              </h2>
              <p>
                Your account needs a minimum of
                {{ microgonToArgonNm(config.vaultingRules?.baseMicrogonCommitment || 0n).format('0,0.[00000000]') }} argon{{
                  microgonToArgonNm(config.vaultingRules?.baseMicrogonCommitment || 0n).format('0') === '1' ? '' : 's'
                }}
                <template v-if="config.vaultingRules?.baseMicronotCommitment">
                  and
                  {{
                    micronotToArgonotNm(config.vaultingRules?.baseMicronotCommitment || 0n).format('0,0.[00000000]')
                  }}
                  argonot{{
                    micronotToArgonotNm(config.vaultingRules?.baseMicronotCommitment || 0n).format('0') === '1' ? '' : 's'
                  }}
                </template>
                to operate your vault. A secure wallet is already attached to your account. All you need to do is move
                some tokens.
              </p>
            </div>
          </div>
        </section>

        <div class="h-px w-full bg-[#CCCEDA]" />

        <button
          @click="startCreateVault"
          :class="[
          walletIsFullyFunded && serverConnectIsChecked && !controller.overlayIsOpen
            ? 'text-white'
            : 'text-white/70 pointer-events-none opacity-30'
        ]"
          class="bg-argon-button border border-argon-button-hover text-2xl font-bold px-4 py-4 mt-10 rounded-md w-full cursor-pointer hover:bg-argon-button-hover hover:inner-button-shadow"
        >
          <span class="relative">
            Launch Stabilization Vault
            <ArrowCalloutButton
              v-if="controller.activeGuideId === OperationalStepId.ActivateVault && currentStep === 'ClickButton'"
              guidance="You're almost done! Click this button to launch your vault."
              position="top"
              class="absolute top-1/2 -right-3 -translate-y-1/2 translate-x-full z-50"
            />
          </span>
        </button>
      </div>
    </div>
  </div>
  <VaultCreatePanel v-if="openCreateOverlay" @close="openCreateOverlay = false" />
</template>

<script setup lang="ts">
import * as Vue from 'vue';
import dayjs from 'dayjs';
import utc from 'dayjs/plugin/utc';
import basicEmitter from '../../emitters/basicEmitter';
import { getConfig } from '../../stores/config';
import { useWallets } from '../../stores/wallets';
import { getCurrency } from '../../stores/currency';
import Checkbox from '../../components/Checkbox.vue';
import numeral, { createNumeralHelpers } from '../../lib/numeral';
import { ArrowLeftIcon } from '@heroicons/vue/24/outline';
import { getVaultCalculator } from '../../stores/mainchain.ts';
import VaultCapital from '../../overlays-operations/vault/VaultCapital.vue';
import VaultReturns from '../../overlays-operations/vault/VaultReturns.vue';
import VaultCreatePanel from '../../panels/VaultCreatePanel.vue';
import { useOperationsController, OperationsTab, OperationalStepId } from '../../stores/operationsController.ts';
import { WalletType } from '../../lib/Wallet.ts';
import { VaultingSetupStatus } from '../../interfaces/IConfig.ts';
import ArrowCalloutButton from '../../components/ArrowCalloutButton.vue';

dayjs.extend(utc);

const config = getConfig();
const wallets = useWallets();
const currency = getCurrency();
const controller = useOperationsController();
const calculator = getVaultCalculator();

const averageAPY = Vue.ref(0);

const { microgonToArgonNm, micronotToArgonotNm } = createNumeralHelpers(currency);
const VaultCreateOverlayReferenceElement = Vue.ref<HTMLElement | null>(null);
const alignOffsetForReturns = Vue.ref(0);
const alignOffsetForCapital = Vue.ref(0);

const serverConnectIsChecked = Vue.computed(() => {
  return wallets.isLoaded && hasMiningMachine.value;
});

const currentStep = Vue.computed(() => {
  if (controller.activeGuideId !== OperationalStepId.ActivateVault) {
    return null;
  } else if (!serverConnectIsChecked.value) {
    return 'ServerConnect';
  } else if (!config.hasSavedVaultingRules) {
    return 'VaultingRules';
  } else if (!walletIsFullyFunded.value) {
    return 'FundWallet';
  } else {
    return 'ClickButton';
  }
});

const walletIsPartiallyFunded = Vue.computed(() => {
  return (wallets.vaultingWallet.availableMicrogons || wallets.vaultingWallet.availableMicronots) > 0;
});

const walletIsFullyFunded = Vue.computed(() => {
  if (!walletIsPartiallyFunded.value) {
    return false;
  }

  if (wallets.vaultingWallet.availableMicrogons < (config.vaultingRules?.baseMicrogonCommitment || 0n)) {
    return false;
  }

  if (wallets.vaultingWallet.availableMicronots < (config.vaultingRules?.baseMicronotCommitment || 0n)) {
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

  const elementRightEdge = elementRect.left + (align === 'start' ? 0 : elementRect.width);
  const parentRightEdge = parentRect.left + (align === 'start' ? 0 : parentRect.width);
  const offset = elementRightEdge - parentRightEdge;

  return align === 'start' ? -offset : offset;
}

function updateApy() {
  const lowApy = calculator.calculateInternalAPY('Low', 'Low');
  const highApy = calculator.calculateInternalAPY('High', 'High');
  averageAPY.value = (lowApy + highApy) / 2;
}

const openCreateOverlay = Vue.ref(false);
function openVaultCreateOverlay() {
  openCreateOverlay.value = true;
}

function openFundVaultingAccountOverlay() {
  basicEmitter.emit('openWalletOverlay', { walletType: WalletType.vaulting, screen: 'receive' });
}

async function startCreateVault() {
  config.vaultingSetupStatus = VaultingSetupStatus.Installing;
  await config.save();
}

function openServerConnectPanel() {
  if (config.isServerAdded) {
    basicEmitter.emit('openServerOverlay');
  } else {
    basicEmitter.emit('openServerConnectPanel');
  }
}

function goBack() {
  config.vaultingSetupStatus = VaultingSetupStatus.None;
  if (controller.backButtonTriggersHome) {
    controller.setScreenKey(OperationsTab.Home);
  }
}

Vue.watch(
  config.vaultingRules,
  () => {
    updateApy();
  },
  { deep: true },
);

Vue.onMounted(async () => {
  calculator.load(config.vaultingRules).then(() => updateApy());
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
