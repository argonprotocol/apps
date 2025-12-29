<!-- prettier-ignore -->
<template>
  <div class="flex flex-col h-full">
    <div class="flex flex-col items-center grow justify-center">
      <section class="flex flex-col items-center">
        <div style="text-shadow: 1px 1px 0 white">
          <div class="text-5xl leading-tight font-bold text-center mt-20 text-[#4B2B4E]">
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
          <button
            @click="openHowVaultingWorksOverlay"
            class="cursor-pointer bg-white/10 hover:bg-argon-600/10 border border-argon-800/30 inner-button-shadow font-bold text-argon-600 [text-shadow:1px_1px_0_rgba(255,255,255,0.5)] px-12 py-2 rounded-md block"
          >
            Learn How Vaulting Works
          </button>
          <button
            @click="startSettingUpVault"
            class="flex flex-row cursor-pointer items-center gap-x-2 bg-argon-500 hover:bg-argon-600 border border-argon-700 inner-button-shadow font-bold text-white px-12 py-2 rounded-md"
          >
            Set Up Your Stabilization Vault
            <ChevronDoubleRightIcon class="size-5 relative top-px" />
          </button>
        </div>
      </section>
    </div>
    <div class="flex-grow flex flex-row items-end w-full">
      <div class="flex flex-col w-full px-5 pb-5">
        <ul
          class="flex flex-row text-center text-sm text-[#4B2B4E] w-full py-7 border-t border-b border-slate-300 mb-5"
        >
          <li class="w-1/4">
            <div class="text-4xl font-bold">
              <template v-if="isLoaded">
                {{ vaultingStats.vaultCount }}
              </template>
              <template v-else>---</template>
            </div>
            <div>Active Vaults</div>
          </li>
          <li style="width: 1px" class="bg-slate-300"></li>
          <li class="w-1/4">
            <div class="text-4xl font-bold">
              <template v-if="isLoaded">
                {{ numeral(vaultingStats.bitcoinLocked).format('0,0.[00000000]') }}
              </template>
              <template v-else>---</template>
            </div>
            <div>Bitcoin In Vaults</div>
          </li>
          <li style="width: 1px" class="bg-slate-300"></li>
          <li class="w-1/4">
            <div class="text-4xl font-bold">
              <template v-if="isLoaded">
                <span :class="[currency.symbol === '₳' ? 'font-semibold' : 'font-bold']">
                  {{ currency.symbol }}
                </span>
                <span>{{ microgonToMoneyNm(vaultingStats.microgonValueInVaults).formatIfElse('< 1_000', '0,0.00', '0,0') }}</span>
              </template>
              <template v-else>---</template>
            </div>
            <div>Total Value In Vaults</div>
          </li>
          <li style="width: 1px" class="bg-slate-300"></li>
          <li class="w-1/4">
            <div class="text-4xl font-bold">
              <template v-if="isLoaded">
                {{ numeral(vaultingStats.averageVaultAPY).formatIfElseCapped('< 1_000', '0,0.00', '0,0', 9_999) }}%
              </template>
              <template v-else>---</template>
            </div>
            <div>Average Vault APY</div>
          </li>
        </ul>
        <ul class="flex flex-row w-full overflow-x-hidden relative h-[117px]">
          <div class="flex flex-row h-full animate-scroll" :class="{ 'animate-paused': !isLoaded }">
            <template v-for="i in cloneCount" :key="'clone' + i">
              <template v-for="(vault, idx) in vaults" :key="vault.id">
                <li 
                  :style="{ animationDelay: `${getAnimationDelay(idx)}ms`, '--sweep-delay': `${getAnimationDelay(idx)}ms` }" 
                  :class="{ 'opacity-50': vault.isFiller }"
                  class="flex flex-row rounded-lg bg-white/30 mr-4 h-full pulse-highlight"
                >
                  <VaultImage class="relative h-full opacity-60 z-10" />
                  <div class="flex flex-col border-l-0 border border-slate-400/50 px-2 rounded-r-lg w-80">
                    <table class="w-full h-full">
                      <tbody>
                        <tr>
                          <td class="font-bold pl-1 pr-5 text-slate-800/70" colspan="2">
                            <header>
                              <template v-if="vault.isFiller">Pending Stabilization Vault</template>
                              <template v-else>Stabilization Vault #{{ abbreviateAddress(vault.operatorAccountId, 3) }}</template>
                            </header>
                          </td>
                        </tr>
                        <tr>
                          <td class="border-t border-slate-600/20 pl-1 font-bold text-sm text-slate-600/50">
                            Bitcoins
                          </td>
                          <td class="border-t border-slate-600/20 w-full pr-1">
                            <div class="relative w-full bg-slate-500/10 border border-slate-400 rounded h-5">
                              <div
                                class="absolute left-[-1px] top-[-1px] h-[calc(100%+2px)] bg-white/90 border border-slate-500 rounded"
                                :style="{ width: vault.btcFillPct + '%' }"
                              ></div>
                            </div>
                          </td>
                        </tr>
                        <tr>
                          <td class="border-t border-slate-600/20 pl-1 font-bold text-sm text-slate-600/50">
                            Treasury
                          </td>
                          <td class="border-t border-slate-600/20 w-full pr-1">
                            <div class="relative w-full bg-slate-500/10 border border-slate-400 rounded h-5">
                              <div
                                class="absolute left-[-1px] top-[-1px] h-[calc(100%+2px)] bg-white/90 border border-slate-500 rounded"
                                :style="{ width: vault.treasuryFillPct + '%' }"
                              ></div>
                            </div>
                          </td>
                        </tr>
                      </tbody>
                    </table>
                  </div>
                </li>
              </template>
            </template>
          </div>
        </ul>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import * as Vue from 'vue';
import basicEmitter from '../../emitters/basicEmitter';
import { getCurrency } from '../../stores/currency';
import VaultImage from '../../assets/vault.svg?component';
import numeral, { createNumeralHelpers } from '../../lib/numeral';
import { ChevronDoubleRightIcon } from '@heroicons/vue/24/outline';
import { getVaults } from '../../stores/vaults.ts';
import { getConfig } from '../../stores/config';
import { abbreviateAddress } from '../../lib/Utils.ts';
import { useVaultingStats } from '../../stores/vaultingStats.ts';

const currency = getCurrency();
const config = getConfig();
const vaultsStore = getVaults();

const vaultingStats = useVaultingStats();

const { microgonToMoneyNm } = createNumeralHelpers(currency);

const isLoaded = Vue.ref(false);

const cloneCount = Vue.computed(() => {
  const minVaults = 6;
  return Math.ceil(minVaults / Math.max(1, vaultingStats.vaultCount));
});

const vaults = Vue.ref(
  [] as { id: number; operatorAccountId: string; btcFillPct: number; treasuryFillPct: number; isFiller?: boolean }[],
);

function openHowVaultingWorksOverlay() {
  basicEmitter.emit('openHowVaultingWorksOverlay');
}

function startSettingUpVault() {
  config.isPreparingVaultSetup = true;
}

// Animation delay calculation based on visual position
function getAnimationDelay(position: number): number {
  return (position + 1) * 150;
}

async function updateRevenue() {
  try {
    const list = Object.values(vaultsStore.vaultsById);
    vaults.value = [];
    for (const vault of list) {
      const maxSpace = vault.securitization - vault.recoverySecuritization();
      const bitcoinSpaceUsed = maxSpace - vault.availableBitcoinSpace();
      const isAlreadyFound = vaults.value.some(v => v.operatorAccountId === vault.operatorAccountId);
      if (isAlreadyFound) continue;

      vaults.value.push({
        id: vault.vaultId,
        operatorAccountId: vault.operatorAccountId,
        btcFillPct: Math.round((Number(bitcoinSpaceUsed) / Number(maxSpace)) * 100),
        treasuryFillPct: vaultsStore.getTreasuryFillPct(vault.vaultId),
      });
    }

    // Add filler items if less than 6 vaults are present, with negative ids to prevent conflict
    if (vaults.value.length < 6) {
      let increment = -1;
      while (vaults.value.length < 6) {
        vaults.value.push({
          id: increment--,
          operatorAccountId: '',
          btcFillPct: 0,
          treasuryFillPct: 0,
          isFiller: true,
        });
      }
    }

    isLoaded.value = true;
  } catch (error) {
    console.error('Error loading vaults:', error);
  }
}

Vue.onMounted(async () => {
  await vaultsStore.load();
  await updateRevenue();
  void vaultsStore.updateRevenue().then(updateRevenue);
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
