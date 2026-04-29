<!-- prettier-ignore -->
<template>
  <div class="flex flex-col h-full">
    <div v-if="!isLoaded" class="flex grow items-center justify-center text-slate-500">
      Loading…
    </div>

    <template v-else>
      <!-- Pending return banner -->
      <div
        v-if="myBonds.bondTotals.returningBonds > 0"
        class="rounded-lg border border-amber-200 bg-amber-50 px-5 py-3 flex flex-row items-center gap-3">
        <div class="text-sm text-amber-700">
          <span class="font-semibold">{{ currency.symbol }}{{ microgonToMoneyNm(myBonds.bondTotals.returningBondMicrogons).format('0,0.00') }}</span>
          is being returned to your wallet
          <template v-if="bondsReturnedDate">
            by
            <CountdownClock :time="bondsReturnedDate" v-slot="{ hours, minutes, seconds, days }">
              in
              <span v-if="days > 0">{{ days }} day{{ days === 1 ? '' : 's' }}</span>
              <template v-else-if="hours > 0">
                <span>{{ hours }} hour{{ hours === 1 ? '' : 's' }}</span>
                <span v-if="minutes > 0"> {{ minutes }} minute{{ minutes === 1 ? '' : 's' }}</span>
              </template>
              <span v-else-if="minutes > 0">{{ minutes }} minute{{ minutes === 1 ? '' : 's' }}</span>
              <span v-else>{{ seconds }} second{{ seconds === 1 ? '' : 's' }}</span>
            </CountdownClock>
          </template>
        </div>
      </div>

      <!-- Active bond stats -->
      <div v-if="myBonds.bondTotals.activeBonds > 0" class="rounded-lg border border-slate-300/50 bg-white px-6 py-4 shadow-sm">
        <div class="flex flex-row gap-8 items-stretch">
          <div class="shrink-0">
            <div class="text-xs font-medium uppercase tracking-wide text-slate-400">Bonds Held</div>
            <div class="mt-1 text-3xl font-bold text-argon-text-primary font-mono">
              {{ currency.symbol }}{{ microgonToMoneyNm(myBonds.bondTotals.activeBondMicrogons).format('0,0.00') }}
            </div>
          </div>

          <div class="w-px bg-slate-100 self-stretch"></div>

          <div class="shrink-0">
            <div class="text-xs font-medium uppercase tracking-wide text-slate-400">Est. APY</div>
            <div class="mt-1 text-2xl font-bold text-slate-700 font-mono">
              {{ numeral(myBonds.estimatedApy).formatIfElseCapped('< 100', '0,0.[00]', '0,0', 9_999) }}%
            </div>
          </div>
        </div>
      </div>

      <div v-if="myBonds.bondLots.length > 0" class="overflow-hidden rounded-lg border border-slate-300/50 bg-white shadow-sm">
        <table class="w-full text-left">
          <thead class="border-b border-slate-100 text-xs font-semibold uppercase tracking-wide text-slate-400">
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
                  +{{ currency.symbol }}{{ microgonToMoneyNm(lot.lifetimeEarnings).format('0,0.00') }}
                </div>
                <div v-if="lot.lastEarningsFrame != null" class="mt-0.5 text-xs text-slate-400">
                  Last paid frame {{ lot.lastEarningsFrame }}
                </div>
              </td>
              <td class="px-6 py-3">
                <div class="flex items-center justify-end gap-3">
                  <span
                    class="rounded-full px-2.5 py-1 text-xs font-semibold"
                    :class="lot.isReleasing ? 'bg-amber-50 text-amber-700' : 'bg-slate-100 text-slate-500'">
                    {{ lot.isReleasing ? 'Returning' : 'Active' }}
                  </span>
                  <button
                    v-if="lot.canRelease && !lot.isReleasing"
                    type="button"
                    :disabled="!!releasingLotIds[lot.id]"
                    class="rounded border border-slate-300 px-3 py-1.5 text-sm font-semibold text-slate-600 hover:bg-slate-50 disabled:cursor-default disabled:opacity-40"
                    @click="releaseBondLot(lot)">
                    {{ releasingLotIds[lot.id] ? 'Liquidating...' : 'Liquidate' }}
                  </button>
                </div>
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      <!-- Blank state -->
      <div v-else class="grow flex flex-col items-center justify-center">
        <div class="flex flex-col w-7/12 max-w-200 pb-10 items-center">
          <div class="bg-white shadow-md w-20">
            <BondIcon class="w-full inline-block text-argon-600/60" />
          </div>
          <p class="w-0 min-w-full whitespace-normal border-y border-slate-400/50 py-4 mt-10 text-[17px]/7 font-light">
            Argon Bonds give you direct exposure to the profit returns of Argon's Stabilization Vaults. Each bond matures
            in ten days and is backed by the vault's own on-chain mechanics, which makes it impossible for a loan to
            default. This means your principal is always protected. The only question becomes: how much will your bond
            earn?
          </p>
          <span class="relative">
            <button
              @click="showBondsOverlay = true"
              :class="walletBalance ? '' : 'pointer-events-none opacity-40 bg-slate-600'"
              class="bg-argon-button hover:bg-argon-button-hover cursor-pointer rounded-md mt-12 px-12 py-2.5 text-base font-bold text-white"
            >
              Purchase Argon Bonds
            </button>
            <CurvedArrow
              class="pointer-events-none absolute left-full top-14 h-22 text-slate-400/80 translate-y-1"
            />
          </span>
          <div class="relative mt-14 text-center">
            <div class="pointer-events-none absolute inset-0 flex items-center justify-center">
              <div
                class="h-24 w-80 rounded-full opacity-95 blur-lg"
                style="background: radial-gradient(ellipse at center, #FFFEDC 0%, #FFFEDC 42%, rgba(255, 254, 220, 0.45) 62%, rgba(255, 255, 255, 0) 78%);"
              />
            </div>

            <div v-if="walletBalance" class="relative text-argon-600 font-bold text-xl leading-8">
              Your account has {{ currency.symbol }}{{ microgonToMoneyNm(walletBalance).format('0,0.00') }} in savings that is<br />
              ready for immediate deployment.
            </div>
            <div v-else class="relative text-argon-600 font-bold text-xl leading-8">
              This feature is disabled until your<br />
              <span @click="openArgonWallet" class="underline cursor-pointer hover:text-argon-600/80">argon wallet</span> is funded.
            </div>
          </div>
        </div>
      </div>

    </template>

    <BuyBondsOverlay
      v-if="showBondsOverlay"
      :vaultId="myBonds.vaultId"
      :currentAmount="myBonds.bondTotals.activeBondMicrogons"
      :walletBalance="walletBalance"
      :availableVaultSpace="vaultAvailableCapacity"
      @close="showBondsOverlay = false"
      @submitted="onSubmitted"
    />
  </div>
</template>

<script setup lang="ts">
import * as Vue from 'vue';
import dayjs from 'dayjs';
import utc from 'dayjs/plugin/utc';
import numeral, { createNumeralHelpers } from '../../lib/numeral.ts';
import { getCurrency } from '../../stores/currency.ts';
import { getVaults } from '../../stores/vaults.ts';
import { getWalletKeys, useWallets } from '../../stores/wallets.ts';
import { getMainchainClient, getMiningFrames } from '../../stores/mainchain.ts';
import { getConfig } from '../../stores/config.ts';
import { BondLot, NetworkConfig, TreasuryBonds } from '@argonprotocol/apps-core';
import { getBondMarket, type IFrameEarningsRow, useMyBonds } from '../../stores/myBonds.ts';
import BuyBondsOverlay from '../../app-shared/overlays/BuyBondsOverlay.vue';
import CountdownClock from '../../components/CountdownClock.vue';
import CurvedArrow from '../../components/CurvedArrow.vue';
import Tooltip from '../../components/Tooltip.vue';
import BondIcon from '../../assets/bond.svg?component';
import { TICK_MILLIS } from '../../lib/Env.ts';
import { getTransactionTracker } from '../../stores/transactions.ts';
import { ExtrinsicType } from '../../lib/db/TransactionsTable.ts';
import basicEmitter from '../../emitters/basicEmitter.ts';
import { WalletType } from '../../lib/Wallet.ts';

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

async function onSubmitted() {
  showBondsOverlay.value = false;
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

  unsubVault = await vaults.subscribeToVault(myBonds.vaultId, () => {
    const vault = vaults.vaultsById[myBonds.vaultId];
    if (vault) {
      vaultTotalCapacity.value = vault.securitization;
    }

    void refreshMarketData();
  });

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
