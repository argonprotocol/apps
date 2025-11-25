<template>
  <TooltipProvider :disableHoverableContent="true">
    <div class="text-md relative flex w-full flex-col items-center whitespace-nowrap">
      <template v-if="props.show !== 'OnlyTotal'">
        <Header
          :tooltip="breakdown.help.vaultingAvailableMicrogons"
          :height="itemHeight"
          :align="props.align"
          class="border-0">
          Minting Pipeline
          <template #icon><ArgonIcon class="h-7 w-7" /></template>
          <template #value>
            {{ currency.symbol }}{{ microgonToMoneyNm(breakdown.vaultingAvailableMicrogons).format('0,0.00') }}
          </template>
        </Header>
        <SubItem :tooltip="breakdown.help.pendingMintingValue" :height="itemHeight" :align="props.align">
          {{ microgonToArgonNm(breakdown.pendingMintingValue).format('0,0.[00]') }} ARGN to Mint
        </SubItem>
        <SubItem
          :tooltip="breakdown.help.alreadyMintedValue"
          :height="itemHeight"
          :align="props.align"
          :showArrow="props.showArrows">
          {{ microgonToArgonNm(breakdown.alreadyMintedValue).format('0,0.[00]') }} ARGN Minted
        </SubItem>

        <Header
          :tooltip="breakdown.help.bitcoinSecurityTotal"
          class="border-dashed"
          :height="itemHeight"
          :align="props.align">
          Bitcoin Security
          <template #icon><ArgonotIcon class="h-7 w-7" /></template>
          <template #value>
            {{ currency.symbol }}{{ micronotToMoneyNm(breakdown.bitcoinSecurityTotal).format('0,0.00') }}
          </template>
        </Header>
        <SubItem
          :tooltip="breakdown.help.waitingSecuritization"
          :height="itemHeight"
          :align="props.align"
          :showArrow="props.showArrows">
          {{ microgonToArgonNm(breakdown.waitingSecuritization).format('0,0.[00]') }} ARGN Unused
        </SubItem>
        <SubItem :tooltip="breakdown.help.pendingSecuritization" :height="itemHeight" :align="props.align">
          {{ microgonToArgonNm(breakdown.pendingSecuritization).format('0,0.[00]') }} ARGN Processing
        </SubItem>
        <SubItem :tooltip="breakdown.help.activatedSecuritization" :height="itemHeight" :align="props.align">
          {{ microgonToArgonNm(breakdown.activatedSecuritization).format('0,0.[00]') }} ARGN Activated
        </SubItem>

        <Header
          :tooltip="breakdown.help.treasuryBondTotal"
          class="border-dashed"
          :height="itemHeight"
          :align="props.align">
          Treasury Bonds
          <template #icon><ArgonotIcon class="h-7 w-7" /></template>
          <template #value>
            {{ currency.symbol }}{{ micronotToMoneyNm(breakdown.treasuryBondTotal).format('0,0.00') }}
          </template>
        </Header>
        <SubItem
          :tooltip="breakdown.help.pendingTreasuryPoolInvestment"
          :height="itemHeight"
          :align="props.align"
          :showArrow="props.showArrows">
          {{ microgonToArgonNm(breakdown.pendingTreasuryPoolInvestment).format('0,0.[00]') }} ARGN Unused
        </SubItem>
        <SubItem :tooltip="breakdown.help.activatedTreasuryPoolInvestment" :height="itemHeight" :align="props.align">
          {{ microgonToArgonNm(breakdown.activatedTreasuryPoolInvestment).format('0,0.[00]') }} ARGN Activated
        </SubItem>

        <Expenses
          v-if="breakdown.hasLockedBitcoin"
          :tooltip="breakdown.help.unlockPrice"
          :height="itemHeight"
          :align="props.align">
          <span class="hidden xl:inline">Cost to</span>
          Unlock Bitcoin
          <template #value>
            -{{ currency.symbol }}{{ microgonToMoneyNm(breakdown.unlockPrice).format('0,0.00') }}
          </template>
        </Expenses>

        <Expenses
          :tooltip="breakdown.help.operationalFeeMicrogons"
          :class="breakdown.hasLockedBitcoin ? 'border-dashed' : ''"
          :height="itemHeight"
          :align="props.align">
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
        :class="props.show === 'OnlyTotal' ? 'h-full' : ''"
        :height="itemHeight"
        :align="props.align">
        Total Value
        <template #value>
          {{ currency.symbol }}{{ microgonToMoneyNm(breakdown.totalVaultValue).format('0,0.00') }}
        </template>
      </Total>
    </div>
  </TooltipProvider>
</template>

<script setup lang="ts">
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
import * as Vue from 'vue';

const props = withDefaults(
  defineProps<{
    show?: 'All' | 'AllExceptTotal' | 'OnlyTotal';
    align?: 'left' | 'right';
    showArrows?: boolean;
  }>(),
  {
    show: 'All',
    align: 'left',
  },
);

const currency = useCurrency();

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
