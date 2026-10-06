<!-- prettier-ignore -->
<template>
  <div DashBox class="flex flex-col h-full w-full relative">
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
          this checklist). <a target="_blank" :href="`${NetworkConfig.websiteHost}/docs/assets-and-entities/vaulting-operations`">Learn more about
          vaulting</a>.
        </p>

        <div class="h-px w-full bg-[#CCCEDA]" />

        <section
          @click="openServerConnectPanel"
          class="flex flex-row cursor-pointer py-5 grow items-center"
        >
          <div class="flex flex-row">
            <Checkbox :isChecked="serverConnectIsChecked" />
            <div class="px-4 text-slate-600">
              <h2 class="text-argon-600 relative inline-block text-2xl font-bold">
                Connect a Cloud Machine
                <span v-if="config.isServerAdded && !config.isServerInstalled" class="installing-badge relative -top-0.5 text-base rounded bg-argon-600/80 px-2 py-0.5 text-white">INSTALLING</span>
                <ArrowCalloutButton
                  v-else-if="currentStep === 'ServerConnect'"
                  guidance="A cloud machine is required to operate your vault."
                  class="pointer-events-none absolute top-1/2 -right-3 -translate-y-1/2 translate-x-full z-50 -mt-0.5"
                />
              </h2>
              <p v-if="config.isServerAdded">
                <template v-if="config.serverAdd?.localComputer">This local computer will run your vaulting and mining software. We've already checked its requirements.</template>
                <template v-else-if="config.serverAdd?.digitalOcean">Your DigitalOcean API key is ready. We'll create and set up your cloud machine for vaulting and mining.</template>
                <template v-else>Your custom server is connected and verified. We'll install and configure the vaulting and mining software.</template>
              </p>
              <p v-else>
                Argon's vaulting and mining software is runnable on cheap virtual cloud machines. We'll show you how to
                add one.
              </p>
            </div>
          </div>
        </section>

        <div class="h-px w-full bg-[#CCCEDA]" />

        <section
          @click="openVaultCreateOverlay"
          class="flex flex-row cursor-pointer py-5 grow items-center hover:bg-argon-menu-hover"
        >
          <div class="flex flex-row">
            <Checkbox :isChecked="config.hasSavedVaultingRules" />
            <div class="px-4 text-slate-600">
              <h2 class="text-argon-600 relative inline-block text-2xl font-bold">
                Confirm Your Vault Settings
                <ArrowCalloutButton
                  v-if="currentStep === 'VaultingRules'"
                  guidance="We've already setup recommended vault settings. All you need to do is confirm."
                  class="pointer-events-none absolute top-1/2 -right-3 -translate-y-1/2 translate-x-full z-50 -mt-0.5"
                />
              </h2>
              <p v-if="!config.hasSavedVaultingRules">
                Choose your ARGN and ARGNOT securitization and Bitcoin locking fees.
              </p>
              <p v-else>
                You confirmed {{ microgonToArgonNm(config.vaultingRules.baseMicrogonCommitment).format('0,0.[0]') }} ARGN
                <template v-if="config.vaultingRules.baseMicronotCommitment > 0n">
                  and {{ micronotToArgonotNm(config.vaultingRules.baseMicronotCommitment).format('0,0.[0]') }} ARGNOT
                </template>
                in securitization.
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
            <div class="px-4 text-slate-600">
              <h2 class="text-argon-600 relative inline-block text-2xl font-bold">
                {{ walletIsPartiallyFunded ? 'Finish' : '' }} Fund{{ walletIsPartiallyFunded ? 'ing' : '' }}
                Your Wallet
                <ArrowCalloutButton
                  v-if="currentStep === 'FundWallet' && !basics.overlayIsOpen"
                  guidance="You must fund your vault before proceeding."
                  class="pointer-events-none absolute top-1/2 -right-3 -translate-y-1/2 translate-x-full z-50 -mt-0.5"
                />
              </h2>
              <p>
                Your account needs a minimum of
                {{ microgonToArgonNm(funding.requiredMicrogons).format('0,0.[0]') }} ARGN
                <template v-if="funding.requiredMicronots > 0n">
                  and {{ micronotToArgonotNm(funding.requiredMicronots).format('0,0.[0]') }} ARGNOT
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
          :disabled="!canLaunch"
          :class="[
          canLaunch
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
import { NetworkConfig } from '@argonprotocol/apps-core';
import basicEmitter from '../../emitters/basicEmitter.ts';
import { getConfig } from '../../stores/config.ts';
import { useWallets } from '../../stores/wallets.ts';
import { getCurrency } from '../../stores/currency.ts';
import Checkbox from '../../components/Checkbox.vue';
import { createNumeralHelpers } from '../../lib/numeral.ts';
import { ArrowLeftIcon } from '@heroicons/vue/24/outline';
import VaultCreatePanel from '../../panels/VaultCreatePanel.vue';
import { useCertificationController, OperationalStepId } from '../../stores/certificationController.ts';
import { TopTab, VaultingSetupStatus } from '../../interfaces/IConfig.ts';
import ArrowCalloutButton from '../../components/ArrowCalloutButton.vue';
import { useBasics } from '../../stores/basics.ts';

import { MyVault } from '../../lib/MyVault.ts';

const config = getConfig();
const basics = useBasics();
const wallets = useWallets();
const currency = getCurrency();
const controller = useCertificationController();
const { microgonToArgonNm, micronotToArgonotNm } = createNumeralHelpers(currency);
const funding = Vue.computed(() => MyVault.getFundingState(config, wallets.defaultArgonWallet));
const walletIsFullyFunded = Vue.computed(() => wallets.isLoaded && funding.value.isFullyFunded);
const canLaunch = Vue.computed(
  () => walletIsFullyFunded.value && serverConnectIsChecked.value && !basics.overlayIsOpen,
);

const serverConnectIsChecked = Vue.computed(() => {
  return wallets.isLoaded && config.isServerAdded;
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
  return (wallets.defaultArgonWallet.availableMicrogons || wallets.defaultArgonWallet.availableMicronots) > 0;
});

const openCreateOverlay = Vue.ref(false);
function openVaultCreateOverlay() {
  openCreateOverlay.value = true;
}

function openFundVaultingAccountOverlay() {
  basicEmitter.emit('openWalletOverlay', {
    wallet: wallets.argonWallets.defaultArgonWallet,
    showGuidance: true,
    guidanceContext: 'vaulting',
  });
}

async function startCreateVault() {
  if (!canLaunch.value) return;
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
    controller.setTab(TopTab.Home);
  }
}
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
