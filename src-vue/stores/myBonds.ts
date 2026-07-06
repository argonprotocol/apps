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
    await miningFrames.load();

    vaultId.value = config.upstreamOperator?.vaultId ?? 0;

    await blockWatch.start();

    Vue.watch(
      () => config.upstreamOperator?.vaultId ?? 0,
      async nextVaultId => {
        setDisplayVaultId(nextVaultId);
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
    bondLots.value = await getOwnBondLots(client);
    setDisplayVaultId(config.upstreamOperator?.vaultId ?? vaultId.value);
  }

  async function refreshFrameHistory(client?: ArgonQueryClient) {
    client ??= await getMainchainClient(false);
    const lots = bondLots.value.length ? bondLots.value : await getOwnBondLots(client);
    frameHistory.value = lots
      .filter(lot => lot.lastEarningsFrame != null)
      .map(lot => ({
        frameId: lot.lastEarningsFrame!,
        bonds: lot.bonds,
        earnings: lot.lastEarnings,
      }))
      .sort((a, b) => b.frameId - a.frameId);
  }

  async function refreshFromBlockEvents(blocks: IBlockHeaderInfo[]) {
    let latestBondLotsBlock: IBlockHeaderInfo | undefined;
    let latestFrameHistoryBlock: IBlockHeaderInfo | undefined;

    for (const block of blocks) {
      const refreshScope = await getTreasuryBondRefreshScope(await blockWatch.getEvents(block));

      if (refreshScope.refreshAll || refreshScope.vaultIds.size > 0) {
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

  async function getOwnBondLots(client: ArgonQueryClient): Promise<BondLot[]> {
    const accountId = walletKeys.defaultArgonAddress;
    const accountLots = await TreasuryBonds.getBondLotsByAccount(client, accountId);
    if (accountLots.length || !config.upstreamOperator?.vaultId) {
      return accountLots.filter(lot => lot.isOwn);
    }

    return (await TreasuryBonds.getBondLots(client, config.upstreamOperator.vaultId, accountId)).filter(
      lot => lot.isOwn,
    );
  }

  function setDisplayVaultId(preferredVaultId: number) {
    const ownedVaultIds = new Set(bondLots.value.map(lot => lot.vaultId));
    if (preferredVaultId && (!ownedVaultIds.size || ownedVaultIds.has(preferredVaultId))) {
      vaultId.value = preferredVaultId;
      return;
    }

    vaultId.value = bondLots.value[0]?.vaultId ?? preferredVaultId;
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
