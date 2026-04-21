<!-- prettier-ignore -->
<template>
  <div class="Navigation LeftBar h-full min-w-80 max-w-80 flex flex-col gap-y-1.5 select-none z-10">
    <section
      DashBox Item
      @click="controller.setScreenKey(TreasuryTab.MainchainSavings)"
      :Selected="controller.selectedTab === TreasuryTab.MainchainSavings || undefined"
    >
      <div>Inflation-Free Savings</div>
      <div>{{ currency.symbol }}{{ microgonToMoneyNm(mainchainBalance).format('0,0.00') }}</div>
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
      <div>{{ currency.symbol }}{{ satoshiToMoneyNm(totalLockedSatoshis).format('0,0.00') }}</div>
      <div ArrowWrapper><Arrow fill="white" stroke="#D3D9E3" :strokeWidth="1" /></div>
    </section>

    <section
      DashBox Item
      @click="controller.setScreenKey(TreasuryTab.EthereumSwaps)"
      :Selected="controller.selectedTab === TreasuryTab.EthereumSwaps || undefined"
    >
      <div>Stable Swaps</div>
      <div>{{currency.symbol}}0.00</div>
      <div ArrowWrapper><Arrow fill="white" stroke="#D3D9E3" :strokeWidth="1" /></div>
    </section>

    <section DashBox class="grow flex flex-col">
      <div class="grow pl-8 pr-10 pb-[40%] flex flex-col justify-center text-justify text-slate-800/60">
        <header class="font-bold">Did You Know?</header>
        <p class="break-words leading-7">
          This Argon Treasury app is fully decentralized and open-source, which means there is no company behind it. All the code runs on your
          computer, and all the data stays with you.
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
import Arrow from '../../components/Arrow.vue';
import { getCurrency } from '../../stores/currency.ts';
import { TreasuryTab, useTreasuryController } from '../../stores/treasuryController.ts';
import { useWallets } from '../../stores/wallets.ts';
import { createNumeralHelpers } from '../../lib/numeral.ts';
import DiscordIcon from '../../assets/discord.svg';
import InstructionsIcon from '../../assets/instructions.svg';
import { useMyBonds } from '../../stores/myBonds.ts';
import { open as tauriOpenUrl } from '@tauri-apps/plugin-shell';
import { getBitcoinLocks } from '../../stores/bitcoin.ts';
import { BitcoinLockStatus } from '../../lib/db/BitcoinLocksTable.ts';

const controller = useTreasuryController();
const currency = getCurrency();
const wallets = useWallets();
const myBonds = useMyBonds();
const bitcoinLocks = getBitcoinLocks();

const { microgonToMoneyNm, satoshiToMoneyNm } = createNumeralHelpers(currency);

const mainchainBalance = Vue.computed(() => wallets.liquidLockingWallet.availableMicrogons);
const totalValue = Vue.computed(() => mainchainBalance.value + myBonds.bondTotals.totalBondMicrogons);

const activeLocks = Vue.computed(() => {
  return bitcoinLocks.getAllLocks();
});

const nonReleasedLocks = Vue.computed(() => {
  return activeLocks.value.filter(l => l.status !== BitcoinLockStatus.Released);
});

const totalLockedSatoshis = Vue.computed(() => {
  return nonReleasedLocks.value.reduce((sum, l) => sum + l.satoshis, 0n);
});

function openLink(url: string) {
  void tauriOpenUrl(url);
}

Vue.onMounted(async () => {
  await myBonds.load();
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
        @apply left-[calc(100%-2px)] block;
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
