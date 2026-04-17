import * as Vue from 'vue';
import { defineStore } from 'pinia';
import { BondLot, TreasuryBonds } from '@argonprotocol/apps-core';
import { getConfig } from './config.ts';
import { getWalletKeys } from './wallets.ts';
import { getMainchainClient, getMiningFrames } from './mainchain.ts';
import { getCurrency } from './currency.ts';
import { BondMarket } from '../lib/BondMarket.ts';

export interface IFrameEarningsRow {
  frameId: number;
  bonds: number;
  earnings: bigint;
}

const bondMarket = new BondMarket();
bondMarket.data = Vue.reactive(bondMarket.data) as BondMarket['data'];

export function getBondMarket(): BondMarket {
  return bondMarket;
}

export const useMyBonds = defineStore('myBonds', () => {
  const config = getConfig();
  const walletKeys = getWalletKeys();
  const miningFrames = getMiningFrames();
  const currency = getCurrency();

  const bondLots = Vue.ref<BondLot[]>([]);
  const frameHistory = Vue.ref<IFrameEarningsRow[]>([]);
  const isLoaded = Vue.ref(false);
  const vaultId = Vue.ref(0);

  const bondTotals = Vue.computed(() => BondLot.getTotals(bondLots.value));

  const estimatedApy = Vue.computed(() => {
    if (bondTotals.value.activeBonds <= 0) return 0;
    return BondLot.getAPY(bondLots.value);
  });

  let unsubBondLots: (() => void) | undefined;
  let unsubFrame: { unsubscribe: () => void } | undefined;

  Vue.watch(
    () => config.isLoaded && config.upstreamOperator,
    () => {
      if (!isLoaded.value) void load();
    },
    { deep: true },
  );

  async function load() {
    if (isLoaded.value) return;

    await config.isLoadedPromise;
    await currency.isLoadedPromise;
    if (!config.upstreamOperator?.vaultId) return;
    await miningFrames.load();

    vaultId.value = config.upstreamOperator.vaultId;

    const client = await getMainchainClient(false);
    const accountId = walletKeys.investmentAddress;

    Vue.watch(
      () => config.upstreamOperator?.vaultId ?? 0,
      async nextVaultId => {
        vaultId.value = nextVaultId;
        unsubBondLots?.();
        if (!vaultId.value) {
          bondLots.value = [];
          frameHistory.value = [];
          return;
        }

        unsubBondLots = await TreasuryBonds.subscribeBondLots(client, vaultId.value, accountId, lots => {
          bondLots.value = lots;
        });
        await refreshFrameHistory();
      },
      { immediate: true },
    );

    isLoaded.value = true;

    unsubFrame = miningFrames.onFrameId(() => {
      void refreshBondLots();
      void refreshFrameHistory();
    });
  }

  async function refreshBondLots() {
    const client = await getMainchainClient(false);
    bondLots.value = await TreasuryBonds.getBondLots(client, vaultId.value, walletKeys.investmentAddress);
  }

  async function refreshFrameHistory() {
    const client = await getMainchainClient(false);
    const accountId = walletKeys.investmentAddress;
    frameHistory.value = await TreasuryBonds.getBondFrameHistory(client, vaultId.value, accountId);
  }

  return {
    vaultId,
    bondLots,
    frameHistory,
    bondTotals,
    estimatedApy,
    isLoaded,
    load,
    refreshBondLots,
    refreshFrameHistory,
  };
});
