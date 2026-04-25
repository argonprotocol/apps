<!-- prettier-ignore -->
<template>
  <OverlayBase
    :isOpen="isOpen"
    @close="closeOverlay"
    @esc="closeOverlay"
    class="w-7/12">
    <template #title>
      <div class="grow text-2xl font-bold">Treasury Bonds</div>
    </template>

    <div v-if="currentScreen === 'buy'" class="space-y-5 px-6 py-5 text-slate-700">
      <div class="text-sm font-semibold text-slate-800">
        Buy Bonds
      </div>

      <div class="text-sm leading-6 text-slate-500">
        Buy bonds to allocate Treasury Bonds to this vault.
        <template v-if="availableBondMicrogons > 0n">
          You can buy up to {{ microgonToArgonNm(availableBondMicrogons).format('0,0.[00]') }} ARGN more for this vault.
        </template>
      </div>

      <div class="rounded-lg border border-slate-200 bg-white px-5 py-5">
        <BuyBondsForm
          :vaultId="vaultId"
          :walletBalance="wallets.vaultingWallet.availableMicrogons"
          :availableVaultSpace="availableBondMicrogons"
          @close="goBack"
          @submitted="onBuySubmitted"
        />
      </div>
    </div>

    <div v-else class="space-y-5 px-6 py-5 text-slate-700">
      <div class="flex items-start justify-between gap-5">
        <div>
          <div class="text-sm font-semibold text-slate-800">
            {{ bondTotals.activeBonds.toLocaleString() }} active bonds
          </div>
          <div class="mt-1 text-sm leading-6 text-slate-500">
            Bond lots are purchased individually and liquidated individually.
            <template v-if="availableBondMicrogons > 0n">
              You can buy up to {{ microgonToArgonNm(availableBondMicrogons).format('0,0.[00]') }} ARGN more for this vault.
            </template>
          </div>
        </div>

        <button
          type="button"
          :disabled="availableBondMicrogons <= 0n"
          class="bg-argon-button hover:bg-argon-button-hover shrink-0 rounded-md px-5 py-2 text-sm font-semibold text-white disabled:cursor-default disabled:opacity-40"
          @click="goToBuy">
          Buy Bonds
        </button>
      </div>

      <div v-if="liquidationProgressActive" class="rounded-2xl border border-slate-200 bg-white px-8 py-8">
        <div class="text-center text-lg font-semibold text-slate-800">
          {{ liquidationProgressTitle }}
        </div>
        <p class="mx-auto mt-3 max-w-xl text-center text-sm leading-6 text-slate-500">
          Liquidating bond lot #{{ liquidatingLotId }} schedules its bonds to return from Treasury Bonds.
          You can close this overlay without disrupting the transaction.
        </p>

        <div class="text-argon-700 mt-8 text-center text-4xl font-bold">
          {{ numeral(liquidationProgressPct).format('0.00') }}%
        </div>

        <ProgressBar
          :progress="liquidationProgressPct"
          :hasError="!!liquidationError"
          :showLabel="false"
          class="mt-4 h-4"
        />

        <div class="mt-4 text-center text-sm text-slate-500">
          {{ liquidationProgressLabel }}
        </div>

        <div v-if="liquidationError" class="mt-5 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
          {{ liquidationError }}
        </div>

        <div v-if="isLiquidationComplete || liquidationError" class="mt-7 flex justify-end">
          <button
            type="button"
            class="bg-argon-button hover:bg-argon-button-hover rounded-lg px-5 py-2.5 text-sm font-semibold text-white"
            @click="resetLiquidationProgress">
            Back to Bonds
          </button>
        </div>
      </div>

      <div v-else-if="ownBondLots.length" class="overflow-hidden rounded-lg border border-slate-200 bg-white">
        <table class="w-full text-left">
          <thead class="border-b border-slate-100 text-xs font-semibold uppercase tracking-wide text-slate-400">
            <tr>
              <th class="px-5 py-2.5">Bond Lot</th>
              <th class="px-5 py-2.5">Bonds</th>
              <th class="px-5 py-2.5">Earnings</th>
              <th class="px-5 py-2.5 text-right">Status</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="lot in ownBondLots" :key="lot.id" class="border-b border-slate-50 last:border-0">
              <td class="px-5 py-3">
                <div class="text-sm font-semibold text-slate-800">Bond lot #{{ lot.id }}</div>
                <div class="mt-0.5 text-xs text-slate-400">
                  {{ lot.createdFrame > 0 ? `Created frame ${lot.createdFrame}` : 'Current bond position' }}
                </div>
              </td>
              <td class="px-5 py-3">
                <div class="font-mono text-sm font-semibold text-slate-800">{{ lot.bonds.toLocaleString() }}</div>
                <div class="mt-0.5 text-xs text-slate-400">
                  {{ currency.symbol }}{{ microgonToMoneyNm(lot.bondMicrogons).format('0,0.00') }}
                </div>
              </td>
              <td class="px-5 py-3">
                <div class="font-mono text-sm font-medium text-slate-700">
                  +{{ currency.symbol }}{{ microgonToMoneyNm(lot.lifetimeEarnings).format('0,0.00') }}
                </div>
                <div v-if="lot.lastEarningsFrame != null" class="mt-0.5 text-xs text-slate-400">
                  Last paid frame {{ lot.lastEarningsFrame }}
                </div>
              </td>
              <td class="px-5 py-3">
                <div class="flex items-center justify-end gap-3">
                  <span
                    class="rounded-full px-2.5 py-1 text-xs font-semibold"
                    :class="lot.isReleasing ? 'bg-amber-50 text-amber-700' : 'bg-slate-100 text-slate-500'">
                    {{ lot.isReleasing ? 'Returning' : 'Active' }}
                  </span>
                  <button
                    v-if="lot.canRelease && !lot.isReleasing"
                    type="button"
                    :disabled="isLiquidating"
                    class="rounded border border-slate-300 px-3 py-1.5 text-sm font-semibold text-slate-600 hover:bg-slate-50 disabled:cursor-default disabled:opacity-40"
                    @click="liquidateBondLot(lot)">
                    Liquidate
                  </button>
                </div>
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      <div v-else class="rounded-lg border border-dashed border-slate-300 bg-slate-50 px-5 py-8 text-center">
        <div class="text-sm font-semibold text-slate-700">No bond lots yet</div>
        <div class="mx-auto mt-1 max-w-md text-sm leading-6 text-slate-500">
          Buy bonds to allocate Treasury Bonds to this vault. They will appear here as individual bond lots.
        </div>
      </div>
    </div>
  </OverlayBase>
</template>

<script setup lang="ts">
import * as Vue from 'vue';
import { BondLot, TreasuryBonds } from '@argonprotocol/apps-core';
import OverlayBase from '../../app-shared/overlays/OverlayBase.vue';
import BuyBondsForm from '../../app-shared/overlays/BuyBondsForm.vue';
import ProgressBar from '../../components/ProgressBar.vue';
import basicEmitter from '../../emitters/basicEmitter.ts';
import { getBondMarket } from '../../stores/myBonds.ts';
import { getCurrency } from '../../stores/currency.ts';
import { getMainchainClient } from '../../stores/mainchain.ts';
import { getTransactionTracker } from '../../stores/transactions.ts';
import { useVaultingAssetBreakdown } from '../../stores/vaultingAssetBreakdown.ts';
import { getMyVault } from '../../stores/vaults.ts';
import { getWalletKeys, useWallets } from '../../stores/wallets.ts';
import numeral, { createNumeralHelpers } from '../../lib/numeral.ts';
import { generateProgressLabel } from '../../lib/Utils.ts';
import { ExtrinsicType } from '../../lib/db/TransactionsTable.ts';

const currency = getCurrency();
const wallets = useWallets();
const walletKeys = getWalletKeys();
const myVault = getMyVault();
const bondMarket = getBondMarket();
const transactionTracker = getTransactionTracker();
const vaultingBreakdown = useVaultingAssetBreakdown();

const { microgonToArgonNm, microgonToMoneyNm } = createNumeralHelpers(currency);

const isOpen = Vue.ref(false);
const currentScreen = Vue.ref<'overview' | 'buy'>('overview');

const liquidatingLotId = Vue.ref<number>();
const liquidationProgressActive = Vue.ref(false);
const liquidationProgressPct = Vue.ref(0);
const liquidationProgressLabel = Vue.ref('');
const liquidationError = Vue.ref('');

let unsubscribeLiquidationProgress: (() => void) | undefined;

const vaultId = Vue.computed(() => myVault.vaultId ?? 0);
const vaultBondState = Vue.computed(() => bondMarket.data.vaultsById[vaultId.value]);
const ownBondLots = Vue.computed(() => {
  return (vaultBondState.value?.bondLots ?? []).filter(lot => lot.isOwn);
});
const bondTotals = Vue.computed(() => BondLot.getTotals(ownBondLots.value));
const availableBondMicrogons = Vue.computed(() => vaultingBreakdown.treasuryBondMicrogonsAvailable);
const isLiquidating = Vue.computed(() => {
  return liquidationProgressActive.value && !liquidationError.value && liquidationProgressPct.value < 100;
});
const isLiquidationComplete = Vue.computed(() => {
  return liquidationProgressPct.value >= 100 && !liquidationError.value;
});
const liquidationProgressTitle = Vue.computed(() => {
  if (liquidationError.value) return 'Liquidation needs attention';
  if (isLiquidationComplete.value) return 'Liquidation submitted';
  return 'Liquidating bond lot';
});

function closeOverlay() {
  isOpen.value = false;
  currentScreen.value = 'overview';
}

function goBack() {
  currentScreen.value = 'overview';
}

function goToBuy() {
  currentScreen.value = 'buy';
}

async function onBuySubmitted() {
  currentScreen.value = 'overview';
  await refreshBondLots();
}

function resetLiquidationProgress() {
  unsubscribeLiquidationProgress?.();
  unsubscribeLiquidationProgress = undefined;
  liquidatingLotId.value = undefined;
  liquidationProgressActive.value = false;
  liquidationProgressPct.value = 0;
  liquidationProgressLabel.value = '';
  liquidationError.value = '';
}

async function liquidateBondLot(lot: BondLot) {
  if (!lot.isOwn || !lot.canRelease || lot.isReleasing || isLiquidating.value) return;

  liquidatingLotId.value = lot.id;
  liquidationProgressActive.value = true;
  liquidationProgressPct.value = 0;
  liquidationProgressLabel.value = 'Submitting transaction...';
  liquidationError.value = '';

  try {
    const client = await getMainchainClient(false);
    const signer = await walletKeys.getVaultingKeypair();
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

    unsubscribeLiquidationProgress?.();
    unsubscribeLiquidationProgress = info.subscribeToProgress((args, error) => {
      liquidationProgressPct.value = args.progressPct;
      liquidationProgressLabel.value = generateProgressLabel(args.confirmations, args.expectedConfirmations);

      if (error) {
        liquidationError.value = error.message ?? 'Transaction failed.';
      }

      if (args.progressPct >= 100 && !error) {
        void refreshBondLots();
      }
    });
  } catch (error) {
    liquidationError.value = error instanceof Error ? error.message : 'Transaction failed. Please try again.';
  }
}

async function refreshBondLots() {
  if (!vaultId.value) return;

  const client = await getMainchainClient(false);
  const vaultBonds = bondMarket.getVaultBonds(vaultId.value);
  vaultBonds.bondLots = await TreasuryBonds.getBondLots(client, vaultId.value, walletKeys.vaultingAddress);
  vaultBonds.isLoaded = true;
}

basicEmitter.on('openTreasuryBondsOverlay', () => {
  isOpen.value = true;
  currentScreen.value = 'overview';
  void refreshBondLots();
});

Vue.onUnmounted(() => {
  unsubscribeLiquidationProgress?.();
});
</script>
