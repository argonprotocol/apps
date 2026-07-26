<template>
  <div DashBox data-testid="ArgonBondsScreen" class="flex h-full min-h-0 grow flex-col">
    <div v-if="!isLoaded" class="flex grow items-center justify-center text-slate-500">Loading…</div>

    <div v-else-if="!bondLots.length" class="flex grow flex-col">
      <div class="flex grow flex-col items-center justify-center">
        <div class="relative flex w-8/12 max-w-200 flex-col items-center py-10">
          <header class="text-argon-600 pb-3 text-xl font-bold">
            Argon Bonds Tap Into the Upside Growth of the Network
          </header>
          <p
            class="w-0 min-w-full border-y border-slate-400/50 py-4 text-justify text-[17px]/7 font-light whitespace-normal"
          >
            Argon Bonds give you direct exposure to the profit returns of the growth of Argon Mining Auction pools.
            These bonds are backed by on-chain mechanics that make it impossible for a bond to default. This means your
            principal is always protected. The only question becomes: how much will your bond earn?
          </p>
          <span class="relative">
            <button
              data-curved-arrow-end
              @click="openBondsOverlay('Vault')"
              :class="
                canBuyWithArgn
                  ? 'bg-argon-button hover:bg-argon-button-hover border-transparent text-white'
                  : 'pointer-events-none border-gray-500 bg-white text-gray-500 opacity-40'
              "
              class="mt-12 cursor-pointer rounded-md border px-12 py-3 text-lg font-bold"
            >
              Buy Argon Bonds
            </button>
            <ArrowCalloutButton
              v-if="controller.activeGuideId === OperationalStepId.AcquireArgonBonds && canBuyWithArgn"
              guidance="Purchase the required Argon Bonds here."
              class="absolute top-1/2 right-0 z-50 translate-x-[calc(100%+0.75rem)] -translate-y-1/2"
            />
          </span>

          <div class="text-argon-600 relative mt-14 text-center text-xl leading-8 font-bold">
            <CurvedArrowRadialGradient />
            <div class="relative">
              <template v-if="canBuyWithArgn">
                <div data-curved-arrow-start class="mx-auto w-fit px-1">
                  Your account has
                  {{
                    microgonToArgonNm(wallets.defaultArgonWallet.availableMicrogons).formatIfElse(
                      '< 1000',
                      '0,0.00',
                      '0,0',
                    )
                  }}
                  in ARGN
                </div>
                that is ready for immediate deployment.
              </template>
              <template v-else>
                <div data-curved-arrow-start class="mx-auto w-fit">This feature is disabled until your</div>
                <span @click="openArgonWallet" class="hover:text-argon-600/80 inline-block cursor-pointer underline">
                  internal app wallet
                </span>
                is funded with ARGN.
              </template>
            </div>
          </div>
          <CurvedArrow
            dynamic
            class="pointer-events-none absolute inset-0 h-full w-full overflow-visible text-slate-400/80"
          />
        </div>
      </div>
      <div class="relative px-0.5 pb-0.5">
        <img src="/treasury-footers/argon-bonds.png" class="w-full opacity-50" />
      </div>
    </div>

    <div v-else class="flex min-h-0 grow flex-col">
      <section class="mt-5 flex flex-row items-end gap-x-2 px-9 text-center">
        <div class="w-1/3 border-b border-slate-400/30 py-5">
          <div class="text-argon-600 inline-flex text-5xl font-bold">
            <span>{{ currency.symbol }}</span>
            <FormattedMoney :isLoaded="isSummaryReady" :value="bondsSummary?.currentValue ?? 0n" />
          </div>
          <div>Current Bond Value</div>
        </div>
        <div class="h-full w-px bg-slate-400/30" />
        <div class="w-1/3 border-b border-slate-400/30 py-5">
          <div class="text-argon-600 inline-flex text-5xl font-bold">
            <span>{{ currency.symbol }}</span>
            <FormattedMoney
              :isLoaded="isSummaryReady && financials.historyRecovery.state === 'ready'"
              :value="bondsSummary?.returnSummary.paidIncome ?? 0n"
            />
          </div>
          <div>Distributed Income</div>
        </div>
        <div class="h-full w-px bg-slate-400/30" />
        <div class="w-1/3 border-b border-slate-400/30 py-5">
          <div class="text-argon-600 text-5xl font-bold">
            <template v-if="bondsSummary?.returnSummary.percent !== undefined">
              {{ numeral(bondsSummary.returnSummary.percent).format('0,0.[00]') }}%
            </template>
            <template v-else>--</template>
          </div>
          <div>Return to Date</div>
        </div>
      </section>

      <div class="relative flex min-h-0 grow flex-col">
        <div class="flex flex-col overflow-y-auto px-9 pt-10 pb-5">
          <div class="flex flex-row items-center text-slate-800/70">
            <span class="grow">
              You have {{ bondLots.length }} bond transaction{{ bondLots.length === 1 ? '' : 's' }}...
            </span>
            <div class="flex flex-row items-stretch gap-x-3">
              <span class="relative">
                <button
                  type="button"
                  :disabled="!canBuyWithArgn"
                  class="text-md text-argon-600 cursor-pointer disabled:cursor-default disabled:opacity-40"
                  @click="openBondsOverlay('Vault')"
                >
                  Buy Argon Bonds
                </button>
                <ArrowCalloutButton
                  v-if="controller.activeGuideId === OperationalStepId.AcquireArgonBonds && canBuyWithArgn"
                  guidance="Purchase the required Treasury Bonds here."
                  class="absolute top-1/2 right-0 z-50 translate-x-[calc(100%+0.75rem)] -translate-y-1/2"
                />
              </span>
              <div class="w-px bg-slate-400/50" />
              <a
                :href="`${NetworkConfig.websiteHost}/docs`"
                target="_blank"
                class="text-md text-argon-600 cursor-pointer"
              >
                View Docs
              </a>
            </div>
          </div>
        </div>

        <section class="flex flex-col gap-y-3 px-9">
          <BondRecord
            v-for="bondLot in bondLots"
            :key="bondLot.id"
            :bondLot="bondLot"
            :isReleasing="bondLot.isReleasing"
            :position="bondPositionsByLotId.get(bondLot.id)"
            :returnPercent="bondReturnsByLotId.get(bondLot.id)"
            @click="openDetail(bondLot)"
            @liquidate="openDetail"
          />
        </section>
        <div class="absolute top-0 left-0 h-10 w-full bg-linear-to-b from-white to-transparent" />
      </div>
      <div class="relative px-0.5 pb-0.5">
        <img src="/treasury-footers/argon-bonds.png" class="w-full opacity-50" />
      </div>
    </div>

    <BuyBondsOverlay
      v-if="showBondsOverlay"
      :programType="purchaseProgramType"
      @close="showBondsOverlay = false"
      @submitted="onPurchaseSubmitted"
    />
    <BondDetailOverlay
      v-if="showDetailOverlay && selectedBondLot"
      :bondLot="selectedBondLot"
      :position="bondPositionsByLotId.get(selectedBondLot.id)"
      :returnPercent="bondReturnsByLotId.get(selectedBondLot.id)"
      @close="closeDetail"
      @submitted="onLiquidationSubmitted"
    />
  </div>
</template>

<script setup lang="ts">
import * as Vue from 'vue';
import numeral, { createNumeralHelpers } from '../lib/numeral.ts';
import { getCurrency } from '../stores/currency.ts';
import { getVaults } from '../stores/vaults.ts';
import { getWalletKeys, useWallets } from '../stores/wallets.ts';
import { getMainchainClient } from '../stores/mainchain.ts';
import { getConfig } from '../stores/config.ts';
import { BondLot, NetworkConfig } from '@argonprotocol/apps-core';
import { getArgonBonds } from '../stores/argonBonds.ts';
import BuyBondsOverlay from '../overlays/BuyBondsOverlay.vue';
import basicEmitter from '../emitters/basicEmitter.ts';
import { WalletType } from '../lib/Wallet.ts';
import FormattedMoney from '../components/FormattedMoney.vue';
import { useFinancials } from '../stores/financials.ts';
import { calculatePositionReturn } from '../lib/financials/index.ts';
import BondRecord from './treasury-screens/components/BondRecord.vue';
import BondDetailOverlay from '../app-treasury/overlays/BondDetailOverlay.vue';
import ArrowCalloutButton from '../components/ArrowCalloutButton.vue';
import { OperationalStepId, useCertificationController } from '../stores/certificationController.ts';
import type { IBondFinancialPosition } from '../interfaces/IFinancialPosition.ts';
import CurvedArrow from '../components/CurvedArrow.vue';
import CurvedArrowRadialGradient from '../components/CurvedArrowRadialGradient.vue';

const currency = getCurrency();
const controller = useCertificationController();
const financials = useFinancials();
const vaults = getVaults();
const walletKeys = getWalletKeys();
const wallets = useWallets();
const config = getConfig();
const argonBonds = getArgonBonds();

const { microgonToArgonNm } = createNumeralHelpers(currency);

const isLoaded = Vue.computed(() => argonBonds.data.isLoaded);
const showBondsOverlay = Vue.ref(false);
const showDetailOverlay = Vue.ref(false);
const purchaseProgramType = Vue.ref<BondLot['programType']>('Vault');
const selectedBondLot = Vue.ref<BondLot>();
const bondLots = Vue.computed(() => argonBonds.data.bondLots.filter(bondLot => bondLot.programType === 'Vault'));
const bondsSummary = Vue.computed(() => {
  return financials.bondSummariesByAsset.ARGN;
});
const bondPositionsByLotId = Vue.computed(() => {
  const positions = new Map<number, IBondFinancialPosition>();

  for (const position of financials.financialPositionAggregate.groupSummaries.bonds.positions) {
    if (position.kind !== 'bond' || position.nativeAsset !== 'ARGN' || !position.bondLot) continue;

    positions.set(position.bondLot.id, position);
  }

  return positions;
});
const bondReturnsByLotId = Vue.computed(() => {
  const returns = new Map<number, number>();

  for (const [bondLotId, position] of bondPositionsByLotId.value) {
    const percent = calculatePositionReturn([position]).percent;
    if (percent !== undefined) returns.set(bondLotId, percent);
  }

  return returns;
});
const isSummaryReady = Vue.computed(() => {
  const state = financials.financialPositionAggregate.groupSummaries.bonds.state;
  return state === 'ready' || state === 'stale';
});
const canBuyWithArgn = Vue.computed(() => financials.savingsTotalReadyToUse > 0n);

function openBondsOverlay(programType: BondLot['programType']) {
  purchaseProgramType.value = programType;
  showBondsOverlay.value = true;
}

async function onPurchaseSubmitted() {
  showBondsOverlay.value = false;
  if (purchaseProgramType.value === 'Vault') await refreshMarketData();
}

async function onLiquidationSubmitted() {
  if (selectedBondLot.value?.programType === 'Vault') await refreshMarketData();
}

function openDetail(bondLot: BondLot) {
  selectedBondLot.value = bondLot;
  showDetailOverlay.value = true;
}

function closeDetail() {
  showDetailOverlay.value = false;
  selectedBondLot.value = undefined;
}

async function refreshMarketData() {
  if (!argonBonds.data.vaultId) return;

  const client = await getMainchainClient(false);
  const vault = vaults.vaultsById[argonBonds.data.vaultId];
  if (!vault) return;

  vaultBondSubscription?.();
  vaultBondSubscription = await argonBonds.subscribeVault(
    {
      vaultId: argonBonds.data.vaultId,
      operatorAddress: vault.operatorAccountId,
      accountId: walletKeys.defaultArgonAddress,
    },
    client,
  );
}

function openArgonWallet() {
  basicEmitter.emit('openWalletOverlay', { walletType: WalletType.defaultArgon });
}

let unsubVault: (() => void) | undefined;
let vaultBondSubscription: (() => void) | undefined;

Vue.onMounted(async () => {
  await config.isLoadedPromise;
  await argonBonds.load();

  const client = await getMainchainClient(false);

  if (argonBonds.data.vaultId) {
    unsubVault = await vaults.subscribeToVault(argonBonds.data.vaultId, () => {
      if (vaultBondSubscription) void refreshMarketData();
    });
  }

  await argonBonds.subscribeGlobal(client);
  await refreshMarketData();
});

Vue.onUnmounted(() => {
  unsubVault?.();
  vaultBondSubscription?.();
});
</script>
