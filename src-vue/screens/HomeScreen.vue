<template>
  <TooltipProvider :disableHoverableContent="true" class="flex h-full flex-col">
    <div class="flex h-full grow flex-col justify-stretch gap-y-2 px-2.5 py-2.5">
      <section box class="flex flex-row items-center !py-3 text-slate-900/90">
        <div class="flex min-h-[6%] w-full flex-row items-center px-5 py-2">
          <p class="w-8/12 font-light">
            Argon is the stablecoin that’s built to last for a thousand years. It uses the natural tension between
            mining and vaulting to create an eternal balance in the ecosystem.
          </p>
          <div class="grow cursor-pointer justify-center text-right font-semibold text-slate-500">
            Watch Welcome Video
          </div>
          <PlayCircleIcon class="text-argon-600/60 h-10 w-10 cursor-pointer pl-2" />
        </div>
      </section>
      <div class="flex flex-row items-stretch gap-x-2">
        <section box class="flex min-h-60 w-1/2 flex-col px-2">
          <header
            class="flex flex-row border-b border-slate-400/30 py-2 text-[18px] font-bold text-slate-900/80 uppercase">
            <MinerIcon class="mr-3 ml-2 h-7" />
            <span>My Mining Operations</span>
          </header>
          <div class="flex grow flex-col gap-y-2 pt-2 text-center" v-if="config.isMinerInstalled">
            <div class="flex h-1/2 flex-row items-center gap-x-2">
              <div StatWrapper class="flex w-1/2 flex-col">
                <div Stat>
                  {{ currency.symbol
                  }}{{ microgonToMoneyNm(miningExternalInvested).formatIfElse('<1000', '0,0.[00]', '0,0') }}
                </div>
                <label>External Capital Invested</label>
              </div>
              <div StatWrapper class="flex w-1/2 flex-col">
                <div Stat>
                  {{ currency.symbol
                  }}{{ microgonToMoneyNm(myMiningEarnings).formatIfElse('<1000', '0,0.[00]', '0,0') }}
                </div>
                <label>Total Earnings</label>
              </div>
            </div>
            <div class="flex h-1/2 flex-row items-center gap-x-2">
              <div StatWrapper class="flex w-1/2 flex-col">
                <div Stat>{{ numeral(myMiningRoi).formatIfElseCapped('< 100', '0.[000]', '0,0', 9_999) }}%</div>
                <label>Return On Investment</label>
              </div>
              <div StatWrapper class="flex w-1/2 flex-col">
                <div Stat>{{ numeral(myMiningApy).formatIfElseCapped('< 100', '0.[000]', '0,0', 9_999) }}%</div>
                <label>Annual Percentage Yield</label>
              </div>
            </div>
          </div>
          <template v-else>
            <p class="px-3 py-3 font-light text-slate-900/80">
              Argon's Miners secure the network by processing transactions and maintaining consensus. Miners are also
              granted rights to print any new Argons needed to keep the stablecoin pegged to its target price. This puts
              miners in a unique position to profit from the growth of the Argon ecosystem.
            </p>
            <button
              @click="controller.setScreenKey(ScreenKey.Mining)"
              class="bg-argon-600 my-4 ml-3 w-5/9 cursor-pointer rounded-md border px-5 py-3 text-lg font-bold text-white">
              Open Mining Screen to Activate
            </button>
          </template>
        </section>
        <section box class="w-1/2 px-2">
          <header
            class="flex flex-row border-b border-slate-400/30 py-2 text-[18px] font-bold text-slate-900/80 uppercase">
            <VaultSmallIcon class="mr-3 ml-2 h-7" />
            <span>My Vaulting Operations</span>
          </header>
          <div class="flex grow flex-col gap-y-2 pt-2 text-center" v-if="config.isVaultActivated">
            <div class="flex h-1/2 flex-row items-center gap-x-2">
              <div StatWrapper class="flex w-1/2 flex-col">
                <div Stat>
                  {{ currency.symbol
                  }}{{ microgonToMoneyNm(vaultingExternalInvested).formatIfElse('<1000', '0,0.[00]', '0,0') }}
                </div>
                <label>External Capital Invested</label>
              </div>
              <div StatWrapper class="flex w-1/2 flex-col">
                <div Stat>
                  {{ currency.symbol }}{{ microgonToMoneyNm(myVaultEarnings).formatIfElse('<1000', '0,0.[00]', '0,0') }}
                </div>
                <label>Total Earnings</label>
              </div>
            </div>
            <div class="flex h-1/2 flex-row items-center gap-x-2">
              <div StatWrapper class="flex w-1/2 flex-col">
                <div Stat>{{ numeral(myVaultRoi).formatIfElseCapped('< 100', '0.[000]', '0,0', 9_999) }}%</div>
                <label>Return On Investment</label>
              </div>
              <div StatWrapper class="flex w-1/2 flex-col">
                <div Stat>{{ numeral(myVaultApy).formatIfElseCapped('< 100', '0.[000]', '0,0', 9_999) }}%</div>
                <label>Annual Percentage Yield</label>
              </div>
            </div>
          </div>
          <template v-else>
            <p class="px-3 py-3 font-light text-slate-900/80">
              Argon's Stabilization Vaults lock Bitcoins into special contracts that generate unencumbered shorts
              against the Argon stablecoin. These shorts give Argon its price stability and make it impossible to
              death-spiral. In return for operating vaults and managing the related treasury pools, Vaulters are able to
              earn substantial rewards.
            </p>
            <button
              @click="controller.setScreenKey(ScreenKey.Vaulting)"
              class="bg-argon-600 my-4 ml-3 w-5/9 cursor-pointer rounded-md border px-5 py-3 text-lg font-bold text-white">
              Open Vaulting Screen to Activate
            </button>
          </template>
        </section>
      </div>

      <section StatsBox box class="flex grow flex-col justify-center gap-x-2 px-2">
        <div>
          <header class="relative flex h-1/5 flex-row items-start justify-stretch px-15 pt-6 text-slate-500 uppercase">
            <div class="h-10 w-2 bg-gray-600/20" />
            <div class="mr-5 h-2 flex-grow bg-gray-600/20" />
            <div class="-mt-2.5 text-2xl font-extrabold">Global Ecosystem</div>
            <div class="ml-5 h-2 flex-grow bg-gray-600/20" />
            <div class="h-10 w-2 bg-gray-600/20" />
          </header>
        </div>
        <div class="flex h-4/5 w-full flex-row px-10">
          <div class="flex w-1/3 flex-col">
            <div StatWrapper class="h-1/4">
              <div Stat>
                {{ currency.symbol
                }}{{ microgonToMoneyNm(miningStats.aggregatedBidCosts).formatIfElse('< 1_000', '0,0.[00]', '0,0') }}
              </div>
              <label>Mining Bids this Epoch</label>
            </div>
            <div class="h-0.5 w-full bg-gradient-to-l from-slate-600/0 to-slate-600/13" />
            <div class="h-1/4" StatWrapper>
              <div Stat>{{ miningStats.activeMiningSeatCount }}</div>
              <label>Active Miners</label>
            </div>
            <div class="h-0.5 w-full bg-gradient-to-l from-slate-600/0 to-slate-600/13" />
            <div class="h-1/4" StatWrapper>
              <div Stat>
                {{ currency.symbol
                }}{{ microgonToMoneyNm(miningStats.aggregatedBlockRewards).formatIfElse('< 1_000', '0,0.[00]', '0,0') }}
              </div>
              <label>Base Mining Rewards</label>
            </div>
            <div class="h-0.5 w-full bg-gradient-to-l from-slate-600/0 to-slate-600/13" />
            <div class="flex h-1/4 flex-row items-center space-x-4">
              <div StatWrapper>
                <div Stat>{{ micronotToArgonotNm(micronotsInCirculation).format('0,0') }}</div>
                <label>Argonot Circulation</label>
              </div>
              <div class="text-argon-600/40 text-4xl font-bold">+</div>
              <div StatWrapper>
                <div Stat>{{ microgonToArgonNm(microgonsInCirculation).format('0,0') }}</div>
                <label>Argon Circulation</label>
              </div>
            </div>
          </div>

          <div class="-mt-5 flex w-1/3 flex-col items-center">
            <div class="flex h-1/4 w-1/2 flex-col items-stretch px-5">
              <div
                class="flex grow flex-row"
                v-for="target in aboveTargetAmounts"
                :key="target.earningsPotentialPercent">
                <div class="grow text-left text-slate-500/50">${{ target.usdPrice }}</div>
                <div class="grow text-right font-semibold text-green-700/50">
                  +{{ target.earningsPotentialPercent }}%
                </div>
              </div>
            </div>
            <div class="-mb-2 flex h-1/4 w-full flex-col">
              <div
                ArgonPrice
                class="rounded-md border-2 border-slate-600/40 p-5 text-center shadow-md shadow-slate-600/20">
                ${{ dollarsPerArgonFormatted }}
              </div>
            </div>
            <div class="flex h-1/4 w-1/2 flex-col px-5">
              <div
                class="flex flex-row pt-1"
                v-for="target in belowTargetAmounts"
                :key="target.earningsPotentialPercent">
                <div class="grow text-left text-slate-500/50">${{ target.usdPrice }}</div>
                <div class="grow text-right font-semibold text-green-700/50">
                  +{{ numeral(target.earningsPotentialPercent).format('0,0') }}%
                </div>
              </div>
              <div class="-mt-3 -mb-2 w-1/2 pr-3 text-center text-2xl text-slate-500/40">...</div>
              <div class="flex flex-row pt-1">
                <div class="grow text-left text-slate-500/50">${{ terraCollapsePriceUsd }}</div>
                <div class="grow text-right font-semibold text-green-700/50">+{{ terraPercentReturn }}</div>
              </div>
            </div>
            <div class="mt-2 flex h-1/4 flex-col text-center" StatWrapper>
              <div class="mx-10 rounded-t-md border-2 border-b-0 border-slate-400/40 px-4 pt-4 pb-2">
                <div Stat>{{ currency.symbol }}{{ numeral(unlockValueInArgons).format('0,0') }}</div>
                <label>Argon Burn from Bitcoin Shorts</label>
              </div>
            </div>
          </div>

          <div class="flex w-1/3 flex-col text-right">
            <div StatWrapper class="h-1/4">
              <div Stat>
                {{ currency.symbol
                }}{{ microgonToMoneyNm(vaultingStats.epochEarnings).formatIfElse('< 1_000', '0,0.[00]', '0,0') }}
              </div>
              <label>Vaulting Revenue this Epoch</label>
            </div>
            <div class="h-0.5 w-full bg-gradient-to-r from-slate-600/0 to-slate-600/13" />
            <div StatWrapper class="h-1/4">
              <div Stat>{{ vaultingStats.vaultCount }}</div>
              <label>Active Vaults</label>
            </div>
            <div class="h-0.5 w-full bg-gradient-to-r from-slate-600/0 to-slate-600/13" />
            <div StatWrapper class="h-1/4">
              <div Stat>
                {{ currency.symbol
                }}{{ microgonToMoneyNm(activatedSecuritization).formatIfElse('< 1_000', '0,0.[00]', '0,0') }}
              </div>
              <label>Bitcoin Security</label>
            </div>
            <div class="h-0.5 w-full bg-gradient-to-r from-slate-600/0 to-slate-600/13" />
            <div class="flex h-1/4 flex-row items-center justify-end space-x-4">
              <div StatWrapper>
                <div Stat>{{ vaultingStats.bitcoinLocked }}</div>
                <label>Vaulted Bitcoins</label>
              </div>
              <div class="text-argon-600/40 text-4xl font-bold">+</div>
              <div StatWrapper>
                <div Stat>
                  {{ currency.symbol
                  }}{{ microgonToMoneyNm(liquidityReceived).formatIfElse('< 1_000', '0,0.[00]', '0,0') }}
                </div>
                <label>Liquidity Received</label>
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
import { useMyVault, useVaults } from '../stores/vaults.ts';
import { useVaultingStats } from '../stores/vaultingStats.ts';
import { useMiningStats } from '../stores/miningStats.ts';
import { TooltipProvider } from 'reka-ui';
import MinerIcon from '../assets/miner.svg?component';
import VaultSmallIcon from '../assets/vault-small.svg?component';
import { ScreenKey } from '../interfaces/IConfig.ts';
import { useController } from '../stores/controller.ts';
import { getDbPromise } from '../stores/helpers/dbPromise.ts';
import { useWalletBalances, useWalletKeys } from '../stores/wallets.ts';
import { useStats } from '../stores/stats.ts';
import { calculateAPY, calculateProfitPct } from '../lib/Utils.ts';
import { useConfig } from '../stores/config.ts';
import { PlayCircleIcon } from '@heroicons/vue/24/outline';
import BigNumber from 'bignumber.js';

const vaults = useVaults();
const currency = useCurrency();
const controller = useController();
const vaultingStats = useVaultingStats();
const miningStats = useMiningStats();
const dbPromise = getDbPromise();
const walletKeys = useWalletKeys();
const myMinerStats = useStats();
const myVault = useMyVault();
const config = useConfig();
const walletBalances = useWalletBalances();

const { microgonToArgonNm, microgonToMoneyNm, micronotToArgonotNm } = createNumeralHelpers(currency);

const microgonsPerArgonot = Vue.ref(0n);
const microgonsPerBitcoin = Vue.ref(0n);
const miningExternalInvested = Vue.ref(0n);

const myMiningEarnings = Vue.computed(() => {
  const { microgonsMinedTotal, microgonsMintedTotal, micronotsMinedTotal, framedCost } = myMinerStats.global;
  return microgonsMintedTotal + microgonsMinedTotal + currency.micronotToMicrogon(micronotsMinedTotal) - framedCost;
});

const myMiningRoi = Vue.computed(() => {
  return calculateProfitPct(miningExternalInvested.value, miningExternalInvested.value + myMiningEarnings.value) * 100;
});

const myMiningApy = Vue.computed(() => {
  return calculateAPY(
    miningExternalInvested.value,
    miningExternalInvested.value + myMiningEarnings.value,
    myMinerStats.activeFrames,
  );
});

const myVaultEarnings = Vue.computed(() => {
  return myVault.revenue().earnings;
});

const myVaultApy = Vue.computed(() => {
  const { earnings, activeFrames } = myVault.revenue();
  if (earnings === 0n) return 0;
  return calculateAPY(vaultingExternalInvested.value, vaultingExternalInvested.value + earnings, activeFrames);
});

const myVaultRoi = Vue.computed(() => {
  const revenue = myVaultEarnings.value;
  const costs = vaultingExternalInvested.value;
  if (costs === 0n) return 0;
  return calculateProfitPct(costs, costs + revenue) * 100;
});

const activatedSecuritization = Vue.ref(0n);

const vaultingExternalInvested = Vue.ref(0n);

const dollarsPerArgon = Vue.ref(0);
const dollarsPerArgonFormatted = Vue.computed(() => {
  return numeral(dollarsPerArgon.value).format('0,0.000');
});

const dollarTargetPerArgon = Vue.ref(0);
const dollarTargetPerArgonFormatted = Vue.computed(() => {
  return numeral(dollarTargetPerArgon.value).format('0,0.000');
});

const finalPriceAfterTerraCollapse = 0.001;

const terraCollapsePriceUsd = Vue.computed(() => {
  return numeral(finalPriceAfterTerraCollapse).format('0,0.000');
});

function getBitcoinReturnAsPercent(simulateArgonUsdPrice: number): number {
  const r = BigNumber(simulateArgonUsdPrice).div(dollarTargetPerArgon.value).toNumber();
  const multiplier = calculateUnlockBurnPerBitcoinDollar(r);

  return (multiplier - 1) * 100;
}

const terraPercentReturn = Vue.computed(() => {
  const percentReturn = getBitcoinReturnAsPercent(finalPriceAfterTerraCollapse);
  return `${numeral(percentReturn).format('0,0')}%`;
});

const aboveTargetAmounts = Vue.ref<{ usdPrice: string; earningsPotentialPercent: number }[]>([]);

const belowTargetAmounts = Vue.ref<{ usdPrice: string; earningsPotentialPercent: number }[]>([]);

const microgonsInCirculation = Vue.ref(0n);
const micronotsInCirculation = Vue.ref(0n);

const unlockValueInArgons = Vue.ref(0);

const liquidityReceived = Vue.ref(0n);

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

async function updateExternalFunding() {
  const db = await dbPromise;

  const miningFunding = await db.walletTransfersTable.fetchExternal(walletKeys.miningAddress);
  miningExternalInvested.value = 0n;
  for (const transfer of miningFunding) {
    if (transfer.currency === 'argon') {
      miningExternalInvested.value += transfer.amount;
    } else {
      miningExternalInvested.value += currency.micronotToMicrogon(transfer.amount, transfer.microgonsForArgonot);
    }
  }

  const vaultFunding = await db.walletTransfersTable.fetchExternal(walletKeys.vaultingAddress);
  vaultingExternalInvested.value = 0n;
  for (const transfer of vaultFunding) {
    vaultingExternalInvested.value += transfer.amount;
  }
}

let unsubscribe: (() => void) | undefined;

Vue.onUnmounted(() => {
  unsubscribe?.();
  unsubscribe = undefined;
  void myMinerStats.unsubscribeFromDashboard();
});

Vue.onMounted(async () => {
  await config.isLoadedPromise;
  await currency.isLoadedPromise;
  await vaults.load();
  await vaultingStats.isLoadedPromise;
  await loadNetworkStats();
  await miningStats.isLoadedPromise;
  await myVault.load();
  await updateExternalFunding();
  unsubscribe = walletBalances.events.on('transfer-in', async () => {
    await updateExternalFunding();
  });

  await myMinerStats.subscribeToDashboard();
  await myMinerStats.load();

  microgonsPerArgonot.value = currency.microgonExchangeRateTo.ARGNOT;
  microgonsPerBitcoin.value = currency.microgonExchangeRateTo.BTC;
  dollarsPerArgon.value = currency.usdForArgon;
  dollarTargetPerArgon.value = currency.usdTargetForArgon;
  microgonsInCirculation.value = await currency.priceIndex.fetchMicrogonsInCirculation();
  micronotsInCirculation.value = await currency.priceIndex.fetchMicronotsInCirculation();
  liquidityReceived.value = await currency.priceIndex.bitcoinLiquidityReceived();

  const bitcoinsMicrogonValueInVault = await fetchBitcoinsMicrogonValueInVault();
  const bitcoinDollarValueInVault = dollarsPerArgon.value * currency.microgonToArgon(bitcoinsMicrogonValueInVault);
  const burnPerBitcoinDollar = calculateUnlockBurnPerBitcoinDollar(finalPriceAfterTerraCollapse);
  unlockValueInArgons.value = burnPerBitcoinDollar * bitcoinDollarValueInVault;

  const targets: { usdPrice: string; earningsPotentialPercent: number }[] = [];
  const currentOffset = ((dollarsPerArgon.value - dollarTargetPerArgon.value) / dollarTargetPerArgon.value) * 100;
  const nextTier = 10 + Math.ceil(currentOffset / 10) * 10;
  const adjustedOffset = nextTier - currentOffset;
  for (let i = 1; i <= 4; i++) {
    const earningsPotentialPercent = adjustedOffset + (i - 1) * 10;
    const targetPrice = dollarTargetPerArgon.value * (1 + earningsPotentialPercent / 100);
    targets.push({
      usdPrice: numeral(targetPrice).format('0,0.000'),
      earningsPotentialPercent,
    });
  }
  aboveTargetAmounts.value = targets.reverse();

  for (const percentOffTarget of [10, 20, 30]) {
    const actualPrice = dollarTargetPerArgon.value * ((100 - percentOffTarget) / 100);
    const earningsPotentialPercent = getBitcoinReturnAsPercent(actualPrice);
    belowTargetAmounts.value.push({
      usdPrice: numeral(actualPrice).format('0,0.000'),
      earningsPotentialPercent,
    });
  }
});
</script>

<style scoped>
@reference "../main.css";

[box] {
  @apply rounded border-[1px] border-slate-400/30 bg-white py-2 shadow;
}

[StatWrapper] {
  @apply flex flex-col justify-center gap-y-1;
  [Stat] {
    @apply text-argon-600 text-3xl font-extrabold;
  }
  header {
    @apply text-3xl;
  }
  label {
    @apply text-argon-600 -mt-1 text-sm font-medium;
  }
}

[ArgonPrice] {
  @apply text-argon-600 text-6xl font-extrabold;
}
</style>
