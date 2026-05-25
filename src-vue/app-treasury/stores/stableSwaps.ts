import * as Vue from 'vue';
import { defineStore } from 'pinia';
import { parseUnits } from 'viem';
import { StableSwaps } from '../../lib/StableSwaps.ts';
import type { IStableSwap, IStableSwapWalletSnapshot } from '../../interfaces/IStableSwap.ts';
import { createStableSwapPublicClient } from '../../lib/StableSwapPublicClient.ts';
import { getConfig } from '../../stores/config.ts';
import { getCurrency } from '../../stores/currency.ts';

export const useStableSwaps = defineStore('stableSwaps', () => {
  const config = getConfig();
  const currency = getCurrency();

  const publicClient = createStableSwapPublicClient();
  const stableSwaps = new StableSwaps(publicClient);
  const swaps = Vue.ref<IStableSwap[]>([]);

  const isLoaded = Vue.ref(false);
  const isLoadingMarket = Vue.ref(false);
  const marketError = Vue.ref('');

  const walletError = Vue.ref('');
  const walletMessage = Vue.ref('');
  const walletSnapshot = Vue.ref<IStableSwapWalletSnapshot | null>(null);

  let loadPromise: Promise<void> | undefined;

  async function load() {
    if (loadPromise) return await loadPromise;

    loadPromise = (async () => {
      await config.isLoadedPromise;
      await currency.isLoadedPromise;

      isLoaded.value = true;
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

      // const db = await dbPromise;
      // await storeStableSwapMarketSnapshot({ db, snapshot });
    })();

    try {
      await loadPromise;
    } catch (error) {
      loadPromise = undefined;
      console.error('Stable swaps failed to load', error);
      throw new Error('Stable swaps failed to load', { cause: error });
    }
  }

  return {
    isLoaded,
    isLoadingMarket,
    marketError,
    walletError,
    walletMessage,
    walletSnapshot,
    swaps,
    stableSwaps,
    load,
  };
});

function getTargetPriceFixed18() {
  const target = getCurrency().priceIndex.argonUsdTargetPrice;
  if (!target) {
    return undefined;
  }

  return parseUnits(target.toString(), 18);
}
