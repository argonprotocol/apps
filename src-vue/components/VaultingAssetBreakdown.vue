<!-- prettier-ignore -->
<template>
  <TooltipProvider :disableHoverableContent="true">
    <div :class="twMerge('text-md relative flex w-full flex-col items-center whitespace-nowrap', props.class)">
      <template v-if="!config.isVaultReadyToCreate && props.show !== 'OnlyTotal'">
        <NeedsSetup
          :tooltipSide="tooltipSide"
          :spacerWidth="spacerWidth"
          :align="props.align">
          Your vault account is still waiting to be setup.
          <template #value>
            <SubItem
              class="h-10"
              :tooltip="breakdown.help.vaultingAvailableMicrogons"
              :tooltipSide="tooltipSide"
              :height="itemHeight"
              :hide-connector="true"
              :spacerWidth="spacerWidth"
              :align="props.align"
              :showMoveButton="props.showMoveButtons"
              :moveFrom="MoveFrom.VaultingUnusedArgon"
              :moveTo="MoveTo.Holding">
              {{ microgonToArgonNm(wallets.vaultingWallet.availableMicrogons).format('0,0.[00]') }} ARGN
            </SubItem>
          </template>
        </NeedsSetup>
      </template>
      <template v-else-if="props.show !== 'OnlyTotal'">
        <Header
          :tooltip="breakdown.help.mintPipelineMicrogons"
          :tooltipSide="tooltipSide"
          :height="itemHeight"
          :spacerWidth="spacerWidth"
          :align="props.align"
          class="border-0">
          Minting Pipeline
          <template #icon><ArgonIcon class="h-7 w-7" /></template>
          <template #value>
            {{ currency.symbol }}{{ microgonToMoneyNm(breakdown.mintedValueInAccount + breakdown.pendingMintingValue).format('0,0.00') }}
          </template>
        </Header>
        <SubItem
          :tooltip="breakdown.help.pendingMintingValue"
          :tooltipSide="tooltipSide"
          :height="itemHeight"
          :spacerWidth="spacerWidth"
          :align="props.align">
          {{ microgonToArgonNm(breakdown.pendingMintingValue).format('0,0.[00]') }} ARGN to Mint
        </SubItem>
        <SubItem
          :tooltip="breakdown.help.alreadyMintedValue"
          :tooltipSide="tooltipSide"
          :height="itemHeight"
          :spacerWidth="spacerWidth"
          :align="props.align"
          :showMoveButton="props.showMoveButtons"
          :moveFrom="MoveFrom.VaultingMintedArgon"
          :moveTo="MoveTo.Holding"
        >
          {{ microgonToArgonNm(breakdown.mintedValueInAccount).format('0,0.[00]') }} ARGN Minted
        </SubItem>

        <Header
          :tooltip="breakdown.help.bitcoinSecurityTotal"
          :tooltipSide="tooltipSide"
          :height="itemHeight"
          :spacerWidth="spacerWidth"
          :align="props.align"
          class="border-dashed"
        >
          Bitcoin Security
          <template #icon><ArgonotIcon class="h-7 w-7" /></template>
          <template #value>
            {{ currency.symbol }}{{ micronotToMoneyNm(breakdown.bitcoinSecurityTotal).format('0,0.00') }}
          </template>
        </Header>
        <SubItem
          :tooltip="breakdown.help.waitingSecuritization"
          :tooltipSide="tooltipSide"
          :height="itemHeight"
          :spacerWidth="spacerWidth"
          :align="props.align"
          :showMoveButton="props.showMoveButtons"
          :moveFrom="MoveFrom.VaultingSecurityUnused"
          :moveTo="MoveTo.Holding"
        >
          {{ microgonToArgonNm(breakdown.waitingSecuritization).format('0,0.[00]') }} ARGN Unused
        </SubItem>
        <SubItem
          :tooltip="breakdown.help.pendingSecuritization"
          :tooltipSide="tooltipSide"
          :height="itemHeight"
          :spacerWidth="spacerWidth"
          :align="props.align"
        >
          {{ microgonToArgonNm(breakdown.pendingSecuritization).format('0,0.[00]') }} ARGN Processing
        </SubItem>
        <SubItem
          :tooltip="breakdown.help.activatedSecuritization"
          :tooltipSide="tooltipSide"
          :height="itemHeight"
          :spacerWidth="spacerWidth"
          :align="props.align"
        >
          {{ microgonToArgonNm(breakdown.activatedSecuritization).format('0,0.[00]') }} ARGN Activated
        </SubItem>

        <Header
          :tooltip="breakdown.help.treasuryBondTotal"
          :tooltipSide="tooltipSide"
          :height="itemHeight"
          :spacerWidth="spacerWidth"
          :align="props.align"
          class="border-dashed"
        >
          Treasury Bonds
          <template #icon><ArgonotIcon class="h-7 w-7" /></template>
          <template #value>
            {{ currency.symbol }}{{ micronotToMoneyNm(breakdown.treasuryBondTotal).format('0,0.00') }}
          </template>
        </Header>
        <SubItem
          :tooltip="breakdown.help.pendingTreasuryPoolInvestment"
          :tooltipSide="tooltipSide"
          :height="itemHeight"
          :spacerWidth="spacerWidth"
          :align="props.align"
          :showMoveButton="props.showMoveButtons"
          :moveFrom="MoveFrom.VaultingTreasuryUnused"
          :moveTo="MoveTo.Holding"
        >
          {{ microgonToArgonNm(breakdown.pendingTreasuryPoolInvestment).format('0,0.[00]') }} ARGN Unused
        </SubItem>
        <SubItem
          :tooltip="breakdown.help.activatedTreasuryPoolInvestment"
          :tooltipSide="tooltipSide"
          :height="itemHeight"
          :spacerWidth="spacerWidth"
          :align="props.align"
        >
          {{ microgonToArgonNm(breakdown.activatedTreasuryPoolInvestment).format('0,0.[00]') }} ARGN Activated
        </SubItem>

        <Expenses
          v-if="breakdown.hasLockedBitcoin"
          :tooltip="breakdown.help.unlockPrice"
          :tooltipSide="tooltipSide"
          :height="itemHeight"
          :spacerWidth="spacerWidth"
          :align="props.align"
        >
          <span class="hidden xl:inline">Cost to</span>
          Unlock Bitcoin
          <template #value>
            -{{ currency.symbol }}{{ microgonToMoneyNm(breakdown.unlockPrice).format('0,0.00') }}
          </template>
        </Expenses>

        <Expenses
          :tooltip="breakdown.help.operationalFeeMicrogons"
          :tooltipSide="tooltipSide"
          :class="breakdown.hasLockedBitcoin ? 'border-dashed' : ''"
          :height="itemHeight"
          :spacerWidth="spacerWidth"
          :align="props.align"
        >
          <span class="hidden xl:inline">Operational</span>
          Expenses
          <template #value>
            -{{ currency.symbol }}{{ microgonToMoneyNm(breakdown.operationalFeeMicrogons ?? 0n).format('0,0.00') }}
          </template>
        </Expenses>
      </template>

      <Total
        v-if="props.show === 'All' || props.show === 'OnlyTotal'"
        :tooltip="breakdown.help.totalVaultValue"
        :tooltipSide="tooltipSide"
        :height="itemHeight"
        :spacerWidth="spacerWidth"
        :align="props.align"
        :class="props.show === 'OnlyTotal' ? 'h-full' : ''"
      >
        Total Value
        <template #value>
          {{ currency.symbol }}{{ microgonToMoneyNm(breakdown.totalVaultValue).format('0,0.00') }}
        </template>
      </Total>
    </div>
  </TooltipProvider>
</template>

<script setup lang="ts">
import * as Vue from 'vue';
import { twMerge } from 'tailwind-merge';
import ArgonIcon from '../assets/resources/argon.svg?component';
import ArgonotIcon from '../assets/resources/argonot.svg?component';
import { TooltipProvider } from 'reka-ui';
import { createNumeralHelpers } from '../lib/numeral.ts';
import { useCurrency } from '../stores/currency.ts';
import { useVaultingAssetBreakdown } from '../stores/vaultingAssetBreakdown.ts';
import Header from './asset-breakdown/Header.vue';
import SubItem from './asset-breakdown/SubItem.vue';
import Expenses from './asset-breakdown/Expenses.vue';
import Total from './asset-breakdown/Total.vue';
import { MoveFrom, MoveTo } from '@argonprotocol/apps-core';
import { useConfig } from '../stores/config.ts';
import { useWallets } from '../stores/wallets.ts';
import NeedsSetup from './asset-breakdown/NeedsSetup.vue';
import { useMyVault, useVaults } from '../stores/vaults.ts';
import { useBitcoinLocks } from '../stores/bitcoin.ts';

const props = withDefaults(
  defineProps<{
    show?: 'All' | 'AllExceptTotal' | 'OnlyTotal';
    align?: 'left' | 'right';
    showMoveButtons?: boolean;
    spacerWidth?: string;
    class?: string;
    tooltipSide?: 'right' | 'top';
  }>(),
  {
    show: 'All',
    align: 'left',
    tooltipSide: 'right',
  },
);

const currency = useCurrency();
const config = useConfig();
const wallets = useWallets();
const myVault = useMyVault();
const vaults = useVaults();
const miningFrames = vaults.miningFrames;
const bitcoinLocks = useBitcoinLocks();

Vue.onMounted(async () => {
  await miningFrames.load();
  await myVault.load();
  await myVault.subscribe();
  await bitcoinLocks.load();
});
const { microgonToMoneyNm, micronotToMoneyNm, microgonToArgonNm } = createNumeralHelpers(currency);

const breakdown = useVaultingAssetBreakdown();

const itemHeight = Vue.computed(() => {
  let total = 12;
  if (props.show === 'AllExceptTotal') {
    total = 11;
  } else if (props.show === 'OnlyTotal') {
    total = 1;
  } else if (props.show === 'All') {
    return 'auto';
  }
  return 100 / total;
});
</script>
