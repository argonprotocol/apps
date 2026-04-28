<template>
  <div class="mt-5 flex flex-col gap-4">
    <p class="font-light">The following is a list of your non-argon tokens.</p>

    <div
      v-if="hasBaseAlert || baseBalancesError"
      class="text-md flex flex-row items-start gap-x-3 rounded-lg border border-amber-300 bg-amber-50 p-2 leading-6">
      <AlertIcon class="relative top-1 w-10 text-amber-600" />
      <p v-if="baseBalancesError" class="text-red-600">
        {{ baseBalancesError }}
      </p>
      <p v-else class="text-amber-900">
        This wallet has tokens on the Base Network, but Base is not supported by the Argon app.
      </p>
    </div>

    <div class="py-1">
      <p v-if="ethereumBalancesError" class="mt-3 text-sm leading-6 text-red-600">
        {{ ethereumBalancesError }}
      </p>

      <OtherTokens :tokens="ethereumBalances" />
    </div>
  </div>
</template>

<script lang="ts">
import * as Vue from 'vue';
import { getWalletKeys } from '../../../stores/wallets.ts';
import { type Address, createPublicClient, erc20Abi, formatUnits, getAddress, http } from 'viem';
import { base } from 'viem/chains';
import { createStableSwapPublicClient } from '../../../lib/StableSwaps.ts';

const trackedEthereumTokens = [
  { symbol: 'ETH', decimals: 18, address: null },
  { symbol: 'USDC', decimals: 6, address: getAddress('0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48') },
  { symbol: 'USDT', decimals: 6, address: getAddress('0xdAC17F958D2ee523a2206206994597C13D831ec7') },
  { symbol: 'USDE', decimals: 18, address: getAddress('0x4c9EDD5852cd905f086C759E8383e09bff1E68B3') },
] as const;

const ethereumBalancesError = Vue.ref('');
const ethereumBalances = Vue.ref(
  trackedEthereumTokens.map(token => ({
    ...token,
    formatted: '--',
    raw: 0n,
  })),
);

const walletKeys = getWalletKeys();
const ethereumBalanceLoadIntervalMs = 60_000;
let lastEthereumBalanceLoadAt = 0;

const trackedBaseTokens = [
  { symbol: 'ETH', decimals: 18, address: null },
  { symbol: 'USDC', decimals: 6, address: getAddress('0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913') },
] as const;

const isLoadingEthereumBalances = Vue.ref(false);
const baseBalancesError = Vue.ref('');
const baseBalances = Vue.ref(
  trackedBaseTokens.map(token => ({
    ...token,
    formatted: '--',
    raw: 0n,
  })),
);

const baseAlertTokens = Vue.computed(() => baseBalances.value.filter(token => token.raw > 0n));
const hasBaseAlert = Vue.computed(() => baseAlertTokens.value.length > 0);

function createBasePublicClient() {
  return createPublicClient({
    chain: base,
    transport: http('https://mainnet.base.org', {
      retryCount: 1,
      timeout: 15_000,
    }),
  });
}

async function loadEthereumBalances() {
  const now = Date.now();

  if (isLoadingEthereumBalances.value || now - lastEthereumBalanceLoadAt < ethereumBalanceLoadIntervalMs) return;

  lastEthereumBalanceLoadAt = now;
  isLoadingEthereumBalances.value = true;
  ethereumBalancesError.value = '';
  baseBalancesError.value = '';

  try {
    const client = createStableSwapPublicClient();
    const baseClient = createBasePublicClient();
    const walletAddress = getAddress(walletKeys.ethereumAddress) as Address;

    const [balances, baseTokenBalances] = await Promise.all([
      Promise.all(
        trackedEthereumTokens.map(async token => {
          const rawBalance = token.address
            ? await client.readContract({
                address: token.address,
                abi: erc20Abi,
                functionName: 'balanceOf',
                args: [walletAddress],
              })
            : await client.getBalance({
                address: walletAddress,
              });

          return {
            ...token,
            raw: rawBalance,
            formatted: formatUnits(rawBalance, token.decimals),
          };
        }),
      ),
      Promise.all(
        trackedBaseTokens.map(async token => {
          const rawBalance = token.address
            ? await baseClient.readContract({
                address: token.address,
                abi: erc20Abi,
                functionName: 'balanceOf',
                args: [walletAddress],
              })
            : await baseClient.getBalance({
                address: walletAddress,
              });

          return {
            ...token,
            raw: rawBalance,
            formatted: formatUnits(rawBalance, token.decimals),
          };
        }),
      ),
    ]);

    ethereumBalances.value = balances;
    baseBalances.value = baseTokenBalances;
  } catch (error) {
    ethereumBalancesError.value = error instanceof Error ? error.message : 'Unable to load Ethereum token balances.';
    baseBalancesError.value = error instanceof Error ? error.message : 'Unable to load Base token balances.';
  } finally {
    isLoadingEthereumBalances.value = false;
  }
}
</script>

<script setup lang="ts">
import OtherTokens from './OtherTokens.vue';
import AlertIcon from '../../../assets/alert.svg';

Vue.onMounted(() => {
  void loadEthereumBalances();

  const refreshOnFocus = () => {
    void loadEthereumBalances();
  };

  window.addEventListener('focus', refreshOnFocus);

  const refreshInterval = window.setInterval(() => {
    if (document.visibilityState !== 'visible') return;
    void loadEthereumBalances();
  }, 60_000);

  Vue.onUnmounted(() => {
    window.removeEventListener('focus', refreshOnFocus);
    window.clearInterval(refreshInterval);
  });
});
</script>
