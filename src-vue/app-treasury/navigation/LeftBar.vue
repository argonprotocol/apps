<!-- prettier-ignore -->
<template>
  <div
    class="bg-white/95 h-full min-w-80 flex flex-col select-none"
    style="border-radius: 10px 10px 0 0; box-shadow: 0 2px 2px rgba(0, 0, 0, 0.2)"
    data-tauri-drag-region
  >
    <div class="flex flex-row items-center pointer-events-none relative pt-1 mx-1 border-b border-slate-500/20 h-[55px]">
      <WindowControls />
      <div class="text-[19px] font-bold whitespace-nowrap">
        {{ APP_NAME }}
        <InstanceMenu v-if="NETWORK_NAME !== 'mainnet' || instances.length > 1" :instances="instances" />
      </div>
    </div>

    <div class="text-center flex-row items-center justify-center py-10 border-b border-slate-500/20">
      <div class="font-bold text-4xl">{{ currency.symbol }}{{ formattedTotal }}</div>
      <div>Total Value</div>
    </div>

    <ul class="mt-5 px-3">
      <li @click="controller.setScreenKey(TreasuryTab.Mainchain)" :Selected="controller.selectedTab === TreasuryTab.Mainchain || undefined">
        <div>Mainchain Balance</div>
        <div>{{ currency.symbol }}{{ formattedMainchain }}</div>
      </li>
      <li @click="controller.setScreenKey(TreasuryTab.Localchain)" :Selected="controller.selectedTab === TreasuryTab.Localchain || undefined">
        <div>Localchain Balance</div>
        <div>{{currency.symbol}}0.00</div>
      </li>
      <li @click="controller.setScreenKey(TreasuryTab.Ethereum)" :Selected="controller.selectedTab === TreasuryTab.Ethereum || undefined">
        <div>Ethereum Balance</div>
        <div>{{currency.symbol}}0.00</div>
      </li>
    </ul>

    <div class="mt-10 px-3">
      <header class="px-2 opacity-40">INVESTMENT RETURNS</header>
      <ul class="mt-2">
        <li @click="controller.setScreenKey(TreasuryTab.ArgonBonds)" :Selected="controller.selectedTab === TreasuryTab.ArgonBonds || undefined">
          <div>Argon Bonds</div>
          <div>{{ numeral(bonds.estimatedApy).format('0.00') }}%</div>
        </li>
        <li @click="controller.setScreenKey(TreasuryTab.BitcoinLocks)" :Selected="controller.selectedTab === TreasuryTab.BitcoinLocks || undefined">
          <div>Bitcoin Locks</div>
          <div>0.00%</div>
        </li>
        <li @click="controller.setScreenKey(TreasuryTab.StableSwaps)" :Selected="controller.selectedTab === TreasuryTab.StableSwaps || undefined">
          <div>Stable Swaps</div>
          <div>0.00%</div>
        </li>
      </ul>
    </div>

    <div class="mt-10 px-3">
      <header class="px-2 opacity-40">NETWORK HEALTH</header>
      <ul class="mt-2">
        <li>
          <div>Operational Agents</div>
          <div>+0.00</div>
        </li>
        <li>
          <div>Token Circulation</div>
          <div>+0.00</div>
        </li>
        <li>
          <div>Price Stabilization</div>
          <div>+0.00</div>
        </li>
      </ul>
    </div>
  </div>
</template>

<script setup lang="ts">
import * as Vue from 'vue';
import WindowControls from '../../tauri-controls/WindowControls.vue';
import CurrencyMenu from '../../app-shared/navigation/CurrencyMenu.vue';
import InstanceMenu, { IInstance } from '../../app-shared/navigation/InstanceMenu.vue';
import { useTour } from '../../stores/tour.ts';
import { appConfigDir } from '@tauri-apps/api/path';
import { readDir } from '@tauri-apps/plugin-fs';
import { APP_NAME, INSTANCE_NAME, NETWORK_NAME } from '../../lib/Env.ts';
import { getCurrency } from '../../stores/currency.ts';
import { TreasuryTab, useTreasuryController } from '../../stores/treasuryController.ts';
import { useWallets } from '../../stores/wallets.ts';
import numeral, { createNumeralHelpers } from '../../lib/numeral.ts';
import { useBonds } from '../../stores/bonds.ts';

const controller = useTreasuryController();
const currency = getCurrency();
const wallets = useWallets();
const bonds = useBonds();

const mainchainBalance = Vue.computed(() => wallets.liquidLockingWallet.availableMicrogons);
const totalValue = Vue.computed(() => mainchainBalance.value + bonds.heldPrincipal);

const formattedMainchain = Vue.computed(() => {
  if (!currency.isLoaded) return '0.00';
  const { microgonToMoneyNm } = createNumeralHelpers(currency);
  return microgonToMoneyNm(mainchainBalance.value).format('0,0.00');
});

const formattedTotal = Vue.computed(() => {
  if (!currency.isLoaded) return '0.00';
  const { microgonToMoneyNm } = createNumeralHelpers(currency);
  return microgonToMoneyNm(totalValue.value).format('0,0.00');
});
const tour = useTour();

const currencyMenuRef = Vue.ref<InstanceType<typeof CurrencyMenu> | null>(null);

const instances = Vue.ref<IInstance[]>([]);

async function fetchInstances() {
  const configDir = await appConfigDir();

  const entries = await readDir(`${configDir}/${NETWORK_NAME}`);
  instances.value = entries
    .filter(entry => entry.isDirectory)
    .map(entry => ({
      name: entry.name,
      isSelected: entry.name === INSTANCE_NAME,
    }));
}
tour.registerPositionCheck('currencyMenu', () => {
  const currencyMenuElem = currencyMenuRef.value?.$el;
  const rect = currencyMenuElem?.getBoundingClientRect().toJSON() || { left: 0, right: 0, top: 0, bottom: 0 };
  rect.left -= 10;
  rect.right += 10;
  rect.top -= 10;
  rect.bottom += 7;
  return { ...rect, blur: 5 };
});

Vue.onMounted(async () => {
  await fetchInstances();
  await bonds.load();
});
</script>

<style scoped>
@reference "../../main.css";

ul li {
  @apply my-1 flex cursor-pointer flex-row items-center rounded border border-transparent px-2 py-1.5;
  div:first-child {
    @apply grow;
  }
  &[Selected] {
    @apply bg-argon-400/10;
    &:hover {
      @apply border-transparent;
    }
  }
  &:hover {
    @apply border-dashed border-slate-500/60;
  }
}
</style>
