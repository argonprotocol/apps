<template>
  <TooltipProvider :disableHoverableContent="true" class="flex h-full flex-col">
    <div class="flex h-full grow flex-col justify-stretch gap-y-2 px-2.5 py-2.5">
      <section box class="flex flex-row items-center !py-3 text-slate-900/90">
        <div class="flex min-h-[6%] w-full flex-row items-center px-5 py-2">
          <p class="w-8/12 font-light">
            Argon is the stablecoin that’s built to last for a thousand years. It uses natural tension between mining
            and vaulting to create balance in the ecosystem.
          </p>
          <div class="grow justify-center text-right">Watch Welcome Video</div>
        </div>
      </section>
      <div class="flex flex-row items-stretch gap-x-2">
        <section box class="min-h-60 w-1/2 px-2">
          <header class="flex flex-row border-b border-slate-400/30 py-2 text-[18px] font-bold text-slate-900/80">
            <MinerIcon class="mr-3 ml-2 h-7" />
            <span>My Mining Operations</span>
          </header>
        </section>
        <section box class="w-1/2 px-2">
          <header class="border-b border-slate-400/30 py-2 text-[18px] font-bold text-slate-900/80">
            My Vaulting Operations
          </header>
        </section>
      </div>

      <section box class="flex grow flex-col items-center justify-center gap-x-2 px-2">
        <header class="h-1/5 pt-6 text-[18px] font-bold text-slate-900/80">Global Ecosystem</header>
        <div class="flex h-4/5 w-full flex-row px-10">
          <div class="flex w-1/3 flex-col">
            <div class="h-1/4">
              <div>
                {{ currency.symbol
                }}{{ microgonToMoneyNm(miningStats.aggregatedBidCosts).formatIfElse('< 1_000', '0,0.00', '0,0') }}
              </div>
              Mining Bids this Epoch
            </div>
            <div class="h-1/4">
              <div>{{ miningStats.activeMiningSeatCount }}</div>
              Active Miners
            </div>
            <div class="h-1/4">
              <div>
                {{ currency.symbol
                }}{{ microgonToMoneyNm(miningStats.aggregatedBlockRewards).formatIfElse('< 1_000', '0,0.00', '0,0') }}
              </div>
              Base Mining Rewards
            </div>
            <div class="flex h-1/4 flex-row space-x-4">
              <div>
                <div>{{ micronotToArgonotNm(micronotsInCirculation).format('0,0') }}</div>
                Argonots In Circulation
              </div>
              <div>+</div>
              <div>
                <div>{{ microgonToArgonNm(microgonsInCirculation).format('0,0') }}</div>
                Argons In Circulation
              </div>
            </div>
          </div>

          <div class="flex w-1/3 flex-col">
            <div class="flex h-3/4 grow flex-col text-center">
              <div class="grow"></div>
              <div>{{ currency.symbol }}{{ dollarsPerArgonFormatted }}</div>
              <div class="grow"></div>
            </div>
            <div class="h-1/4 text-center">
              <div>{{ currency.symbol }}{{ numeral(unlockValueInArgons).format('0,0') }}</div>
              Argon Burn from Bitcoin Shorts
            </div>
          </div>

          <div class="flex w-1/3 flex-col text-right">
            <div class="h-1/4">
              <div>
                {{ currency.symbol
                }}{{ microgonToMoneyNm(vaultingStats.treasuryPoolEarnings).formatIfElse('< 1_000', '0,0.00', '0,0') }}
              </div>
              Vaulting Revenue this Epoch
            </div>
            <div class="h-1/4">
              <div>{{ vaultingStats.vaultCount }}</div>
              Active Vaults
            </div>
            <div class="h-1/4">
              <div>
                {{ currency.symbol
                }}{{ microgonToMoneyNm(activatedSecuritization).formatIfElse('< 1_000', '0,0.00', '0,0') }}
              </div>
              Bitcoin Security
            </div>
            <div class="flex h-1/4 flex-row justify-end space-x-4">
              <div>
                <div>{{ vaultingStats.bitcoinLocked }}</div>
                Vaulted Bitcoins
              </div>
              <div>+</div>
              <div>
                <div>{{ currency.symbol }}--,---</div>
                Total Liquidity Received
              </div>
            </div>
          </div>
        </div>
      </section>
    </div>
  </TooltipProvider>
</template>

<script setup lang="ts">
import * as Vue from 'vue';
import { useCurrency } from '../stores/currency.ts';
import numeral, { createNumeralHelpers } from '../lib/numeral.ts';
import { useVaults } from '../stores/vaults.ts';
import { useVaultingStats } from '../stores/vaultingStats.ts';
import { useMiningStats } from '../stores/miningStats.ts';
import { TooltipProvider } from 'reka-ui';
import MinerIcon from '../assets/miner.svg?component';

const currency = useCurrency();
const vaults = useVaults();
const vaultingStats = useVaultingStats();
const miningStats = useMiningStats();

const { microgonToArgonNm, microgonToMoneyNm, micronotToArgonotNm } = createNumeralHelpers(currency);

const microgonsPerArgonot = Vue.ref(0n);
const microgonsPerBitcoin = Vue.ref(0n);

const activatedSecuritization = Vue.ref(0n);

const dollarsPerArgon = Vue.ref(0);
const dollarsPerArgonFormatted = Vue.computed(() => {
  return numeral(dollarsPerArgon.value).format('0,0.000');
});

const dollarTargetPerArgon = Vue.ref(0);
const dollarTargetPerArgonFormatted = Vue.computed(() => {
  return numeral(dollarTargetPerArgon.value).format('0,0.000');
});

const microgonsInCirculation = Vue.ref(0n);
const micronotsInCirculation = Vue.ref(0n);

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

async function loadNetworkStats() {
  await vaults.load();

  const list = Object.values(vaults.vaultsById);
  for (const vault of list) {
    activatedSecuritization.value += vaults.activatedSecuritization(vault.vaultId);
  }
}

Vue.onMounted(async () => {
  await currency.isLoadedPromise;
  await vaults.load();
  await loadNetworkStats();

  microgonsPerArgonot.value = currency.microgonExchangeRateTo.ARGNOT;
  microgonsPerBitcoin.value = currency.microgonExchangeRateTo.BTC;
  dollarsPerArgon.value = currency.usdForArgon;
  dollarTargetPerArgon.value = currency.usdTargetForArgon;
  microgonsInCirculation.value = await currency.priceIndex.fetchMicrogonsInCirculation();
  micronotsInCirculation.value = await currency.priceIndex.fetchMicronotsInCirculation();

  const bitcoinsMicrogonValueInVault = await fetchBitcoinsMicrogonValueInVault();
  const bitcoinDollarValueInVault = dollarsPerArgon.value * currency.microgonToArgon(bitcoinsMicrogonValueInVault);
  const finalPriceAfterTerraCollapse = 0.001;
  const burnPerBitcoinDollar = calculateUnlockBurnPerBitcoinDollar(finalPriceAfterTerraCollapse);
  unlockValueInArgons.value = burnPerBitcoinDollar * bitcoinDollarValueInVault;
});
</script>

<style scoped>
@reference "../main.css";

[box] {
  @apply rounded border-[1px] border-slate-400/30 bg-white py-2 shadow;
}
</style>
