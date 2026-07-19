<template>
  <div class="Navigation LeftBar z-10 flex h-full max-w-76 min-w-76 flex-col gap-y-1.5 select-none">
    <section DashBox class="border-argon-600/50! w-full px-1">
      <div class="mt-3">
        <header>Basic Nav</header>
        <ul>
          <li @click="goto(TopTab.Dashboard)" :class="{ Selected: controller.selectedTab === TopTab.Dashboard }">
            <article class="flex flex-row items-center">
              <div class="mr-1 w-6">
                <OverviewIcon class="w-5.5" />
              </div>
              <div class="grow">Account Overview</div>
            </article>
            <div Selector />
          </li>
          <li @click="goto(TopTab.Network)" :class="{ Selected: controller.selectedTab === TopTab.Network }">
            <article class="flex flex-row items-center">
              <div class="mr-1 w-6">
                <WorldNetworkIcon class="w-5.5" />
              </div>
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
        <header class="relative flex flex-row items-center">
          <div class="grow">Treasury</div>
          <div class="relative flex">
            <button type="button" class="cursor-pointer" @click="openDefaultArgonWallet">
              <MoreIcon class="h-4 opacity-80" />
            </button>
            <ArrowCalloutButton
              v-if="controller.activeGuideId === OperationalStepId.TreasuryTransfer && !basics.overlayIsOpen"
              guidance="Open your Argon wallet."
              class="absolute top-1/2 right-0 z-50 translate-x-[calc(100%+0.75rem)] -translate-y-1/2"
            />
          </div>
        </header>
        <ul>
          <li @click="goto(TopTab.BitcoinLocks)" :class="{ Selected: controller.selectedTab === TopTab.BitcoinLocks }">
            <article class="relative flex flex-row items-center">
              <div class="flex grow flex-row items-center">
                <div class="mr-1 w-6">
                  <BitcoinIcon class="w-6" />
                </div>
                Bitcoin Locks
                <GiftIcon v-if="bitcoinLockCoupons.openCouponCount" class="text-argon-800/50 ml-2 w-4" />
              </div>
              <div class="flex items-center gap-x-2">
                <span v-if="currency.isLoaded" class="opacity-60">
                  {{ currency.symbol }}{{ satToMoneyNm(financials.liquidTotalSatoshis).format('0,0.00') }}
                </span>
              </div>
              <ArrowCalloutButton
                v-if="
                  controller.activeGuideId === OperationalStepId.LiquidLock &&
                  controller.selectedTab !== TopTab.BitcoinLocks
                "
                guidance="Open Bitcoin Locks to continue this task."
                class="absolute top-1/2 right-0 z-50 translate-x-[calc(100%+0.75rem)] -translate-y-1/2"
              />
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
            <article class="relative flex flex-row items-center">
              <div class="mr-1 w-6">
                <BondIcon class="w-5.5 opacity-70" />
              </div>
              <div class="grow">Argon(ot) Bonds</div>
              <div class="opacity-60">{{ currency.symbol }}{{ formatFinancialGroupValue('bonds') }}</div>
              <ArrowCalloutButton
                v-if="
                  controller.activeGuideId === OperationalStepId.AcquireBonds &&
                  controller.selectedTab !== TopTab.ArgonBonds
                "
                guidance="Open Argon(ot) Bonds to continue this task."
                class="absolute top-1/2 right-0 z-50 translate-x-[calc(100%+0.75rem)] -translate-y-1/2"
              />
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
              <div class="mr-1 w-6">
                <SwapIcon class="w-5.5 opacity-90" />
              </div>
              <div class="grow">Stable Swaps</div>
              <div v-if="currency.isLoaded" class="opacity-60">
                {{ currency.symbol
                }}{{
                  config.hasActivatedStableSwaps
                    ? microgonToMoneyNm(financials.swapsTotalValue).format('0,0.00')
                    : '0.00'
                }}
              </div>
            </article>
            <div Selector LastSelector />
          </li>
        </ul>
      </div>
    </section>

    <section DashBox v-if="config.isLoaded && config.hasExtensionOperations" class="border-argon-600/50! w-full px-1">
      <div class="mt-3">
        <header class="relative flex flex-row items-center">
          <div class="grow">Operations</div>
          <div class="relative flex">
            <button type="button" class="cursor-pointer" @click="openDefaultArgonWallet">
              <MoreIcon class="h-4 opacity-80" />
            </button>
            <ArrowCalloutButton
              v-if="controller.activeGuideId === OperationalStepId.OperationalTransfer && !basics.overlayIsOpen"
              guidance="Open your Argon wallet."
              class="absolute top-1/2 right-0 z-50 translate-x-[calc(100%+0.75rem)] -translate-y-1/2"
            />
          </div>
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
                <div class="flex grow flex-row items-center">
                  <div class="mr-1 w-6">
                    <MiningOilIcon class="relative -top-0.5 w-6" />
                  </div>
                  Mining
                </div>
                <div class="opacity-60">{{ currency.symbol }}{{ formatFinancialGroupValue('mining') }}</div>
              </div>
              <div v-if="controller.selectedTab === TopTab.Mining" class="text-md -mb-1.5">
                <div class="flex flex-row">
                  <div class="mt-0.5 flex grow flex-row items-center">
                    <div class="Connector" />
                    <div class="flex grow flex-row items-center border-t border-slate-400/30">
                      <div class="grow py-1 text-slate-600/80">
                        {{ numeral(miningAssets.auctionBidCount).format('0,0') }} Current Bids
                      </div>
                      <ExternalIcon class="w-3.5 opacity-50" />
                    </div>
                  </div>
                </div>
                <div class="flex flex-row">
                  <div class="flex grow flex-row items-center">
                    <div class="Connector" />
                    <div class="flex grow flex-row items-center border-t border-slate-400/30">
                      <div class="grow py-1 text-slate-600/80">
                        {{ numeral(miningAssets.seatActiveCount).format('0,0') }} Active Seats
                      </div>
                      <ExternalIcon class="w-3.5 opacity-50" />
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
              <div class="relative flex flex-row items-center">
                <div class="mr-1 w-6 text-center">
                  <VaultIcon class="relative inline-block w-5.5 opacity-90" />
                </div>
                <div class="grow">Vaulting</div>
                <div class="opacity-60">{{ currency.symbol }}{{ formatFinancialGroupValue('vaulting') }}</div>
              </div>
              <div v-if="controller.selectedTab === TopTab.Vaulting" class="text-md -mb-1.5">
                <div class="flex flex-row">
                  <button
                    type="button"
                    @click.stop="openSecuritization"
                    class="mt-0.5 flex grow cursor-pointer flex-row items-center text-left"
                  >
                    <div class="Connector" />
                    <div class="flex grow flex-row items-center border-t border-slate-400/30">
                      <div class="grow py-1 text-slate-600/80">
                        {{ microgonToArgonNm(vaultingAssets.securityMicrogons).format('0,0.[00]') }} Argons Securitized
                      </div>
                      <ExternalIcon class="w-3.5 opacity-50" />
                    </div>
                  </button>
                </div>
                <div class="flex flex-row">
                  <div class="flex grow flex-row items-center">
                    <div class="Connector" />
                    <div class="flex grow flex-row items-center border-t border-slate-400/30">
                      <div class="grow py-1 text-slate-600/80">
                        {{ micronotToArgonotNm(vaultingAssets.securityMicronots).format('0,0.[00]') }} Argonots Staked
                      </div>
                      <ExternalIcon class="w-3.5 opacity-50" />
                    </div>
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
            <article class="relative flex flex-col">
              <div class="relative flex flex-row items-center">
                <div class="mr-1 w-6">
                  <OnboardingIcon class="w-5.5 opacity-70" />
                </div>
                <div class="grow">Onboarding</div>
                <div v-if="currency.isLoaded" class="opacity-60">
                  {{
                    `${currency.symbol}${microgonToMoneyNm(controller.operationalOverview.rewardsEarnedAmount).format('0,0.00')}`
                  }}
                </div>
              </div>
              <div v-if="controller.selectedTab === TopTab.Invites" class="text-md -mb-1.5">
                <div class="flex flex-row">
                  <div class="mt-0.5 flex grow flex-row items-center">
                    <div class="Connector" />
                    <div class="flex grow flex-row items-center border-t border-slate-400/30">
                      <div class="grow py-1 text-slate-600/80">0 Pending Invites</div>
                      <ExternalIcon class="w-3.5 opacity-50" />
                    </div>
                  </div>
                </div>
                <div class="flex flex-row">
                  <div class="flex grow flex-row items-center">
                    <div class="Connector" />
                    <div class="flex grow flex-row items-center border-t border-slate-400/30">
                      <div class="grow py-1 text-slate-600/80">0 Active Members</div>
                      <ExternalIcon class="w-3.5 opacity-50" />
                    </div>
                  </div>
                </div>
              </div>
            </article>
            <div Selector LastSelector />
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
        <div class="relative mt-4 text-slate-700/60">
          Insert an access code to
          <br />
          unlock yield generating assets.
        </div>
        <div class="text-argon-600 mt-2 flex flex-row items-center justify-center gap-x-2">
          <a class="cursor-pointer opacity-50 hover:opacity-100">Learn More</a>
          <span class="text-slate-600/40">or</span>
          <a class="cursor-pointer opacity-50 hover:opacity-100">Join Discord</a>
        </div>
      </div>
      <div
        v-else-if="
          config.isLoaded &&
          config.hasExtensionTreasury &&
          !controller.chainProgress.isUpgradedToOperations &&
          controller.completedTreasuryCertificationStepCount !== treasuryCertificationStepIds.length
        "
        class="relative flex grow flex-col items-center justify-center text-center"
      >
        <div class="relative flex flex-row items-center text-center font-bold whitespace-nowrap">Next Steps</div>
        <div class="relative mt-1 text-slate-700/60">
          Finish Treasury certification
          <br />
          to be eligible for the next level!
        </div>
      </div>
      <div v-else class="relative flex grow flex-col items-center justify-center text-center text-slate-700/30">
        <div class="relative flex flex-row items-center text-center whitespace-nowrap">Explore</div>
        <div class="relative mt-px">
          <a class="cursor-pointer opacity-40 hover:opacity-100">Docs</a>
          and
          <a class="cursor-pointer opacity-40 hover:opacity-100">Community</a>
        </div>
      </div>
      <section
        DashBox
        class="border-argon-400! relative -bottom-px -left-2 w-[calc(100%+26px)] rounded-lg! rounded-tl-none!"
        style="box-shadow: 1px 1px 5px 3px rgba(0, 0, 0, 0.05)"
      >
        <div class="border-argon-400 absolute -top-2 -left-px h-3 w-2 border-l bg-white" />
        <div class="border-argon-400 absolute -top-5 -left-px -z-1 h-5 w-2.5 rounded-l-full border bg-slate-400/40" />
        <div
          class="border-argon-400 absolute -top-5 -left-px h-5 w-2.5 rounded-l-full border border-t-transparent border-r-transparent"
        />
        <div class="bg-argon-100/20 h-full w-full" style="text-shadow: 1px 1px 0 white">
          <div class="absolute top-0 left-0 h-full w-5 rounded-bl-lg bg-linear-to-r from-slate-600/10 to-transparent" />
          <div class="flex flex-col justify-center pt-3 pr-3 pl-3">
            <header class="flex w-full flex-row items-center border-b border-slate-500/20">
              <WalletSelector
                :selectedWallet="selectedWallet"
                :walletSelections="walletSelections"
                :getName="getWalletName"
                testIdPrefix="LeftBar.walletMenu"
                side="top"
                class="hover:text-argon-700"
                @select="selectWallet"
              />
              <WalletActions
                :selection="selectedWallet"
                :wallet="selectedWalletData"
                :walletAddressTestId="selectedWalletAddressTestId"
                :canExportPrivateKey="selectedWalletCanExportPrivateKey"
                class="grow justify-end pr-1"
              />
            </header>
            <div class="flex cursor-pointer flex-col justify-center py-7" @click="openSelectedWallet">
              <div class="text-argon-600/70 flex flex-row justify-center text-5xl font-bold">
                <span>{{ currency.symbol }}</span>
                <FormattedMoney :isLoaded="selectedWalletBalanceIsLoaded" :value="selectedWalletBalance" />
              </div>
              <div
                v-if="currency.isLoaded && selectedWallet.walletType === WalletType.defaultArgon"
                class="mx-auto mt-2 w-fit border-t border-slate-500/30 pt-2 text-center opacity-50"
              >
                Includes {{ currency.symbol
                }}{{ microgonToMoneyNm(financials.savingsTotalPending).format('0,0.00') }} waiting to mint
              </div>
              <div
                v-else-if="currency.isLoaded && isEthereumWalletSelection(selectedWallet)"
                class="mx-auto mt-2 flex w-fit gap-x-2 border-t border-slate-500/30 pt-2 text-center opacity-50"
              >
                {{ currency.symbol }}{{ microgonToMoneyNm(selectedOtherTokenValue).format('0,0.00') }} non-native tokens
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
import { MoveTo } from '@argonprotocol/apps-core';
import { MiningSetupStatus, TopTab, VaultingSetupStatus } from '../interfaces/IConfig.ts';
import {
  OperationalStepId,
  useCertificationController,
  treasuryCertificationStepIds,
} from '../stores/certificationController.ts';
import { getConfig } from '../stores/config.ts';
import FormattedMoney from '../components/FormattedMoney.vue';
import { getBitcoinLockCoupons } from '../stores/bitcoin.ts';
import basicEmitter from '../emitters/basicEmitter.ts';
import { getWalletTotalValue, type IWallet, WalletType } from '../lib/Wallet.ts';
import ArrowCalloutButton from '../components/ArrowCalloutButton.vue';
import { useWallets } from '../stores/wallets.ts';
import { getCurrency } from '../stores/currency.ts';
import numeral, { createNumeralHelpers } from '../lib/numeral.ts';
import { useFinancials } from '../stores/financials.ts';
import { useMiningAssetBreakdown } from '../stores/miningAssetBreakdown.ts';
import { useVaultingAssetBreakdown } from '../stores/vaultingAssetBreakdown.ts';
import { useBasics } from '../stores/basics.ts';
import type { FinancialGroup } from '../interfaces/IFinancialPosition.ts';
import { open as tauriOpenUrl } from '@tauri-apps/plugin-shell';
import DiamondsIcon from '../assets/diamonds.svg?component';
import MoreIcon from '../assets/more.svg';
import GiftIcon from '../assets/gift.svg';
import EditIcon from '../assets/edit.svg';
import BitcoinIcon from '../assets/wallets/bitcoin.svg';
import BondIcon from '../assets/bond.svg';
import AuctionIcon from '../assets/auction.svg';
import ViewIcon from '../assets/view.svg';
import MiningOilIcon from '../assets/mining-oil.svg';
import OverviewIcon from '../assets/overview.svg';
import SwapIcon from '../assets/swap.svg';
import VaultIcon from '../assets/vault-small.svg';
import WorldNetworkIcon from '../assets/world-network.svg';
import OnboardingIcon from '../assets/onboarding.svg';
import ExternalIcon from '../assets/external.svg';
import {
  getAvailableWalletSelections,
  getWalletSelectionKey,
  isEthereumWalletSelection,
  type IWalletSelection,
} from '../wallets/walletOverlayState.ts';
import WalletSelector from '../wallets/components/WalletSelector.vue';
import WalletActions from '../wallets/components/WalletActions.vue';

const controller = useCertificationController();
const basics = useBasics();
const bitcoinLockCoupons = getBitcoinLockCoupons();
const config = getConfig();
const wallets = useWallets();
const currency = getCurrency();
const financials = useFinancials();
const miningAssets = useMiningAssetBreakdown();
const vaultingAssets = useVaultingAssetBreakdown();
const { microgonToArgonNm, microgonToMoneyNm, micronotToArgonotNm, micronotToMoneyNm, satToMoneyNm } =
  createNumeralHelpers(currency);

const showOperationsNavigationCallouts = Vue.ref(false);
const selectedWallet = Vue.ref<IWalletSelection>({ walletType: WalletType.defaultArgon });
const selectedWalletIsRefreshing = Vue.ref(false);

const walletSelections = Vue.computed(() => {
  return getAvailableWalletSelections(wallets.walletRecords, [], config.hasExtensionOperations);
});

const selectedWalletData = Vue.computed<IWallet>(() => {
  if (isEthereumWalletSelection(selectedWallet.value)) {
    return wallets.getEthereumWalletRecord(selectedWallet.value.walletRecord.id);
  }
  return selectedWallet.value.walletType === WalletType.miningBot
    ? wallets.miningBotWallet
    : wallets.defaultArgonWallet;
});

const selectedWalletKey = Vue.computed(() => getWalletSelectionKey(selectedWallet.value));
const selectedWalletCanExportPrivateKey = Vue.computed(() => {
  return (
    isEthereumWalletSelection(selectedWallet.value) && selectedWallet.value.walletRecord.role === 'defaultEthereum'
  );
});
const selectedWalletAddressTestId = Vue.computed(() => {
  return `LeftBar.${selectedWalletKey.value}Address`;
});
const selectedWalletBalanceIsLoaded = Vue.computed(() => {
  if (selectedWalletIsRefreshing.value) return false;
  if (selectedWallet.value.walletType === WalletType.defaultArgon) return financials.savingsIsLoaded;
  return wallets.isLoaded;
});
const selectedOtherTokenValue = Vue.computed(() => {
  return selectedWalletData.value.otherTokens.reduce((total, token) => {
    return total + currency.convertOtherToMicrogon(token);
  }, 0n);
});
const selectedWalletBalance = Vue.computed(() => {
  if (!currency.isLoaded) return 0n;

  if (selectedWallet.value.walletType === WalletType.defaultArgon) {
    return financials.savingsTotalValue;
  }

  const wallet = selectedWalletData.value;
  return getWalletTotalValue(wallet, currency);
});

async function selectWallet(wallet: IWalletSelection) {
  selectedWallet.value = wallet;
  if (!isEthereumWalletSelection(wallet)) return;

  selectedWalletIsRefreshing.value = true;
  try {
    await wallets.selectEthereumWalletRecord(wallet.walletRecord.id);
  } finally {
    selectedWalletIsRefreshing.value = false;
  }
}

function openSelectedWallet() {
  if (isEthereumWalletSelection(selectedWallet.value)) {
    basicEmitter.emit('openWalletOverlay', {
      walletType: WalletType.ethereum,
      ethereumWalletRecordId: selectedWallet.value.walletRecord.id,
    });
    return;
  }

  basicEmitter.emit('openWalletOverlay', { walletType: selectedWallet.value.walletType });
}

function getWalletName(wallet: IWalletSelection): string {
  if (isEthereumWalletSelection(wallet)) return wallet.walletRecord.name;
  return wallet.walletType === WalletType.miningBot ? 'Mining Bot Wallet' : 'Argon Wallet';
}

function formatFinancialGroupValue(group: FinancialGroup): string {
  if (!currency.isLoaded) return '--';

  const summary = financials.financialPositionAggregate.groupSummaries[group];
  if (summary.state !== 'ready' && !(summary.state === 'stale' && summary.positions.length)) return '--';
  return microgonToMoneyNm(summary.currentValue).format('0,0.00');
}

function openDefaultArgonWallet() {
  basicEmitter.emit('openWalletOverlay', { walletType: WalletType.defaultArgon });
}

function openSecuritization() {
  basicEmitter.emit('openMoveCapitalOverlay', {
    walletType: WalletType.defaultArgon,
    moveTo: MoveTo.VaultingSecurity,
  });
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
    @apply border-argon-400 absolute -top-px left-[-5px] hidden h-[calc(100%+2px)] w-[calc(100%+24px)] rounded-r-lg border bg-white shadow-lg;
    &:before {
      @apply bg-argon-100/10 absolute top-0 left-0 h-full w-full rounded-r-lg;
      content: '';
    }
    &:after {
      @apply absolute -top-px left-0 h-[calc(100%+2px)] w-[50%] bg-linear-to-r from-white to-transparent;
      content: '';
    }
    &[LastSelector] {
      @apply rounded-bl-lg;
      &:before {
        @apply rounded-bl-lg;
      }
      &:after {
        @apply rounded-bl-lg;
      }
    }
  }
}
</style>
