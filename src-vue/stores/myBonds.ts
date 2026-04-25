import * as Vue from 'vue';
import { defineStore } from 'pinia';
import { type ArgonQueryClient, BondLot, type IBlockHeaderInfo, TreasuryBonds } from '@argonprotocol/apps-core';
import { getConfig } from './config.ts';
import { getWalletKeys } from './wallets.ts';
import { getBlockWatch, getMainchainClient, getMiningFrames } from './mainchain.ts';
import { getCurrency } from './currency.ts';
import { BondMarket, getTreasuryBondRefreshScope } from '../lib/BondMarket.ts';

export interface IFrameEarningsRow {
  frameId: number;
  bonds: number;
  earnings: bigint;
}

let bondMarket: BondMarket | undefined;

export function getBondMarket(): BondMarket {
  if (!bondMarket) {
    bondMarket = new BondMarket(getBlockWatch());
    bondMarket.data = Vue.reactive(bondMarket.data) as BondMarket['data'];
  }

  return bondMarket;
}

export const useMyBonds = defineStore('myBonds', () => {
  const config = getConfig();
  const walletKeys = getWalletKeys();
  const miningFrames = getMiningFrames();
  const blockWatch = getBlockWatch();
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

    await blockWatch.start();

    Vue.watch(
      () => config.upstreamOperator?.vaultId ?? 0,
      async nextVaultId => {
        vaultId.value = nextVaultId;
        if (!vaultId.value) {
          bondLots.value = [];
          frameHistory.value = [];
          return;
        }

        await refreshBondLots();
        await refreshFrameHistory();
      },
      { immediate: true },
    );

    isLoaded.value = true;

    blockWatch.events.on('best-blocks', blocks => {
      void refreshFromBlockEvents(blocks);
    });
  }

  async function refreshBondLots(client?: ArgonQueryClient) {
    client ??= await getMainchainClient(false);
    bondLots.value = (await TreasuryBonds.getBondLots(client, vaultId.value, walletKeys.investmentAddress)).filter(
      lot => lot.isOwn,
    );
  }

  async function refreshFrameHistory(client?: ArgonQueryClient) {
    client ??= await getMainchainClient(false);
    const accountId = walletKeys.investmentAddress;
    frameHistory.value = await TreasuryBonds.getBondFrameHistory(client, vaultId.value, accountId);
  }

  async function refreshFromBlockEvents(blocks: IBlockHeaderInfo[]) {
    if (!vaultId.value) return;

    let latestBondLotsBlock: IBlockHeaderInfo | undefined;
    let latestFrameHistoryBlock: IBlockHeaderInfo | undefined;

    for (const block of blocks) {
      const refreshScope = await getTreasuryBondRefreshScope(await blockWatch.getEvents(block));

      if (refreshScope.refreshAll || refreshScope.vaultIds.has(vaultId.value)) {
        latestBondLotsBlock = block;
      }

      if (block.isNewFrame) {
        latestBondLotsBlock = block;
        latestFrameHistoryBlock = block;
      }
    }

    if (latestBondLotsBlock) {
      await refreshBondLots(await blockWatch.getApi(latestBondLotsBlock));
    }

    if (latestFrameHistoryBlock) {
      await refreshFrameHistory(await blockWatch.getApi(latestFrameHistoryBlock));
    }
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
