<!-- prettier-ignore -->
<template>
  <div class="h-full min-w-80 flex flex-col gap-y-1.5 select-none z-10">
    <section DashBox class="px-4">
      <header class="flex flex-row items-center pt-3 pb-2 opacity-50">
        <MainchainIcon class="mr-2 h-4 w-4" />
        <div>MAINCHAIN NETWORK</div>
      </header>
      <ul>
        <li Divider />
        <li Clickable Item @click="controller.setScreenKey(TreasuryTab.MainchainSavings)" :Selected="controller.selectedTab === TreasuryTab.MainchainSavings || undefined">
          <div>Inflation-Free Savings</div>
          <div>{{ currency.symbol }}{{ formattedMainchain }}</div>
          <div Selector>
            <div ArrowWrapper><Arrow fill="#ECE1EE" :strokeWidth="0" /></div>
          </div>
        </li>
        <li Divider />
        <li Clickable Item @click="controller.setScreenKey(TreasuryTab.ArgonBonds)" :Selected="controller.selectedTab === TreasuryTab.ArgonBonds || undefined">
          <div>Argon Bonds</div>
          <div>{{ numeral(bonds.estimatedApy).format('0.00') }}%</div>
          <div Selector>
            <div ArrowWrapper><Arrow fill="#ECE1EE" :strokeWidth="0" /></div>
          </div>
        </li>
        <li Divider />
        <li Clickable Item @click="controller.setScreenKey(TreasuryTab.BitcoinLocks)" :Selected="controller.selectedTab === TreasuryTab.BitcoinLocks || undefined">
          <div>Bitcoin Locks</div>
          <div>0.00%</div>
          <div Selector>
            <div ArrowWrapper><Arrow fill="#ECE1EE" :strokeWidth="0" /></div>
          </div>
        </li>
        <li Divider />
      </ul>

      <header class="flex flex-row items-center pt-5 pb-2 opacity-50">
        <P2pIcon class="mr-2 h-4 w-4" />
        <div>PERSON-TO-PERSON</div>
      </header>
      <ul class="mt-2">
        <li Divider />
        <li Clickable Item @click="controller.setScreenKey(TreasuryTab.P2pSavings)" :Selected="controller.selectedTab === TreasuryTab.P2pSavings || undefined">
          <div>Ready Cash</div>
          <div>{{currency.symbol}}0.00</div>
          <div Selector>
            <div ArrowWrapper><Arrow fill="#ECE1EE" :strokeWidth="0" /></div>
          </div>
        </li>
        <li Divider />
        <li Clickable Item @click="controller.setScreenKey(TreasuryTab.P2pTaxes)" :Selected="controller.selectedTab === TreasuryTab.P2pTaxes || undefined">
          <div>Tax Revenue</div>
          <div>{{currency.symbol}}0.00</div>
          <div Selector>
            <div ArrowWrapper><Arrow fill="#ECE1EE" :strokeWidth="0" /></div>
          </div>
        </li>
        <li Divider />
      </ul>

      <header class="flex flex-row items-center pt-5 pb-2 opacity-50">
        <ExternalIcon class="mr-2 h-4 w-4" />
        <div>EXTERNAL NETWORKS</div>
      </header>
      <ul>
        <li Divider />
        <li Clickable Item @click="controller.setScreenKey(TreasuryTab.EthereumSwaps)" :Selected="controller.selectedTab === TreasuryTab.EthereumSwaps || undefined">
          <div>Ethereum Swaps</div>
          <div>{{currency.symbol}}0.00</div>
          <div Selector>
            <div ArrowWrapper><Arrow fill="#ECE1EE" :strokeWidth="0" /></div>
          </div>
        </li>
      </ul>
    </section>

    <section DashBox class="px-4">
      <ul class="text-slate-900/60">
        <li Item>
          <div>Total Portfolio Value</div>
          <div>{{ currency.symbol }}{{ formattedTotal }}</div>
        </li>
        <li Divider />
        <li Item>
          <div>Total Portfolio Change</div>
          <div>+0.2</div>
        </li>
        <li Divider />
        <li Item>
          <div>Portfolio Return This Year</div>
          <div>32%</div>
        </li>
        <li Divider />
        <li Item>
          <div>Projected APY</div>
          <div>3,283%</div>
        </li>
      </ul>
    </section>

    <section DashBox class="grow">

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
import numeral, { createNumeralHelpers } from '../../lib/numeral.ts';
import MainchainIcon from '../../assets/mainchain-icon.svg';
import P2pIcon from '../../assets/p2p-icon.svg';
import ExternalIcon from '../../assets/external-icon.svg';
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

ul li[Item] {
  @apply relative my-1 flex flex-row items-center py-1.5;
  &[Clickable] {
    @apply cursor-pointer;
  }
  div {
    @apply relative z-10;
  }
  div:first-child {
    @apply grow;
  }
  &[Selected] {
    text-shadow: 1px 1px 1px white;
    div[Selector] {
      @apply block;
    }
    /*
      &:hover {
        @apply border-transparent;
      }
    */
  }

  div[Selector] {
    @apply absolute top-[-5px] left-0 z-0 hidden h-[calc(100%+10px)] w-[calc(100%+20px)] border-y border-slate-400/40 bg-[#ECE1EE] shadow-md;
    &::before {
      content: '';
      @apply absolute -top-px -left-px h-[calc(100%+7px)] w-4/12 bg-gradient-to-r from-white to-transparent;
    }
  }
}

[ArrowWrapper] {
  @apply absolute top-0 -right-full aspect-square h-[calc(100%+6px)] overflow-hidden pr-1.5 pb-1.5;
  svg {
    @apply absolute top-0 left-1/4 h-1/2 w-[calc(100%-6px)] origin-left -translate-y-1/2 rotate-90 drop-shadow-[1px_1px_1px_black];
  }
}

ul li[Divider] {
  @apply h-px border-t border-slate-400/40;
}
</style>
