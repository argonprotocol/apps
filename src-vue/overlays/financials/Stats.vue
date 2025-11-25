<template>
  <div class="flex h-full w-full flex-col space-y-5">
    <p class="w-10/12 pb-2 font-light text-slate-800/70">
      This page shows a high-level snapshot of the Argon Network's financial performance. It includes the current
      Argon's price, the ARGN-to-USD exchange rate, and the total value of the network's assets.
    </p>
    <div class="flex w-full grow flex-col space-y-5">
      <div class="flex h-1/4 w-full flex-row gap-x-4">
        <div StatWrapper class="flex h-full w-1/3 flex-col border-b border-slate-400/50">
          <span>{{ currency.symbol }}{{ microgonToArgonNm(microgonsPerArgonot).format('0,0.000') }}</span>
          <label>Price Per Argonot</label>
        </div>
        <div class="h-full w-[1px] bg-slate-400/50"></div>

        <div StatWrapper class="flex h-full w-1/3 flex-col border-b border-slate-400/50">
          <span class="relative">
            {{ currency.symbol }}1.000 ->
            <span :class="dollarsPerArgonFormatted === dollarTargetPerArgonFormatted ? '' : 'line-through opacity-30'">
              ${{ dollarTargetPerArgonFormatted }}
            </span>
            <span
              v-if="dollarsPerArgonFormatted !== dollarTargetPerArgonFormatted"
              :class="
                Number(dollarsPerArgonFormatted) > Number(dollarTargetPerArgonFormatted)
                  ? 'text-green-600'
                  : 'text-red-600'
              "
              class="absolute top-0 right-0 -translate-y-full -rotate-5 text-4xl font-bold">
              ${{ dollarsPerArgonFormatted }}
            </span>
          </span>
          <label>ARGN-to-USD Exchange Rate</label>
        </div>
        <div class="h-full w-[1px] bg-slate-400/50"></div>

        <div StatWrapper class="flex h-full w-1/3 flex-col border-b border-slate-400/50">
          <span>{{ currency.symbol }}{{ microgonToArgonNm(microgonsPerBitcoin).format('0,0.000') }}</span>
          <label>Price Per Bitcoin</label>
        </div>
      </div>

      <div class="flex h-1/4 w-full flex-row gap-x-4">
        <div StatWrapper class="flex h-full w-1/2 flex-col border-b border-slate-400/50">
          <span>{{ microgonToArgonNm(microgonsInCirculation).format('0,0') }}</span>
          <label>Argons In Circulation</label>
        </div>
        <div class="h-full w-[1px] bg-slate-400/50"></div>

        <div StatWrapper class="flex h-full w-1/2 flex-col border-b border-slate-400/50">
          <span>{{ currency.symbol }}{{ numeral(unlockValueInArgons).format('0,0') }}</span>
          <label>BTC-to-Argon Short Value</label>
        </div>
      </div>

      <div class="flex h-1/4 w-full flex-row gap-x-4">
        <div StatWrapper class="flex h-full w-1/4 flex-col border-b border-slate-400/50">
          <span>{{ miningStats.activeMiningSeatCount }}</span>
          <label>Mining Seats</label>
        </div>
        <div class="h-full w-[1.05px] bg-slate-400/50"></div>

        <div StatWrapper class="flex h-full w-1/4 flex-col border-b border-slate-400/50">
          <span>
            <span :class="[currency.symbol === '₳' ? 'font-semibold' : 'font-bold']">
              {{ currency.symbol }}
            </span>
            <span>
              {{ microgonToMoneyNm(miningStats.aggregatedBidCosts).formatIfElse('< 1_000', '0,0.00', '0,0') }}
            </span>
          </span>
          <label>Active Seat Cost</label>
        </div>
        <div class="h-full w-[1px] bg-slate-400/50"></div>

        <div StatWrapper class="flex h-full w-1/4 flex-col border-b border-slate-400/50">
          <span>
            <span :class="[currency.symbol === '₳' ? 'font-semibold' : 'font-bold']">
              {{ currency.symbol }}
            </span>
            <span>
              {{ microgonToMoneyNm(miningStats.aggregatedBlockRewards).formatIfElse('< 1_000', '0,0.00', '0,0') }}
            </span>
          </span>
          <label>Active Seat Rewards</label>
        </div>
        <div class="h-full w-[1.05px] bg-slate-400/50"></div>

        <div StatWrapper class="flex h-full w-1/4 flex-col border-b border-slate-400/50">
          <span>{{ numeral(miningStats.currentAPY).formatCapped('0,0', 9_999) }}%</span>
          <label>Annual Percentage Yield</label>
        </div>
      </div>

      <div class="flex h-1/4 w-full flex-row gap-x-4">
        <div StatWrapper class="flex h-full w-1/4 flex-col">
          <span>{{ vaultingStats.vaultCount }}</span>
          <label>Active Vaults</label>
        </div>
        <div class="h-full w-[1.05px] bg-slate-400/50"></div>

        <div StatWrapper class="flex h-full w-1/4 flex-col">
          <span>{{ vaultingStats.bitcoinLocked }}</span>
          <label>Bitcoin In Vaults</label>
        </div>
        <div class="h-full w-[1px] bg-slate-400/50"></div>

        <div StatWrapper class="flex h-full w-1/4 flex-col">
          <span>
            <span :class="[currency.symbol === '₳' ? 'font-semibold' : 'font-bold']">
              {{ currency.symbol }}
            </span>
            <span>
              {{ microgonToMoneyNm(vaultingStats.microgonValueInVaults).formatIfElse('< 1_000', '0,0.00', '0,0') }}
            </span>
          </span>
          <label>Total Value In Vaults</label>
        </div>
        <div class="h-full w-[1.05px] bg-slate-400/50"></div>

        <div StatWrapper class="flex h-full w-1/4 flex-col">
          <span>
            {{ numeral(vaultingStats.averageVaultAPY).formatIfElseCapped('< 1_000', '0,0.00', '0,0', 9_999) }}%
          </span>
          <label>Average Vault APY</label>
        </div>
      </div>
    </div>
  </div>
</template>
<script setup lang="ts">
import * as Vue from 'vue';
import { useCurrency } from '../../stores/currency.ts';
import numeral, { createNumeralHelpers } from '../../lib/numeral.ts';
import { useVaults } from '../../stores/vaults.ts';
import { useVaultingStats } from '../../stores/vaultingStats.ts';
import { useMiningStats } from '../../stores/miningStats.ts';

const currency = useCurrency();
const vaults = useVaults();
const vaultingStats = useVaultingStats();
const miningStats = useMiningStats();

const { microgonToArgonNm, microgonToMoneyNm } = createNumeralHelpers(currency);

const microgonsPerArgonot = Vue.ref(0n);
const microgonsPerBitcoin = Vue.ref(0n);

const dollarsPerArgon = Vue.ref(0);
const dollarsPerArgonFormatted = Vue.computed(() => {
  return numeral(dollarsPerArgon.value).format('0,0.000');
});

const dollarTargetPerArgon = Vue.ref(0);
const dollarTargetPerArgonFormatted = Vue.computed(() => {
  return numeral(dollarTargetPerArgon.value).format('0,0.000');
});

const microgonsInCirculation = Vue.ref(0n);
const unlockValueInArgons = Vue.ref(0);

function calculateUnlockBurnPerBitcoinDollar(argonRatioPrice: number): number {
  const r = argonRatioPrice;
  if (r >= 1.0) {
    return 1;
  } else if (r >= 0.9) {
    return 20 * Math.pow(r, 2) - 38 * r + 19;
  } else if (r >= 0.01) {
    return (0.5618 * r + 0.3944) / r;
  } else {
    return (1 / r) * (0.576 * r + 0.4);
  }
}

async function fetchBitcoinsMicrogonValueInVault() {
  const satsLocked = vaults.getTotalSatoshisLocked();
  try {
    return await vaults.getMarketRate(satsLocked);
  } catch (error) {
    return 0n;
  }
}

Vue.onMounted(async () => {
  await currency.isLoadedPromise;
  await vaults.load();
  microgonsPerArgonot.value = currency.microgonExchangeRateTo.ARGNOT;
  microgonsPerBitcoin.value = currency.microgonExchangeRateTo.BTC;
  dollarsPerArgon.value = currency.usdForArgon;
  dollarTargetPerArgon.value = currency.usdTargetForArgon;
  microgonsInCirculation.value = await currency.priceIndex.fetchMicrogonsInCirculation();

  const bitcoinsMicrogonValueInVault = await fetchBitcoinsMicrogonValueInVault();
  const bitcoinDollarValueInVault = dollarsPerArgon.value * currency.microgonToArgon(bitcoinsMicrogonValueInVault);
  const finalPriceAfterTerraCollapse = 0.001;
  const burnPerBitcoinDollar = calculateUnlockBurnPerBitcoinDollar(finalPriceAfterTerraCollapse);
  unlockValueInArgons.value = burnPerBitcoinDollar * bitcoinDollarValueInVault;
});
</script>

<style scoped>
@reference "../../main.css";

[StatWrapper] {
  @apply flex flex-col items-center justify-center text-slate-800/70;
  & > span {
    @apply text-4xl font-bold;
  }
  label {
    @apply mt-1 font-light;
  }
}
</style>
