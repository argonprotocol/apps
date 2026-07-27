<template>
  <div class="flex grow flex-col">
    <div class="flex grow flex-col items-center justify-center">
      <div class="relative flex w-8/12 max-w-200 flex-col items-center py-10">
        <header class="text-argon-600 pb-3 text-xl font-bold">
          Argonot Staking Taps Into the Upside Growth of the Network
        </header>
        <p
          class="w-0 min-w-full border-y border-slate-400/50 py-4 text-justify text-[17px]/7 font-light whitespace-normal"
        >
          Argonot Staking gives you direct exposure to the profit returns of the growth of Argon Mining Auction pools.
          These stakes are backed by on-chain mechanics that make it impossible for a stake to default. This means your
          principal is always protected. The only question becomes: how much will your stake earn?
        </p>
        <span class="relative">
          <button
            data-curved-arrow-end
            @click="openBondsOverlay('Argonot')"
            :class="
              canBuyWithArgnot
                ? 'bg-argon-button hover:bg-argon-button-hover border-transparent text-white'
                : 'pointer-events-none border-gray-500 bg-white text-gray-500 opacity-40'
            "
            class="mt-12 cursor-pointer rounded-md border px-12 py-3 text-lg font-bold"
          >
            Buy Argonot Stakes
          </button>
          <!--            <ArrowCalloutButton-->
          <!--              v-if="controller.activeGuideId === OperationalStepId.AcquireArgonotStakes && canBuyWithArgnot"-->
          <!--              guidance="Purchase the required Argonot Stakes here."-->
          <!--              class="absolute top-1/2 right-0 z-50 translate-x-[calc(100%+0.75rem)] -translate-y-1/2"-->
          <!--            />-->
        </span>
        <div class="text-argon-600 relative mt-14 text-center text-xl leading-8 font-bold">
          <CurvedArrowRadialGradient />
          <div class="relative">
            <template v-if="canBuyWithArgnot">
              <div data-curved-arrow-start class="mx-auto w-fit px-1">
                Your account has
                {{
                  micronotToArgonotNm(wallets.defaultArgonWallet.availableMicronots).formatIfElse(
                    '< 1000',
                    '0,0.00',
                    '0,0',
                  )
                }}
                ARGNOT
              </div>
              that is ready for immediate deployment.
            </template>
            <template v-else>
              <div data-curved-arrow-start class="mx-auto w-fit">This feature is disabled until your</div>
              <span @click="openArgonWallet" class="hover:text-argon-600/80 inline-block cursor-pointer underline">
                internal app wallet
              </span>
              is funded with ARGNOT.
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
</template>

<script setup lang="ts">
import * as Vue from 'vue';
import numeral, { createNumeralHelpers } from '../../lib/numeral.ts';
import { getCurrency } from '../../stores/currency.ts';
import { getVaults } from '../../stores/vaults.ts';
import { getWalletKeys, useWallets } from '../../stores/wallets.ts';
import { getMainchainClient } from '../../stores/mainchain.ts';
import { getConfig } from '../../stores/config.ts';
import { BondLot, NetworkConfig } from '@argonprotocol/apps-core';
import { getArgonBonds } from '../../stores/argonBonds.ts';
import BuyBondsOverlay from '../../overlays/BuyBondsOverlay.vue';
import basicEmitter from '../../emitters/basicEmitter.ts';
import { WalletType } from '../../lib/Wallet.ts';
import FormattedMoney from '../../components/FormattedMoney.vue';
import { useFinancials } from '../../stores/financials.ts';
import { calculatePositionReturn } from '../../lib/financials/index.ts';
import BondRecord from '../treasury-screens/components/BondRecord.vue';
import BondDetailOverlay from '../../app-treasury/overlays/BondDetailOverlay.vue';
import ArrowCalloutButton from '../../components/ArrowCalloutButton.vue';
import { OperationalStepId, useCertificationController } from '../../stores/certificationController.ts';
import type { IBondFinancialPosition } from '../../interfaces/IFinancialPosition.ts';
import CurvedArrow from '../../components/CurvedArrow.vue';
import CurvedArrowRadialGradient from '../../components/CurvedArrowRadialGradient.vue';

const currency = getCurrency();
const controller = useCertificationController();
const financials = useFinancials();
const vaults = getVaults();
const walletKeys = getWalletKeys();
const wallets = useWallets();
const config = getConfig();
const argonBonds = getArgonBonds();

const { micronotToArgonotNm } = createNumeralHelpers(currency);

const isLoaded = Vue.computed(() => argonBonds.data.isLoaded);
const supportsArgnotBacking = Vue.ref(false);
const showBondsOverlay = Vue.ref(false);
const showDetailOverlay = Vue.ref(false);
const purchaseProgramType = Vue.ref<BondLot['programType']>('Vault');
const selectedBondLot = Vue.ref<BondLot>();
const stakeLots = Vue.computed(() => argonBonds.data.bondLots.filter(bondLot => bondLot.programType === 'Argonot'));
const stakesSummary = Vue.computed(() => {
  return financials.bondSummariesByAsset.ARGNOT;
});
const stakePositionsByLotId = Vue.computed(() => {
  const positions = new Map<number, IBondFinancialPosition>();

  for (const position of financials.financialPositionAggregate.groupSummaries.bonds.positions) {
    if (position.kind !== 'bond' || position.nativeAsset !== 'ARGNOT' || !position.bondLot) continue;

    positions.set(position.bondLot.id, position);
  }

  return positions;
});
const stakeReturnsByLotId = Vue.computed(() => {
  const returns = new Map<number, number>();

  for (const [stakeLotId, position] of stakePositionsByLotId.value) {
    const percent = calculatePositionReturn([position]).percent;
    if (percent !== undefined) returns.set(stakeLotId, percent);
  }

  return returns;
});
const isSummaryReady = Vue.computed(() => {
  const state = financials.financialPositionAggregate.groupSummaries.bonds.state;
  return state === 'ready' || state === 'stale';
});
const canBuyWithArgn = Vue.computed(() => financials.savingsTotalReadyToUse > 0n);
const canBuyWithArgnot = Vue.computed(() => {
  return supportsArgnotBacking.value && wallets.defaultArgonWallet.availableMicronots > 0n;
});

function openBondsOverlay(programType: BondLot['programType']) {
  basicEmitter.emit('openBuyBondsOverlay', programType);
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
  supportsArgnotBacking.value = 'buyArgonotBonds' in client.tx.treasury;

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
