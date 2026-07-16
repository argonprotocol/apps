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
            <div Selector>
              <div ArrowSquare>
                <Arrow ActiveArrow fill="white" stroke="#D3D9E3" :strokeWidth="1" />
              </div>
            </div>
          </li>
          <li @click="goto(TopTab.Network)" :class="{ Selected: controller.selectedTab === TopTab.Network }">
            <article class="flex flex-row items-center">
              <div class="grow">Network Economics</div>
              <!--              <div><span class="rounded-full bg-slate-600/40 px-2 font-bold text-white">0</span></div>-->
            </article>
            <div Selector>
              <div ArrowSquare>
                <Arrow ActiveArrow fill="white" stroke="#D3D9E3" :strokeWidth="1" />
              </div>
            </div>
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
              <div class="grow">Argon Bonds</div>
              <div class="opacity-60">{{ currency.symbol }}{{ formatFinancialGroupValue('bonds') }}</div>
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
              <div class="opacity-60">{{ currency.symbol }}{{ formatFinancialGroupValue('stableSwaps') }}</div>
            </article>
            <div Selector>
              <div ArrowSquare>
                <Arrow ActiveArrow fill="white" stroke="#D3D9E3" :strokeWidth="1" />
              </div>
            </div>
          </li>
        </ul>
      </div>
    </section>

    <section DashBox v-if="config.isLoaded && config.hasExtensionOperations" class="border-argon-600/50! w-full px-1">
      <div class="mt-3">
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
              <div class="opacity-60">{{ currency.symbol }}{{ formatFinancialGroupValue('mining') }}</div>
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
              <div class="opacity-60">{{ currency.symbol }}{{ formatFinancialGroupValue('vaulting') }}</div>
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
              <div class="grow">Invites</div>
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
          <!--          <img src="/arrow-small.png" class="absolute top-0 right-0 translate-y-[-80%]" />-->
          Insert an access code to
          <br />
          unlock yield generating assets.
        </div>
      </div>
      <!--      <div-->
      <!--        v-else-if="-->
      <!--          config.hasExtensionTreasury &&-->
      <!--          controller.completedTreasuryCertificationStepCount === treasuryCertificationStepIds.length-->
      <!--        "-->
      <!--        class="flex grow items-center justify-center px-8 py-8"-->
      <!--      ></div>-->
      <section
        DashBox
        class="border-argon-600/50! relative -left-2 w-[calc(100%+32px)] rounded-l-none! rounded-r-lg! border-l-0! shadow-xl!"
      >
        <div class="flex flex-col justify-center px-1 pt-3">
          <header class="flex w-full flex-row items-center border-b border-slate-500/20">
            <div class="grow">Argon Wallet</div>
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
          <div class="mt-2 w-full border-t border-slate-500/30 pt-2 pb-4 text-center opacity-50">
            {{ currency.symbol }}18.45 Is Locked On Chain
          </div>
        </div>
      </section>
      <ul class="flex w-full flex-row gap-x-3 px-3 pb-3 text-center">
        <li class="w-1/2">
          <div
            @click="() => void openLink('https://argon.network/docs')"
            class="text-argon-600/80 hover:text-argon-600/70 flex cursor-pointer flex-col items-center gap-y-1 pt-4 text-center"
          >
            <InstructionsIcon class="h-6 w-6" />
            <div>Docs</div>
          </div>
        </li>
        <li class="w-1/2">
          <div
            @click="() => void openLink('https://discord.gg/xDwwDgCYr9')"
            class="text-argon-600/80 hover:text-argon-600/70 flex cursor-pointer flex-col items-center gap-y-1 pt-4 text-center"
          >
            <DiscordIcon class="-mb-1 h-7 w-7" />
            <div>Community</div>
          </div>
        </li>
      </ul>
    </section>
  </div>
</template>

<script setup lang="ts">
import * as Vue from 'vue';
import { MiningSetupStatus, TopTab, VaultingSetupStatus } from '../interfaces/IConfig.ts';
import {
  OperationalStepId,
  treasuryCertificationStepIds,
  useCertificationController,
} from '../stores/certificationController.ts';
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
import type { FinancialGroup } from '../interfaces/IFinancialPosition.ts';
import { open as tauriOpenUrl } from '@tauri-apps/plugin-shell';
import DiscordIcon from '../assets/discord.svg';
import InstructionsIcon from '../assets/instructions.svg';
import DiamondsIcon from '../assets/diamonds.svg?component';

const controller = useCertificationController();
const bitcoinLockCoupons = getBitcoinLockCoupons();
const config = getConfig();
const wallets = useWallets();
const currency = getCurrency();
const financials = useFinancials();

const { microgonToArgonNm, microgonToMoneyNm, micronotToArgonotNm, micronotToMoneyNm, satToMoneyNm } =
  createNumeralHelpers(currency);

const showOperationsNavigationCallouts = Vue.ref(false);

function formatFinancialGroupValue(group: FinancialGroup): string {
  return microgonToMoneyNm(financials.financialPositionAggregate.groupSummaries[group].currentValue).format('0,0.00');
}

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

ul li {
  @apply relative cursor-pointer border-t border-slate-500/20 py-1;
  &.Selected {
    [Selector] {
      @apply hidden;
    }
    article {
      @apply bg-argon-300/20 text-slate-900;
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
  @apply absolute left-[calc(100%+0px)] z-10 block hidden h-full w-4 overflow-visible;
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
