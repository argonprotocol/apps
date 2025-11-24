<template>
  <div class="text-md relative mb-4 flex min-h-6/12 w-full flex-col items-center whitespace-nowrap">
    <div v-if="props.show !== 'OnlyTotal'" class="flex min-h-[calc(100%/7)] w-full flex-col py-1">
      <HoverCardRoot :openDelay="200" :closeDelay="100">
        <HoverCardTrigger
          as="div"
          class="hover:text-argon-600 hover:bg-argon-200/10 flex w-full flex-row items-center rounded pt-1">
          <ArgonIcon class="text-argon-600/70 mr-2 h-7 w-7" />
          <div class="grow">Minting Pipeline</div>
          <div class="pr-1">
            {{ currency.symbol }}{{ microgonToMoneyNm(breakdown.vaultingAvailableMicrogons).format('0,0.00') }}
          </div>
        </HoverCardTrigger>
        <HoverCardContent
          align="center"
          side="right"
          :avoidCollisions="false"
          class="z-50 w-fit rounded-md border border-gray-800/20 bg-white px-5 py-4 text-slate-900/60 shadow-2xl">
          <div v-html="breakdown.help.vaultingAvailableMicrogons" />
          <HoverCardArrow :width="27" :height="15" class="-mt-px fill-white stroke-gray-800/20 stroke-[0.5px]" />
        </HoverCardContent>
      </HoverCardRoot>
      <div class="ml-9 flex flex-col gap-y-1 text-slate-900/60">
        <HoverCardRoot :openDelay="200" :closeDelay="100">
          <HoverCardTrigger
            as="div"
            class="hover:text-argon-600 hover:bg-argon-200/10 relative rounded border-t border-dashed border-gray-600/20 pt-2">
            <ArrowTurnDownRightIcon
              class="absolute top-1/2 left-0 h-5 w-5 -translate-x-[130%] -translate-y-1/2 text-slate-600/40" />
            {{ microgonToArgonNm(breakdown.pendingMintingValue).format('0,0.[00]') }} ARGN Pending
          </HoverCardTrigger>
          <HoverCardContent
            align="start"
            :alignOffset="-20"
            side="right"
            :avoidCollisions="false"
            class="z-50 w-md rounded-md border border-gray-800/20 bg-white px-5 py-4 text-slate-900/60 shadow-2xl">
            <div v-html="breakdown.help.pendingMintingValue" />
            <HoverCardArrow :width="27" :height="15" class="-mt-px fill-white stroke-gray-800/20 stroke-[0.5px]" />
          </HoverCardContent>
        </HoverCardRoot>
        <HoverCardRoot :openDelay="200" :closeDelay="100">
          <HoverCardTrigger
            as="div"
            class="hover:text-argon-600 relative border-t border-dashed border-gray-600/20 pt-2">
            <ArrowTurnDownRightIcon
              class="absolute top-1/2 left-0 h-5 w-5 -translate-x-[130%] -translate-y-1/2 text-slate-600/40" />
            {{ microgonToArgonNm(breakdown.alreadyMintedValue).format('0,0.[00]') }} ARGN Minted
          </HoverCardTrigger>
          <HoverCardContent
            align="start"
            :alignOffset="-20"
            side="right"
            :avoidCollisions="false"
            class="z-50 w-md rounded-md border border-gray-800/20 bg-white px-5 py-4 text-slate-900/60 shadow-2xl">
            <div v-html="breakdown.help.alreadyMintedValue" />
            <HoverCardArrow :width="27" :height="15" class="-mt-px fill-white stroke-gray-800/20 stroke-[0.5px]" />
          </HoverCardContent>
        </HoverCardRoot>
      </div>
    </div>
    <div v-if="props.show !== 'OnlyTotal'" class="flex w-full flex-col border-t border-dashed border-gray-600/20 py-2">
      <HoverCardRoot :openDelay="200" :closeDelay="100">
        <HoverCardTrigger as="div" class="hover:text-argon-600 flex w-full flex-row items-center">
          <ArgonotIcon class="text-argon-600/70 mr-2 h-7 w-7" />
          <div class="grow">Bitcoin Security</div>
          <div class="pr-1">
            {{ currency.symbol }}{{ micronotToMoneyNm(breakdown.bitcoinSecurityTotal).format('0,0.00') }}
          </div>
        </HoverCardTrigger>
        <HoverCardContent
          align="start"
          :alignOffset="-20"
          side="right"
          :avoidCollisions="false"
          class="z-50 w-md rounded-md border border-gray-800/20 bg-white px-5 py-4 text-slate-900/60 shadow-2xl">
          <div v-html="breakdown.help.bitcoinSecurityTotal" />
          <HoverCardArrow :width="27" :height="15" class="-mt-px fill-white stroke-gray-800/20 stroke-[0.5px]" />
        </HoverCardContent>
      </HoverCardRoot>
      <div class="ml-9 flex flex-col gap-y-1 text-slate-900/60">
        <HoverCardRoot :openDelay="200" :closeDelay="100">
          <HoverCardTrigger
            as="div"
            class="hover:text-argon-600 relative border-t border-dashed border-gray-600/20 pt-2">
            <ArrowTurnDownRightIcon
              class="absolute top-1/2 left-0 h-5 w-5 -translate-x-[130%] -translate-y-1/2 text-slate-600/40" />
            {{ microgonToArgonNm(breakdown.waitingSecuritization).format('0,0.[00]') }} ARGN Unused
          </HoverCardTrigger>
          <HoverCardContent
            align="start"
            :alignOffset="-20"
            side="right"
            :avoidCollisions="false"
            class="z-50 w-md rounded-md border border-gray-800/20 bg-white px-5 py-4 text-slate-900/60 shadow-2xl">
            <div v-html="breakdown.help.waitingSecuritization" />
            <HoverCardArrow :width="27" :height="15" class="-mt-px fill-white stroke-gray-800/20 stroke-[0.5px]" />
          </HoverCardContent>
        </HoverCardRoot>
        <HoverCardRoot :openDelay="200" :closeDelay="100">
          <HoverCardTrigger
            as="div"
            class="hover:text-argon-600 relative border-t border-dashed border-gray-600/20 pt-2">
            <ArrowTurnDownRightIcon
              class="absolute top-1/2 left-0 h-5 w-5 -translate-x-[130%] -translate-y-1/2 text-slate-600/40" />
            {{ microgonToArgonNm(breakdown.pendingSecuritization).format('0,0.[00]') }} ARGN Processing
          </HoverCardTrigger>
          <HoverCardContent
            align="start"
            :alignOffset="-20"
            side="right"
            :avoidCollisions="false"
            class="z-50 w-md rounded-md border border-gray-800/20 bg-white px-5 py-4 text-slate-900/60 shadow-2xl">
            <div v-html="breakdown.help.pendingSecuritization" />
            <HoverCardArrow :width="27" :height="15" class="-mt-px fill-white stroke-gray-800/20 stroke-[0.5px]" />
          </HoverCardContent>
        </HoverCardRoot>
        <HoverCardRoot :openDelay="200" :closeDelay="100">
          <HoverCardTrigger
            as="div"
            class="hover:text-argon-600 relative border-t border-dashed border-gray-600/20 pt-2">
            <ArrowTurnDownRightIcon
              class="absolute top-1/2 left-0 h-5 w-5 -translate-x-[130%] -translate-y-1/2 text-slate-600/40" />
            {{ microgonToArgonNm(breakdown.activatedSecuritization).format('0,0.[00]') }} ARGN Activated
          </HoverCardTrigger>
          <HoverCardContent
            align="start"
            :alignOffset="-20"
            side="right"
            :avoidCollisions="false"
            class="z-50 w-md rounded-md border border-gray-800/20 bg-white px-5 py-4 text-slate-900/60 shadow-2xl">
            <div v-html="breakdown.help.activatedSecuritization" />
            <HoverCardArrow :width="27" :height="15" class="-mt-px fill-white stroke-gray-800/20 stroke-[0.5px]" />
          </HoverCardContent>
        </HoverCardRoot>
      </div>
    </div>
    <div v-if="props.show !== 'OnlyTotal'" class="flex w-full flex-col border-t border-dashed border-gray-600/20 py-2">
      <HoverCardRoot :openDelay="200" :closeDelay="100">
        <HoverCardTrigger as="div" class="hover:text-argon-600 flex w-full flex-row items-center">
          <ArgonotIcon class="text-argon-600/70 mr-2 h-7 w-7" />
          <div class="grow">Treasury Bonds</div>
          <div class="pr-1">
            {{ currency.symbol }}{{ micronotToMoneyNm(breakdown.treasuryBondTotal).format('0,0.00') }}
          </div>
        </HoverCardTrigger>
        <HoverCardContent
          align="start"
          :alignOffset="-20"
          side="right"
          :avoidCollisions="false"
          class="z-50 w-md rounded-md border border-gray-800/20 bg-white px-5 py-4 text-slate-900/60 shadow-2xl">
          <div v-html="breakdown.help.treasuryBondTotal" />
          <HoverCardArrow :width="27" :height="15" class="-mt-px fill-white stroke-gray-800/20 stroke-[0.5px]" />
        </HoverCardContent>
      </HoverCardRoot>
      <div class="ml-9 flex flex-col gap-y-1 text-slate-900/60">
        <HoverCardRoot :openDelay="200" :closeDelay="100">
          <HoverCardTrigger
            as="div"
            class="hover:text-argon-600 relative border-t border-dashed border-gray-600/20 pt-2">
            <ArrowTurnDownRightIcon
              class="absolute top-1/2 left-0 h-5 w-5 -translate-x-[130%] -translate-y-1/2 text-slate-600/40" />
            {{ microgonToArgonNm(breakdown.pendingTreasuryPoolInvestment).format('0,0.[00]') }} ARGN Unused
          </HoverCardTrigger>
          <HoverCardContent
            align="start"
            :alignOffset="-20"
            side="right"
            :avoidCollisions="false"
            class="z-50 w-md rounded-md border border-gray-800/20 bg-white px-5 py-4 text-slate-900/60 shadow-2xl">
            <div v-html="breakdown.help.pendingTreasuryPoolInvestment" />
            <HoverCardArrow :width="27" :height="15" class="-mt-px fill-white stroke-gray-800/20 stroke-[0.5px]" />
          </HoverCardContent>
        </HoverCardRoot>
        <HoverCardRoot :openDelay="200" :closeDelay="100">
          <HoverCardTrigger
            as="div"
            class="hover:text-argon-600 relative border-t border-dashed border-gray-600/20 pt-2">
            <ArrowTurnDownRightIcon
              class="absolute top-1/2 left-0 h-5 w-5 -translate-x-[130%] -translate-y-1/2 text-slate-600/40" />
            {{ microgonToArgonNm(breakdown.activatedTreasuryPoolInvestment).format('0,0.[00]') }} ARGN Activated
          </HoverCardTrigger>
          <HoverCardContent
            align="start"
            :alignOffset="-20"
            side="right"
            :avoidCollisions="false"
            class="z-50 w-md rounded-md border border-gray-800/20 bg-white px-5 py-4 text-slate-900/60 shadow-2xl">
            <div v-html="breakdown.help.activatedTreasuryPoolInvestment" />
            <HoverCardArrow :width="27" :height="15" class="-mt-px fill-white stroke-gray-800/20 stroke-[0.5px]" />
          </HoverCardContent>
        </HoverCardRoot>
      </div>
    </div>
    <div
      v-if="props.show !== 'OnlyTotal' && breakdown.hasLockedBitcoin"
      class="flex w-full flex-row items-center border-t border-gray-600/50 py-2 text-red-900/70">
      <HoverCardRoot :openDelay="200" :closeDelay="100">
        <HoverCardTrigger as="div" class="hover:text-argon-600 flex w-full flex-row items-center">
          <div class="grow pl-1">
            <span class="hidden xl:inline">Cost to</span>
            Unlock Bitcoin
          </div>
          <div class="pr-1">
            -{{ currency.symbol }}{{ microgonToMoneyNm(breakdown.unlockPrice).format('0,0.[00]') }}
          </div>
        </HoverCardTrigger>
        <HoverCardContent
          align="start"
          :alignOffset="-20"
          side="right"
          :avoidCollisions="false"
          class="z-50 w-md rounded-md border border-gray-800/20 bg-white px-5 py-4 text-slate-900/60 shadow-2xl">
          <div v-html="breakdown.help.unlockPrice" />
          <HoverCardArrow :width="27" :height="15" class="-mt-px fill-white stroke-gray-800/20 stroke-[0.5px]" />
        </HoverCardContent>
      </HoverCardRoot>
    </div>
    <div
      v-if="props.show !== 'OnlyTotal'"
      :class="[breakdown.hasLockedBitcoin ? 'border-dashed border-gray-600/20' : 'border-t border-gray-600/50']"
      class="flex w-full flex-row items-center border-t py-2 text-red-900/70">
      <HoverCardRoot :openDelay="200" :closeDelay="100">
        <HoverCardTrigger as="div" class="flex w-full flex-row items-center hover:text-red-600">
          <div class="grow pl-1">
            <span class="hidden xl:inline">Operational</span>
            Expenses
          </div>
          <div class="pr-1">
            -{{ currency.symbol }}{{ microgonToMoneyNm(breakdown.operationalFeeMicrogons ?? 0n).format('0,0.00') }}
          </div>
        </HoverCardTrigger>
        <HoverCardContent
          align="start"
          :alignOffset="-20"
          side="right"
          :avoidCollisions="false"
          class="z-50 w-md rounded-md border border-gray-800/20 bg-white px-5 py-4 text-slate-900/60 shadow-2xl">
          <div v-html="breakdown.help.operationalFeeMicrogons" />
          <HoverCardArrow :width="27" :height="15" class="-mt-px fill-white stroke-gray-800/20 stroke-[0.5px]" />
        </HoverCardContent>
      </HoverCardRoot>
    </div>
    <div
      v-if="props.show === 'All' || props.show === 'OnlyTotal'"
      class="flex w-full flex-row items-center justify-between border-t border-b border-gray-600/50 py-2 font-bold">
      <HoverCardRoot :openDelay="200" :closeDelay="100">
        <HoverCardTrigger as="div" class="hover:text-argon-600 flex w-full flex-row items-center">
          <div class="grow pl-1">Total Value</div>
          <div class="pr-1">
            {{ currency.symbol }}{{ microgonToMoneyNm(breakdown.totalVaultValue).format('0,0.00') }}
          </div>
        </HoverCardTrigger>
        <HoverCardContent
          align="start"
          :alignOffset="-20"
          side="right"
          :avoidCollisions="false"
          class="z-50 w-fit rounded-md border border-gray-800/20 bg-white px-5 py-4 text-slate-900/60 shadow-2xl">
          <div v-html="breakdown.help.totalVaultValue" />
          <HoverCardArrow :width="27" :height="15" class="-mt-px fill-white stroke-gray-800/20 stroke-[0.5px]" />
        </HoverCardContent>
      </HoverCardRoot>
    </div>
  </div>
</template>
<script setup lang="ts">
import ArgonIcon from '../assets/resources/argon.svg?component';
import ArgonotIcon from '../assets/resources/argonot.svg?component';
import { ArrowTurnDownRightIcon } from '@heroicons/vue/24/outline';
import { HoverCardArrow, HoverCardContent, HoverCardRoot, HoverCardTrigger } from 'reka-ui';

import { createNumeralHelpers } from '../lib/numeral.ts';
import { useCurrency } from '../stores/currency.ts';
import { useVaultingAssetBreakdown } from '../stores/vaultingAssetBreakdown.ts';

const props = withDefaults(
  defineProps<{
    show?: 'All' | 'AllExceptTotal' | 'OnlyTotal';
  }>(),
  {
    show: 'All',
  },
);

const currency = useCurrency();

const { microgonToMoneyNm, micronotToMoneyNm, microgonToArgonNm } = createNumeralHelpers(currency);

const breakdown = useVaultingAssetBreakdown();
</script>
