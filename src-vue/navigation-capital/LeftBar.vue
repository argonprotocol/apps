<!-- prettier-ignore -->
<template>
  <div
    class="bg-white/95 h-full min-w-80 flex flex-col select-none"
    style="border-radius: 10px 10px 0 0; box-shadow: 0 2px 2px rgba(0, 0, 0, 0.2)"
    data-tauri-drag-region
  >
    <div class="flex flex-row items-center pointer-events-none relative py-3 mx-1 border-b border-slate-500/20">
      <WindowControls />
      <div class="text-[19px] font-bold whitespace-nowrap">
        {{ APP_NAME }}
        <InstanceMenu v-if="NETWORK_NAME !== 'mainnet' || instances.length > 1" :instances="instances" />
      </div>
    </div>

    <div class="text-center flex-row items-center justify-center py-10 border-b border-slate-500/20">
      <div class="font-bold text-4xl">₳41,464.66</div>
      <div>Total Value</div>
    </div>

    <ul class="mt-5 px-5">
      <li>
        <div>Mainchain Balance</div>
        <div>{{currency.symbol}}0.00</div>
      </li>
      <li>
        <div>Localchain Balance</div>
        <div>{{currency.symbol}}0.00</div>
      </li>
      <li>
        <div>External Balance</div>
        <div>{{currency.symbol}}0.00</div>
      </li>
    </ul>

    <div class="mt-10 px-5">
      <header>INVESTMENT RETURNS</header>
      <ul class="mt-2">
        <li>
          <div>Argon Bonds</div>
          <div>{{currency.symbol}}0.00%</div>
        </li>
        <li>
          <div>Bitcoin Locks</div>
          <div>{{currency.symbol}}0.00%</div>
        </li>
        <li>
          <div>Stable Swaps</div>
          <div>{{currency.symbol}}0.00%</div>
        </li>
      </ul>
    </div>

    <div class="mt-10 px-5">
      <header>NETWORK HEALTH</header>
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
import WindowControls from '../tauri-controls/WindowControls.vue';
import CurrencyMenu from '../navigation-shared/CurrencyMenu.vue';
import AccountMenu from '../navigation-shared/AccountMenu.vue';
import InstanceMenu, { IInstance } from '../navigation-shared/InstanceMenu.vue';
import { useTour } from '../stores/tour.ts';
import { appConfigDir } from '@tauri-apps/api/path';
import { readDir } from '@tauri-apps/plugin-fs';
import { APP_NAME, INSTANCE_NAME, NETWORK_NAME } from '../lib/Env.ts';
import { getCurrency } from '../stores/currency.ts';

const currency = getCurrency();
const tour = useTour();

const accountMenuRef = Vue.ref<InstanceType<typeof AccountMenu> | null>(null);
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

tour.registerPositionCheck('accountMenu', () => {
  const accountMenuElem = accountMenuRef.value?.$el;
  const rect = accountMenuElem?.getBoundingClientRect().toJSON() || { left: 0, right: 0, top: 0, bottom: 0 };
  rect.left -= 7;
  rect.right += 7;
  rect.top -= 7;
  rect.bottom += 7;
  return { ...rect, blur: 5 };
});

Vue.onMounted(async () => {
  await fetchInstances();
});
</script>

<style scoped>
@reference "../main.css";

ul li {
  @apply flex flex-row items-center py-2;
  div:first-child {
    @apply grow;
  }
}
</style>
