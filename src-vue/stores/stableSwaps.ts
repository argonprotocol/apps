import * as Vue from 'vue';
import { defineStore } from 'pinia';
import { isValidEthereumAddress } from '@argonprotocol/apps-core';
import { open as tauriOpenUrl } from '@tauri-apps/plugin-shell';
import { parseUnits } from 'viem';
import {
  buildStableSwapUniswapUrl,
  fetchStableSwapMarketSnapshot,
  normalizeStableSwapAddress,
  stableSwapMarketRecordToSnapshot,
  storeStableSwapMarketSnapshot,
} from '../lib/StableSwaps.ts';
import {
  backfillStableSwapProofs,
  loadStableSwapWalletSnapshot,
  syncStableSwapWallet,
} from '../lib/StableSwapWallet.ts';
import type {
  IStableSwapMarketSnapshot,
  IStableSwapPoolMetadata,
  IStableSwapWalletSnapshot,
} from '../interfaces/IStableSwap.ts';
import { createEthereumPublicClient } from '../lib/EthereumClient.ts';
import { getConfig } from './config.ts';
import { getCurrency } from './currency.ts';
import { getDbPromise } from './helpers/dbPromise.ts';
import { getBlockWatch } from './mainchain.ts';

export const useStableSwaps = defineStore('stableSwaps', () => {
  const config = getConfig();
  const currency = getCurrency();
  const dbPromise = getDbPromise();
  const blockWatch = getBlockWatch();

  const isLoaded = Vue.ref(false);
  const isLoadingMarket = Vue.ref(false);
  const isRefreshingWallet = Vue.ref(false);
  const marketError = Vue.ref('');
  const walletError = Vue.ref('');
  const walletMessage = Vue.ref('');

  const marketSnapshot = Vue.ref<IStableSwapMarketSnapshot | null>(null);
  const walletSnapshot = Vue.ref<IStableSwapWalletSnapshot | null>(null);
  const selectedWalletAddress = Vue.ref('');

  const marketTradeUrl = Vue.computed(() => {
    return buildStableSwapUniswapUrl(marketSnapshot.value?.discountedEthereumArgonAmount ?? 0n);
  });

  let loadPromise: Promise<void> | undefined;
  let publicClient: ReturnType<typeof createEthereumPublicClient> | undefined;
  let activePool: IStableSwapPoolMetadata | null = null;

  async function load() {
    if (loadPromise) {
      return await loadPromise;
    }

    loadPromise = (async () => {
      await config.isLoadedPromise;
      await currency.isLoadedPromise;

      const db = await dbPromise;
      const cachedMarket = await db.stableSwapMarketStateTable.get();
      marketSnapshot.value = cachedMarket ? stableSwapMarketRecordToSnapshot(cachedMarket) : null;

      isLoaded.value = true;
      await refreshMarket();
    })();

    try {
      await loadPromise;
    } catch {
      loadPromise = undefined;
      throw new Error('Stable swaps failed to load');
    }
  }

  async function refreshMarket() {
    await config.isLoadedPromise;
    await currency.isLoadedPromise;

    publicClient = createEthereumPublicClient();

    isLoadingMarket.value = true;
    marketError.value = '';

    try {
      publicClient = createEthereumPublicClient();

      const { pool, snapshot } = await fetchStableSwapMarketSnapshot(
        publicClient,
        currency.microgonsPer.USD,
        getTargetPriceFixed18(),
      );

      activePool = pool;
      marketSnapshot.value = snapshot;

      const db = await dbPromise;
      await storeStableSwapMarketSnapshot({ db, snapshot });

      if (selectedWalletAddress.value) {
        walletSnapshot.value = await loadStableSwapWalletSnapshot({
          db,
          walletAddress: selectedWalletAddress.value,
          currentPriceMicrogons: snapshot.currentPriceMicrogons,
        });
      }
    } catch (error) {
      console.error('Stable swaps market refresh failed', error);
      marketError.value = error instanceof Error ? error.message : 'Could not load the live stable-swap market.';
    } finally {
      isLoadingMarket.value = false;
    }
  }

  async function lookupWallet(addressRaw: string) {
    await load();

    walletError.value = '';
    walletMessage.value = '';

    const trimmedAddress = addressRaw.trim();
    if (!trimmedAddress) {
      selectedWalletAddress.value = '';
      walletSnapshot.value = null;
      return;
    }

    const validation = isValidEthereumAddress(trimmedAddress);
    if (!validation.valid) {
      walletError.value = 'Enter a valid Ethereum address to track stable swaps.';
      return;
    }

    const walletAddress = normalizeStableSwapAddress(trimmedAddress);
    selectedWalletAddress.value = walletAddress;
    isRefreshingWallet.value = true;

    try {
      publicClient ??= createEthereumPublicClient();

      if (!marketSnapshot.value) {
        await refreshMarket();
      }

      if (!marketSnapshot.value) {
        throw new Error('The stable-swap market is not available yet. Please try again.');
      }

      if (!activePool) {
        const refreshedMarket = await fetchStableSwapMarketSnapshot(
          publicClient,
          currency.microgonsPer.USD,
          getTargetPriceFixed18(),
        );
        activePool = refreshedMarket.pool;
        marketSnapshot.value = refreshedMarket.snapshot;

        const db = await dbPromise;
        await storeStableSwapMarketSnapshot({ db, snapshot: refreshedMarket.snapshot });
      }

      const db = await dbPromise;
      const { walletSnapshot: nextWalletSnapshot, message } = await syncStableSwapWallet({
        db,
        client: publicClient,
        walletAddress,
        pool: activePool,
        blockWatch,
        microgonsPerUsd: currency.microgonsPer.USD,
        currentPriceMicrogons: marketSnapshot.value.currentPriceMicrogons,
      });

      walletSnapshot.value = nextWalletSnapshot;
      walletMessage.value = message;

      void backfillProofs(walletAddress);
    } catch (error) {
      console.error('Stable swaps wallet lookup failed', error);
      walletError.value = error instanceof Error ? error.message : 'Could not refresh wallet swap tracking.';
    } finally {
      isRefreshingWallet.value = false;
    }
  }

  async function refreshSelectedWallet() {
    if (!selectedWalletAddress.value) {
      return;
    }

    await lookupWallet(selectedWalletAddress.value);
  }

  async function openCurrentTrade() {
    const url = marketTradeUrl.value;
    if (!url) {
      return;
    }

    await tauriOpenUrl(url);
  }

  async function backfillProofs(walletAddress: string) {
    if (!publicClient) {
      return;
    }

    try {
      const db = await dbPromise;
      await backfillStableSwapProofs({
        db,
        client: publicClient,
        walletAddress,
      });
    } catch (error) {
      console.error('Stable swaps proof backfill failed', error);
    }
  }

  return {
    isLoaded,
    isLoadingMarket,
    isRefreshingWallet,
    marketError,
    walletError,
    walletMessage,
    marketSnapshot,
    walletSnapshot,
    selectedWalletAddress,
    marketTradeUrl,
    load,
    refreshMarket,
    lookupWallet,
    refreshSelectedWallet,
    openCurrentTrade,
  };
});

function getTargetPriceFixed18() {
  const target = getCurrency().priceIndex.argonUsdTargetPrice;
  if (!target) {
    return undefined;
  }

  return parseUnits(target.toString(), 18);
}
