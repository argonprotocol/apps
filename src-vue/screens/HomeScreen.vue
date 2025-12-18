<template>
  <TooltipProvider :disableHoverableContent="true" class="flex h-full flex-col">
    <div class="flex h-full grow flex-col justify-stretch gap-y-2 px-2.5 py-2.5">
      <section box class="flex flex-row items-center !py-3 text-slate-900/90">
        <div class="flex min-h-[6%] w-full flex-row items-center px-5 py-2">
          <p class="w-8/12 font-light">
            Argon is the stablecoin that’s built to last for a thousand years. It uses the natural tension between
            mining and vaulting to create an eternal balance in the ecosystem.
          </p>
        </div>
      </section>
      <div class="flex flex-row items-stretch gap-x-2">
        <section box class="flex min-h-60 w-1/2 flex-col px-2">
          <header
            class="flex flex-row border-b border-slate-400/30 py-2 text-[18px] font-bold text-slate-900/80 uppercase">
            <MinerIcon class="mr-3 ml-2 h-7" />
            <span>My Mining Operations</span>
          </header>
          <div class="flex grow flex-row pt-2 text-center" v-if="config.isMinerInstalled">
            <div class="flex w-1/2 flex-col items-center gap-x-2">
              <div StatWrapper class="flex h-1/2 w-full flex-col border-b border-slate-600/20">
                <div Stat>
                  {{ currency.symbol
                  }}{{ microgonToMoneyNm(miningExternalInvested).formatIfElse('<1000', '0,0.[00]', '0,0') }}
                </div>
                <label>Capital Invested</label>
              </div>
              <div StatWrapper class="flex h-1/2 w-full flex-col">
                <div Stat>{{ numeral(myMiningRoi).formatIfElseCapped('< 100', '0.[000]', '0,0', 9_999) }}%</div>
                <label>Return On Investment</label>
              </div>
            </div>
            <div class="mx-2 h-full w-px bg-slate-600/20" />
            <div class="flex w-1/2 flex-col items-center gap-x-2">
              <div StatWrapper class="flex h-1/2 w-full flex-col border-b border-slate-600/20">
                <div Stat>
                  {{ currency.symbol
                  }}{{ microgonToMoneyNm(myMiningEarnings).formatIfElse('<1000', '0,0.[00]', '0,0') }}
                </div>
                <label>Total Earnings</label>
              </div>
              <div StatWrapper class="flex h-1/2 w-full flex-col">
                <div Stat>{{ numeral(myMiningApy).formatIfElseCapped('< 100', '0.[000]', '0,0', 9_999) }}%</div>
                <label>Annual Percentage Yield</label>
              </div>
            </div>
          </div>
          <div v-else class="px-3">
            <p class="py-3 font-light text-slate-900/80">
              Argon's Miners secure the network by processing transactions and maintaining consensus. Miners are also
              granted rights to print any new Argons needed to keep the stablecoin pegged to its target price. This puts
              miners in a unique position to profit from the growth of the Argon ecosystem.
            </p>
            <button
              @click="controller.setScreenKey(ScreenKey.Mining)"
              class="bg-argon-600 my-4 w-full max-w-180 cursor-pointer rounded-md border px-5 py-2 text-lg font-bold text-white">
              Open Mining Screen
            </button>
          </div>
        </section>
        <section box class="flex min-h-60 w-1/2 flex-col px-2">
          <header
            class="flex flex-row border-b border-slate-400/30 py-2 text-[18px] font-bold text-slate-900/80 uppercase">
            <VaultSmallIcon class="mr-3 ml-2 h-7" />
            <span>My Vaulting Operations</span>
          </header>
          <div class="flex grow flex-row pt-2 text-center" v-if="config.isVaultActivated">
            <div class="flex w-1/2 flex-col items-center gap-x-2">
              <div StatWrapper class="flex h-1/2 w-full flex-col border-b border-slate-600/20">
                <div Stat>
                  {{ currency.symbol
                  }}{{ microgonToMoneyNm(vaultingExternalInvested).formatIfElse('<1000', '0,0.[00]', '0,0') }}
                </div>
                <label>Capital Invested</label>
              </div>
              <div StatWrapper class="flex h-1/2 w-full flex-col">
                <div Stat>{{ numeral(myVaultRoi).formatIfElseCapped('< 100', '0.[000]', '0,0', 9_999) }}%</div>
                <label>Return On Investment</label>
              </div>
            </div>
            <div class="mx-2 h-full w-px bg-slate-600/20" />
            <div class="flex w-1/2 flex-col items-center gap-x-2">
              <div StatWrapper class="flex h-1/2 w-full flex-col border-b border-slate-600/20">
                <div Stat>
                  {{ currency.symbol }}{{ microgonToMoneyNm(myVaultEarnings).formatIfElse('<1000', '0,0.[00]', '0,0') }}
                </div>
                <label>Total Earnings</label>
              </div>
              <div StatWrapper class="flex h-1/2 w-full flex-col">
                <div Stat>{{ numeral(myVaultApy).formatIfElseCapped('< 100', '0.[000]', '0,0', 9_999) }}%</div>
                <label>Annual Percentage Yield</label>
              </div>
            </div>
          </div>
          <div v-else class="px-3">
            <p class="py-3 font-light text-slate-900/80">
              Argon's Stabilization Vaults lock Bitcoins into special contracts that generate unencumbered shorts
              against the Argon stablecoin. These shorts give Argon its price stability and make it impossible to
              death-spiral. In return, vaults earn all revenue generated by mining bids.
            </p>
            <button
              @click="controller.setScreenKey(ScreenKey.Vaulting)"
              class="bg-argon-600 my-4 w-full max-w-180 cursor-pointer rounded-md border px-5 py-2 text-lg font-bold text-white">
              Open Vaulting Screen
            </button>
          </div>
        </section>
      </div>

      <section StatsBox box class="flex grow flex-col justify-center px-2 !pb-0">
        <header
          class="relative mx-1 mt-6 flex flex-row items-start justify-stretch px-12 text-[20px] font-bold text-slate-900/80 uppercase">
          <div class="relative top-5 mr-2 h-10 w-3 bg-gray-600/13">
            <div class="absolute -top-5 h-5 w-5 rounded-tl-xl border-t-12 border-l-12 border-gray-600/13" />
          </div>
          <div class="mr-5 h-3 flex-grow bg-gray-600/13" />
          <div class="-mt-2">The Global Ecosystem</div>
          <div class="ml-5 h-3 flex-grow bg-gray-600/13" />
          <div class="relative top-5 ml-2 h-10 w-3 bg-gray-600/13">
            <div class="absolute -top-5 right-0 h-5 w-5 rounded-tr-xl border-t-12 border-r-12 border-gray-600/13" />
            <LineArrow
              class="absolute top-full left-1/2 z-10 -translate-x-1/2 -translate-y-1/2 rotate-90 text-slate-600/13" />
          </div>
        </header>
        <div class="flex w-full grow flex-row">
          <div class="flex w-1/3 flex-col">
            <div class="relative h-px w-full bg-gradient-to-l from-slate-600/0 to-slate-600/20 to-[50%]">
              <div class="absolute -top-3 left-12 bg-white px-1"><div class="relative h-7 w-3 bg-gray-600/13" /></div>
            </div>
            <div StatWrapper class="ml-10 h-1/4">
              <div Stat>
                {{ currency.symbol
                }}{{ microgonToMoneyNm(miningStats.aggregatedBidCosts).formatIfElse('< 1_000', '0,0.[00]', '0,0') }}
              </div>
              <label>Mining Bids this Epoch</label>
            </div>
            <div class="relative h-px w-full bg-gradient-to-l from-slate-600/0 to-slate-600/20 to-[50%]">
              <div class="absolute -top-4 left-12 bg-white px-1">
                <div class="relative h-9 w-3 bg-gray-600/13" />
                <LineArrow
                  class="absolute bottom-full left-1/2 z-10 -translate-x-1/2 translate-y-1/2 -rotate-90 text-slate-600/13" />
              </div>
            </div>
            <div StatWrapper class="ml-10 h-1/4">
              <div class="flex flex-row items-center">
                <div Stat>{{ miningStats.activeMiningSeatCount }}</div>
                <div class="relative mr-5 ml-7 h-3 flex-grow bg-gray-600/13">
                  <LineArrow class="absolute top-1/2 right-full z-10 -translate-y-1/2 -rotate-180 text-slate-600/13" />
                </div>
              </div>
              <label>Active Miners</label>
            </div>
            <div class="relative h-px w-full bg-gradient-to-l from-slate-600/0 to-slate-600/20 to-[50%]">
              <div class="absolute -top-4 left-12 bg-white px-1">
                <div class="relative h-9 w-3 bg-gray-600/13" />
                <LineArrow
                  class="absolute top-full left-1/2 z-10 -translate-x-1/2 -translate-y-1/2 rotate-90 text-slate-600/13" />
              </div>
            </div>
            <div StatWrapper class="ml-10 h-1/4">
              <div Stat>
                {{ currency.symbol
                }}{{ microgonToMoneyNm(miningStats.aggregatedBlockRewards).formatIfElse('< 1_000', '0,0.[00]', '0,0') }}
              </div>
              <label>Base Mining Rewards</label>
            </div>
            <div class="relative h-px w-full bg-gradient-to-l from-slate-600/0 to-slate-600/20 to-[50%]">
              <div class="absolute -top-4 left-12 bg-white px-1">
                <div class="relative h-9 w-3 bg-gray-600/13" />
                <LineArrow
                  class="absolute top-full left-1/2 z-10 -translate-x-1/2 -translate-y-1/2 rotate-90 text-slate-600/13" />
              </div>
            </div>

            <div class="ml-10 flex h-1/4 flex-row items-center space-x-4">
              <div StatWrapper>
                <div Stat>{{ micronotToArgonotNm(micronotsInCirculation).format('0,0') }}</div>
                <label>Argonot Circulation</label>
              </div>
              <div class="pb-6 text-4xl font-bold text-slate-600/20">+</div>
              <div class="relative flex h-full flex-col">
                <div class="absolute bottom-full left-1/2 h-[calc(150%-30px)] -translate-x-1/2 bg-white px-1">
                  <div class="relative h-full w-3 bg-gray-600/13" />
                </div>
                <div class="absolute bottom-[calc(250%-22px)] left-1/2 z-10 w-1/2 translate-x-[5px] bg-white">
                  <div
                    class="absolute top-0 left-[-11px] h-5 w-5 rounded-tl-xl border-t-12 border-l-12 border-gray-600/13" />
                  <div class="relative ml-[9px] h-3 w-full bg-gray-600/13" />
                </div>
                <div class="relative grow">
                  <div class="absolute bottom-2 left-1/2 h-full -translate-x-1/2 bg-white px-1">
                    <div class="relative h-full w-3 bg-gray-600/13" />
                  </div>
                </div>
                <div StatWrapper>
                  <div Stat>{{ microgonToArgonNm(microgonsInCirculation).format('0,0') }}</div>
                  <label>Argon Circulation</label>
                </div>
                <div class="grow" />
              </div>
              <div class="relative flex h-full grow flex-col">
                <div class="absolute bottom-[calc(250%-22px)] -left-6 z-10 w-[calc(100%-4px)] bg-white">
                  <div class="relative h-3 w-full bg-gray-600/13" />
                  <LineArrow class="absolute top-1/2 left-full z-10 -translate-y-1/2 text-slate-600/13" />
                </div>
                <div class="grow" />
                <div class="relative -top-2.5 mr-3 ml-3 h-3 bg-gray-600/13">
                  <LineArrow class="absolute top-1/2 right-full z-10 -translate-y-1/2 -rotate-180 text-slate-600/13" />
                </div>
                <div class="grow" />
              </div>
            </div>
          </div>

          <div class="flex w-1/3 flex-col items-center">
            <div class="relative -top-1 flex h-1/4 w-1/2 flex-col items-stretch px-5">
              <div
                class="flex grow flex-row"
                v-for="target in aboveTargetAmounts"
                :key="target.earningsPotentialPercent">
                <div class="grow text-left text-slate-500/50">${{ numeral(target.usdPrice).format('0,0.00') }}</div>
                <div class="grow text-right font-semibold text-green-700/50">
                  +{{ numeral(target.earningsPotentialPercent).format('0,0') }}%
                </div>
              </div>
            </div>
            <div class="-mb-1 flex h-1/4 w-full flex-col">
              <div
                ArgonPrice
                class="rounded-lg border border-slate-600/50 px-5 pt-5 pb-4 text-center shadow-md shadow-slate-600/20">
                ${{ numeral(dollarsPerArgon).format('0,0.00') }}
                <label class="mt-1 block text-sm font-medium text-slate-700/50">Price Per Argon</label>
              </div>
            </div>
            <div class="relative top-2.5 flex h-1/4 w-1/2 flex-col px-5">
              <div
                class="flex flex-row pt-1"
                v-for="target in belowTargetAmounts"
                :key="target.earningsPotentialPercent">
                <div class="grow text-left text-slate-500/50">${{ numeral(target.usdPrice).format('0,0.00') }}</div>
                <div class="grow text-right font-semibold text-green-700/50">
                  +{{ numeral(target.earningsPotentialPercent).format('0,0') }}%
                </div>
              </div>
              <div class="-mt-4 -mb-2 flex flex-row text-2xl text-slate-500/40">
                <div class="grow text-left">...</div>
                <div class="grow text-right">...</div>
              </div>
              <div class="flex flex-row pt-1">
                <div class="grow text-left text-slate-500/50">${{ terraCollapsePriceUsd }}</div>
                <div class="grow text-right font-semibold text-green-700/50">+{{ terraPercentReturn }}</div>
              </div>
            </div>
            <div StatWrapper class="mt-2 flex h-1/4 w-full flex-col text-center">
              <div
                class="relative mx-2 mt-3 mb-5 grow rounded-t-lg border border-b-0 border-slate-400/50 px-4 pt-4 pb-2">
                <div class="absolute top-1/4 -right-0.5 -left-0.5 h-3/4 bg-gradient-to-b from-transparent to-white" />
                <div Stat class="relative z-10">
                  {{ currency.symbol }}{{ numeral(unlockValueInArgons).format('0,0') }}
                </div>
                <label class="relative z-10">Argon Burn Potential from Bitcoin</label>
              </div>
            </div>
          </div>

          <div class="flex w-1/3 flex-col text-right">
            <div class="relative h-px w-full bg-gradient-to-r from-slate-600/0 to-slate-600/20 to-[50%]">
              <div class="absolute -top-3 right-12 bg-white px-1"><div class="relative h-7 w-3 bg-gray-600/13" /></div>
            </div>
            <div StatWrapper class="mr-10 h-1/4">
              <div Stat>
                {{ currency.symbol
                }}{{ microgonToMoneyNm(vaultingStats.epochEarnings).formatIfElse('< 1_000', '0,0.[00]', '0,0') }}
              </div>
              <label>Vaulting Revenue this Epoch</label>
            </div>
            <div class="relative h-px w-full bg-gradient-to-r from-slate-600/0 to-slate-600/20 to-[50%]">
              <div class="absolute -top-4 right-12 bg-white px-1">
                <div class="relative h-9 w-3 bg-gray-600/13" />
                <LineArrow
                  class="absolute top-full left-1/2 z-10 -translate-x-1/2 -translate-y-1/2 rotate-90 text-slate-600/13" />
              </div>
            </div>
            <div StatWrapper class="mr-10 h-1/4">
              <div class="flex flex-row items-center">
                <div class="relative mr-7 ml-5 h-3 flex-grow bg-gray-600/13">
                  <LineArrow class="absolute top-1/2 left-full z-10 -translate-y-1/2 text-slate-600/13" />
                </div>
                <div Stat>{{ vaultingStats.vaultCount }}</div>
              </div>
              <label>Active Vaults</label>
            </div>
            <div class="relative h-px w-full bg-gradient-to-r from-slate-600/0 to-slate-600/20 to-[50%]">
              <div class="absolute -top-4 right-12 bg-white px-1">
                <div class="relative h-9 w-3 bg-gray-600/13" />
                <LineArrow
                  class="absolute top-full left-1/2 z-10 -translate-x-1/2 -translate-y-1/2 rotate-90 text-slate-600/13" />
              </div>
            </div>
            <div StatWrapper class="mr-10 h-1/4">
              <div Stat>
                {{ currency.symbol
                }}{{ microgonToMoneyNm(activatedSecuritization).formatIfElse('< 1_000', '0,0.[00]', '0,0') }}
              </div>
              <label>Bitcoin Security</label>
            </div>
            <div class="relative h-px w-full bg-gradient-to-r from-slate-600/0 to-slate-600/20 to-[50%]">
              <div class="absolute -top-4 right-12 bg-white px-1">
                <div class="relative h-9 w-3 bg-gray-600/13" />
                <LineArrow
                  class="absolute top-full left-1/2 z-10 -translate-x-1/2 -translate-y-1/2 rotate-90 text-slate-600/13" />
              </div>
            </div>

            <div class="mr-10 flex h-1/4 flex-row items-center justify-end space-x-4">
              <div class="relative flex h-full grow flex-col">
                <div class="absolute -right-6 bottom-[calc(250%-22px)] z-10 w-[calc(100%-4px)] bg-white">
                  <div class="relative h-3 w-full bg-gray-600/13" />
                  <LineArrow class="absolute top-1/2 right-full z-10 -translate-y-1/2 -rotate-180 text-slate-600/13" />
                </div>
                <div class="grow" />
                <div class="relative -top-2.5 mr-1 ml-5 h-3 bg-gray-600/13">
                  <LineArrow class="absolute top-1/2 right-full z-10 -translate-y-1/2 -rotate-180 text-slate-600/13" />
                </div>
                <div class="grow" />
              </div>

              <div class="relative flex h-full flex-col">
                <div class="absolute bottom-full left-1/2 h-[calc(150%-30px)] -translate-x-1/2 bg-white px-1">
                  <div class="relative h-full w-3 bg-gray-600/13" />
                </div>
                <div class="absolute right-1/2 bottom-[calc(250%-22px)] z-10 w-1/2 translate-x-[-14px] bg-white">
                  <div
                    class="absolute top-0 right-[-20px] h-5 w-5 rounded-tr-xl border-t-12 border-r-12 border-gray-600/13" />
                  <div class="relative mr-[9px] h-3 w-full bg-gray-600/13" />
                </div>
                <div class="relative grow">
                  <div class="absolute bottom-2 left-1/2 h-full -translate-x-1/2 bg-white px-1">
                    <div class="relative h-full w-3 bg-gray-600/13" />
                  </div>
                </div>
                <div StatWrapper>
                  <div Stat>
                    {{ numeral(vaultingStats.bitcoinLocked).formatIfElse('> 1', '0,0.[00]', '0.[000000]') }}
                  </div>
                  <label>Vaulted Bitcoins</label>
                </div>
                <div class="grow" />
              </div>
              <div class="relative left-1 pb-6 text-4xl font-bold text-slate-600/20">+</div>
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
import BigNumber from 'bignumber.js';
import LineArrow from '../components/asset-breakdown/LineArrow.vue';

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
  const argonsRequired = calculateUnlockBurnPerBitcoinDollar(r);
  const argonCost = argonsRequired * simulateArgonUsdPrice;
  const profitPercent = ((1 - argonCost) / argonCost) * 100;
  return profitPercent;
}

const terraPercentReturn = Vue.computed(() => {
  const percentReturn = getBitcoinReturnAsPercent(finalPriceAfterTerraCollapse);
  return `${numeral(percentReturn).format('0,0')}%`;
});

const aboveTargetAmounts = Vue.ref<{ usdPrice: number; earningsPotentialPercent: number }[]>([]);

const belowTargetAmounts = Vue.ref<{ usdPrice: number; earningsPotentialPercent: number }[]>([]);

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
    return (1 / r) * (0.702 * r + 0.274);
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

  const targets: { usdPrice: number; earningsPotentialPercent: number }[] = [];
  const currentOffset = ((dollarsPerArgon.value - dollarTargetPerArgon.value) / dollarTargetPerArgon.value) * 100;
  const nextTier = 10 + Math.ceil(currentOffset / 10) * 10;
  const adjustedOffset = nextTier - currentOffset;
  for (let i = 1; i <= 4; i++) {
    const earningsPotentialPercent = adjustedOffset + (i - 1) * 10;
    const targetPrice = dollarTargetPerArgon.value * (1 + earningsPotentialPercent / 100);
    targets.push({
      usdPrice: targetPrice,
      earningsPotentialPercent,
    });
  }
  aboveTargetAmounts.value = targets.reverse();

  for (const percentOffTarget of [5, 10, 20]) {
    const actualPrice = dollarTargetPerArgon.value * ((100 - percentOffTarget) / 100);
    const earningsPotentialPercent = getBitcoinReturnAsPercent(actualPrice);
    belowTargetAmounts.value.push({
      usdPrice: actualPrice,
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
    @apply -mt-1 text-sm font-medium text-slate-700/50;
  }
}

[ArgonPrice] {
  @apply text-argon-600 text-6xl font-extrabold;
}
</style>
