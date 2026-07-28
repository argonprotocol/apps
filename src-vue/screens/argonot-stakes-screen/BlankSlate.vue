<template>
  <div class="flex grow flex-col">
    <div class="flex grow flex-col items-center justify-center">
      <div class="relative flex w-10/12 max-w-300 flex-col items-center py-10 text-center">
        <header class="text-argon-600/70 text-2xl font-normal tracking-widest">ARGONOT STAKES</header>
        <h1 class="mt-2 text-4xl font-bold opacity-80 xl:text-[2.6rem] 2xl:text-5xl">
          Earn a Share of the Mining Auctions
        </h1>
        <p class="mx-10 mt-3 flex-col text-xl leading-relaxed text-slate-900/60 xl:mx-40 2xl:mx-auto 2xl:flex">
          <span>Argonot Stakes pay you a share of each day’s Mining Auction profits, with onchain</span>
          <span>
            mechanics that keep your principal protected.
            <a :href="`${NetworkConfig.websiteHost}/docs/assets-and-entities/argonot-stakes`" target="_blank">
              Learn more &raquo;
            </a>
          </span>
        </p>

        <ul class="mt-10 flex w-full flex-row gap-x-4">
          <li class="w-1/3 rounded-md border border-slate-600/30 px-4 pt-6 pb-4">
            <Step1Icon class="text-argon-600/60 mx-auto h-18" />
            <header class="mt-5 mb-1 font-bold">1. Buy Stakes</header>
            <p class="mx-auto max-w-60 leading-relaxed text-slate-900/60">
              Your capital helps fund the liquidity need of the network.
            </p>
          </li>
          <li class="w-1/3 rounded-md border border-slate-600/30 px-4 pt-6 pb-4">
            <Step2Icon class="text-argon-600/60 mx-auto h-18" />
            <header class="mt-5 mb-1 font-bold">2. Earn from Miners</header>
            <p class="mx-auto max-w-60 leading-relaxed text-slate-900/60">
              You earn a share of revenue from mining seat auctions.
            </p>
          </li>
          <li class="w-1/3 rounded-md border border-slate-600/30 px-4 pt-6 pb-4">
            <Step3Icon class="text-argon-600/60 mx-auto h-18" />
            <header class="mt-5 mb-1 font-bold">3. Stay Protected</header>
            <p class="mx-auto max-w-60 leading-relaxed text-slate-900/60">
              Onchain mechanics make stakes impossible to default.
            </p>
          </li>
        </ul>

        <span class="relative">
          <button
            @click="openBondsOverlay('Argonot')"
            class="bg-argon-button hover:bg-argon-button-hover mt-12 cursor-pointer rounded-md border border-transparent px-12 py-3 text-lg font-bold text-white"
          >
            Buy Your First Argonot Stake
          </button>
        </span>
        <div class="mt-2 text-slate-800/60">It only takes a minute · Preview is free</div>
      </div>
    </div>
    <div class="relative px-0.5 pb-0.5">
      <img src="/treasury-footers/argon-bonds.png" class="w-full opacity-50" />
    </div>
  </div>
</template>

<script setup lang="ts">
import * as Vue from 'vue';
import { getVaults } from '../../stores/vaults.ts';
import { getWalletKeys } from '../../stores/wallets.ts';
import { getMainchainClient } from '../../stores/mainchain.ts';
import { getConfig } from '../../stores/config.ts';
import { BondLot, NetworkConfig } from '@argonprotocol/apps-core';
import { getArgonBonds } from '../../stores/argonBonds.ts';
import basicEmitter from '../../emitters/basicEmitter.ts';
import Step1Icon from './images/step1.svg?component';
import Step2Icon from './images/step2.svg?component';
import Step3Icon from './images/step3.svg?component';

const vaults = getVaults();
const walletKeys = getWalletKeys();
const config = getConfig();
const argonBonds = getArgonBonds();

const supportsArgnotBacking = Vue.ref(false);

function openBondsOverlay(programType: BondLot['programType']) {
  basicEmitter.emit('openBuyBondsOverlay', programType);
}

async function refreshMarketData() {
  if (!argonBonds.data.vaultId) return;

  const client = await getMainchainClient(false);
  const vault = vaults.vaultsById[argonBonds.data.vaultId];
  if (!vault) return;

  vaultBondSubscription?.();
  vaultBondSubscription = await argonBonds.subscribeVault(
    {
      vaultId: argonBonds.data.vaultId,
      operatorAddress: vault.operatorAccountId,
      accountId: walletKeys.defaultArgonAddress,
    },
    client,
  );
}

let unsubVault: (() => void) | undefined;
let vaultBondSubscription: (() => void) | undefined;

Vue.onMounted(async () => {
  await config.isLoadedPromise;
  await argonBonds.load();

  const client = await getMainchainClient(false);
  supportsArgnotBacking.value = 'buyArgonotBonds' in client.tx.treasury;

  if (argonBonds.data.vaultId) {
    unsubVault = await vaults.subscribeToVault(argonBonds.data.vaultId, () => {
      if (vaultBondSubscription) void refreshMarketData();
    });
  }

  await argonBonds.subscribeGlobal(client);
  await refreshMarketData();
});

Vue.onUnmounted(() => {
  unsubVault?.();
  vaultBondSubscription?.();
});
</script>
