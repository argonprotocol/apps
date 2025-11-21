<template>
  <ul class="text-md relative mb-4 flex min-h-6/12 w-full flex-col items-center whitespace-nowrap">
    <li class="flex min-h-[calc(100%/7)] w-full flex-col py-1">
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
          <p class="break-words whitespace-normal">These argons are not currently being used.</p>
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
            <p v-if="breakdown.pendingMintingValue" class="break-words whitespace-normal">
              These have been earned, but they have not yet been minted. Minting is determined by supply and demand,
              which means, although you're guaranteed to get them, the timeframe is unknown.
            </p>
            <p v-else class="break-words whitespace-normal">
              This is where you'll see argons that are earned but not yet minted. You currently have zero argons waiting
              in the minting queue.
            </p>
            <HoverCardArrow :width="27" :height="15" class="-mt-px fill-white stroke-gray-800/20 stroke-[0.5px]" />
          </HoverCardContent>
        </HoverCardRoot>
        <HoverCardRoot :openDelay="200" :closeDelay="100">
          <HoverCardTrigger
            as="div"
            class="hover:text-argon-600 relative border-t border-dashed border-gray-600/20 pt-2">
            <ArrowTurnDownRightIcon
              class="absolute top-1/2 left-0 h-5 w-5 -translate-x-[130%] -translate-y-1/2 text-slate-600/40" />
            <template v-if="!breakdown.pendingAllocateTxMetadata">
              {{ microgonToArgonNm(breakdown.sidelinedMicrogons).format('0,0.[00]') }} ARGN Minted
            </template>
            <template v-else>
              {{
                microgonToArgonNm(
                  breakdown.pendingAllocateTxMetadata.addedSecuritizationMicrogons +
                    breakdown.pendingAllocateTxMetadata.addedTreasuryMicrogons,
                ).format('0,0.[00]')
              }}
              ARGN Minted
            </template>
          </HoverCardTrigger>
          <HoverCardContent
            align="start"
            :alignOffset="-20"
            side="right"
            :avoidCollisions="false"
            class="z-50 w-md rounded-md border border-gray-800/20 bg-white px-5 py-4 text-slate-900/60 shadow-2xl">
            <p class="break-words whitespace-normal">
              <template v-if="!breakdown.pendingAllocateTxMetadata">
                These argons are available for use. Click the Activate button to distribute them between bitcoin
                securitization and treasury bonds.
              </template>
              <template v-else>
                These argons are currently being activated. Once the activation transaction is finalized, they will be
                distributed between bitcoin securitization and treasury bonds.
              </template>
            </p>
            <HoverCardArrow :width="27" :height="15" class="-mt-px fill-white stroke-gray-800/20 stroke-[0.5px]" />
          </HoverCardContent>
        </HoverCardRoot>
      </div>
    </li>
    <li class="flex w-full flex-col border-t border-dashed border-gray-600/20 py-2">
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
          <p class="break-words whitespace-normal">
            This is the total capital applied to your vault's bitcoin securitization. It insures that anyone who locks
            bitcoin in your vault will be able to claim their bitcoin back in full.
          </p>
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
            <p class="break-words whitespace-normal">
              These argons have not yet been applied to your vault's securitization. They are waiting for new bitcoins
              to be added to your vault.
            </p>
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
            <p class="break-words whitespace-normal">
              These argons are already committed to bitcoins pending in your vault. However, these bitcoins are still in
              the process of locking. Once completed, these argons will move to "Actively In Use".
            </p>
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
            <p v-if="breakdown.activatedSecuritization" class="break-words whitespace-normal">
              These argons are currently being used to securitize your vault's bitcoin.
            </p>
            <p v-else class="break-words whitespace-normal">
              You have no argons actively being used to securitize bitcoins.
            </p>
            <HoverCardArrow :width="27" :height="15" class="-mt-px fill-white stroke-gray-800/20 stroke-[0.5px]" />
          </HoverCardContent>
        </HoverCardRoot>
      </div>
    </li>
    <li class="flex w-full flex-col border-t border-dashed border-gray-600/20 py-2">
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
          <p class="break-words whitespace-normal">
            This is the capital that has been allocated to your vault's treasury bonds.
          </p>
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
            <p class="break-words whitespace-normal">
              This capital is sitting idle because your vault does not have enough bitcoin. The amount in treasury bonds
              cannot exceed the bitcoin value in your vault.
            </p>
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
            <p v-if="breakdown.activatedTreasuryPoolInvestment" class="break-words whitespace-normal">
              These argons are actively generating yield for your vault through treasury bond investments.
            </p>
            <p v-else class="break-words whitespace-normal">
              You have no argons actively being applied to treasury bond investments.
            </p>
            <HoverCardArrow :width="27" :height="15" class="-mt-px fill-white stroke-gray-800/20 stroke-[0.5px]" />
          </HoverCardContent>
        </HoverCardRoot>
      </div>
    </li>
    <li
      class="flex w-full flex-row items-center border-t border-gray-600/50 py-2 text-red-900/70"
      v-if="breakdown.hasLockedBitcoin">
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
          <p class="break-words whitespace-normal">This is what it will cost to unlock your personal bitcoin.</p>
          <HoverCardArrow :width="27" :height="15" class="-mt-px fill-white stroke-gray-800/20 stroke-[0.5px]" />
        </HoverCardContent>
      </HoverCardRoot>
    </li>
    <li
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
          <p class="break-words whitespace-normal">
            The summation of all operational expenses that have been paid since your vault's inception.
          </p>
          <HoverCardArrow :width="27" :height="15" class="-mt-px fill-white stroke-gray-800/20 stroke-[0.5px]" />
        </HoverCardContent>
      </HoverCardRoot>
    </li>
    <li class="flex w-full flex-row items-center justify-between border-t border-b border-gray-600/50 py-2 font-bold">
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
          <p class="font-normal break-words whitespace-normal">The total value of your vault's assets.</p>
          <HoverCardArrow :width="27" :height="15" class="-mt-px fill-white stroke-gray-800/20 stroke-[0.5px]" />
        </HoverCardContent>
      </HoverCardRoot>
    </li>
  </ul>
</template>
<script setup lang="ts">
import ArgonIcon from '../assets/resources/argon.svg?component';
import ArgonotIcon from '../assets/resources/argonot.svg?component';
import { ArrowTurnDownRightIcon } from '@heroicons/vue/24/outline';
import { HoverCardArrow, HoverCardContent, HoverCardRoot, HoverCardTrigger } from 'reka-ui';

import { createNumeralHelpers } from '../lib/numeral.ts';
import { useCurrency } from '../stores/currency.ts';
import { useVaultingAssetBreakdown } from '../stores/vaultingAssetBreakdown.ts';

const currency = useCurrency();

const { microgonToMoneyNm, micronotToMoneyNm, microgonToArgonNm } = createNumeralHelpers(currency);

const breakdown = useVaultingAssetBreakdown();
</script>
