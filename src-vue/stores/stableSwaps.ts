import * as Vue from 'vue';
import { defineStore } from 'pinia';
import { parseUnits } from 'viem';
import { StableSwaps } from '../lib/StableSwaps.ts';
import { loadStableSwapWalletSnapshot } from '../lib/StableSwapWallet.ts';
import type { IStableSwap, IStableSwapMarketSnapshot, IStableSwapWalletSnapshot } from '../interfaces/IStableSwap.ts';
import { createStableSwapPublicClient } from '../lib/StableSwapPublicClient.ts';
import { getConfig } from './config.ts';
import { getCurrency } from './currency.ts';
import { getDbPromise } from './helpers/dbPromise.ts';
import { useWallets } from './wallets.ts';

export const useStableSwaps = defineStore('stableSwaps', () => {
  const config = getConfig();
  const currency = getCurrency();
  const wallets = useWallets();

  const swaps = Vue.ref<IStableSwap[]>([]);
  const marketSnapshot = Vue.ref<IStableSwapMarketSnapshot | null>(null);

  const isLoaded = Vue.ref(false);
  const isLoadingMarket = Vue.ref(false);
  const marketError = Vue.ref('');

  const walletError = Vue.ref('');
  const walletMessage = Vue.ref('');
  const walletSnapshot = Vue.ref<IStableSwapWalletSnapshot | null>(null);

  let loadPromise: Promise<void> | undefined;
  let stableSwapsPromise: Promise<StableSwaps> | undefined;

  async function getStableSwaps(): Promise<StableSwaps> {
    stableSwapsPromise ??= createStableSwapPublicClient().then(publicClient => new StableSwaps(publicClient));
    return await stableSwapsPromise;
  }

  async function load() {
    if (loadPromise) return await loadPromise;

    loadPromise = (async () => {
      await config.isLoadedPromise;
      await currency.isLoadedPromise;
      await wallets.isLoadedPromise;
      await refresh();
      if (marketError.value) throw new Error(marketError.value);
    })();

    try {
      await loadPromise;
    } catch (error) {
      loadPromise = undefined;
      throw new Error('Stable swaps failed to load', { cause: error });
    }
  }

  async function refresh(): Promise<void> {
    await config.isLoadedPromise;
    await currency.isLoadedPromise;
    await wallets.isLoadedPromise;

    marketError.value = '';
    isLoadingMarket.value = true;
    try {
      const stableSwaps = await getStableSwaps();
      swaps.value = await stableSwaps.getActive({
        microgonsPerUsd: currency.microgonsPer.USD,
        inputTokenPricesMicrogons: {
          USDC: currency.microgonsPer.USD,
          USDT: currency.microgonsPer.USD,
          ETH: currency.microgonsPer.ETH,
          ARGNOT: currency.microgonsPer.ARGNOT,
        },
        targetPriceFixed18: getTargetPriceFixed18(),
      });
      marketSnapshot.value = stableSwaps.marketSnapshot ?? null;
      await refreshWalletSnapshot();
    } catch (error) {
      marketError.value = error instanceof Error ? error.message : String(error);
      console.error('Stable swaps failed to load', error);
    } finally {
      isLoaded.value = true;
      isLoadingMarket.value = false;
    }
  }

  async function refreshWalletSnapshot(): Promise<void> {
    if (!marketSnapshot.value) {
      walletSnapshot.value = null;
      return;
    }

    try {
      walletError.value = '';
      walletSnapshot.value = await loadStableSwapWalletSnapshot({
        db: await getDbPromise(),
        walletAddress: wallets.ethereumWallet.address,
        currentPriceMicrogons: marketSnapshot.value.currentPriceMicrogons,
      });
    } catch (error) {
      walletSnapshot.value = null;
      walletError.value = error instanceof Error ? error.message : 'Could not load stable-swap wallet history.';
    }
  }

  return {
    isLoaded,
    isLoadingMarket,
    marketError,
    walletError,
    walletMessage,
    walletSnapshot,
    marketSnapshot,
    swaps,
    load,
    refresh,
    refreshWalletSnapshot,
  };
});

function getTargetPriceFixed18() {
  const target = getCurrency().priceIndex.argonUsdTargetPrice;
  if (!target) {
    return undefined;
  }

  return parseUnits(target.toString(), 18);
}
