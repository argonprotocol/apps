<template>
  <div class="Navigation LeftBar z-10 flex h-full max-w-80 min-w-80 flex-col gap-y-1.5 pt-1.5 select-none">
    <section DashBox class="min-h-48 w-full">
      <div class="flex flex-col justify-center px-1">
        <header class="w-full border-b border-slate-500/20">Native Argon Wallet</header>
        <div class="text-argon-600/50 mt-5 flex flex-row justify-center text-5xl font-bold">
          <FormattedMoney :value="0n" />
        </div>
        <div class="w-full text-center">Total Value</div>
        <div class="mt-4 text-left">
          <div class="border-t border-slate-500/20 px-3 py-2">0 ARGN</div>
          <div class="border-t border-slate-500/20 px-3 py-2">0 ARGNOT</div>
        </div>
        <div class="border-t border-slate-500/50 px-3 py-2">3 Other Wallets</div>
      </div>
    </section>

    <section DashBox class="w-full grow px-1 pt-4 pb-3">
      <div>
        <header>Basics</header>
        <ul>
          <li @click="goto(TopTab.Dashboard)" :class="{ selected: controller.selectedTab === TopTab.Dashboard }">
            Dashboard
          </li>
          <li @click="goto(TopTab.Network)" :class="{ selected: controller.selectedTab === TopTab.Network }">
            Network
          </li>
        </ul>
      </div>

      <div class="mt-3" v-if="config.isLoaded && config.hasExtensionTreasury">
        <header>Treasury</header>
        <ul>
          <li @click="goto(TopTab.ArgonBonds)" :class="{ selected: controller.selectedTab === TopTab.ArgonBonds }">
            Argon Bonds
          </li>
          <li @click="goto(TopTab.ArgonotBonds)" :class="{ selected: controller.selectedTab === TopTab.ArgonotBonds }">
            Argonot Bonds
          </li>
          <li @click="goto(TopTab.BitcoinLocks)" :class="{ selected: controller.selectedTab === TopTab.BitcoinLocks }">
            Bitcoin Locks {{ bitcoinLockCoupons.openCouponCount }}
          </li>
          <li @click="goto(TopTab.BitcoinLoans)" :class="{ selected: controller.selectedTab === TopTab.BitcoinLoans }">
            Bitcoin Loans
          </li>
          <li @click="goto(TopTab.StableSwaps)" :class="{ selected: controller.selectedTab === TopTab.StableSwaps }">
            Stable Swaps
          </li>
        </ul>
      </div>

      <div class="mt-3" v-if="config.isLoaded && config.hasExtensionOperations">
        <header>Operations</header>
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
import { getBitcoinLockCoupons } from '../stores/bitcoin.ts';

const controller = useCertificationController();
const bitcoinLockCoupons = getBitcoinLockCoupons();
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

header {
  @apply px-3 py-2 font-bold text-slate-700/40 uppercase;
}

ul li {
  @apply cursor-pointer border-t border-slate-500/20 px-2 py-2;
  &.selected {
    @apply bg-argon-100/30;
  }
}
</style>
