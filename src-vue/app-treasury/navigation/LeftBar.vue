<!-- prettier-ignore -->
<template>
  <div class="Navigation LeftBar h-full min-w-80 max-w-80 flex flex-col gap-y-1.5 select-none z-10">
    <section
      DashBox Item
      @click="controller.setScreenKey(TreasuryTab.MainchainSavings)"
      :Selected="controller.selectedTab === TreasuryTab.MainchainSavings || undefined"
    >
      <div>Argon Savings</div>
      <div>{{ currency.symbol }}{{ formattedMainchain }}</div>
      <div ArrowWrapper><Arrow fill="white" stroke="#D3D9E3" :strokeWidth="1" /></div>
    </section>

    <section
      DashBox Item
      @click="controller.setScreenKey(TreasuryTab.ArgonBonds)"
      :Selected="controller.selectedTab === TreasuryTab.ArgonBonds || undefined"
    >
      <div>Argon Bonds</div>
      <div>{{ currency.symbol }}0.00</div>
      <div ArrowWrapper><Arrow fill="white" stroke="#D3D9E3" :strokeWidth="1" /></div>
    </section>

    <section
      DashBox Item
      @click="controller.setScreenKey(TreasuryTab.BitcoinLocks)"
      :Selected="controller.selectedTab === TreasuryTab.BitcoinLocks || undefined"
    >
      <div>Bitcoin Locks</div>
      <div>{{ currency.symbol }}0.00</div>
      <div ArrowWrapper><Arrow fill="white" stroke="#D3D9E3" :strokeWidth="1" /></div>
    </section>

    <section
      DashBox Item
      @click="controller.setScreenKey(TreasuryTab.EthereumSwaps)"
      :Selected="controller.selectedTab === TreasuryTab.EthereumSwaps || undefined"
    >
      <div>Ethereum Swaps</div>
      <div>{{currency.symbol}}0.00</div>
      <div ArrowWrapper><Arrow fill="white" stroke="#D3D9E3" :strokeWidth="1" /></div>
    </section>

    <section DashBox class="grow flex flex-col">
      <div class="grow px-10 pb-[40%] flex flex-col justify-center text-justify text-slate-800/60">
        <header class="font-bold">Did You Know?</header>
        <p class="break-words leading-7">
          The argon stablecoin is designed to never lose value. Unlike the dollar, it buys the same amount of goods
          today as it will a century from now.
        </p>
      </div>
      <ul class="flex flex-row w-full items-end px-3 pb-4 gap-x-3 text-center">
        <li class="w-1/2 border-t border-slate-400/40 pt-3">
          <div @click="() => void openLink('https://argon.network/docs')" class="cursor-pointer flex flex-col items-center gap-y-1 text-center text-argon-600 hover:text-argon-600/70">
            <InstructionsIcon class="h-6 w-6" />
            <div>Docs</div>
          </div>
        </li>
        <li class="w-1/2 border-t border-slate-400/40 pt-3">
          <div @click="() => void openLink('https://discord.gg/xDwwDgCYr9')" class="cursor-pointer flex flex-col items-center gap-y-1 text-center text-argon-600 hover:text-argon-600/70">
            <DiscordIcon class="h-7 w-7 -mb-1" />
            <div>Community</div>
          </div>
        </li>
      </ul>

    </section>
  </div>
</template>

<script setup lang="ts">
import * as Vue from 'vue';
import CurrencyMenu from '../../app-shared/navigation/CurrencyMenu.vue';
import Arrow from '../../components/Arrow.vue';
import { IInstance } from '../../app-shared/navigation/InstanceMenu.vue';
import { useTour } from '../../stores/tour.ts';
import { appConfigDir } from '@tauri-apps/api/path';
import { readDir } from '@tauri-apps/plugin-fs';
import { INSTANCE_NAME, NETWORK_NAME } from '../../lib/Env.ts';
import { getCurrency } from '../../stores/currency.ts';
import { TreasuryTab, useTreasuryController } from '../../stores/treasuryController.ts';
import { useWallets } from '../../stores/wallets.ts';
import { createNumeralHelpers } from '../../lib/numeral.ts';
import DiscordIcon from '../../assets/discord.svg';
import InstructionsIcon from '../../assets/instructions.svg';
import { useBonds } from '../../stores/bonds.ts';
import { open as tauriOpenUrl } from '@tauri-apps/plugin-shell';

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

function openLink(url: string) {
  void tauriOpenUrl(url);
}

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

<style>
@reference "../../main.css";

.Navigation.LeftBar {
  section[Item] {
    @apply relative flex cursor-pointer flex-row items-center justify-between gap-x-2 px-4 py-4 whitespace-nowrap;
    div:nth-child(1) {
      @apply text-argon-600;
    }
    div:nth-child(2) {
      @apply text-argon-800/40;
    }
    &:hover:not([Selected]) {
      @apply bg-[var(--bg-color)];
      [ArrowWrapper] {
        @apply left-[calc(100%-12px)] block;
        &::before {
          @apply w-4;
        }
        .Component.Arrow path {
          fill: var(--bg-color) !important;
        }
      }
    }
    &[Selected] {
      text-shadow: 1px 1px 1px white;
      [ArrowWrapper] {
        @apply block;
      }
    }
  }

  [ArrowWrapper] {
    @apply absolute top-[-4px] left-[calc(100%-2px)] hidden aspect-square h-[calc(100%+8px)] overflow-hidden pr-[6px] pb-[8px];
    &::before {
      content: '';
      @apply absolute top-[3px] left-0 h-[calc(100%+2px)] w-1 bg-[var(--bg-color)];
    }
    svg {
      @apply absolute top-[2px] left-[calc(25%-3px)] h-1/2 w-[calc(100%-10px)] origin-left -translate-y-1/2 rotate-90 drop-shadow-[2px_2px_2px_rgb(0_0_0/0.3)];
    }
  }
}
</style>
