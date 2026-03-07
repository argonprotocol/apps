<!-- prettier-ignore -->
<template>
  <TooltipProvider :disableHoverableContent="true">
    <div :class="twMerge('text-md relative flex w-full flex-col items-center whitespace-nowrap', props.class)">
      <Header
        :tooltipSide="tooltipSide"
        :height="itemHeight"
        :spacerWidth="spacerWidth"
        :align="props.align"
        class="border-0"
      >
        Inflation-Free Savings
        <template #icon><ArgonIcon class="h-7 w-7" /></template>
        <template #value>
          {{ currency.symbol }}{{ microgonToMoneyNm(breakdown.sidelinedTotalValue).format('0,0.00') }}
        </template>
        <template #tooltip>
          <div class="break-words whitespace-normal">
            <p v-if="breakdown.sidelinedTotalValue">
              These argons have not been allocated to Bitcoin Security or Treasury Bonds, and therefore they
              are ready to be moved wherever you want.
            </p>
            <p v-else>
              You have no unused holdings.
            </p>
          </div>
        </template>
      </Header>
      <SubItem
        :tooltipSide="tooltipSide"
        :height="itemHeight"
        :spacerWidth="spacerWidth"
        :align="props.align"
        :moveFrom="MoveFrom.VaultingHold"
        :moveToken="MoveToken.ARGN"
      >
        {{ microgonToArgonNm(breakdown.sidelinedMicrogons).format('0,0.[00]') }} ARGN
        <template #tooltip>
          <div class="break-words whitespace-normal">
            <p v-if="breakdown.sidelinedMicrogons">
              Click to move these argons anywhere you want. For example, allocate them to Bitcoin Security to allow
              more bitcoins into your vault, or to Treasury Bonds to increase yield.
            </p>
            <p v-else>
              You have no unused argons in your vault.
            </p>
          </div>
        </template>
      </SubItem>
      <SubItem
        :tooltipSide="tooltipSide"
        :height="itemHeight"
        :spacerWidth="spacerWidth"
        :align="props.align"
        :moveFrom="MoveFrom.VaultingHold"
        :moveToken="MoveToken.ARGNOT"
      >
        {{ micronotToArgonotNm(breakdown.sidelinedMicronots).format('0,0.[00]') }} ARGNOT
        <template #tooltip>
          <div class="break-words whitespace-normal">
            <p v-if="breakdown.sidelinedMicronots">
              Argonots are a critical component of both Bitcoin Security and Mining operations. Click to open the Move
              model and deploy these tokens.
            </p>
            <p v-else>
              You have no unused argonots in your vault.
            </p>
          </div>
        </template>
      </SubItem>

      <Header
        :tooltipSide="tooltipSide"
        :height="itemHeight"
        :spacerWidth="spacerWidth"
        :align="props.align"
        class="border-dashed"
      >
        Bitcoin Security
        <template #icon><ArgonotIcon class="h-7 w-7" /></template>
        <template #value>
          {{ currency.symbol }}{{ microgonToMoneyNm(breakdown.securityTotalValue).format('0,0.00') }}
        </template>
        <template #tooltip>
          <div class="break-words whitespace-normal">
            <p v-if="breakdown.securityTotalValue">
              This represents the total capital applied to your vault's bitcoin securitization. It insures anyone who locks
              bitcoin in your vault will be able to reclaim their bitcoin back in full.
            </p>
            <p v-else>
              Your vault has no securitization capital. This means no bitcoins can be locked in your vault, and
              therefore, your vault has no way to generate revenue.
            </p>
          </div>
        </template>
      </Header>
      <SubItem
        :tooltipSide="tooltipSide"
        :height="itemHeight"
        :spacerWidth="spacerWidth"
        :align="props.align"
        :moveFrom="MoveFrom.VaultingSecurity"
        :moveToken="MoveToken.ARGN"
      >
        <div class="flex flex-row items-center w-full">
          <div class="grow">
            {{ microgonToArgonNm(breakdown.securityMicrogons).format('0,0.[00]') }} ARGN
          </div>
          <div class="opacity-60">{{ numeral(breakdown.securityMicrogonsActivatedPct).format('0,0.[00]') }}%</div>
        </div>
        <template #tooltip>
          <div class="break-words whitespace-normal">
            <div v-if="breakdown.securityMicrogons" class="flex flex-col gap-y-3">
              <p>
                <span v-if="!breakdown.securityMicrogonsActivatedPct">
                  These argons guarantee the safety of bitcoins locked in your vault, however, no bitcoins
                  have been locked into your vault yet.
                </span>
                <span v-else>
                  These argons guarantee the safety of bitcoins locked in your vault.
                </span>
                <span v-if="numeral(breakdown.securityMicrogonsActivatedPct).format('0,0.00') === '100.00'">
                  All your argons are currently being used, which means your vault is at full capacity. You must add
                  more argons to increase your capacity for more bitcoin.
                </span>
                <span v-else>
                  Only {{ numeral(breakdown.securityMicrogonsActivatedPct).format('0,0.[00]') }}% are actively
                  being used, which means your vault has room for more bitcoin.
                </span>
              </p>
              <p>
                Argons held as security are locked for up to a full year:
              </p>
              <table class="w-full whitespace-nowrap -mb-2">
                <tbody>
                  <tr>
                    <td class="border-t border-slate-600/20 py-1">Allowed to move immediately</td>
                    <td class="border-t border-slate-600/20 py-1 text-right">{{ microgonToArgonNm(breakdown.securityMicrogonsUnused).format('0,0.[00]') }} ARGN</td>
                  </tr>
                  <tr>
                    <td class="border-y border-slate-600/10 py-1">Must wait 24 hours</td>
                    <td class="border-y border-slate-600/10 py-1 text-right">{{ microgonToArgonNm(breakdown.securityMicrogonsPending).format('0,0.[00]') }} ARGN</td>
                  </tr>
                  <tr>
                    <td class="py-1">Must wait a year</td>
                    <td class="py-1 text-right">{{ microgonToArgonNm(breakdown.securityMicrogonsActivated).format('0,0.[00]') }} ARGN</td>
                  </tr>
                </tbody>
              </table>
            </div>
            <p v-else>
              You have no argons allocating to securing your vault.
            </p>
          </div>
        </template>
      </SubItem>
      <SubItem
        :tooltipSide="tooltipSide"
        :height="itemHeight"
        :spacerWidth="spacerWidth"
        :align="props.align"
        :moveFrom="MoveFrom.VaultingSecurity"
        :moveToken="MoveToken.ARGNOT"
      >
        <div class="flex flex-row items-center w-full">
          <div class="grow">
            {{ micronotToArgonotNm(breakdown.securityMicronots).format('0,0.[00]') }} ARGNOT
          </div>
          <div v-if="breakdown.securityMicronots" class="opacity-60">{{ numeral(breakdown.securityMicronotsActivatedPct).format('0,0.[00]') }}%</div>
        </div>
        <template #tooltip>
          <div class="break-words whitespace-normal">
            <div v-if="breakdown.securityMicronots" class="flex flex-col gap-y-3">
              <p>
                Argonots serve as a second layer of securing your vault's bitcoin. Similar to argons, they are locked
                for up to a full year.
              </p>
              <table class="w-full whitespace-nowrap -mb-2">
                <tbody>
                  <tr>
                    <td class="border-t border-slate-600/20 py-1">Allowed to move immediately</td>
                    <td class="border-t border-slate-600/20 py-1 text-right">{{ micronotToArgonotNm(breakdown.securityMicronotsUnused).format('0,0.[00]') }} ARGN</td>
                  </tr>
                  <tr>
                    <td class="border-y border-slate-600/10 py-1">Must wait 24 hours</td>
                    <td class="border-y border-slate-600/10 py-1 text-right">{{ micronotToArgonotNm(breakdown.securityMicronotsPending).format('0,0.[00]') }} ARGN</td>
                  </tr>
                  <tr>
                    <td class="py-1">Must wait a year</td>
                    <td class="py-1 text-right">{{ micronotToArgonotNm(breakdown.securityMicronotsActivated).format('0,0.[00]') }} ARGN</td>
                  </tr>
                </tbody>
              </table>
            </div>
            <p v-else>
              You have no argonots securing your vault.
            </p>
          </div>
        </template>
      </SubItem>

      <Header
        :tooltipSide="tooltipSide"
        :height="itemHeight"
        :spacerWidth="spacerWidth"
        :align="props.align"
        class="border-dashed"
      >
        Treasury Bonds
        <template #icon><ArgonotIcon class="h-7 w-7" /></template>
        <template #value>
          {{ currency.symbol }}{{ microgonToMoneyNm(breakdown.treasuryTotalValue).format('0,0.00') }}
        </template>

        <template #tooltip>
          <p class="break-words whitespace-normal">
            This is the capital that has been allocated to your vault's treasury bonds. It has a huge impact on your
            vault's revenue yield.
          </p>
        </template>
      </Header>
      <SubItem
        :tooltipSide="tooltipSide"
        :height="itemHeight"
        :spacerWidth="spacerWidth"
        :align="props.align"
        :moveFrom="MoveFrom.VaultingTreasury"
        :moveToken="MoveToken.ARGN"
      >
        <div class="flex flex-row items-center w-full">
          <div class="grow">
            {{ microgonToArgonNm(breakdown.treasuryMicrogons).format('0,0.[00]') }} ARGN
          </div>
          <div v-if="breakdown.treasuryMicrogonsMaxCapacity > breakdown.treasuryMicrogons" class="flex flex-row items-center gap-x-1">
            <ExclamationTriangleIcon class="size-5 text-yellow-600" aria-hidden="true" />
            LOW
          </div>
          <div class="opacity-60" v-else>{{ numeral(breakdown.treasuryMicrogonsActivatedPct).format('0,0.[00]')}}%</div>
        </div>
        <template #tooltip>
          <div class="break-words whitespace-normal">
            <p v-if="breakdown.treasuryMicrogons">
              These are the argons that have been allocated to Treasury Bonds.
              <template v-if="breakdown.treasuryMicrogonsMaxCapacity > breakdown.treasuryMicrogons">
                You can add more argons here to increase your vault's yield. The maximum amount you can allocate
                is {{ microgonToArgonNm(breakdown.treasuryMicrogonsMaxCapacity).format('0,0.[00]') }} ARGN,
                which is determined by the bitcoin value in your vault.
              </template>
              <template v-else>The amount cannot exceed the bitcoin value in your vault.</template>
            </p>
            <p v-else>
              You have no argons allocated to Treasury Bonds.
            </p>
          </div>
        </template>
      </SubItem>

      <Expenses
        :tooltipSide="tooltipSide"
        :height="itemHeight"
        :spacerWidth="spacerWidth"
        :align="props.align"
      >
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

      <Total
        :tooltipSide="tooltipSide"
        :height="itemHeight"
        :spacerWidth="spacerWidth"
        :align="props.align"
      >
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
import ArgonIcon from '../../assets/resources/argon.svg?component';
import ArgonotIcon from '../../assets/resources/argonot.svg?component';
import { TooltipProvider } from 'reka-ui';
import numeral, { createNumeralHelpers } from '../../lib/numeral.ts';
import { getCurrency } from '../../stores/currency.ts';
import { useVaultingAssetBreakdown } from '../../stores/vaultingAssetBreakdown.ts';
import Header from '../../components/asset-breakdown/Header.vue';
import SubItem from '../../components/asset-breakdown/SubItem.vue';
import Expenses from '../../components/asset-breakdown/Expenses.vue';
import Total from '../../components/asset-breakdown/Total.vue';
import { MoveFrom, MoveTo, MoveToken } from '@argonprotocol/apps-core';
import { getMyVault, getVaults } from '../../stores/vaults.ts';
import { getBitcoinLocks } from '../../stores/bitcoin.ts';
import { ExclamationTriangleIcon } from '@heroicons/vue/20/solid';

const props = withDefaults(
  defineProps<{
    align?: 'left' | 'right';
    spacerWidth?: string;
    class?: string;
    tooltipSide?: 'right' | 'top';
  }>(),
  {
    align: 'left',
    tooltipSide: 'right',
  },
);

const currency = getCurrency();
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
const { microgonToMoneyNm, microgonToArgonNm, micronotToArgonotNm } = createNumeralHelpers(currency);

const breakdown = useVaultingAssetBreakdown();

const itemHeight = Vue.computed(() => {
  return 'auto' as const;
});
</script>
