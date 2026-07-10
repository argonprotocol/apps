<template>
  <div class="Navigation LeftBar z-10 flex h-full max-w-80 min-w-80 flex-col gap-y-1.5 pt-1.5 select-none">
    <section DashBox class="min-h-48 w-full">
      <div class="flex flex-col justify-center px-1">
        <header class="w-full border-b border-slate-500/20 py-2 px-3">Native Argon Wallet</header>
        <div class="flex flex-row text-5xl font-bold mt-5 justify-center">
          <FormattedMoney :value="0n" />
        </div>
        <div class="w-full text-center">Total Value</div>
        <div class="text-left border-y border-slate-500/20">
          <div>0 ARGN</div>
          <div>0 ARGNOT</div>
        </div>
        <div>
          3 Other Wallets
        </div>
      </div>
    </section>

    <section DashBox class="w-full grow px-5 py-3">
      <div>
        <header class="opacity-50">Basics</header>
        <ul>
          <li
            @click="goto(TopTab.Dashboard)"
            :class="{ selected: controller.selectedTab === TopTab.Dashboard }"
          >
            Dashboard
          </li>
          <li
            @click="goto(TopTab.Network)"
            :class="{ selected: controller.selectedTab === TopTab.Network }"
          >
            Network
          </li>
        </ul>
      </div>

      <div class="mt-3">
        <header class="opacity-50">Treasury</header>
        <ul>
          <li
            @click="goto(TopTab.ArgonBonds)"
            :class="{ selected: controller.selectedTab === TopTab.ArgonBonds }"
          >
            Argon Bonds
          </li>
          <li
            @click="goto(TopTab.ArgonotBonds)"
            :class="{ selected: controller.selectedTab === TopTab.ArgonotBonds }"
          >
            Argonot Bonds
          </li>
          <li
            @click="goto(TopTab.BitcoinLocks)"
            :class="{ selected: controller.selectedTab === TopTab.BitcoinLocks }"
          >
            Bitcoin Locks
          </li>
          <li
            @click="goto(TopTab.BitcoinLoans)"
            :class="{ selected: controller.selectedTab === TopTab.BitcoinLoans }"
          >
            Bitcoin Loans
          </li>
          <li
            @click="goto(TopTab.StableSwaps)"
            :class="{ selected: controller.selectedTab === TopTab.StableSwaps }"
          >
            Stable Swaps
          </li>
        </ul>
      </div>

      <div class="mt-3">
        <header class="opacity-50">Operations</header>
        <ul>
          <li
            data-testid="LeftBar.goto(TopTab.Mining)"
            @click="goto(TopTab.Mining)"
            :class="{ selected: controller.selectedTab === TopTab.Mining }"
          >
            Mining
          </li>
          <li
            data-testid="LeftBar.goto(TopTab.Vaulting)"
            @click="goto(TopTab.Vaulting)"
            :class="{ selected: controller.selectedTab === TopTab.Vaulting }"
          >
            Vaulting
          </li>
        </ul>
      </div>
    </section>
  </div>
</template>

<script setup lang="ts">
import { MiningSetupStatus, TopTab, VaultingSetupStatus } from '../interfaces/IConfig.ts';
import { useCertificationController } from '../stores/certificationController.ts';
import { getConfig } from '../stores/config.ts';
import FormattedMoney from '../components/FormattedMoney.vue';

const controller = useCertificationController();
const config = getConfig();

function goto(tab: TopTab) {
  if (controller.backButtonTriggersHome) {
    controller.backButtonTriggersHome = false;
    if (tab === TopTab.Mining) {
      config.miningSetupStatus = MiningSetupStatus.None;
    } else if (tab === TopTab.Vaulting) {
      config.vaultingSetupStatus = VaultingSetupStatus.None;
    }
  }
  controller.setTab(tab);
}
</script>

<style scoped>
@reference "../main.css";

ul li {
  @apply cursor-pointer;
  &.selected {
    @apply bg-argon-100/30;
  }
}
</style>
