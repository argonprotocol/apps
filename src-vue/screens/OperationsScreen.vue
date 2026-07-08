<template>
  <div class="flex flex-row gap-x-5">
    <section box class="flex min-h-60 w-1/3 flex-col px-2">
      <header class="flex flex-row border-b border-slate-400/30 py-2 text-[18px] font-bold text-slate-900/80 uppercase">
        <span class="grow pl-3">Your Mining Operations</span>
        <CopyAddressMenu :walletType="WalletType.defaultArgon" class="mr-1" />
        <AssetMenu :walletType="WalletType.defaultArgon" class="pr-3" />
      </header>
      <div class="flex grow flex-row pt-2 text-center" v-if="config.miningSetupStatus === MiningSetupStatus.Finished">
        <div class="flex w-1/2 flex-col items-center gap-x-2">
          <div StatWrapper class="flex h-1/2 w-full flex-col border-b border-slate-600/20 pb-1">
            <div Stat class="text-2xl!">
              {{ currency.symbol
              }}{{ microgonToMoneyNm(portfolio.miningExternalInvested).formatIfElse('<1000', '0,0.[00]', '0,0') }}
            </div>
            <label>Capital Invested</label>
          </div>
          <div StatWrapper class="flex h-1/2 w-full flex-col pt-1.5">
            <div Stat class="text-2xl!">
              {{ numeral(myMiningRoi).formatIfElseCapped('< 100', '0.[000]', '0,0', 9_999) }}%
            </div>
            <label>Current ROI</label>
          </div>
        </div>
        <div class="mx-2 h-full w-px bg-slate-600/20" />
        <div class="flex w-1/2 flex-col items-center gap-x-2">
          <div StatWrapper class="flex h-1/2 w-full flex-col border-b border-slate-600/20 pb-1">
            <div Stat class="text-2xl!">
              {{ currency.symbol }}{{ microgonToMoneyNm(myMiningEarnings).formatIfElse('<1000', '0,0.[00]', '0,0') }}
            </div>
            <label>Earnings-to-Date</label>
          </div>
          <div StatWrapper class="flex h-1/2 w-full flex-col pt-1.5">
            <div Stat class="text-2xl!">
              {{ numeral(myMiningApy).formatIfElseCapped('< 100', '0.[000]', '0,0', 9_999) }}%
            </div>
            <label>Projected APY</label>
          </div>
        </div>
      </div>
      <div v-else class="flex grow flex-col px-3">
        <p class="grow pt-3 pb-2 font-light text-slate-900/80">
          Argon's Miners secure the network by maintaining consensus and printing new Argons when needed. This puts them
          in a unique position to profit from the growth of the Argon ecosystem.
        </p>
        <button
          @click="setupMining"
          class="bg-argon-500 hover:bg-argon-600 border-argon-700 inner-button-shadow my-3 flex w-full max-w-180 cursor-pointer flex-row items-center justify-center rounded-md border px-5 py-2 text-lg font-bold text-white"
        >
          Set Up Your Mining Operations
          <ChevronDoubleRightIcon class="relative ml-1 size-5" />
        </button>
      </div>
    </section>

    <section box class="flex min-h-60 w-1/3 flex-col px-2">
      <header class="flex flex-row border-b border-slate-400/30 py-2 text-[18px] font-bold text-slate-900/80 uppercase">
        <span class="grow pl-3">Your Vaulting Operations</span>
        <CopyAddressMenu :walletType="WalletType.defaultArgon" class="mr-1" />
        <AssetMenu :walletType="WalletType.defaultArgon" class="mr-3" />
      </header>
      <div
        class="flex grow flex-row pt-2 text-center"
        v-if="config.vaultingSetupStatus === VaultingSetupStatus.Finished"
      >
        <div class="flex w-1/2 flex-col items-center gap-x-2">
          <div StatWrapper class="flex h-1/2 w-full flex-col border-b border-slate-600/20 pb-1">
            <div Stat class="text-2xl!">
              {{ currency.symbol
              }}{{ microgonToMoneyNm(portfolio.vaultingExternalInvested).formatIfElse('<1000', '0,0.[00]', '0,0') }}
            </div>
            <label>Capital Invested</label>
          </div>
          <div StatWrapper class="flex h-1/2 w-full flex-col pt-1.5">
            <div Stat class="text-2xl!">
              {{ numeral(myVaultRoi).formatIfElseCapped('< 100', '0.[00]', '0,0', 9_999) }}%
            </div>
            <label>Current ROI</label>
          </div>
        </div>
        <div class="mx-2 h-full w-px bg-slate-600/20" />
        <div class="flex w-1/2 flex-col items-center gap-x-2">
          <div StatWrapper class="flex h-1/2 w-full flex-col border-b border-slate-600/20 pb-1">
            <div Stat class="text-2xl!">
              {{ currency.symbol }}{{ microgonToMoneyNm(myVaultEarnings).formatIfElse('<1000', '0,0.[00]', '0,0') }}
            </div>
            <label>Earnings-to-Date</label>
          </div>
          <div StatWrapper class="flex h-1/2 w-full flex-col pt-1.5">
            <div Stat class="text-2xl!">
              {{ numeral(myVaultApy).formatIfElseCapped('< 100', '0.[000]', '0,0', 9_999) }}%
            </div>
            <label>Projected APY</label>
          </div>
        </div>
      </div>
      <div v-else class="px-3">
        <p class="py-3 font-light text-slate-900/80">
          Argon's Stabilization Vaults lock Bitcoins into special contracts that provide price stability for the
          stablecoin and make it impossible to death-spiral. In return, vaults earn all revenue generated by mining
          bids.
        </p>
        <button
          @click="setupVault"
          class="bg-argon-500 hover:bg-argon-600 border-argon-700 inner-button-shadow my-4 flex w-full max-w-180 cursor-pointer flex-row items-center justify-center rounded-md border px-5 py-2 text-lg font-bold text-white"
        >
          Setup Your Stabilization Vault
          <ChevronDoubleRightIcon class="relative ml-1 size-5" />
        </button>
      </div>
    </section>
  </div>
</template>
<script setup lang="ts">
import * as Vue from 'vue';
import { calculateAPY, calculateProfitPct } from '@argonprotocol/apps-core';
import { WalletType } from '../lib/Wallet.ts';
import { MiningSetupStatus, VaultingSetupStatus } from '../interfaces/IConfig.ts';
import { ChevronDoubleRightIcon } from '@heroicons/vue/24/outline';
import CopyAddressMenu from '../components/CopyAddressMenu.vue';
import AssetMenu from './components/AssetMenu.vue';
import numeral, { createNumeralHelpers } from '../lib/numeral.ts';
import { getCurrency } from '../stores/currency.ts';
import { getMyVault } from '../stores/vaults.ts';
import { getStats } from '../stores/stats.ts';
import { getConfig } from '../stores/config.ts';
import { TopTab } from '../interfaces/IConfig.ts';
import { useCertificationController } from '../stores/certificationController.ts';
import { usePortfolio } from '../stores/portfolio.ts';
import { UnitOfMeasurement } from '../lib/Currency.ts';

const controller = useCertificationController();
const portfolio = usePortfolio();
const currency = getCurrency();
const myMinerStats = getStats();
const myVault = getMyVault();
const config = getConfig();

const { microgonToMoneyNm } = createNumeralHelpers(currency);

const myMiningEarnings = Vue.computed(() => {
  const { microgonsMinedTotal, microgonsMintedTotal, micronotsMinedTotal, framedCost } = myMinerStats.global;
  const microgonValueOfMicronotsMined = currency.convertMicronotTo(micronotsMinedTotal, UnitOfMeasurement.Microgon);
  return microgonsMintedTotal + microgonsMinedTotal + microgonValueOfMicronotsMined - framedCost;
});

const myMiningRoi = Vue.computed(() => {
  return (
    calculateProfitPct(portfolio.miningExternalInvested, portfolio.miningExternalInvested + myMiningEarnings.value) *
    100
  );
});

const myMiningApy = Vue.computed(() => {
  const rewards = portfolio.miningExternalInvested + myMiningEarnings.value;
  return calculateAPY(portfolio.miningExternalInvested, rewards, myMinerStats.activeFrames);
});

const myVaultEarnings = Vue.computed(() => {
  return myVault.revenue().earnings;
});

const myVaultApy = Vue.computed(() => {
  const { earnings, activeFrames } = myVault.revenue();
  if (earnings === 0n) return 0;
  return calculateAPY(portfolio.vaultingExternalInvested, portfolio.vaultingExternalInvested + earnings, activeFrames);
});

const myVaultRoi = Vue.computed(() => {
  const investment = portfolio.vaultingExternalInvested;
  const returnValue = portfolio.vaultingExternalInvested + myVaultEarnings.value;
  if (investment === 0n) return 0;
  return calculateProfitPct(investment, returnValue) * 100;
});

function setupVault() {
  controller.setTab(TopTab.VaultingOperations);
  controller.backButtonTriggersHome = true;
  config.vaultingSetupStatus = VaultingSetupStatus.Checklist;
}

function setupMining() {
  controller.setTab(TopTab.MiningOperations);
  controller.backButtonTriggersHome = true;
  config.miningSetupStatus = MiningSetupStatus.Checklist;
}
</script>
