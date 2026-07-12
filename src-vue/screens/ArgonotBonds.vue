<template>
  <div DashBox class="flex h-full min-h-0 grow flex-col">
    <div v-if="!isLoaded" class="flex grow items-center justify-center text-slate-500">Loading…</div>

    <!-- Blank state -->
    <div v-else-if="!bondLots.length" class="flex grow flex-col">
      <div class="flex grow flex-col items-center justify-center">
        <div class="flex w-8/12 max-w-200 flex-col items-center py-10">
          <header class="text-argon-600 pb-3 text-xl font-bold">
            Argonot Bonds Tap Into the Upside Growth of the Network
          </header>
          <p
            class="w-0 min-w-full border-y border-slate-400/50 py-4 text-justify text-[17px]/7 font-light whitespace-normal"
          >
            Argonot Bonds allow you to generate yield on Argonots as the competition for Mining Seats heats up. The more
            Argonots you have, the larger share of the Mining Auction pool you have rights to claim every day.
          </p>
          <span class="relative">
            <button
              @click="showBondsOverlay = true"
              :disabled="!canBuyArgonotBonds"
              :class="
                canBuyArgonotBonds
                  ? 'bg-argon-button hover:bg-argon-button-hover border-transparent text-white'
                  : 'pointer-events-none border-gray-500 bg-white text-gray-500 opacity-40'
              "
              class="mt-12 cursor-pointer rounded-md border px-12 py-3 text-lg font-bold"
            >
              Purchase Argonot Bonds
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

            <div v-if="!supportsArgonotBonds" class="text-argon-600 relative text-xl leading-8 font-bold">
              Argonot bonds will be available after
              <br />
              the connected runtime is upgraded.
            </div>
            <div
              v-else-if="wallets.defaultArgonWallet.availableMicronots"
              class="text-argon-600 relative text-xl leading-8 font-bold"
            >
              Your account has
              {{ micronotToArgonotNm(wallets.defaultArgonWallet.availableMicronots).format('0,0.00') }} ARGNOT that is
              <br />
              ready for immediate deployment.
            </div>
            <div v-else class="text-argon-600 relative text-xl leading-8 font-bold">
              This feature is disabled until your Argon wallet
              <br />
              <span @click="openArgonWallet" class="hover:text-argon-600/80 inline-block cursor-pointer underline">
                has Argonots
              </span>
              available.
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
        <div class="w-1/2 border-b border-slate-400/30 py-5">
          <div class="text-argon-600 inline-flex text-5xl font-bold">
            {{ micronotToArgonotNm(bondsTotalValue).format('0,0.00') }} ARGNOT
          </div>
          <div>Total Argonots Bonded</div>
        </div>
        <div class="h-full w-px bg-slate-400/30" />
        <div class="w-1/2 border-b border-slate-400/30 py-5">
          <div class="text-argon-600 inline-flex text-5xl font-bold">
            <span>{{ currency.symbol }}</span>
            <FormattedMoney :isLoaded="myBonds.isLoaded" :value="bondsTotalProfits" />
          </div>
          <div>Distributed Profits</div>
        </div>
      </section>

      <div class="relative flex min-h-0 grow flex-col">
        <div class="flex flex-col overflow-y-auto px-9 pt-10 pb-5">
          <div class="flex flex-row items-center text-slate-800/70">
            <span class="grow">
              You have {{ bondLots.length }} bond transaction{{ bondLots.length === 1 ? '' : 's' }}...
            </span>
            <div class="flex flex-row items-stretch gap-x-3">
              <button
                :disabled="!canBuyArgonotBonds"
                class="text-md text-argon-600 cursor-pointer disabled:cursor-default disabled:opacity-40"
                @click="showBondsOverlay = true"
              >
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

    <BuyBondsOverlay
      v-if="showBondsOverlay"
      programType="Argonot"
      @close="showBondsOverlay = false"
      @submitted="onSubmitted"
    />
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
import { createNumeralHelpers } from '../lib/numeral.ts';
import { getCurrency } from '../stores/currency.ts';
import { useWallets } from '../stores/wallets.ts';
import { getMainchainClient } from '../stores/mainchain.ts';
import { BondLot } from '@argonprotocol/apps-core';
import { useMyBonds } from '../stores/myBonds.ts';
import BuyBondsOverlay from '../overlays/BuyBondsOverlay.vue';
import CurvedArrow from '../components/CurvedArrow.vue';
import basicEmitter from '../emitters/basicEmitter.ts';
import { WalletType } from '../lib/Wallet.ts';
import FormattedMoney from '../components/FormattedMoney.vue';
import BondRecord from './treasury-screens/components/BondRecord.vue';
import BondDetailOverlay from '../app-treasury/overlays/BondDetailOverlay.vue';

const currency = getCurrency();
const wallets = useWallets();
const myBonds = useMyBonds();
const { micronotToArgonotNm } = createNumeralHelpers(currency);

const isLoaded = Vue.ref(false);
const supportsArgonotBonds = Vue.ref(false);
const showBondsOverlay = Vue.ref(false);
const showDetailOverlay = Vue.ref(false);
const selectedBondLot = Vue.ref<BondLot | undefined>();
const bondLots = Vue.computed(() => myBonds.bondLots.filter(bondLot => bondLot.programType === 'Argonot'));
const canBuyArgonotBonds = Vue.computed(() => {
  return supportsArgonotBonds.value && wallets.defaultArgonWallet.availableMicronots > 0n;
});
const bondsTotalValue = Vue.computed(() => {
  return bondLots.value.reduce((sum, bondLot) => sum + bondLot.bondMicrogons, 0n);
});
const bondsTotalProfits = Vue.computed(() => {
  return bondLots.value.reduce((sum, bondLot) => sum + bondLot.lifetimeEarnings, 0n);
});

async function onSubmitted() {
  showBondsOverlay.value = false;
  await myBonds.refreshBondLots();
}

function openDetail(bondLot: BondLot) {
  selectedBondLot.value = bondLot;
  showDetailOverlay.value = true;
}

function closeDetail() {
  showDetailOverlay.value = false;
  selectedBondLot.value = undefined;
}

function openArgonWallet() {
  basicEmitter.emit('openWalletOverlay', { walletType: WalletType.defaultArgon });
}

Vue.onMounted(async () => {
  await myBonds.load();

  const client = await getMainchainClient(false);
  supportsArgonotBonds.value = 'buyArgonotBonds' in client.tx.treasury;

  isLoaded.value = true;
});
</script>
