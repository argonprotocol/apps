<template>
  <TooltipProvider :disableHoverableContent="true" class="flex h-full flex-col">
    <div class="flex h-full grow flex-col justify-stretch gap-y-2 px-2.5 py-2.5">
      <section box class="flex flex-row items-center !py-3 text-slate-900/90">
        <div class="flex min-h-[6%] w-full flex-row items-center px-5 py-2">
          <p class="w-8/12 font-light">
            Argon is the stablecoin that’s built to last for a thousand years. It uses the natural tension between
            mining and vaulting to create an eternal balance in the ecosystem.
          </p>
          <div class="grow justify-center text-right">Watch Welcome Video</div>
        </div>
      </section>
      <div class="flex flex-row items-stretch gap-x-2">
        <section box class="flex min-h-60 w-1/2 flex-col px-2">
          <header class="flex flex-row border-b border-slate-400/30 py-2 text-[18px] font-bold text-slate-900/80">
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
              class="text-argon-600 border-argon-600 mt-2 ml-3 min-w-7/12 cursor-pointer rounded border px-5 py-1">
              Open Mining Screen to Activate
            </button>
          </template>
        </section>
        <section box class="w-1/2 px-2">
          <header class="flex flex-row border-b border-slate-400/30 py-2 text-[18px] font-bold text-slate-900/80">
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
              class="text-argon-600 border-argon-600 mt-2 ml-3 min-w-7/12 cursor-pointer rounded border px-5 py-1">
              Open Vaulting Screen to Activate
            </button>
          </template>
        </section>
      </div>

      <section box class="flex grow flex-col items-center justify-center gap-x-2 px-2">
        <header class="h-1/5 pt-6 text-[18px] font-bold text-slate-900/80">Global Ecosystem</header>
        <div class="flex h-4/5 w-full flex-row px-10">
          <div class="flex w-1/3 flex-col">
            <div StatWrapper class="h-1/4">
              <div Stat>
                {{ currency.symbol
                }}{{ microgonToMoneyNm(miningStats.aggregatedBidCosts).formatIfElse('< 1_000', '0,0.[00]', '0,0') }}
              </div>
              <label>Mining Bids this Epoch</label>
            </div>
            <div class="h-1/4" StatWrapper>
              <div Stat>{{ miningStats.activeMiningSeatCount }}</div>
              <label>Active Miners</label>
            </div>
            <div class="h-1/4" StatWrapper>
              <div Stat>
                {{ currency.symbol
                }}{{ microgonToMoneyNm(miningStats.aggregatedBlockRewards).formatIfElse('< 1_000', '0,0.[00]', '0,0') }}
              </div>
              <label>Base Mining Rewards</label>
            </div>
            <div class="flex h-1/4 flex-row items-center space-x-4">
              <div StatWrapper>
                <div Stat>{{ micronotToArgonotNm(micronotsInCirculation).format('0,0') }}</div>
                <label>Argonot Circulation</label>
              </div>
              <div>+</div>
              <div StatWrapper>
                <div Stat>{{ microgonToArgonNm(microgonsInCirculation).format('0,0') }}</div>
                <label>Argon Circulation</label>
              </div>
            </div>
          </div>

          <div class="flex w-1/3 flex-col">
            <div class="flex h-3/4 grow flex-col text-center">
              <div class="grow"></div>
              <div ArgonPrice>{{ currency.symbol }}{{ dollarsPerArgonFormatted }}</div>
              <div class="grow"></div>
            </div>
            <div class="h-1/4 text-center" StatWrapper>
              <div Stat>{{ currency.symbol }}{{ numeral(unlockValueInArgons).format('0,0') }}</div>
              <label>Argon Burn from Bitcoin Shorts</label>
            </div>
          </div>

          <div class="flex w-1/3 flex-col text-right">
            <div StatWrapper class="h-1/4">
              <div Stat>
                {{ currency.symbol
                }}{{ microgonToMoneyNm(vaultingStats.epochEarnings).formatIfElse('< 1_000', '0,0.00', '0,0') }}
              </div>
              <label>Vaulting Revenue this Epoch</label>
            </div>
            <div StatWrapper class="h-1/4">
              <div Stat>{{ vaultingStats.vaultCount }}</div>
              <label>Active Vaults</label>
            </div>
            <div StatWrapper class="h-1/4">
              <div Stat>
                {{ currency.symbol
                }}{{ microgonToMoneyNm(activatedSecuritization).formatIfElse('< 1_000', '0,0.00', '0,0') }}
              </div>
              <label>Bitcoin Security</label>
            </div>
            <div class="flex h-1/4 flex-row items-center justify-end space-x-4">
              <div StatWrapper>
                <div Stat>{{ vaultingStats.bitcoinLocked }}</div>
                <label>Vaulted Bitcoins</label>
              </div>
              <div>+</div>
              <div StatWrapper>
                <div Stat>
                  {{ currency.symbol
                  }}{{ microgonToMoneyNm(liquidityReceived).formatIfElse('< 1_000', '0,0.00', '0,0') }}
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

[StatWrapper] {
  @apply flex flex-col justify-center gap-y-1;
  [Stat] {
    @apply text-2xl font-bold;
  }
}

[ArgonPrice] {
  @apply text-5xl font-bold;
}
</style>
