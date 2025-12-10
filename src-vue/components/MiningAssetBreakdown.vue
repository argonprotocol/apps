<!-- prettier-ignore -->
<template>
  <TooltipProvider :disableHoverableContent="true">
    <div
      class="MiningAssetBreakdown"
      :class="twMerge('text-md relative flex w-full flex-col items-center whitespace-nowrap', props.class)">
      <template v-if="props.show !== 'OnlyTotal' && !config.isMinerInstalled">
        <NeedsSetup :tooltipSide="tooltipSide" :spacerWidth="spacerWidth" :align="props.align">
          Your mining account is still waiting to be setup.
          <template #value>
            <SubItem
              :tooltipSide="tooltipSide"
              :height="itemHeight"
              :showMoveButton="props.showMoveButtons"
              :spacerWidth="spacerWidth"
              :moveFrom="MoveFrom.MiningReserveArgon"
              :moveTo="MoveTo.Holding">
              {{ microgonToArgonNm(breakdown.unusedMicrogons).format('0,0.[00]') }} ARGN Available
              <template #tooltip>
                <p class="break-words whitespace-normal">
                  These argons have been activated for mining, but your bot hasn't found a competitively priced bid.
                </p>
              </template>
            </SubItem>
            <SubItem
              :tooltipSide="tooltipSide"
              :height="itemHeight"
              :showMoveButton="props.showMoveButtons"
              :spacerWidth="spacerWidth"
              :moveFrom="MoveFrom.MiningReserveArgonot"
              :moveTo="MoveTo.Holding">
              {{ microgonToArgonNm(breakdown.unusedMicronots).format('0,0.[00]') }} ARGNOT Available
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
          Bidding Reserves
          <template #tooltip>
            <p class="break-words whitespace-normal">These argons are currently sitting unused.</p>
          </template>
          <template #icon><ArgonIcon class="h-7 w-7" /></template>
          <template #value>
            {{ currency.symbol }}{{ microgonToMoneyNm(breakdown.biddingReserves).format('0,0.00') }}
          </template>
        </Header>
        <SubItem
          :tooltipSide="tooltipSide"
          :height="itemHeight"
          :showMoveButton="props.showMoveButtons"
          :spacerWidth="spacerWidth"
          :moveFrom="MoveFrom.MiningReserveArgon"
          :moveTo="MoveTo.Holding">
          {{ microgonToArgonNm(breakdown.unusedMicrogons).format('0,0.[00]') }} ARGN Available
          <template #tooltip>
            <p class="break-words whitespace-normal">
              These argons have been activated for mining, but your bot hasn't found a competitively priced bid.
            </p>
          </template>
        </SubItem>
        <SubItem
          :tooltipSide="tooltipSide"
          :height="itemHeight"
          :showMoveButton="props.showMoveButtons"
          :spacerWidth="spacerWidth"
          :moveFrom="MoveFrom.MiningReserveArgonot"
          :moveTo="MoveTo.Holding">
          {{ microgonToArgonNm(breakdown.unusedMicronots).format('0,0.[00]') }} ARGNOT Available
          <template #tooltip>
            <p class="break-words whitespace-normal">
              These argonots are available for mining, but your bot hasn't found a competitively priced bid.
            </p>
          </template>
        </SubItem>

        <Header :tooltipSide="tooltipSide" :height="itemHeight" :spacerWidth="spacerWidth" class="border-dashed">
          Winning
          <span class="hidden 2xl:inline">Mining</span>
          Bids ({{ numeral(breakdown.bidTotalCount).format('0,0') }})
          <template #icon><MiningBidIcon class="h-7 w-7" /></template>
          <template #value>
            {{ currency.symbol }}{{ microgonToMoneyNm(breakdown.bidTotalCost).format('0,0.00') }}
          </template>
          <template #tooltip>
            <p class="break-words whitespace-normal">
              You have a total of {{ numeral(breakdown.bidTotalCount).format('0,0') }} winning bids in today's mining
              auction. They include both argons and argonots at a total value of {{ currency.symbol}}{{ microgonToMoneyNm(wallets.miningBidValue).format('0,0.00') }}.
            </p>
            <table class="my-3 w-full text-slate-800/50">
              <thead>
                <tr>
                  <th class="h-10 w-1/4">Token</th>
                  <th class="w-1/4 text-right">Per Seat</th>
                  <th class="w-1/4 text-right">Total</th>
                  <th class="h-10 w-1/4 text-right">Value</th>
                </tr>
              </thead>
              <tbody>
                <tr>
                  <td class="h-10 border-t border-gray-600/20 pr-5">Argons</td>
                  <td class="border-t border-gray-600/20 text-right">
                    {{
                      microgonToMoneyNm(breakdown.bidTotalCount > 0 ? breakdown.bidMicrogons / BigInt(breakdown.bidTotalCount) : 0n,).format('0,0.00')
                    }}
                  </td>
                  <td class="border-t border-gray-600/20 text-right">
                    {{ microgonToMoneyNm(breakdown.bidMicrogons).format('0,0.00') }}
                  </td>
                  <td class="border-t border-gray-600/20 text-right">
                    {{ currency.symbol }}{{ microgonToMoneyNm(breakdown.bidMicrogons).format('0,0.00') }}
                  </td>
                </tr>
                <tr>
                  <td class="h-10 border-y border-gray-600/20 pr-5">Argonots</td>
                  <td class="border-y border-gray-600/20 text-right">
                    {{
                      microgonToMoneyNm(
                        breakdown.bidTotalCount > 0 ? breakdown.bidMicronots / BigInt(breakdown.bidTotalCount) : 0n,
                      ).format('0,0.00')
                    }}
                  </td>
                  <td class="border-y border-gray-600/20 text-right">
                    {{ microgonToMoneyNm(breakdown.bidMicronots).format('0,0.00') }}
                  </td>
                  <td class="border-y border-gray-600/20 text-right">
                    {{ currency.symbol }}{{ microgonToMoneyNm(currency.micronotToMicrogon(breakdown.bidMicronots)).format('0,0.00') }}
                  </td>
                </tr>
              </tbody>
            </table>

            <p class="break-words whitespace-normal">
              If any bids lose, all associated tokens will automatically revert back to your mining wallet.
            </p>
          </template>
        </Header>
        <SubItem :tooltipSide="tooltipSide" :height="itemHeight" :spacerWidth="spacerWidth">
          {{ microgonToArgonNm(breakdown.bidMicrogons).format('0,0.[00]') }} ARGN Locked
          <template #tooltip>
            <p class="break-words whitespace-normal">
              These argons have been activated for mining, but your bot hasn't found a competitively priced bid.
            </p>
          </template>
        </SubItem>
        <SubItem :tooltipSide="tooltipSide" :height="itemHeight" :spacerWidth="spacerWidth">
          {{ microgonToArgonNm(breakdown.bidMicronots).format('0,0.[00]') }} ARGNOT Locked
          <template #tooltip>
            <p class="break-words whitespace-normal">
              These argonots are available for mining, but your bot hasn't found a competitively priced bid.
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
              them using a combination of argons and argonots. They have an currently estimated value of
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
          {{ microgonToArgonNm(breakdown.expectedSeatMicrogons).format('0,0.[00]') }} ARGN Expected
          <template #tooltip>
            <p class="break-words whitespace-normal">
              These argons are expected to be earned during the remainder of your active mining seats.
            </p>
          </template>
        </SubItem>
        <SubItem :height="itemHeight" :spacerWidth="spacerWidth" :tooltipSide="tooltipSide">
          {{ microgonToArgonNm(breakdown.expectedSeatMicronots).format('0,0.[00]') }} ARGNOT Expected
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
import ArgonIcon from '../assets/resources/argon.svg?component';
import MiningBidIcon from '../assets/resources/mining-bid.svg?component';
import MiningSeatIcon from '../assets/resources/mining-seat.svg?component';
import { useCurrency } from '../stores/currency.ts';
import numeral, { createNumeralHelpers } from '../lib/numeral';
import { useMiningAssetBreakdown } from '../stores/miningAssetBreakdown.ts';
import Header from './asset-breakdown/Header.vue';
import SubItem from './asset-breakdown/SubItem.vue';
import Expenses from './asset-breakdown/Expenses.vue';
import Total from './asset-breakdown/Total.vue';
import { TooltipProvider } from 'reka-ui';
import { MoveFrom, MoveTo } from '@argonprotocol/apps-core';
import { useConfig } from '../stores/config.ts';
import { useWallets } from '../stores/wallets.ts';
import NeedsSetup from './asset-breakdown/NeedsSetup.vue';

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
const breakdown = useMiningAssetBreakdown();
const config = useConfig();
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
@reference "../main.css";

.MiningAssetBreakdown {
  [data-reka-popper-content-wrapper] div {
    pointer-events: none !important;
  }
}
</style>
