import * as Vue from 'vue';
import { defineStore } from 'pinia';
import { type IFunderState, TreasuryPool } from '@argonprotocol/apps-core';
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

  const funderState = Vue.ref<IFunderState | null>(null);
  const frameHistory = Vue.ref<IFrameEarningsRow[]>([]);
  const isLoaded = Vue.ref(false);
  const vaultId = Vue.ref(0);

  const estimatedApy = Vue.computed(() => {
    if (!funderState.value || funderState.value.heldPrincipal <= 0n) return 0;
    return TreasuryPool.funderAPY(funderState.value, miningFrames.currentFrameId);
  });

  const heldPrincipal = Vue.computed(() => funderState.value?.heldPrincipal ?? 0n);

  let unsubFunder: (() => void) | undefined;
  let unsubFrame: { unsubscribe: () => void } | undefined;

  async function load() {
    if (isLoaded.value) return;

    await config.isLoadedPromise;
    await currency.isLoadedPromise;
    await miningFrames.load();
    await vaults.load();

    vaultId.value = config.connectedVault!.vaultId;

    const client = await getMainchainClient(false);
    const accountId = walletKeys.investmentAddress;

    unsubFunder = await TreasuryPool.subscribeFunderState(client, vaultId.value, accountId, state => {
      funderState.value = state;
    });

    await refreshFrameHistory();
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
    isLoaded,
    load,
    refreshFrameHistory,
  };
});
