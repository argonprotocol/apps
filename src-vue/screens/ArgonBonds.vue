<template>
  <div DashBox class="flex h-full min-h-0 grow flex-col">
    <div v-if="!isLoaded" class="flex grow items-center justify-center text-slate-500">Loading…</div>

    <!-- Blank state -->
    <div v-else-if="!bondLots.length" class="flex grow flex-col">
      <div class="flex grow flex-col items-center justify-center">
        <div class="flex w-8/12 max-w-200 flex-col items-center py-10">
          <header class="text-argon-600 pb-3 text-xl font-bold">
            Argon Bonds Tap Into the Upside Growth of the Network
          </header>
          <p
            class="w-0 min-w-full border-y border-slate-400/50 py-4 text-justify text-[17px]/7 font-light whitespace-normal"
          >
            Argon Bonds give you direct exposure to the profit returns of Argon's Stabilization Vaults. These bonds are
            backed by own on-chain mechanics that make it impossible for a loan to default. This means your principal is
            always protected. The only question becomes: how much will your bond earn?
          </p>
          <span class="relative">
            <button
              @click="showBondsOverlay = true"
              :class="
                financials.savingsTotalReadyToUse
                  ? 'bg-argon-button hover:bg-argon-button-hover border-transparent text-white'
                  : 'pointer-events-none border-gray-500 bg-white text-gray-500 opacity-40'
              "
              class="mt-12 cursor-pointer rounded-md border px-12 py-3 text-lg font-bold"
            >
              Purchase Argon Bonds
            </button>
            <CurvedArrow class="pointer-events-none absolute top-14 left-full h-22 translate-y-1 text-slate-400/80" />
          </span>
          <div class="relative mt-14 text-center">
            <div class="pointer-events-none absolute inset-0 flex items-center justify-center">
              <div
                class="h-24 w-80 rounded-full opacity-95 blur-lg"
                style="
                  background: radial-gradient(
                    ellipse at center,
                    #fffedc 0%,
                    #fffedc 42%,
                    rgba(255, 254, 220, 0.45) 62%,
                    rgba(255, 255, 255, 0) 78%
                  );
                "
              />
            </div>

            <div v-if="financials.savingsTotalReadyToUse" class="text-argon-600 relative text-xl leading-8 font-bold">
              Your account has {{ currency.symbol
              }}{{ microgonToMoneyNm(financials.savingsTotalReadyToUse).format('0,0.00') }} in savings that is
              <br />
              ready for immediate deployment.
            </div>
            <div v-else class="text-argon-600 relative text-xl leading-8 font-bold">
              This feature is disabled until your
              <br />
              <span @click="openArgonWallet" class="hover:text-argon-600/80 inline-block cursor-pointer underline">
                argon wallet
              </span>
              is funded.
            </div>
          </div>
        </div>
      </div>
      <div class="relative px-0.5 pb-0.5">
        <img src="/treasury-footers/argon-bonds.png" class="w-full opacity-50" />
      </div>
    </div>

    <div v-else class="flex min-h-0 grow flex-col">
      <section class="mt-5 flex flex-row items-end gap-x-2 px-9 text-center">
        <div class="w-1/3 border-b border-slate-400/30 py-5">
          <div class="text-argon-600 inline-flex text-5xl font-bold">
            <span>{{ currency.symbol }}</span>
            <FormattedMoney :isLoaded="myBonds.isLoaded" :value="bondsTotalValue" />
          </div>
          <div>Total Capital Invested</div>
        </div>
        <div class="h-full w-px bg-slate-400/30" />
        <div class="w-1/3 border-b border-slate-400/30 py-5">
          <div class="text-argon-600 inline-flex text-5xl font-bold">
            <span>{{ currency.symbol }}</span>
            <FormattedMoney :isLoaded="myBonds.isLoaded" :value="bondsTotalProfits" />
          </div>
          <div>Distributed Profits</div>
        </div>
        <div class="h-full w-px bg-slate-400/30" />
        <div class="w-1/3 border-b border-slate-400/30 py-5">
          <div class="text-argon-600 text-5xl font-bold">
            {{ numeral(returnToDate(bondsTotalValue, bondsTotalProfits)).format('0,0.00') }}%
          </div>
          <div>Performance Return</div>
        </div>
      </section>

      <div class="relative flex min-h-0 grow flex-col">
        <div class="flex flex-col overflow-y-auto px-9 pt-10 pb-5">
          <div class="flex flex-row items-center text-slate-800/70">
            <span class="grow">
              You have {{ bondLots.length }} bond transaction{{ bondLots.length === 1 ? '' : 's' }}...
            </span>
            <div class="flex flex-row items-stretch gap-x-3">
              <button @click="showBondsOverlay = true" class="text-md text-argon-600 cursor-pointer">
                Buy More Bonds
              </button>
              <div class="w-px bg-slate-400/50" />
              <a href="https://argon.network/" target="_blank" class="text-md text-argon-600 cursor-pointer">
                View Docs
              </a>
            </div>
          </div>
        </div>

        <section class="flex flex-col gap-y-3 px-9">
          <BondRecord
            v-for="bondLot in bondLots"
            :key="bondLot.id"
            :bondLot="bondLot"
            :isReleasing="bondLot.isReleasing"
            @click="openDetail(bondLot)"
            @liquidate="openDetail"
          />
        </section>
        <div class="absolute top-0 left-0 h-10 w-full bg-linear-to-b from-white to-transparent" />
      </div>
      <div class="relative px-0.5 pb-0.5">
        <img src="/treasury-footers/argon-bonds.png" class="w-full opacity-50" />
      </div>
    </div>

    <BuyBondsOverlay v-if="showBondsOverlay" @close="showBondsOverlay = false" @submitted="onSubmitted" />
    <BondDetailOverlay
      v-if="showDetailOverlay && selectedBondLot"
      :bondLot="selectedBondLot"
      @close="closeDetail"
      @submitted="onSubmitted"
    />
  </div>
</template>

<script setup lang="ts">
import * as Vue from 'vue';
import dayjs from 'dayjs';
import utc from 'dayjs/plugin/utc';
import BigNumber from 'bignumber.js';
import numeral, { createNumeralHelpers } from '../lib/numeral.ts';
import { getCurrency } from '../stores/currency.ts';
import { getVaults } from '../stores/vaults.ts';
import { getWalletKeys } from '../stores/wallets.ts';
import { getMainchainClient, getMiningFrames } from '../stores/mainchain.ts';
import { getConfig } from '../stores/config.ts';
import { BondLot, TreasuryBonds } from '@argonprotocol/apps-core';
import { getBondMarket, useMyBonds } from '../stores/myBonds.ts';
import BuyBondsOverlay from '../overlays/BuyBondsOverlay.vue';
import CountdownClock from '../components/CountdownClock.vue';
import CurvedArrow from '../components/CurvedArrow.vue';
import BondIcon from '../assets/bond.svg?component';
import basicEmitter from '../emitters/basicEmitter.ts';
import { WalletType } from '../lib/Wallet.ts';
import FormattedMoney from '../components/FormattedMoney.vue';
import { useFinancials } from '../stores/financials.ts';
import BondRecord from './treasury-screens/components/BondRecord.vue';
import BondDetailOverlay from '../app-treasury/overlays/BondDetailOverlay.vue';

dayjs.extend(utc);

const currency = getCurrency();
const financials = useFinancials();
const vaults = getVaults();
const walletKeys = getWalletKeys();
const miningFrames = getMiningFrames();
const config = getConfig();
const myBonds = useMyBonds();
const bondMarket = getBondMarket();
const { microgonToMoneyNm } = createNumeralHelpers(currency);

const isLoaded = Vue.ref(false);
const showBondsOverlay = Vue.ref(false);
const showDetailOverlay = Vue.ref(false);
const vaultTotalCapacity = Vue.ref(0n);
const selectedBondLot = Vue.ref<BondLot | undefined>();
const bondLots = Vue.computed(() => myBonds.bondLots.filter(bondLot => bondLot.programType === 'Vault'));
const bondsTotalValue = Vue.computed(() => {
  return bondLots.value.reduce((sum, bondLot) => sum + bondLot.bondMicrogons, 0n);
});
const bondsTotalProfits = Vue.computed(() => {
  return bondLots.value.reduce((sum, bondLot) => sum + bondLot.lifetimeEarnings, 0n);
});

const vaultBondState = Vue.computed(() => bondMarket.data.vaultsById[myBonds.vaultId]);

function returnToDate(investment: bigint, earnings: bigint): number {
  const pctBn = BigNumber(earnings).dividedBy(investment);
  return pctBn.multipliedBy(100).toNumber();
}

async function onSubmitted() {
  showBondsOverlay.value = false;
  await myBonds.refreshBondLots();
  await myBonds.refreshFrameHistory();
  await refreshMarketData();
}

function openDetail(bondLot: BondLot) {
  selectedBondLot.value = bondLot;
  showDetailOverlay.value = true;
}

function closeDetail() {
  showDetailOverlay.value = false;
  selectedBondLot.value = undefined;
}

async function refreshMarketData() {
  if (!myBonds.vaultId) return;

  const client = await getMainchainClient(false);
  const vault = vaults.vaultsById[myBonds.vaultId];
  if (!vault) return;

  vaultBondSubscription?.();
  vaultBondSubscription = await bondMarket.subscribeVault(
    {
      vaultId: myBonds.vaultId,
      operatorAddress: vault.operatorAccountId,
      accountId: walletKeys.defaultArgonAddress,
    },
    client,
  );
}

function openArgonWallet() {
  basicEmitter.emit('openWalletOverlay', { walletType: WalletType.defaultArgon });
}

let unsubVault: (() => void) | undefined;
let unsubFrameId: { unsubscribe: () => void } | undefined;
let vaultBondSubscription: (() => void) | undefined;

Vue.onMounted(async () => {
  await config.isLoadedPromise;
  await myBonds.load();

  const client = await getMainchainClient(false);

  if (myBonds.vaultId) {
    unsubVault = await vaults.subscribeToVault(myBonds.vaultId, () => {
      const vault = vaults.vaultsById[myBonds.vaultId];
      if (vault) {
        vaultTotalCapacity.value = vault.securitization;
      }

      void refreshMarketData();
    });
  }

  await bondMarket.subscribeGlobal(client);
  await refreshMarketData();

  isLoaded.value = true;

  unsubFrameId = miningFrames.onFrameId(() => {
    void refreshMarketData();
  });
});

Vue.onUnmounted(() => {
  unsubVault?.();
  vaultBondSubscription?.();
  unsubFrameId?.unsubscribe();
});
</script>

<style scoped>
.frame-row-enter-active {
  transition: all 0.4s ease-out;
}
.frame-row-move {
  transition: transform 0.4s ease-out;
}
.frame-row-enter-from {
  opacity: 0;
  transform: translateY(-100%);
}
</style>
