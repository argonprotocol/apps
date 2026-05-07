<template>
  <div class="flex h-full flex-col px-9">
    <div v-if="!isLoaded" class="flex grow items-center justify-center text-slate-500">Loading…</div>

    <!-- Blank state -->
    <div v-else-if="!myBonds.bondLots.length" class="flex grow flex-col items-center justify-center">
      <div class="flex w-7/12 max-w-200 flex-col items-center pb-10">
        <div class="w-20 bg-white shadow-md">
          <BondIcon class="text-argon-600/60 inline-block w-full" />
        </div>
        <p class="mt-10 w-0 min-w-full border-y border-slate-400/50 py-4 text-[17px]/7 font-light whitespace-normal">
          Argon Bonds give you direct exposure to the profit returns of Argon's Stabilization Vaults. Each bond matures
          in ten days and is backed by the vault's own on-chain mechanics, which makes it impossible for a loan to
          default. This means your principal is always protected. The only question becomes: how much will your bond
          earn?
        </p>
        <span class="relative">
          <button
            @click="showBondsOverlay = true"
            :class="walletBalance ? '' : 'pointer-events-none bg-slate-600 opacity-40'"
            class="bg-argon-button hover:bg-argon-button-hover mt-12 cursor-pointer rounded-md px-12 py-2.5 text-base font-bold text-white"
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

          <div v-if="walletBalance" class="text-argon-600 relative text-xl leading-8 font-bold">
            Your account has {{ currency.symbol }}{{ microgonToMoneyNm(walletBalance).format('0,0.00') }} in savings
            that is
            <br />
            ready for immediate deployment.
          </div>
          <div v-else class="text-argon-600 relative text-xl leading-8 font-bold">
            This feature is disabled until your
            <br />
            <span @click="openArgonWallet" class="hover:text-argon-600/80 cursor-pointer underline">argon wallet</span>
            is funded.
          </div>
        </div>
      </div>
    </div>

    <template v-else>
      <!-- Pending return banner -->
      <div
        v-if="myBonds.bondTotals.returningBonds > 0"
        class="flex flex-row items-center gap-3 rounded-lg border border-amber-200 bg-amber-50 px-5 py-3"
      >
        <div class="text-sm text-amber-700">
          <span class="font-semibold">
            {{ currency.symbol }}{{ microgonToMoneyNm(myBonds.bondTotals.returningBondMicrogons).format('0,0.00') }}
          </span>
          is being returned to your wallet
          <template v-if="bondsReturnedDate">
            by
            <CountdownClock :time="bondsReturnedDate" v-slot="{ hours, minutes, seconds, days }">
              in
              <span v-if="days > 0">{{ days }} day{{ days === 1 ? '' : 's' }}</span>
              <template v-else-if="hours > 0">
                <span>{{ hours }} hour{{ hours === 1 ? '' : 's' }}</span>
                <span v-if="minutes > 0">{{ minutes }} minute{{ minutes === 1 ? '' : 's' }}</span>
              </template>
              <span v-else-if="minutes > 0">{{ minutes }} minute{{ minutes === 1 ? '' : 's' }}</span>
              <span v-else>{{ seconds }} second{{ seconds === 1 ? '' : 's' }}</span>
            </CountdownClock>
          </template>
        </div>
      </div>

      <section class="mt-5 mb-10 flex flex-row items-end gap-x-2 text-center">
        <div class="w-1/3 border-b border-slate-400/30 py-5">
          <div class="text-5xl font-bold">
            {{ currency.symbol }}
            <FormattedMoney :value="myBonds.bondTotals.activeBondMicrogons" />
          </div>
          <div>Total Capital Invested</div>
        </div>
        <div class="h-full w-px bg-slate-400/30" />
        <div class="w-1/3 border-b border-slate-400/30 py-5">
          <div class="text-5xl font-bold">
            {{ currency.symbol }}
            <FormattedMoney :value="myBonds.bondTotals.lifetimeEarnings" />
          </div>
          <div>Distributed Profits</div>
        </div>
        <div class="h-full w-px bg-slate-400/30" />
        <div class="w-1/3 border-b border-slate-400/30 py-5">
          <div class="text-5xl font-bold">{{ numeral(performanceReturn).format('0,0.00') }}%</div>
          <div>Performance Return</div>
        </div>
      </section>

      <div
        v-if="myBonds.bondLots.length > 0"
        class="overflow-hidden rounded-lg border border-slate-300/50 bg-white shadow-sm"
      >
        <table class="w-full text-left">
          <thead class="border-b border-slate-100 text-xs font-semibold tracking-wide text-slate-400 uppercase">
            <tr>
              <th class="px-6 py-2.5">Bond Lot</th>
              <th class="px-6 py-2.5">Principal</th>
              <th class="px-6 py-2.5">Returns</th>
              <th class="px-6 py-2.5 text-right">Status</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="lot in myBonds.bondLots" :key="lot.id" class="border-b border-slate-50 last:border-0">
              <td class="px-6 py-3">
                <div class="text-sm font-semibold text-slate-700">Lot #{{ lot.id }}</div>
                <div class="mt-0.5 text-xs text-slate-400">
                  {{ lot.canRelease ? `Created frame ${lot.createdFrame}` : 'Legacy bond position' }}
                </div>
              </td>
              <td class="px-6 py-3 font-mono text-sm font-medium text-slate-800">
                {{ currency.symbol }}{{ microgonToMoneyNm(lot.bondMicrogons).format('0,0.00') }}
              </td>
              <td class="px-6 py-3">
                <div class="font-mono text-sm font-medium text-slate-700">
                  +{{ currency.symbol }}{{ microgonToMoneyNm(lot.lifetimeEarnings).format('0,0.00') }} ({{
                    numeral(returnToDate(lot.bondMicrogons, lot.lifetimeEarnings)).format('0,0.00')
                  }}%)
                </div>
                <div v-if="lot.lastEarningsFrame != null" class="mt-0.5 text-xs text-slate-400">
                  Last paid frame {{ lot.lastEarningsFrame }}
                </div>
              </td>
              <td class="px-6 py-3">
                <div class="flex items-center justify-end gap-3">
                  <span
                    class="rounded-full px-2.5 py-1 text-xs font-semibold"
                    :class="lot.isReleasing ? 'bg-amber-50 text-amber-700' : 'bg-slate-100 text-slate-500'"
                  >
                    {{ lot.isReleasing ? 'Returning' : 'Active' }}
                  </span>
                  <button
                    v-if="lot.canRelease && !lot.isReleasing"
                    type="button"
                    :disabled="!!releasingLotIds[lot.id]"
                    class="rounded border border-slate-300 px-3 py-1.5 text-sm font-semibold text-slate-600 hover:bg-slate-50 disabled:cursor-default disabled:opacity-40"
                    @click="releaseBondLot(lot)"
                  >
                    {{ releasingLotIds[lot.id] ? 'Liquidating...' : 'Liquidate' }}
                  </button>
                </div>
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      <div
        @click="showBondsOverlay = true"
        class="mt-5 flex cursor-pointer flex-col items-center justify-center border-2 border-dashed border-slate-500/50 py-12"
      >
        + Buy More Bonds
      </div>
    </template>

    <BuyBondsOverlay v-if="showBondsOverlay" @close="showBondsOverlay = false" @submitted="onSubmitted" />
  </div>
</template>

<script setup lang="ts">
import * as Vue from 'vue';
import dayjs from 'dayjs';
import utc from 'dayjs/plugin/utc';
import BigNumber from 'bignumber.js';
import numeral, { createNumeralHelpers } from '../../lib/numeral.ts';
import { getCurrency } from '../../stores/currency.ts';
import { getVaults } from '../../stores/vaults.ts';
import { getWalletKeys, useWallets } from '../../stores/wallets.ts';
import { getMainchainClient, getMiningFrames } from '../../stores/mainchain.ts';
import { getConfig } from '../../stores/config.ts';
import { BondLot, NetworkConfig, TreasuryBonds } from '@argonprotocol/apps-core';
import { getBondMarket, type IFrameEarningsRow, useMyBonds } from '../../stores/myBonds.ts';
import BuyBondsOverlay from '../overlays/BuyBondsOverlay.vue';
import CountdownClock from '../../components/CountdownClock.vue';
import CurvedArrow from '../../components/CurvedArrow.vue';
import Tooltip from '../../components/Tooltip.vue';
import BondIcon from '../../assets/bond.svg?component';
import { TICK_MILLIS } from '../../lib/Env.ts';
import { getTransactionTracker } from '../../stores/transactions.ts';
import { ExtrinsicType } from '../../lib/db/TransactionsTable.ts';
import basicEmitter from '../../emitters/basicEmitter.ts';
import { WalletType } from '../../lib/Wallet.ts';
import FormattedMoney from '../../components/FormattedMoney.vue';
import { calculatePerformanceReturn } from '../lib/PerformanceReturn.ts';

dayjs.extend(utc);

interface IFrameRow extends IFrameEarningsRow {
  date: Date;
}

const currency = getCurrency();
const vaults = getVaults();
const wallets = useWallets();
const walletKeys = getWalletKeys();
const miningFrames = getMiningFrames();
const config = getConfig();
const myBonds = useMyBonds();
const bondMarket = getBondMarket();
const transactionTracker = getTransactionTracker();
const { microgonToMoneyNm } = createNumeralHelpers(currency);

const isLoaded = Vue.ref(false);
const showBondsOverlay = Vue.ref(false);
const showAllHistory = Vue.ref(false);
const vaultTotalCapacity = Vue.ref(0n);
const distributableBidPool = Vue.ref(0n);
const globalActiveCapital = Vue.ref(0n);
const vaultActiveCapital = Vue.ref(0n);
const releasingLotIds = Vue.ref<Record<number, boolean>>({});
const performanceReturn = Vue.ref(0);

const walletBalance = Vue.computed(() => wallets.investmentWallet.availableMicrogons);
const vaultBondState = Vue.computed(() => bondMarket.data.vaultsById[myBonds.vaultId]);
const vaultBondLots = Vue.computed(() => vaultBondState.value?.bondLots ?? []);

const nextFrameBondAvailability = Vue.computed(() => {
  return TreasuryBonds.calculateNextFrameBondAvailability(
    vaultTotalCapacity.value,
    vaultBondLots.value,
    bondMarket.data.bondFullCapacityPerFrame,
  );
});

const vaultAvailableCapacity = Vue.computed(() => {
  return BondLot.bondsToMicrogons(nextFrameBondAvailability.value.nextFrameAvailableBonds);
});

const frameHistory = Vue.computed<IFrameRow[]>(() => {
  return myBonds.frameHistory
    .filter(row => row.frameId > 0)
    .map(row => {
      let date: Date;
      if (miningFrames.framesById[row.frameId]) {
        date = miningFrames.getFrameDate(row.frameId);
      } else {
        const frameDiff = miningFrames.currentFrameId - row.frameId;
        date = new Date(Date.now() - frameDiff * TICK_MILLIS);
      }
      return { ...row, date };
    });
});

const bondsReturnedDate = Vue.computed(() => {
  const returningBondFrame = myBonds.bondTotals.returningBondFrame;
  if (returningBondFrame == null) return null;
  return dayjs.utc(miningFrames.getFrameDate(returningBondFrame));
});

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

async function releaseBondLot(lot: BondLot) {
  if (releasingLotIds.value[lot.id]) return;

  releasingLotIds.value = { ...releasingLotIds.value, [lot.id]: true };
  try {
    const client = await getMainchainClient(false);
    const signer = await walletKeys.getInvestmentKeypair();
    const tx = await TreasuryBonds.buildReleaseBondLotTx({ client, bondLot: lot });
    const info = await transactionTracker.submitAndWatch({
      tx,
      txSigner: signer,
      extrinsicType: ExtrinsicType.TreasuryReleaseBondLot,
      metadata: {
        bondLotId: lot.id,
        releasedBondMicrogons: lot.bondMicrogons,
      },
    });

    info.subscribeToProgress((args, error) => {
      if (args.progressPct >= 100 && !error) {
        void onSubmitted();
      }
      if (error) {
        releasingLotIds.value = { ...releasingLotIds.value, [lot.id]: false };
      }
    });
  } catch {
    releasingLotIds.value = { ...releasingLotIds.value, [lot.id]: false };
  }
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
      accountId: walletKeys.investmentAddress,
    },
    client,
  );
}

function openArgonWallet() {
  basicEmitter.emit('openWalletOverlay', { walletType: WalletType.investment });
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

  const investments = myBonds.bondLots.map(bondLot => {
    return {
      startDate: miningFrames.getFrameDate(bondLot.createdFrame),
      endDate: new Date(),
      startCapital: bondLot.activeBondMicrogons,
      endCapital: bondLot.activeBondMicrogons + bondLot.lifetimeEarnings,
    };
  });
  performanceReturn.value = calculatePerformanceReturn(investments).percent;

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
