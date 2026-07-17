<!-- prettier-ignore -->
<template>
  <div DashBox class="flex flex-col h-full">
    <div class="flex flex-col items-center grow justify-center">
      <section class="flex flex-col items-center">
        <div style="text-shadow: 1px 1px 0 white">
          <div class="text-5xl leading-tight font-bold text-center text-[#4B2B4E]">
            Earn Revenue By Operating
            <div>Stabilization Vaults for the Network</div>
          </div>
          <p class="text-base text-justify w-[780px] !mx-auto mt-10 text-[#4B2B4E]">
            Argon's Stabilization Vaults are the backbone of its ingenuity. These vaults are designed to lock Bitcoins into
            special contracts that generate unencumbered shorts against the Argon stablecoin. It is these Bitcoin-to-Argon shorts
            that give Argon its price stability and make it impossible to death-spiral. In return for operating vaults and managing
            the related treasury pools, Vaulters are able to earn substantial rewards. Click a button below to get started.
          </p>
        </div>
        <div class="flex flex-row items-center text-2xl mt-10 w-full justify-center gap-x-6">
          <a
            target="_blank"
            href="https://argon.network/docs/vaulting-operations"
            class="flex flex-row items-center cursor-pointer bg-white/10 hover:bg-argon-600/10 border border-argon-800/30 inner-button-shadow font-bold! !text-argon-600 visited:!text-argon-600 hover:!text-argon-600 no-underline hover:no-underline [text-shadow:1px_1px_0_rgba(255,255,255,0.5)] px-12 py-2 rounded-md"
          >
            Learn How Vaulting Works
            <ArrowTopRightOnSquareIcon class="w-5 ml-2" />
          </a>
          <button
            @click="startSettingUpVault"
            class="flex flex-row cursor-pointer items-center gap-x-2 bg-argon-500 hover:bg-argon-600 border border-argon-700 inner-button-shadow font-bold text-white px-12 py-2 rounded-md"
          >
            <span class="relative">
              Set Up Your Stabilization Vault
              <ArrowCalloutButton
                v-if="controller.activeGuideId === OperationalStepId.ActivateVault"
                class="absolute top-1/2 -left-2 -translate-y-1/2 -translate-x-full z-50"
                guidance="Click to start setting up your vault."
                direction="right"
              />
            </span>
            <ChevronDoubleRightIcon class="size-5 relative top-px" />
          </button>
        </div>
      </section>
    </div>
  </div>
</template>

<script setup lang="ts">
import * as Vue from 'vue';
import { getCurrency } from '../../stores/currency.ts';
import VaultImage from '../../assets/vault.svg?component';
import numeral, { createNumeralHelpers } from '../../lib/numeral.ts';
import { ArrowTopRightOnSquareIcon, ChevronDoubleRightIcon } from '@heroicons/vue/24/outline';
import { getVaults } from '../../stores/vaults.ts';
import { getConfig } from '../../stores/config.ts';
import { abbreviateAddress, getPercent } from '../../lib/Utils.ts';
import { useVaultingStats } from '../../stores/vaultingStats.ts';
import { VaultingSetupStatus } from '../../interfaces/IConfig.ts';
import { OperationalStepId, useCertificationController } from '../../stores/certificationController.ts';
import ArrowCalloutButton from '../../components/ArrowCalloutButton.vue';

const currency = getCurrency();
const config = getConfig();
const vaultsStore = getVaults();

const vaultingStats = useVaultingStats();
const controller = useCertificationController();

const { microgonToMoneyNm } = createNumeralHelpers(currency);

const isLoaded = Vue.ref(false);

function startSettingUpVault() {
  config.vaultingSetupStatus = VaultingSetupStatus.Checklist;
}

Vue.onMounted(async () => {
  await vaultsStore.load();
  void vaultsStore.updateRevenue();
  isLoaded.value = true;
});
</script>

<style scoped>
@keyframes scroll {
  0% {
    transform: translateX(0);
  }
  100% {
    transform: translateX(-50%);
  }
}

@keyframes pulseHighlight {
  0% {
    border-color: rgba(203, 213, 225, 0.4);
  }
  50% {
    border-color: rgba(139, 92, 246, 0.2);
  }
  100% {
    border-color: rgba(203, 213, 225, 0.4);
  }
}

@keyframes sweepHighlight {
  0% {
    transform: translateX(-100%);
  }
  100% {
    transform: translateX(100%);
  }
}

.pulse-highlight {
  animation: pulseHighlight 3s ease-in-out infinite;
  position: relative;
  overflow: hidden;
}

.pulse-highlight::before {
  content: '';
  position: absolute;
  top: 0;
  left: 0;
  width: 100%;
  height: 100%;
  background: linear-gradient(90deg, transparent 0%, rgba(139, 92, 246, 0.08) 50%, transparent 100%);
  animation: sweepHighlight 1.5s ease-in-out infinite;
  animation-delay: var(--sweep-delay, 0s);
  pointer-events: none;
  z-index: 1;
}

.animate-scroll {
  animation: scroll 60s linear infinite;
  display: flex;
  will-change: transform;
  animation-play-state: running;
}

.animate-paused {
  animation-play-state: paused;
}

.animate-scroll:hover {
  animation-play-state: paused;
}
</style>
