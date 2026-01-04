<!-- prettier-ignore -->
<template>
  <TooltipProvider :disableHoverableContent="true">
    <div :class="twMerge('text-md relative flex w-full flex-col items-center whitespace-nowrap', props.class)">
      <template v-if="!config.isVaultReadyToCreate && props.show !== 'OnlyTotal'">
        <NeedsSetup :tooltipSide="tooltipSide" :spacerWidth="spacerWidth" :align="props.align">
          Your vault account is still waiting to be setup.
          <template #value>
            <SubItem
              class="h-10"
              :tooltipSide="tooltipSide"
              :height="itemHeight"
              :hide-connector="true"
              :spacerWidth="spacerWidth"
              :align="props.align"
              :showMoveButton="props.showMoveButtons"
              :moveFrom="MoveFrom.VaultingUnusedArgon"
              :moveTo="MoveTo.Holding">
              {{ microgonToArgonNm(breakdown.vaultingAvailableMicrogons).format('0,0.[00]') }} ARGN
              <template #tooltip>
                <p class="break-words whitespace-normal">
                  This is the amount of argons you have available and unallocated in your account.
                </p>
              </template>
            </SubItem>
          </template>
        </NeedsSetup>
      </template>
      <template v-else-if="props.show !== 'OnlyTotal'">
        <Header
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
          <template #tooltip>
            <p class="break-words whitespace-normal">
              These argons are minted to your account via liquid locked bitcoins.
            </p>
          </template>
        </Header>
        <SubItem :tooltipSide="tooltipSide" :height="itemHeight" :spacerWidth="spacerWidth" :align="props.align">
          {{ microgonToArgonNm(breakdown.pendingMintingValue).format('0,0.[00]') }} ARGN to Mint

          <template #tooltip>
            <p v-if="breakdown.pendingMintingValue" class="break-words whitespace-normal">
              These have been earned, but they have not yet been minted. Minting is determined by supply and demand,
              which means, although you're guaranteed to get them, the timeframe is unknown.
            </p>
            <p v-else class="break-words whitespace-normal">
              This is where you'll see argons that are earned but not yet minted. You currently have zero argons waiting
              in the minting queue.
            </p>
          </template>
        </SubItem>
        <SubItem
          :tooltipSide="tooltipSide"
          :height="itemHeight"
          :spacerWidth="spacerWidth"
          :align="props.align"
          :showMoveButton="props.showMoveButtons"
          :moveFrom="MoveFrom.VaultingMintedArgon"
          :moveTo="MoveTo.Holding">
          {{ microgonToArgonNm(breakdown.mintedValueInAccount).format('0,0.[00]') }} ARGN Minted

          <template #tooltip>
            <p v-if="breakdown.mintedValueInAccount" class="break-words whitespace-normal">
              These argons are minted to your account and available for use. They will be needed to unlock your Bitcoin,
              but can be used freely in the interim.
            </p>
            <p v-else class="break-words whitespace-normal">
              This is where you'll see argons that have been minted as a result of locking bitcoin into your vault. You
              currently have zero argons minted.
            </p>
          </template>
        </SubItem>

        <Header
          :tooltipSide="tooltipSide"
          :height="itemHeight"
          :spacerWidth="spacerWidth"
          :align="props.align"
          class="border-dashed">
          Bitcoin Security
          <template #icon><ArgonotIcon class="h-7 w-7" /></template>
          <template #value>
            {{ currency.symbol }}{{ microgonToMoneyNm(breakdown.bitcoinSecurityTotal).format('0,0.00') }}
          </template>
          <template #tooltip>
            <p class="break-words whitespace-normal">
              This is the total capital applied to your vault's bitcoin securitization. It insures that anyone who locks
              bitcoin in your vault will be able to claim their bitcoin back in full.
            </p>
          </template>
        </Header>
        <SubItem
          :tooltipSide="tooltipSide"
          :height="itemHeight"
          :spacerWidth="spacerWidth"
          :align="props.align"
          :showMoveButton="props.showMoveButtons"
          :moveFrom="MoveFrom.VaultingSecurityUnused"
          :moveTo="MoveTo.Holding">
          {{ microgonToArgonNm(breakdown.waitingSecuritization).format('0,0.[00]') }} ARGN Unused

          <template #tooltip>
            <p class="break-words whitespace-normal">
              These argons have not yet been applied to your vault's securitization. They are waiting for new bitcoins
              to be added to your vault.
            </p>
          </template>
        </SubItem>
        <SubItem :tooltipSide="tooltipSide" :height="itemHeight" :spacerWidth="spacerWidth" :align="props.align">
          {{ microgonToArgonNm(breakdown.pendingSecuritization).format('0,0.[00]') }} ARGN Processing

          <template #tooltip>
            <p class="break-words whitespace-normal">
              These argons are already committed to bitcoins pending in your vault. However, these bitcoins are still in
              the process of locking. Once completed, these argons will move to "Activated".
            </p>
          </template>
        </SubItem>
        <SubItem :tooltipSide="tooltipSide" :height="itemHeight" :spacerWidth="spacerWidth" :align="props.align">
          {{ microgonToArgonNm(breakdown.activatedSecuritization).format('0,0.[00]') }} ARGN Activated

          <template #tooltip>
            <p v-if="breakdown.activatedSecuritization" class="break-words whitespace-normal">
              These argons are currently being used to securitize your vault's bitcoin.
            </p>
            <p v-else class="break-words whitespace-normal">
              You have no argons actively being used to securitize bitcoins.
            </p>
          </template>
        </SubItem>

        <Header
          :tooltipSide="tooltipSide"
          :height="itemHeight"
          :spacerWidth="spacerWidth"
          :align="props.align"
          class="border-dashed">
          Treasury Bonds
          <template #icon><ArgonotIcon class="h-7 w-7" /></template>
          <template #value>
            {{ currency.symbol }}{{ microgonToMoneyNm(breakdown.treasuryBondTotal).format('0,0.00') }}
          </template>

          <template #tooltip>
            <p class="break-words whitespace-normal">
              This is the capital that has been allocated to your vault's treasury bonds.
            </p>
          </template>
        </Header>
        <SubItem
          :tooltipSide="tooltipSide"
          :height="itemHeight"
          :spacerWidth="spacerWidth"
          :align="props.align"
          :showMoveButton="props.showMoveButtons"
          :moveFrom="MoveFrom.VaultingTreasuryUnused"
          :moveTo="MoveTo.Holding">
          {{ microgonToArgonNm(breakdown.pendingTreasuryPoolInvestment).format('0,0.[00]') }} ARGN Unused

          <template #tooltip>
            <p class="break-words whitespace-normal">
              This capital is sitting idle because your vault does not have enough bitcoin. The amount in treasury bonds
              cannot exceed the bitcoin value in your vault.
            </p>
          </template>
        </SubItem>
        <SubItem :tooltipSide="tooltipSide" :height="itemHeight" :spacerWidth="spacerWidth" :align="props.align">
          {{ microgonToArgonNm(breakdown.activatedTreasuryPoolInvestment).format('0,0.[00]') }} ARGN Activated
          <template #tooltip>
            <p class="break-words whitespace-normal" v-if="breakdown.activatedTreasuryPoolInvestment">
              These argons are actively generating yield for your vault through treasury bond investments.
            </p>
            <p v-else class="break-words whitespace-normal">
              You have no argons actively being applied to treasury bond investments.
            </p>
          </template>
        </SubItem>

        <Expenses
          v-if="breakdown.hasLockedBitcoin"
          :tooltipSide="tooltipSide"
          :height="itemHeight"
          :spacerWidth="spacerWidth"
          :align="props.align">
          <span class="hidden xl:inline">Cost to</span>
          Unlock Bitcoin
          <template #value>
            -{{ currency.symbol }}{{ microgonToMoneyNm(breakdown.unlockPrice).format('0,0.00') }}
          </template>
          <template #tooltip>
            <p class="break-words whitespace-normal">This is what it will cost to unlock your personal bitcoin.</p>
          </template>
        </Expenses>

        <Expenses
          :tooltipSide="tooltipSide"
          :class="breakdown.hasLockedBitcoin ? 'border-dashed' : ''"
          :height="itemHeight"
          :spacerWidth="spacerWidth"
          :align="props.align">
          <span class="hidden xl:inline">Operational</span>
          Expenses
          <template #value>
            -{{ currency.symbol }}{{ microgonToMoneyNm(breakdown.operationalFeeMicrogons ?? 0n).format('0,0.00') }}
          </template>
          <template #tooltip>
            <p class="break-words whitespace-normal">
              The summation of all operational expenses that have been paid since your vault's inception.
            </p>
          </template>
        </Expenses>
      </template>

      <Total
        v-if="props.show === 'All' || props.show === 'OnlyTotal'"
        :tooltipSide="tooltipSide"
        :height="itemHeight"
        :spacerWidth="spacerWidth"
        :align="props.align"
        :class="props.show === 'OnlyTotal' ? 'h-full' : ''">
        Total Value
        <template #value>
          {{ currency.symbol }}{{ microgonToMoneyNm(breakdown.totalVaultValue).format('0,0.00') }}
        </template>
        <template #tooltip>
          <p class="font-normal break-words whitespace-normal">The total value of your vault's assets.</p>
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
import { getCurrency } from '../stores/currency.ts';
import { useVaultingAssetBreakdown } from '../stores/vaultingAssetBreakdown.ts';
import Header from './asset-breakdown/Header.vue';
import SubItem from './asset-breakdown/SubItem.vue';
import Expenses from './asset-breakdown/Expenses.vue';
import Total from './asset-breakdown/Total.vue';
import { MoveFrom, MoveTo } from '@argonprotocol/apps-core';
import { getConfig } from '../stores/config.ts';
import { useWallets } from '../stores/wallets.ts';
import NeedsSetup from './asset-breakdown/NeedsSetup.vue';
import { getMyVault, getVaults } from '../stores/vaults.ts';
import { getBitcoinLocks } from '../stores/bitcoin.ts';

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

const currency = getCurrency();
const config = getConfig();
const wallets = useWallets();
const myVault = getMyVault();
const vaults = getVaults();
const miningFrames = vaults.miningFrames;
const bitcoinLocks = getBitcoinLocks();

Vue.onMounted(async () => {
  await miningFrames.load();
  await myVault.load();
  if (!myVault.createdVault) {
    return;
  }
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
