<!-- prettier-ignore -->
<template>
  <div class="flex h-full flex-col px-4 py-4 gap-4">
    <header class="flex flex-row items-center justify-between">
      <div>
        <h2 class="text-xl font-bold text-slate-800/70">Argon Bonds</h2>
        <div v-if="isLoaded && vaultTotalCapacity > 0n" class="mt-0.5 text-sm text-slate-400">
          <span class="font-medium text-slate-600">{{ currency.symbol }}{{ microgonToMoneyNm(vaultAvailableCapacity).format('0,0.00') }}</span>
          available of
          <span>{{ currency.symbol }}{{ microgonToMoneyNm(vaultTotalCapacity).format('0,0.00') }}</span>
          vault capacity
        </div>
      </div>
      <button
        v-if="myBonds.bondLots.length > 0 && vaultAvailableCapacity > 0n"
        @click="showOverlay = true"
        class="bg-argon-button hover:bg-argon-button-hover cursor-pointer rounded-md px-5 py-2 text-base font-bold text-white">
        Buy Bonds
      </button>
    </header>

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
      <div
        v-else
        class="flex grow flex-col items-center justify-center gap-4">
        <div class="text-center">
          <div class="text-base font-medium text-argon-text-primary">No active bond</div>
          <div class="mt-1 text-sm text-slate-400">
            Buy bonds to earn treasury yield from Vault #{{ myBonds.vaultId }}
          </div>
        </div>
        <button
          @click="showOverlay = true"
          class="bg-argon-button hover:bg-argon-button-hover cursor-pointer rounded-md px-6 py-2.5 text-base font-bold text-white">
          Buy Bonds
        </button>
      </div>

    </template>

    <BuyBondsOverlay
      v-if="showOverlay"
      :vaultId="myBonds.vaultId"
      :walletBalance="wallets.liquidLockingWallet.availableMicrogons"
      :availableVaultSpace="vaultAvailableCapacity"
      @close="showOverlay = false"
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
import Tooltip from '../../components/Tooltip.vue';
import { TICK_MILLIS } from '../../lib/Env.ts';
import { getTransactionTracker } from '../../stores/transactions.ts';
import { ExtrinsicType } from '../../lib/db/TransactionsTable.ts';

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
const showOverlay = Vue.ref(false);
const vaultTotalCapacity = Vue.ref(0n);
const releasingLotIds = Vue.ref<Record<number, boolean>>({});

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

const bondsReturnedDate = Vue.computed(() => {
  const returningBondFrame = myBonds.bondTotals.returningBondFrame;
  if (returningBondFrame == null) return null;
  return dayjs.utc(miningFrames.getFrameDate(returningBondFrame));
});

async function onSubmitted() {
  showOverlay.value = false;
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
