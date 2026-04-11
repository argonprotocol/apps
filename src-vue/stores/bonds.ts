import * as Vue from 'vue';
import { defineStore } from 'pinia';
import { BondFunder, TreasuryPool } from '@argonprotocol/apps-core';
import { getConfig } from './config.ts';
import { getWalletKeys } from './wallets.ts';
import { getVaults } from './vaults.ts';
import { getMainchainClient, getMiningFrames } from './mainchain.ts';
import { getCurrency } from './currency.ts';

export interface IFrameEarningsRow {
  frameId: number;
  balance: bigint;
  earnings: bigint;
  sharingPct: number;
}

export const useBonds = defineStore('bonds', () => {
  const config = getConfig();
  const walletKeys = getWalletKeys();
  const vaults = getVaults();
  const miningFrames = getMiningFrames();
  const currency = getCurrency();

  const funderState = Vue.ref<BondFunder | null>(null);
  const frameHistory = Vue.ref<IFrameEarningsRow[]>([]);
  const isLoaded = Vue.ref(false);
  const vaultId = Vue.ref(0);

  const estimatedApy = Vue.computed(() => {
    if (!funderState.value || funderState.value.heldPrincipal <= 0n) return 0;
    return funderState.value.getAPY(miningFrames.currentFrameId);
  });

  const heldPrincipal = Vue.computed(() => funderState.value?.heldPrincipal ?? 0n);
  const targetPrincipal = Vue.computed(() => funderState.value?.targetPrincipal ?? 0n);

  let unsubFunder: (() => void) | undefined;
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
    await vaults.load();

    vaultId.value = config.upstreamOperator.vaultId;

    const client = await getMainchainClient(false);
    const accountId = walletKeys.investmentAddress;

    Vue.watch(
      () => config.upstreamOperator?.vaultId ?? 0,
      async nextVaultId => {
        vaultId.value = nextVaultId;
        unsubFunder?.();
        if (!vaultId.value) {
          funderState.value = null;
          frameHistory.value = [];
          return;
        }

        unsubFunder = await TreasuryPool.subscribeFunderState(client, vaultId.value, accountId, false, state => {
          funderState.value = state;
        });
        await refreshFrameHistory();
      },
      { immediate: true },
    );

    isLoaded.value = true;

    unsubFrame = miningFrames.onFrameId(() => {
      void refreshFrameHistory();
    });
  }

  async function refreshFrameHistory() {
    const client = await getMainchainClient(false);
    const accountId = walletKeys.investmentAddress;
    const vault = vaults.vaultsById[vaultId.value];
    const operatorAddr = vault?.operatorAccountId ?? '';
    frameHistory.value = await TreasuryPool.getBondFrameHistory(client, vaultId.value, accountId, operatorAddr);
  }

  return {
    vaultId,
    funderState,
    frameHistory,
    estimatedApy,
    heldPrincipal,
    targetPrincipal,
    isLoaded,
    load,
    refreshFrameHistory,
  };
});
