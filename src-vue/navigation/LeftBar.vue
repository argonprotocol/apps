<template>
  <div class="Navigation LeftBar z-10 flex h-full max-w-76 min-w-76 flex-col gap-y-1.5 select-none">
    <section DashBox class="w-full">
      <div class="flex flex-col justify-center px-1">
        <header class="flex w-full flex-row items-center border-b border-slate-500/20">
          <div class="grow">Your Argon Wallet</div>
          <button type="button" class="cursor-pointer" @click="openDefaultArgonWallet">
            <ExternalIcon class="w-4 opacity-80" />
          </button>
        </header>
        <div class="text-argon-600/70 mt-5 flex flex-row justify-center text-5xl font-bold">
          <span>{{ currency.symbol }}</span>
          <FormattedMoney
            :isLoaded="wallets.isLoaded"
            :value="
              wallets.defaultArgonWallet.totalMicrogons +
              currency.convertMicronotTo(wallets.defaultArgonWallet.totalMicronots, UnitOfMeasurement.Microgon)
            "
          />
        </div>
        <div class="w-full text-center">Total Value</div>
        <div class="mt-4 text-left text-slate-900/60">
          <div class="flex flex-row border-t border-slate-500/20 px-3 py-2">
            <div class="grow">
              {{ microgonToArgonNm(wallets.defaultArgonWallet.totalMicrogons).format('0,0.[00]') }} ARGN
            </div>
            <div class="opacity-60">
              {{ currency.symbol }}{{ microgonToMoneyNm(wallets.defaultArgonWallet.totalMicrogons).format('0,0.00') }}
            </div>
          </div>
          <div class="flex flex-row border-t border-slate-500/20 px-3 py-2">
            <div class="grow">
              {{ micronotToArgonotNm(wallets.defaultArgonWallet.totalMicronots).format('0,0.[00]') }} ARGNOT
            </div>
            <div class="opacity-60">
              {{ currency.symbol }}{{ micronotToMoneyNm(wallets.defaultArgonWallet.totalMicronots).format('0,0.00') }}
            </div>
          </div>
        </div>
        <WalletsMenu />
      </div>
    </section>

    <section DashBox class="border-argon-600/50! w-full grow px-1 pb-3">
      <div>
        <!--        <header>Basics</header>-->
        <ul>
          <li
            @click="goto(TopTab.Dashboard)"
            class="border-t-0!"
            :class="{ Selected: controller.selectedTab === TopTab.Dashboard }"
          >
            <article TopLevel class="flex flex-row items-center">
              <div class="grow">Account Overview</div>
              <div><span class="rounded-full bg-slate-600/40 text-white font-bold px-2">0</span></div>
            </article>
            <div Selector>
              <div ArrowSquare>
                <Arrow ActiveArrow fill="white" stroke="#D3D9E3" :strokeWidth="1" />
              </div>
            </div>
          </li>
          <li v-if="!config.hasExtensionTreasury" @click="goto(TopTab.TreasuryUnlock)" :class="{ Selected: controller.selectedTab === TopTab.TreasuryUnlock }">
            <article TopLevel class="flex flex-row items-center">
              <div class="grow">Unlock Treasury</div>
              <div class="opacity-60">{{ currency.symbol }}0.00</div>
            </article>
            <div Selector>
              <div ArrowSquare>
                <Arrow ActiveArrow fill="white" stroke="#000000" :strokeWidth="1" />
              </div>
            </div>
          </li>
        </ul>
        <div
          v-if="config.isLoaded && !config.hasExtensionTreasury"
          class="pointer-events-none relative -top-2 z-20 text-center"
        >
          <div class="text-right">
            <div class="absolute top-[7px] right-[19px] z-10 h-px w-[21px] bg-[#FDF4FF]" />
            <img src="/arrow.png" class="relative z-20 mr-5 inline-block" />
          </div>
          <div class="font-bold">Upgrade Your App</div>
          <div class="mt-1 text-slate-700/60">
            Insert an access code to
            <br />
            unlock your network’s
            <br />
            yield generating assets.
          </div>
        </div>
      </div>

      <div class="mt-3" v-if="config.isLoaded && config.hasExtensionTreasury">
        <header>Treasury</header>
        <ul>
          <li @click="goto(TopTab.BitcoinLocks)" :class="{ Selected: controller.selectedTab === TopTab.BitcoinLocks }">
            <article class="flex flex-row items-center">
              <div class="grow">Bitcoin Locks</div>
              <div class="flex items-center gap-x-2">
                <span class="opacity-60">
                  {{ currency.symbol }}{{ satToMoneyNm(financials.liquidTotalSatoshis).format('0,0.00') }}
                </span>
                <span
                  v-if="bitcoinLockCoupons.openCouponCount"
                  class="rounded-full bg-slate-600/40 px-2 font-bold text-white"
                >
                  {{ bitcoinLockCoupons.openCouponCount }}
                </span>
              </div>
            </article>
            <div Selector>
              <div ArrowSquare>
                <Arrow ActiveArrow fill="white" stroke="#D3D9E3" :strokeWidth="1" />
              </div>
            </div>
          </li>
          <li @click="goto(TopTab.BitcoinLoans)" :class="{ Selected: controller.selectedTab === TopTab.BitcoinLoans }">
            <article class="flex flex-row items-center">
              <div class="grow">Bitcoin Loans</div>
              <div class="opacity-60">
                {{ currency.symbol }}{{ microgonToMoneyNm(financials.liquidCurrentBitcoinDebt).format('0,0.00') }}
              </div>
            </article>
            <div Selector>
              <div ArrowSquare>
                <Arrow ActiveArrow fill="white" stroke="#D3D9E3" :strokeWidth="1" />
              </div>
            </div>
          </li>
          <li @click="goto(TopTab.ArgonBonds)" :class="{ Selected: controller.selectedTab === TopTab.ArgonBonds }">
            <article class="flex flex-row items-center">
              <div class="grow">Argon Bonds</div>
              <div class="opacity-60">
                {{ currency.symbol
                }}{{
                  microgonToMoneyNm(
                    myBonds.bondLots
                      .filter(bondLot => bondLot.programType === 'Vault')
                      .reduce((sum, bondLot) => sum + bondLot.bondMicrogons, 0n),
                  ).format('0,0.00')
                }}
              </div>
            </article>
            <div Selector>
              <div ArrowSquare>
                <Arrow ActiveArrow fill="white" stroke="#D3D9E3" :strokeWidth="1" />
              </div>
            </div>
          </li>
          <li @click="goto(TopTab.ArgonotBonds)" :class="{ Selected: controller.selectedTab === TopTab.ArgonotBonds }">
            <article class="flex flex-row items-center">
              <div class="grow">Argonot Bonds</div>
              <div class="opacity-60">
                {{ currency.symbol
                }}{{
                  micronotToMoneyNm(
                    myBonds.bondLots
                      .filter(bondLot => bondLot.programType === 'Argonot')
                      .reduce((sum, bondLot) => sum + bondLot.bondMicrogons, 0n),
                  ).format('0,0.00')
                }}
              </div>
            </article>
            <div Selector>
              <div ArrowSquare>
                <Arrow ActiveArrow fill="white" stroke="#D3D9E3" :strokeWidth="1" />
              </div>
            </div>
          </li>
          <li @click="goto(TopTab.StableSwaps)" :class="{ Selected: controller.selectedTab === TopTab.StableSwaps }">
            <article class="flex flex-row items-center">
              <div class="grow">Stable Swaps</div>
              <div class="opacity-60">
                {{ currency.symbol }}{{ microgonToMoneyNm(financials.swapsTotalValue).format('0,0.00') }}
              </div>
            </article>
            <div Selector>
              <div ArrowSquare>
                <Arrow ActiveArrow fill="white" stroke="#D3D9E3" :strokeWidth="1" />
              </div>
            </div>
          </li>
        </ul>
      </div>

      <div class="mt-3" v-if="config.isLoaded && config.hasExtensionOperations">
        <header class="relative">
          Operations
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
            <article class="flex flex-row items-center">
              <div class="grow">Mining</div>
              <div class="opacity-60">
                {{ currency.symbol }}{{ microgonToMoneyNm(miningAssets.totalMiningResources).format('0,0.00') }}
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
            <div Selector>
              <div ArrowSquare><Arrow ActiveArrow fill="white" stroke="#D3D9E3" :strokeWidth="1" /></div>
            </div>
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
            <article class="flex flex-row items-center">
              <div class="grow">Vaulting</div>
              <div class="opacity-60">
                {{ currency.symbol }}{{ microgonToMoneyNm(vaultingAssets.totalVaultValue).format('0,0.00') }}
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
            <div Selector>
              <div ArrowSquare><Arrow ActiveArrow fill="white" stroke="#D3D9E3" :strokeWidth="1" /></div>
            </div>
          </li>
          <li @click="goto(TopTab.Network)" :class="{ Selected: controller.selectedTab === TopTab.Network }">
            <article class="flex flex-row items-center">
              <div class="grow">Network</div>
              <div class="opacity-60">{{ currency.symbol }}0.00</div>
            </article>
            <div Selector>
              <div ArrowSquare>
                <Arrow ActiveArrow fill="white" stroke="#000000" :strokeWidth="1" />
              </div>
            </div>
          </li>
        </ul>
      </div>
    </section>
  </div>
</template>

<script setup lang="ts">
import * as Vue from 'vue';
import { MiningSetupStatus, TopTab, VaultingSetupStatus } from '../interfaces/IConfig.ts';
import { OperationalStepId, useCertificationController } from '../stores/certificationController.ts';
import { getConfig } from '../stores/config.ts';
import FormattedMoney from '../components/FormattedMoney.vue';
import { getBitcoinLockCoupons } from '../stores/bitcoin.ts';
import ExternalIcon from '../assets/external.svg?component';
import WalletsMenu from './WalletsMenu.vue';
import Arrow from '../components/Arrow.vue';
import basicEmitter from '../emitters/basicEmitter.ts';
import { WalletType } from '../lib/Wallet.ts';
import ArrowCalloutButton from '../components/ArrowCalloutButton.vue';
import { useWallets } from '../stores/wallets.ts';
import { getCurrency } from '../stores/currency.ts';
import { createNumeralHelpers } from '../lib/numeral.ts';
import { UnitOfMeasurement } from '@argonprotocol/apps-core';
import { useFinancials } from '../stores/financials.ts';
import { useMyBonds } from '../stores/myBonds.ts';
import { useMiningAssetBreakdown } from '../stores/miningAssetBreakdown.ts';
import { useVaultingAssetBreakdown } from '../stores/vaultingAssetBreakdown.ts';

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
  @apply px-2 py-3 font-bold text-slate-700/40 uppercase;
}

ul {
  @apply border-b border-slate-500/20;
}

ul li {
  @apply relative cursor-pointer border-t border-slate-500/20 py-1;
  &.Selected {
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
      @apply bg-argon-100/20 text-slate-900;
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
    @apply border-argon-600 absolute -top-px left-[-5px] hidden h-[calc(100%+2px)] w-[calc(100%+10px)] rounded-l border border-r-0 shadow-lg;
    background: #fdf4ff;
  }
}

[ArrowSquare] {
  @apply absolute left-[calc(100%+0px)] z-10 block h-full w-4 overflow-visible;
  &::before {
    content: '';
    @apply absolute inset-y-0 left-0 w-full bg-black drop-shadow-[1px_1px_1px_rgb(0_0_0/0.16)];
    clip-path: polygon(0 0, 100% 50%, 0 100%);
  }
  &::after {
    content: '';
    @apply absolute top-px right-[1px] bottom-px left-0;
    background: #fdf4ff;
    clip-path: polygon(0 0, 100% 50%, 0 100%);
  }
  svg[InactiveArrow] {
    @apply hidden;
  }
  svg[ActiveArrow] {
    @apply absolute top-[2px] left-[calc(25%-9px)] hidden h-5.5 w-[calc(100%-10px)] origin-left -translate-y-1/2 rotate-90 drop-shadow-[2px_2px_2px_rgb(0_0_0/0.3)];
    path {
      fill: #fdf4ff !important;
    }
  }
}
</style>
