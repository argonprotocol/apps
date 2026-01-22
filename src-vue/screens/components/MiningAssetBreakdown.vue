<!-- prettier-ignore -->
<template>
  <TooltipProvider :disableHoverableContent="true">
    <div
      class="MiningAssetBreakdown"
      :class="twMerge('text-md relative flex w-full flex-col items-center whitespace-nowrap', props.class)"
    >
      <template v-if="props.show !== 'OnlyTotal' && !config.isMinerInstalled">
        <NeedsSetup :tooltipSide="tooltipSide" :spacerWidth="spacerWidth" :align="props.align">
          Your mining account is still waiting to be setup.
          <template #value>
            <SubItem
              :tooltipSide="tooltipSide"
              :height="itemHeight"
              :spacerWidth="spacerWidth"
              :moveFrom="MoveFrom.MiningBot"
              :moveToken="MoveToken.ARGN"
            >
              {{ microgonToArgonNm(breakdown.sidelinedMicrogons).format('0,0.[00]') }} ARGN
              <template #tooltip>
                <p class="break-words whitespace-normal">
                  These argons have been activated for mining, but your bot hasn't found a competitively priced bid.
                </p>
              </template>
            </SubItem>
            <SubItem
              :tooltipSide="tooltipSide"
              :height="itemHeight"
              :showMoveButton="true"
              :moveFrom="MoveFrom.MiningBot"
              :moveToken="MoveToken.ARGNOT"
            >
              {{ microgonToArgonNm(breakdown.sidelinedMicronots).format('0,0.[00]') }} ARGNOT
              <template #tooltip>
                <p class="break-words whitespace-normal">
                  These argonots are available for mining, but your bot hasn't found a competitively priced bid.
                </p>
              </template>
            </SubItem>
          </template>
        </NeedsSetup>
      </template>
      <template v-else-if="props.show !== 'OnlyTotal'">
        <Header :tooltipSide="tooltipSide" :height="itemHeight" :spacerWidth="spacerWidth" class="border-0">
          Unused Holdings
          <template #tooltip>
            <p class="break-words whitespace-normal">These argons are currently sitting unused.</p>
          </template>
          <template #icon><ArgonIcon class="h-7 w-7" /></template>
          <template #value>
            {{ currency.symbol }}{{ microgonToMoneyNm(breakdown.sidelinedTotalValue).format('0,0.00') }}
          </template>
        </Header>
        <SubItem
          :tooltipSide="tooltipSide"
          :height="itemHeight"
          :spacerWidth="spacerWidth"
          :moveFrom="MoveFrom.MiningHold"
          :moveToken="MoveToken.ARGN"
        >
          {{ microgonToArgonNm(breakdown.sidelinedMicrogons).format('0,0.[00]') }} ARGN
          <template #tooltip>
            <p class="break-words whitespace-normal">
              These argons have been activated for mining, but your bot hasn't found a competitively priced bid.
            </p>
          </template>
        </SubItem>
        <SubItem
          :tooltipSide="tooltipSide"
          :height="itemHeight"
          :showMoveButton="true"
          :spacerWidth="spacerWidth"
          :moveFrom="MoveFrom.MiningHold"
          :moveToken="MoveToken.ARGNOT"
        >
          {{ microgonToArgonNm(breakdown.sidelinedMicronots).format('0,0.[00]') }} ARGNOT
          <template #tooltip>
            <p class="break-words whitespace-normal">
              These argonots are available for mining, but your bot hasn't found a competitively priced bid.
            </p>
          </template>
        </SubItem>

        <Header :tooltipSide="tooltipSide" :height="itemHeight" :spacerWidth="spacerWidth" class="border-dashed">
          Mining Bids
          ({{ numeral(breakdown.auctionBidCount).format('0,0') }})
          <template #tooltip>
            <p class="break-words whitespace-normal">These argons are allocated to currently winning bids.</p>
          </template>
          <template #icon><ArgonIcon class="h-7 w-7" /></template>
          <template #value>
            {{ currency.symbol }}{{ microgonToMoneyNm(breakdown.auctionTotalValue).format('0,0.00') }}
          </template>
        </Header>
        <SubItem
          :tooltipSide="tooltipSide"
          :height="itemHeight"
          :showMoveButton="true"
          :spacerWidth="spacerWidth"
          :moveFrom="MoveFrom.MiningBot"
          :moveToken="MoveToken.ARGN"
        >
          <div class="flex flex-row items-center w-full">
            <div class="grow">
              {{ microgonToArgonNm(breakdown.auctionMicrogonsTotal).format('0,0.[00]') }} ARGN
            </div>
            <div class="opacity-60">{{ numeral(breakdown.auctionMicrogonsActivatedPct).format('0,0.[00]') }}%</div>
          </div>
          <template #tooltip>
            <p class="break-words whitespace-normal">
              These argons are available for bidding. {{ numeral(breakdown.auctionMicrogonsActivatedPct).format('0,0.[00]') }}% is currently being used in active bids.
            </p>
          </template>
        </SubItem>
        <SubItem
          :tooltipSide="tooltipSide"
          :height="itemHeight"
          :spacerWidth="spacerWidth"
          :moveFrom="MoveFrom.MiningBot"
          :moveToken="MoveToken.ARGNOT"
        >
          <div class="flex flex-row items-center w-full">
            <div class="grow">
              {{ microgonToArgonNm(breakdown.auctionMicronotsTotal).format('0,0.[00]') }} ARGNOT
            </div>
            <div class="opacity-60">{{ numeral(breakdown.auctionMicronotsActivatedPct).format('0,0.[00]') }}%</div>
          </div>
          <template #tooltip>
            <p class="break-words whitespace-normal">
              These argonots are available for bidding. {{ numeral(breakdown.auctionMicronotsActivatedPct).format('0,0.[00]') }}% is currently being used in active bids.
            </p>
          </template>
        </SubItem>

        <Header :tooltipSide="tooltipSide" :height="itemHeight" :spacerWidth="spacerWidth" class="border-dashed">
          Active
          <span class="hidden 2xl:inline">Mining</span>
          Seats ({{ numeral(breakdown.seatActiveCount).format('0,0') }})
          <template #icon><MiningSeatIcon class="h-7 w-7" /></template>
          <template #value>
            {{ currency.symbol }}{{ microgonToMoneyNm(breakdown.expectedSeatValue).format('0,0.00') }}
          </template>
          <template #tooltip>
            <p class="break-words whitespace-normal">
              You have a total of {{ numeral(breakdown.seatActiveCount).format('0,0') }} active mining seats. You won
              them using a combination of argons and argonots. They have an estimated value of
              {{ currency.symbol }}{{ microgonToMoneyNm(wallets.miningSeatValue).format('0,0.00') }}.
            </p>
            <p class="mt-3 break-words whitespace-normal">
              These mining seats have
              {{ microgonToMoneyNm(breakdown.stakedSeatMicronots).format('0,0.00') }} argonots which will be released back
              into your wallet once the associated mining cycle completes.
            </p>
          </template>
        </Header>
        <SubItem :tooltipSide="tooltipSide" :height="itemHeight" :spacerWidth="spacerWidth">
          {{ microgonToArgonNm(breakdown.expectedSeatMicrogons).format('0,0.[00]') }} ARGN to Mine
          <template #tooltip>
            <p class="break-words whitespace-normal">
              These argons are expected to be earned during the remainder of your active mining seats.
            </p>
          </template>
        </SubItem>
        <SubItem :height="itemHeight" :spacerWidth="spacerWidth" :tooltipSide="tooltipSide">
          {{ microgonToArgonNm(breakdown.expectedSeatMicronots).format('0,0.[00]') }} ARGNOT to Mine
          <template #tooltip>
            <p class="break-words whitespace-normal">
              These argonots are expected to be earned during the remainder of your active mining seats.
            </p>
          </template>
        </SubItem>
        <SubItem :height="itemHeight" :spacerWidth="spacerWidth" :tooltipSide="tooltipSide">
          {{ microgonToArgonNm(breakdown.stakedSeatMicronots).format('0,0.[00]') }} ARGNOT Staked
          <template #tooltip>
            <p class="break-words whitespace-normal">
              These argonots are expected to be earned during the remainder of your active mining seats.
            </p>
          </template>
        </SubItem>

        <Expenses :tooltipSide="tooltipSide" :height="itemHeight" :spacerWidth="spacerWidth">
          <span class="hidden xl:inline">Operational</span>
          Expenses
          <template #value>
            -{{ currency.symbol }}{{ microgonToMoneyNm(breakdown.transactionFeesTotal).format('0,0.00') }}
          </template>
          <template #tooltip>
            <p class="break-words whitespace-normal">
              The summation of all operational expenses that have been paid since you started mining.
            </p>
          </template>
        </Expenses>
      </template>

      <Total
        v-if="props.show === 'All' || props.show === 'OnlyTotal'"
        :tooltipSide="tooltipSide"
        :height="itemHeight"
        :spacerWidth="spacerWidth"
        :class="props.show === 'OnlyTotal' ? 'h-full' : ''">
        Total Value
        <template #value>
          {{ currency.symbol }}{{ microgonToMoneyNm(breakdown.totalMiningResources).format('0,0.00') }}
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
import MiningSeatIcon from '../../assets/resources/mining-seat.svg?component';
import { getCurrency } from '../../stores/currency.ts';
import numeral, { createNumeralHelpers } from '../../lib/numeral.ts';
import { useMiningAssetBreakdown } from '../../stores/miningAssetBreakdown.ts';
import Header from '../../components/asset-breakdown/Header.vue';
import SubItem from '../../components/asset-breakdown/SubItem.vue';
import Expenses from '../../components/asset-breakdown/Expenses.vue';
import Total from '../../components/asset-breakdown/Total.vue';
import { TooltipProvider } from 'reka-ui';
import { MoveFrom, MoveTo, MoveToken } from '@argonprotocol/apps-core';
import { getConfig } from '../../stores/config.ts';
import { useWallets } from '../../stores/wallets.ts';
import NeedsSetup from '../../components/asset-breakdown/NeedsSetup.vue';

const props = withDefaults(
  defineProps<{
    show?: 'All' | 'AllExceptTotal' | 'OnlyTotal';
    align?: 'left' | 'right';
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
const breakdown = useMiningAssetBreakdown();
const config = getConfig();
const wallets = useWallets();

const { microgonToMoneyNm, microgonToArgonNm } = createNumeralHelpers(currency);

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

<style>
@reference "../../main.css";

.MiningAssetBreakdown {
  [data-reka-popper-content-wrapper] div {
    pointer-events: none !important;
  }
}
</style>
