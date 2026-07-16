<template>
  <div class="Navigation LeftBar z-10 flex h-full max-w-76 min-w-76 flex-col gap-y-1.5 select-none">
    <section DashBox class="border-argon-600/50! w-full px-1">
      <div class="mt-3">
        <header>Basic Nav</header>
        <ul>
          <li @click="goto(TopTab.Dashboard)" :class="{ Selected: controller.selectedTab === TopTab.Dashboard }">
            <article class="flex flex-row items-center">
              <div class="grow">Account Overview</div>
              <!--              <div><span class="rounded-full bg-slate-600/40 px-2 font-bold text-white">0</span></div>-->
            </article>
            <div Selector />
          </li>
          <li @click="goto(TopTab.Network)" :class="{ Selected: controller.selectedTab === TopTab.Network }">
            <article class="flex flex-row items-center">
              <div class="grow">Network Economics</div>
              <!--              <div><span class="rounded-full bg-slate-600/40 px-2 font-bold text-white">0</span></div>-->
            </article>
            <div Selector />
          </li>
        </ul>
      </div>
    </section>

    <section DashBox v-if="config.isLoaded && config.hasExtensionTreasury" class="border-argon-600/50! w-full px-1">
      <div class="mt-3">
        <header>Treasury</header>
        <ul>
          <li @click="goto(TopTab.BitcoinLocks)" :class="{ Selected: controller.selectedTab === TopTab.BitcoinLocks }">
            <article class="flex flex-row items-center">
              <div class="grow flex flex-row items-center">
                <div class="w-6 mr-1">
                  <BitcoinIcon class="w-6" />
                </div>
                Bitcoin Locks
                <GiftIcon v-if="bitcoinLockCoupons.openCouponCount" class="w-4 ml-2 text-argon-800/50" />
              </div>
              <div class="flex items-center gap-x-2">
                <span class="opacity-60">
                  {{ currency.symbol }}{{ satToMoneyNm(financials.liquidTotalSatoshis).format('0,0.00') }}
                </span>
              </div>
            </article>
            <div Selector />
          </li>
          <!--          <li @click="goto(TopTab.BitcoinLoans)" :class="{ Selected: controller.selectedTab === TopTab.BitcoinLoans }">-->
          <!--            <article class="flex flex-row items-center">-->
          <!--              <div class="grow">Bitcoin Loans</div>-->
          <!--              <div class="opacity-60">-->
          <!--                {{ currency.symbol }}{{ microgonToMoneyNm(financials.liquidCurrentBitcoinDebt).format('0,0.00') }}-->
          <!--              </div>-->
          <!--            </article>-->
          <!--            <div Selector>-->
          <!--              <div ArrowSquare>-->
          <!--                <Arrow ActiveArrow fill="white" stroke="#D3D9E3" :strokeWidth="1" />-->
          <!--              </div>-->
          <!--            </div>-->
          <!--          </li>-->
          <li @click="goto(TopTab.ArgonBonds)" :class="{ Selected: controller.selectedTab === TopTab.ArgonBonds }">
            <article class="flex flex-row items-center">
              <div class="w-6 mr-1">
                <BondIcon class="w-5.5 opacity-60" />
              </div>
              <div class="grow">Argon Bonds</div>
              <div class="opacity-60">
                {{ currency.symbol
                }}{{
                  microgonToMoneyNm(myBonds.bondLots.reduce((sum, bondLot) => sum + bondLot.bondMicrogons, 0n)).format(
                    '0,0.00',
                  )
                }}
              </div>
            </article>
            <div Selector />
          </li>
          <!--          <li @click="goto(TopTab.ArgonotBonds)" :class="{ Selected: controller.selectedTab === TopTab.ArgonotBonds }">-->
          <!--            <article class="flex flex-row items-center">-->
          <!--              <div class="grow">Argonot Bonds</div>-->
          <!--              <div class="opacity-60">-->
          <!--                {{ currency.symbol-->
          <!--                }}{{-->
          <!--                  micronotToMoneyNm(-->
          <!--                    myBonds.bondLots-->
          <!--                      .filter(bondLot => bondLot.programType === 'Argonot')-->
          <!--                      .reduce((sum, bondLot) => sum + bondLot.bondMicrogons, 0n),-->
          <!--                  ).format('0,0.00')-->
          <!--                }}-->
          <!--              </div>-->
          <!--            </article>-->
          <!--            <div Selector>-->
          <!--              <div ArrowSquare>-->
          <!--                <Arrow ActiveArrow fill="white" stroke="#D3D9E3" :strokeWidth="1" />-->
          <!--              </div>-->
          <!--            </div>-->
          <!--          </li>-->
          <li @click="goto(TopTab.StableSwaps)" :class="{ Selected: controller.selectedTab === TopTab.StableSwaps }">
            <article class="flex flex-row items-center">
              <div class="grow">Stable Swaps</div>
              <div class="opacity-60">
                {{ currency.symbol }}{{ config.hasActivatedStableSwaps ? microgonToMoneyNm(financials.swapsTotalValue).format('0,0.00') : '0.00' }}
              </div>
            </article>
            <div Selector />
          </li>
        </ul>
      </div>
    </section>

    <section DashBox v-if="config.isLoaded && config.hasExtensionOperations" class="border-argon-600/50! w-full px-1">
      <div class="mt-3">
        <header class="relative flex flex-row items-center">
          <div class="grow">Operations</div>
          <button type="button" class="cursor-pointer" @click="openDefaultArgonWallet">
            <MoreIcon class="h-4 opacity-80" />
          </button>
          <ArrowCalloutButton
            v-if="showOperationsNavigationCallouts"
            label="New"
            guidanceTitle="Operations Unlocked"
            guidance="Mining and Vaulting are now available from the sidebar."
            :showGuidanceActions="false"
            class="pointer-events-none absolute top-1/2 right-0 z-50 translate-x-[calc(100%+0.75rem)] -translate-y-1/2"
          />
        </header>
        <ul>
          <li
            data-testid="LeftBar.goto(TopTab.Mining)"
            class="relative"
            @click="goto(TopTab.Mining)"
            :class="{
              Selected: controller.selectedTab === TopTab.Mining,
              'bg-argon-100/40 ring-argon-400/40 ring-1': showOperationsNavigationCallouts,
            }"
          >
            <article class="flex flex-col">
              <div class="flex flex-row items-center">
                <div class="grow flex flex-row items-center">
                  <div class="w-6 mr-1">
                    <MiningOilIcon class="w-6 relative -top-0.5" />
                  </div>
                  Mining
                </div>
                <div class="opacity-60">
                  {{ currency.symbol }}{{ microgonToMoneyNm(miningAssets.totalMiningResources).format('0,0.00') }}
                </div>
              </div>
              <div v-if="controller.selectedTab === TopTab.Mining">
                <div class="flex flex-row">
                  <div class="grow flex flex-row items-center">
                    <div class="Connector" />
                    <div class="grow flex flex-row items-center border-t border-slate-400/30">
                      <div class="grow">{{ numeral(miningAssets.auctionBidCount).format('0,0') }} Current Bids</div>
                      <AuctionIcon class="w-4" />
                    </div>
                  </div>
                </div>
                <div class="flex flex-row">
                  <div class="grow flex flex-row items-center">
                    <div class="Connector" />
                    <div class="grow flex flex-row items-center border-t border-slate-400/30">
                      <div class="grow">{{ numeral(miningAssets.seatActiveCount).format('0,0') }} Active Seats</div>
                    </div>
                  </div>
                </div>
              </div>
              <ArrowCalloutButton
                v-if="
                  !showOperationsNavigationCallouts &&
                  controller.selectedTab !== TopTab.Mining &&
                  (controller.activeGuideId === OperationalStepId.FirstMiningSeat ||
                    controller.activeGuideId === OperationalStepId.MoreMiningSeats)
                "
                guidance="Continue this certification task in Mining."
                class="pointer-events-none absolute top-1/2 right-0 z-50 translate-x-[calc(100%+0.75rem)] -translate-y-1/2"
              />
            </article>
            <div Selector />
          </li>
          <li
            data-testid="LeftBar.goto(TopTab.Vaulting)"
            class="relative"
            @click="goto(TopTab.Vaulting)"
            :class="{
              Selected: controller.selectedTab === TopTab.Vaulting,
              'bg-argon-100/40 ring-argon-400/40 ring-1': showOperationsNavigationCallouts,
            }"
          >
            <article class="flex flex-col">
              <div class="flex flex-row items-center relative">
                <div class="grow">Vaulting</div>
                <div class="opacity-60">
                  {{ currency.symbol }}{{ microgonToMoneyNm(vaultingAssets.totalVaultValue).format('0,0.00') }}
                </div>
              </div>
              <div v-if="controller.selectedTab === TopTab.Vaulting">
                <div class="flex flex-row">
                  <div class="grow flex flex-row items-center">
                    <div class="grow">- {{ microgonToArgonNm(vaultingAssets.securityMicrogons).format('0,0.[00]') }} Argons Securitized</div>
                    <EditIcon class="w-4 opacity-60" />
                  </div>
                </div>
                <div class="flex flex-row">
                  <div class="grow flex flex-row items-center">
                    <div class="grow">- {{ micronotToArgonotNm(vaultingAssets.securityMicronots).format('0,0.[00]') }} Argonots Staked</div>
                    <EditIcon class="w-4 opacity-60" />
                  </div>
                </div>
              </div>
              <ArrowCalloutButton
                v-if="
                  !showOperationsNavigationCallouts &&
                  controller.selectedTab !== TopTab.Vaulting &&
                  controller.activeGuideId === OperationalStepId.ActivateVault
                "
                guidance="Continue this certification task in Vaulting."
                class="pointer-events-none absolute top-1/2 right-0 z-50 translate-x-[calc(100%+0.75rem)] -translate-y-1/2"
              />
            </article>
            <div Selector />
          </li>
          <li @click="goto(TopTab.Invites)" :class="{ Selected: controller.selectedTab === TopTab.Invites }">
            <article class="flex flex-col relative">
              <div class="flex flex-row items-center relative">
                <div class="grow">Invites</div>
                <div class="opacity-60">{{ currency.symbol }}0.00</div>
              </div>
              <div v-if="controller.selectedTab === TopTab.Invites">
                <div class="flex flex-row">
                  <div class="grow flex flex-row items-center">
                    <div class="grow">- {{ microgonToArgonNm(vaultingAssets.securityMicrogons).format('0,0.[00]') }} Pending</div>
                  </div>
                </div>
                <div class="flex flex-row">
                  <div class="grow flex flex-row items-center">
                    <div class="grow">- {{ micronotToArgonotNm(vaultingAssets.securityMicronots).format('0,0.[00]') }} Converted</div>
                  </div>
                </div>
              </div>
            </article>
            <div Selector />
          </li>
        </ul>
      </div>
    </section>

    <section DashBox class="flex w-full grow flex-col justify-end px-1">
      <div
        v-if="config.isLoaded && !config.hasExtensionTreasury"
        class="relative flex grow flex-col items-center justify-center text-center"
      >
        <DiamondsIcon class="text-argon-600/80 mb-2 w-20" />
        <div
          class="text-argon-600/70 flex h-[30px] cursor-pointer flex-row items-center justify-center overflow-hidden rounded-md border border-slate-400/50 text-base font-semibold whitespace-nowrap hover:border-slate-400/50 hover:bg-slate-400/10 focus:outline-none data-[state=open]:border-slate-400/60 data-[state=open]:bg-slate-400/10"
          @click="openUpgradeToTreasuryOverlay"
        >
          <div class="relative flex flex-row items-center gap-1.5 px-5 py-3 whitespace-nowrap">Upgrade to Treasury</div>
        </div>
        <div class="relative mt-3 text-slate-700/60">
          Insert an access code to
          <br />
          unlock yield generating assets.
        </div>
      </div>
      <div
        v-else-if="config.isLoaded && config.hasExtensionTreasury && controller.completedTreasuryCertificationStepCount !== treasuryCertificationStepIds.length"
        class="relative flex grow flex-col items-center justify-center text-center"
      >
        <div class="relative flex flex-row items-center text-center font-bold whitespace-nowrap">Next Steps</div>
        <div class="relative mt-1 text-slate-700/60">
          Finish Treasury certification
          <br />
          to be eligible for the next level!
        </div>
      </div>
      <div
        v-else
        class="relative flex grow flex-col items-center justify-center text-center text-slate-700/30"
      >
        <div class="relative flex flex-row items-center text-center whitespace-nowrap">Explore</div>
        <div class="relative mt-px">
          <a class="opacity-40 hover:opacity-100 cursor-pointer">Docs</a> and <a class="opacity-40 hover:opacity-100 cursor-pointer">Community</a>
        </div>
      </div>
      <!--      <div-->
      <!--        v-else-if="-->
      <!--          config.hasExtensionTreasury &&-->
      <!--          controller.completedTreasuryCertificationStepCount === treasuryCertificationStepIds.length-->
      <!--        "-->
      <!--        class="flex grow items-center justify-center px-8 py-8"-->
      <!--      ></div>-->
<!--      <ul class="flex w-full flex-row gap-x-3 px-3 pb-3 text-center">-->
<!--        <li class="w-1/2">-->
<!--          <div-->
<!--            @click="() => void openLink('https://argon.network/docs')"-->
<!--            class="text-argon-600/80 hover:text-argon-600/70 flex cursor-pointer flex-col items-center gap-y-1 pt-4 text-center"-->
<!--          >-->
<!--            <InstructionsIcon class="h-6 w-6" />-->
<!--            <div>Docs</div>-->
<!--          </div>-->
<!--        </li>-->
<!--        <li class="w-1/2">-->
<!--          <div-->
<!--            @click="() => void openLink('https://discord.gg/xDwwDgCYr9')"-->
<!--            class="text-argon-600/80 hover:text-argon-600/70 flex cursor-pointer flex-col items-center gap-y-1 pt-4 text-center"-->
<!--          >-->
<!--            <DiscordIcon class="-mb-1 h-7 w-7" />-->
<!--            <div>Community</div>-->
<!--          </div>-->
<!--        </li>-->
<!--      </ul>-->
      <section
        DashBox
        class="border-argon-400! relative -bottom-px -left-2 w-[calc(100%+26px)] rounded-lg! rounded-tl-none!"
        style="box-shadow: 1px 1px 5px 3px rgba(0,0,0,0.05)"
      >
        <div class="border-argon-400 absolute -top-2 -left-px h-3 w-2 border-l bg-white" />
        <div class="border-argon-400 absolute -top-5 -left-px -z-1 h-5 w-2.5 rounded-l-full border bg-slate-400/40" />
        <div
          class="border-argon-400 absolute -top-5 -left-px h-5 w-2.5 rounded-l-full border border-t-transparent border-r-transparent"
        />
        <div
          @click="openDefaultArgonWallet"
          class="bg-argon-100/20 hover:bg-argon-100/30 h-full w-full cursor-pointer"
          style="text-shadow: 1px 1px 0 white"
        >
          <div class="absolute top-0 left-0 h-full w-5 rounded-bl-lg bg-linear-to-r from-slate-600/10 to-transparent" />
          <div class="flex flex-col justify-center pl-3 pr-3 pt-3">
            <header class="flex w-full flex-row items-center border-b border-slate-500/20">
              <div>Argon Wallet</div>
              <ChevronDownIcon class="ml-1.5 w-4" />
              <div class="flex grow flex-row justify-end gap-x-3.5 pr-1">
                <button type="button" class="cursor-pointer" @click="openDefaultArgonWallet">
                  <CopyIcon class="h-4 opacity-80" />
                </button>
                <button type="button" class="cursor-pointer" @click="openDefaultArgonWallet">
                  <MoreIcon class="h-4 opacity-80" />
                </button>
              </div>
            </header>
            <div class="py-7 flex flex-col justify-center">
              <div class="text-argon-600/70 flex flex-row justify-center text-5xl font-bold">
                <span>{{ currency.symbol }}</span>
                <FormattedMoney
                  :isLoaded="wallets.isLoaded"
                  :value="
                    wallets.defaultArgonWallet.totalMicrogons +
                    currency.convertMicronotTo(wallets.defaultArgonWallet.totalMicronots, UnitOfMeasurement.Microgon)
                  "
                />
              </div>
              <div class="mt-2 w-fit mx-auto border-t border-slate-500/30 pt-2 text-center opacity-50">
                {{ currency.symbol }}{{ microgonToMoneyNm(financials.savingsTotalPending).format('0,0.00') }} Is Locked On Chain
              </div>
            </div>
          </div>
        </div>
      </section>
    </section>
  </div>
</template>

<script setup lang="ts">
import * as Vue from 'vue';
import { MiningSetupStatus, TopTab, VaultingSetupStatus } from '../interfaces/IConfig.ts';
import { OperationalStepId, useCertificationController, treasuryCertificationStepIds } from '../stores/certificationController.ts';
import { getConfig } from '../stores/config.ts';
import FormattedMoney from '../components/FormattedMoney.vue';
import { getBitcoinLockCoupons } from '../stores/bitcoin.ts';
import WalletsMenu from './WalletsMenu.vue';
import Arrow from '../components/Arrow.vue';
import basicEmitter from '../emitters/basicEmitter.ts';
import { WalletType } from '../lib/Wallet.ts';
import ArrowCalloutButton from '../components/ArrowCalloutButton.vue';
import { useWallets } from '../stores/wallets.ts';
import { getCurrency } from '../stores/currency.ts';
import numeral, { createNumeralHelpers } from '../lib/numeral.ts';
import { UnitOfMeasurement } from '@argonprotocol/apps-core';
import { useFinancials } from '../stores/financials.ts';
import { useMyBonds } from '../stores/myBonds.ts';
import { useMiningAssetBreakdown } from '../stores/miningAssetBreakdown.ts';
import { useVaultingAssetBreakdown } from '../stores/vaultingAssetBreakdown.ts';
import { open as tauriOpenUrl } from '@tauri-apps/plugin-shell';
import DiscordIcon from '../assets/discord.svg';
import InstructionsIcon from '../assets/instructions.svg';
import DiamondsIcon from '../assets/diamonds.svg?component';
import { ChevronDownIcon } from '@heroicons/vue/24/outline';
import MoreIcon from '../assets/more.svg';
import CopyIcon from '../assets/copy.svg';
import GiftIcon from '../assets/gift.svg';
import EditIcon from '../assets/edit.svg';
import BitcoinIcon from '../assets/wallets/bitcoin.svg';
import BondIcon from '../assets/bond.svg';
import AuctionIcon from '../assets/auction.svg';
import MiningOilIcon from '../assets/mining-oil.svg';

const controller = useCertificationController();
const bitcoinLockCoupons = getBitcoinLockCoupons();
const config = getConfig();
const wallets = useWallets();
const currency = getCurrency();
const financials = useFinancials();
const myBonds = useMyBonds();
const miningAssets = useMiningAssetBreakdown();
const vaultingAssets = useVaultingAssetBreakdown();

const { microgonToArgonNm, microgonToMoneyNm, micronotToArgonotNm, micronotToMoneyNm, satToMoneyNm } =
  createNumeralHelpers(currency);

const showOperationsNavigationCallouts = Vue.ref(false);

function openDefaultArgonWallet() {
  basicEmitter.emit('openWalletOverlay', { walletType: WalletType.defaultArgon });
}

function openLink(url: string) {
  void tauriOpenUrl(url);
}

function openUpgradeToTreasuryOverlay() {
  basicEmitter.emit('openUpgradeToTreasuryOverlay');
}

function goto(tab: TopTab) {
  if ([TopTab.Mining, TopTab.Vaulting].includes(tab)) {
    showOperationsNavigationCallouts.value = false;
  }

  if (
    tab === TopTab.Mining &&
    (controller.activeGuideId === OperationalStepId.FirstMiningSeat ||
      controller.activeGuideId === OperationalStepId.MoreMiningSeats)
  ) {
    controller.backButtonTriggersHome = true;
    if (config.miningSetupStatus === MiningSetupStatus.None) {
      config.miningSetupStatus = MiningSetupStatus.Checklist;
    }
  } else if (tab === TopTab.Vaulting && controller.activeGuideId === OperationalStepId.ActivateVault) {
    controller.backButtonTriggersHome = true;
    config.vaultingSetupStatus = VaultingSetupStatus.Checklist;
  } else if (controller.backButtonTriggersHome) {
    controller.backButtonTriggersHome = false;
    if (tab === TopTab.Mining) {
      config.miningSetupStatus = MiningSetupStatus.None;
    } else if (tab === TopTab.Vaulting) {
      config.vaultingSetupStatus = VaultingSetupStatus.None;
    }
  }
  controller.setTab(tab);
}

function highlightOperationsNavigation() {
  showOperationsNavigationCallouts.value = true;
}

basicEmitter.on('highlightOperationsNavigation', highlightOperationsNavigation);

Vue.onBeforeUnmount(() => {
  basicEmitter.off('highlightOperationsNavigation', highlightOperationsNavigation);
});
</script>

<style scoped>
@reference "../main.css";

header {
  @apply px-2 pt-1 pb-3 font-bold text-slate-700/40 uppercase;
}

.Connector {
  @apply relative h-full w-9;
  &:before {
    content: '';
    @apply bg-argon-600/40 absolute top-0 left-1/2 h-1/2 w-px translate-x-[-6px];
  }
  &:after {
    content: '';
    @apply bg-argon-600/40 absolute top-1/2 left-1/2 h-px w-3.5 translate-x-[-6px];
  }
}

ul li {
  @apply relative cursor-pointer border-t border-slate-500/20 py-1;
  &.Selected {
    @apply cursor-default;
    [Selector] {
      @apply block;
    }
    article {
      @apply text-slate-900;
    }
    article[TopLevel] {
      @apply text-argon-700/70;
    }
  }
  &:hover:not(.Selected) {
    article {
      @apply text-slate-900;
    }
    article[TopLevel] {
      @apply text-argon-700/50;
    }
  }
  article {
    @apply relative z-10 px-2 py-2 text-slate-900/60;
  }
  article[TopLevel] {
    @apply font-bold text-slate-700/60 uppercase;
  }
  [Selector] {
    @apply border-argon-400 absolute -top-px left-[-5px] hidden h-[calc(100%+2px)] w-[calc(100%+25px)] rounded-r-lg border shadow-lg bg-white;
    &:before {
      @apply bg-argon-100/10 absolute left-0 top-0 h-full w-full;
      content: '';
    }
  }
}
</style>
