<!-- prettier-ignore -->
<template>
  <DialogRoot class="absolute inset-0 z-10" :open="isOpen">
    <DialogPortal>
      <DialogOverlay asChild>
        <BgOverlay @close="finishReading" />
      </DialogOverlay>

      <DialogContent @escapeKeyDown="finishReading" :aria-describedby="undefined">
        <div
          ref="dialogPanel"
          class="HowVaultingWorksOverlay absolute top-20 left-24 right-24 bottom-12 flex flex-col rounded-md border border-black/40 shadow-xl bg-argon-menu-bg text-left z-20 transition-all focus:outline-none"
        >
          <div class="flex flex-col h-full w-full overflow-hidden">
            <h2
              FadeBorder
              class="relative text-3xl font-bold text-left border-b border-slate-300 pt-5 pb-4 pl-3 mx-4 text-[#672D73]"
              style="box-shadow: 0 1px 4px rgba(0, 0, 0, 0.1)"
            >
              <DialogTitle as="div" class="relative z-10">How Vaulting Works</DialogTitle>
              <div @click="cancelOverlay" class="absolute top-[22px] right-[0px] z-10 flex items-center justify-center text-sm/6 font-semibold cursor-pointer border rounded-md w-[30px] h-[30px] focus:outline-none border-slate-400/60 hover:border-slate-500/70 hover:bg-[#D6D9DF]">
                <XMarkIcon class="w-5 h-5 text-[#B74CBA] stroke-4" />
              </div>
            </h2>

            <div v-if="isLoaded" ref="dialogPanelContent" class="flex flex-col grow relative w-full overflow-y-auto px-8 py-5">
              <p>
                In many ways vaulting is the flip side of the mining process.
                Miners bring new stablecoins into existence, and Vaulters provide services to stabilize those stablecoins. Miners buy mining seats at auction, and vaulters
                collect all the revenue generated from those auctions.
              </p>

              <p>
                Just like the mining side, there is no third-party company, authority, or server helping to run
                this app. However, unlike the mining side, no mining machine is required to operate a vault. Everything runs directly from this app on your local machine.
              </p>

              <p>Below is a brief overview of how it all works.</p>

              <ul>
                <li>
                  <header>The Purpose of Vaults</header>
                  Vaults stabilize the Argon stablecoin by attracting Bitcoin Liquid Locks, which create financial "shorts" against the Argon. These "shorts" provide a profit incentive to burn away unwanted Argons from the system, in turn stabilizing the price of Argon.
                  <div class="border border-dashed border-gray-400/50 p-3 my-4 font-medium text-sm italic! rounded"><strong>> Unwanted Argons</strong> If the price of the Argon is below its target ($1), then there's too much supply. The extra supply is thus "unwanted" and its removal will stabilize the price.</div>
                </li>

                <li>
                  <header>Attracting Bitcoin to Vaults</header>
                  Vaults are able to attract new Bitcoin Liquid Locks by providing two key services:
                  <ol class="list-decimal">
                    <li>Provide securitization guarantees for Bitcoin locks.</li>
                    <li>Provide instant liquidity to new Bitcoin locks, even with depressed Argon prices.</li>
                  </ol>
                </li>

                <li>
                  <header>Benefits of Liquid Locking for Bitcoin</header>
                  When a Bitcoin is locked into a network Vault, the system will trade the owner the equivalent market value in Argons on a one-year loan.
                  This deal allows Bitcoiners to continue holding their assets while gaining full "market-value" in liquidity.
                  <br/><br/>
                  Bitcoin holders have one year to unlock by <strong>burning</strong> the loan-value of the Bitcoin. The deal is always favorable to the holder:<br/>
                  - If the market value of Bitcoin falls, they can re-lock and pocket the difference.<br/>
                  - If the market value of Bitcoin rises, they only owe the original lock price, so they net the increased Bitcoin value.<br/>
                  - If the market value of Argon falls, first movers are given a discounted price to unlock their Bitcoin.<br/><br/>
                  The important part of this last item is that the further the Argon price falls, the bigger discount
                  for the Bitcoin holder to unlock and the <span class="font-medium">MORE</span> of the unwanted Argons are burned away.
                  <table class="text-slate-800/50">
                    <thead>
                    <tr>
                      <th>BTC Lock Price</th>
                      <th>Current BTC Price</th>
                      <th>Argon Price/Target</th>
                      <th>Holder Gain</th>
                      <th>Argons Burned</th>
                    </tr>
                    </thead>
                    <tbody>
                    <tr>
                      <td>$90,000</td>
                      <td>$100,000 (+$10,000)</td>
                      <td>1.0</td>
                      <td>+$10,000 in BTC</td>
                      <td>₳90,000</td>
                    </tr>
                    <tr>
                      <td>$100,000</td>
                      <td>$90,000 (-$10,000)</td>
                      <td>1.0</td>
                      <td>+$10,000 in Argons</td>
                      <td>₳90,000</td>
                    </tr>
                    <tr>
                      <td>$100,000</td>
                      <td>$100,000 (+$0)</td>
                      <td>0.8</td>
                      <td>+$20,000 (price of Argons $80,000)</td>
                      <td>₳{{  micronotToArgonNm(BigInt(Math.floor(100_000 * 1e6 *  (((0.5618 * 0.8) + 0.3944) / 0.8)))).format('0,') }}</td>
                    </tr>
                    </tbody>
                  </table>
                </li>
                <li>
                  <header>Vault Revenue Streams</header>
                  Each Vault sets the security fees for locking Bitcoin into it (you can set a base fee and a percentage fee). Once Bitcoin is locked into a vault, the vault can then participate in the Network Treasury.
                  <table class="text-slate-800/50">
                    <thead>
                    <tr>
                      <th></th>
                      <th>Fee Settings</th>
                      <th>Bitcoin Lock Value</th>
                      <th>Fee Revenue</th>
                      <th>Treasury Revenue</th>
                    </tr>
                    </thead>
                    <tbody>
                    <tr v-for="(vault, index) in vaults" :key="vault.vaultId">
                      <td class="text-left">#{{ index+1  }}</td>
                      <td class="text-left">{{ currency.symbol }}{{ microgonToMoneyNm(vault.bitcoinBaseFee).format('0,0.00') }} + {{numeral(vault.bitcoinAnnualPercentRate * 100).format('0,[0.0]')}}%</td>
                      <td class="text-left">{{ currency.symbol }}{{ microgonToMoneyNm(vault.activatedSecuritization).format('0,0.00') }}</td>
                      <td class="text-left">{{ currency.symbol }}{{ microgonToMoneyNm(vault.feeRevenue).format('0,0.00') }}</td>
                      <td class="text-left">{{ currency.symbol }}{{ microgonToMoneyNm(vault.poolEarnings).format('0,0.00') }}</td>
                    </tr>
                    <tr v-if="vaults.length === 0">
                      <td colspan="5">Loading...</td>
                    </tr>
                    </tbody>
                  </table>
                </li>

                <li>
                  <header>The Network Treasury</header>
                  The Network Treasury is funded by the mining auction revenue generated every day (frame). The revenue from each frame goes into a Treasury Pool and used to pay out Liquid Locks when minting is not immediately available..<br/><br/>

                  A Vault can raise capital to match up to 1/10th of their locked bitcoin for each pool. This raised capital is returned at the end of the epoch, or once Bitcoins are minted (whichever is sooner). The Treasury pool is distributed as follows:<br/><br/>
                  - 20% of the capital is burned to prevent inflation.<br/>
                  - 80% is distributed to Vaults pro-rata based on how much they have contributed to the Treasury Pools.<br/>
                  - The distribution might be used for short-term loans to the network to provide instant liquidity for Bitcoin locks.<br/>
                  <table class="text-slate-800/50">
                    <thead>
                    <tr>
                      <th>Frame #</th>
                      <th>Mining Auction Revenue</th>
                      <th>Treasury Pool Capital</th>
                      <th>Burned (20%)</th>
                      <th>Vault Earnings (80%)</th>
                    </tr>
                    </thead>
                    <tbody>
                    <tr v-for="pool in treasuryPools" :key="pool.frameId">
                      <td class="text-left">{{ pool.frameId }}</td>
                      <td>{{ currency.symbol }}{{ microgonToMoneyNm(pool.auctionCapitalRaised).format('0,0.00') }}</td>
                      <td>{{ currency.symbol }}{{ microgonToMoneyNm(pool.treasuryPoolCapital).format('0,0.00') }}</td>
                      <td>{{ currency.symbol }}{{ microgonToMoneyNm(pool.burned).format('0,0.00') }}</td>
                      <td>{{ currency.symbol }}{{ microgonToMoneyNm(pool.earnings).format('0,0.00') }}</td>
                    </tr>
                    </tbody>
                  </table>
                </li>


                <li>
                  <header>Vault Responsibilities</header>
                  When you activate a vault, you create a keypair that is used to secure your half of any Bitcoins locked into your vault. The process to create new locks is automated and doesn't require any work beyond setup. However, you are the only owner of the keypair that can unlock Bitcoins in your vault, so you must:
                  <br/><br/>
                  - Preserve and backup your security keys that can unlock Bitcoin Liquid Locks<br/>
                  - Respond to unlock requests within 10 days<br/>
                </li>
                <li>
                  <header>Kick-starting Your Vault with BTC</header>
                   You can kickstart your vault by directly depositing an initial bitcoin transaction into it (skipping any fees). Once your Bitcoin is verified, you can start earning a share of the Treasury Pools.
                </li>
              </ul>
            </div>
            <div v-else>Loading...</div>

            <div 
              FadeBorder
              class="flex flex-row justify-end border-t border-slate-300 mx-4 py-4 space-x-4 rounded-b-lg"
              style="box-shadow: 0 -1px 4px rgba(0, 0, 0, 0.1)"
            >
              <div class="flex flex-row space-x-4 justify-center items-center relative z-10">
                <button @click="finishReading" class="border border-argon-button/50 hover:border-argon-button text-xl font-bold text-gray-500 px-7 py-1 rounded-md cursor-pointer">
                  <span>Finish Reading</span>
                </button>
              </div>
            </div>
          </div>
        </div>
      </DialogContent>
    </DialogPortal>
  </DialogRoot>
</template>

<script setup lang="ts">
import * as Vue from 'vue';
import { useCurrency } from '../../stores/currency.ts';
import { DialogContent, DialogOverlay, DialogPortal, DialogRoot, DialogTitle } from 'reka-ui';
import basicEmitter from '../../emitters/basicEmitter';
import { useConfig } from '../../stores/config';
import BgOverlay from '../../components/BgOverlay.vue';
import { XMarkIcon } from '@heroicons/vue/24/outline';
import { createNumeralHelpers } from '../../lib/numeral.ts';
import { useVaults } from '../../stores/vaults.ts';
import numeral from 'numeral';

const config = useConfig();
const currency = useCurrency();
const vaultStore = useVaults();

const { micronotToArgonNm, microgonToMoneyNm } = createNumeralHelpers(currency);
const isOpen = Vue.ref(false);
const isLoaded = Vue.ref(false);

const dialogPanelContent = Vue.ref<HTMLDivElement | null>(null);

const vaults = Vue.ref<
  {
    vaultId: number;
    operatorAccountId: string;
    bitcoinBaseFee: bigint;
    bitcoinAnnualPercentRate: number;
    activatedSecuritization: bigint;
    feeRevenue: bigint;
    poolEarnings: bigint;
    apy: number;
  }[]
>([]);

const treasuryPools = Vue.ref<
  {
    frameId: number;
    auctionCapitalRaised: bigint;
    treasuryPoolCapital: bigint;
    burned: bigint;
    earnings: bigint;
  }[]
>([]);

function finishReading() {
  const el = dialogPanelContent.value;
  if (!el) {
    isOpen.value = false;
    return;
  }
  const start = el.scrollTop;
  const end = Math.max(0, el.scrollHeight - el.clientHeight);
  const change = end - start;
  if (change <= 0 || end === 0) {
    isOpen.value = false;
    return;
  }
  const remainingFraction = change / end; // 1.0 if at top, 0.5 if halfway, etc.
  const duration = Math.max(0, 1500 * remainingFraction);
  let startTime: number | null = null;
  const step = (ts: number) => {
    if (startTime === null) startTime = ts;
    const p = Math.min((ts - startTime) / duration, 1);
    const eased = p < 0.5 ? 2 * p * p : -1 + (4 - 2 * p) * p; // easeInOutQuad
    el.scrollTop = start + change * eased;
    if (p < 1) requestAnimationFrame(step);
    else isOpen.value = false;
  };
  requestAnimationFrame(step);
}

function cancelOverlay() {
  isOpen.value = false;
}

async function loadVaults() {
  await vaultStore.load();
  await vaultStore.refreshRevenue();

  const nextVaults = [];
  for (const vault of Object.values(vaultStore.vaultsById)) {
    const { terms } = vault;
    const apy = vaultStore.calculateVaultApy(vault.vaultId);
    nextVaults.push({
      vaultId: vault.vaultId,
      operatorAccountId: vault.operatorAccountId,
      bitcoinAnnualPercentRate: terms.bitcoinAnnualPercentRate.toNumber(),
      activatedSecuritization: vault.activatedSecuritization(),
      bitcoinBaseFee: terms.bitcoinBaseFee,
      poolEarnings: vaultStore.treasuryPoolEarnings(vault.vaultId),
      feeRevenue: vaultStore.getTotalFeeRevenue(vault.vaultId),
      apy,
    });
  }
  if (vaultStore.stats === null) return;

  const oldestFrame = vaultStore.stats!.synchedToFrame - 10;
  const statsByFrame: {
    [frameId: number]: {
      frameId: number;
      auctionCapitalRaised: bigint;
      treasuryPoolCapital: bigint;
      earnings: bigint;
      burned: bigint;
    };
  } = {};
  for (const vault of Object.values(vaultStore.stats!.vaultsById)) {
    for (const { frameId, treasuryPool } of Object.values(vault.changesByFrame)) {
      if (frameId < oldestFrame) continue;
      statsByFrame[frameId] ??= {
        frameId: frameId,
        auctionCapitalRaised: 0n,
        treasuryPoolCapital: 0n,
        burned: 0n,
        earnings: 0n,
      };
      const auctionPool = (treasuryPool.totalEarnings * 120n) / 100n;
      statsByFrame[frameId].auctionCapitalRaised += auctionPool;
      statsByFrame[frameId].treasuryPoolCapital += treasuryPool.externalCapital + treasuryPool.vaultCapital;
      statsByFrame[frameId].burned += auctionPool - treasuryPool.totalEarnings;
      statsByFrame[frameId].earnings += treasuryPool.totalEarnings;
    }
  }
  treasuryPools.value = Object.values(statsByFrame);
  treasuryPools.value.sort((a, b) => b.frameId - a.frameId);
  if (treasuryPools.value.length > 10) treasuryPools.value.length = 10;
  nextVaults.sort((a, b) => Number(b.activatedSecuritization - a.activatedSecuritization));
  vaults.value = nextVaults;
}

basicEmitter.on('openHowVaultingWorksOverlay', async () => {
  if (isOpen.value) return;
  isOpen.value = true;
  void loadVaults();

  isLoaded.value = true;
  config.hasReadVaultingInstructions = true;
});
</script>

<style>
@reference "../../main.css";

.HowVaultingWorksOverlay {
  [FadeBorder] {
    position: relative;
    &:before {
      @apply from-argon-menu-bg bg-gradient-to-r to-transparent;
      content: '';
      display: block;
      width: 30px;
      position: absolute;
      z-index: 1;
      left: -5px;
      top: -5px;
      bottom: -5px;
    }
    &:after {
      @apply from-argon-menu-bg bg-gradient-to-l to-transparent;
      content: '';
      display: block;
      width: 30px;
      position: absolute;
      z-index: 1;
      right: -5px;
      top: -5px;
      bottom: -5px;
    }
  }

  header {
    @apply mt-2 font-bold;
  }

  ul > li,
  p {
    @apply mb-4;
  }

  ol > li {
    @apply mt-2;
  }

  ol {
    @apply ml-6;
  }

  table {
    @apply text-md mt-3 mb-5 ml-0.5 w-full font-mono;
    th {
      @apply pb-1 text-right font-bold;
    }
    td {
      @apply border-t border-slate-300 py-1 text-right;
    }
    tr:last-child td {
      @apply border-b border-slate-300;
    }
    th:first-child,
    td:first-child {
      @apply text-left;
    }
  }
}
</style>
