<!-- prettier-ignore -->
<template>
  <TooltipProvider :disableHoverableContent="true" data-testid="Dashboard" class="flex flex-col h-full">
    <div class="flex flex-col h-full px-2.5 py-2.5 gap-y-2 justify-stretch grow">
      <section box class="flex flex-row items-center text-slate-900/90 !py-3">
        <div class="flex flex-row items-center w-full min-h-[6%]">
          <div v-if="myVault.data.pendingCollectTxInfo" class="px-6 flex flex-row items-center w-full h-full">
            <div class="flex flex-row items-center text-lg relative text-slate-800/90" v-if="pendingCollectTxMetadata?.expectedCollectRevenue">
              <MoneyIcon class="h-10 w-10 inline-block mr-4 relative top-1 text-argon-800/60" />
              <strong>{{ currency.symbol }}{{ microgonToMoneyNm(pendingCollectTxMetadata?.expectedCollectRevenue).formatIfElse('< 1_000', '0,0.00', '0,0') }} is being collected</strong>&nbsp;
            </div>
            <div v-else class="flex flex-row items-center text-lg relative text-slate-800/90">
              <SigningIcon class="h-10 w-10 inline-block mr-4 relative text-argon-800/60" />
              <strong>{{ pendingCollectTxMetadata?.cosignedUtxoIds.length ?? 0 }} co-signatures are processing.</strong>&nbsp;
            </div>
            <div class="grow flex flex-row items-center pl-2 pr-3">
              <div class="h-4 w-full bg-linear-to-r from-transparent to-argon-700/10"></div>
              <div class="flex items-center justify-center">
                <svg viewBox="7 5 5 10" fill="currentColor" class="text-argon-700/10 h-7" xmlns="http://www.w3.org/2000/svg">
                  <path d="M7 5l5 5-5 5" fill="currentColor" />
                </svg>
              </div>
            </div>
            <button @click="showCollectOverlay = true" class="bg-white border border-argon-600/20 hover:bg-argon-600/10 inner-button-shadow cursor-pointer rounded-md px-8 py-2 font-bold text-argon-600 focus:outline-none">
              View Progress
            </button>
          </div>
          <div v-else-if="myVault.data.pendingCollectRevenue" class="px-6 flex flex-row items-center w-full h-full">
            <div class="flex flex-row items-center text-lg relative text-slate-800/90">
              <MoneyIcon class="h-10 w-10 inline-block mr-4 relative top-1 text-argon-800/60" />
              <strong>{{ currency.symbol }}{{ microgonToMoneyNm(myVault.data.pendingCollectRevenue).formatIfElse('< 1_000', '0,0.00', '0,0') }} is waiting to be collected</strong>&nbsp;
              <CountdownClock :time="nextCollectDueDate" v-slot="{ hours, minutes, days, seconds }">
                <template v-if="hours || minutes || days || seconds > 0">
                  ({{ currency.symbol }}{{ microgonToMoneyNm(myVault.data.expiringCollectAmount).formatIfElse('< 1_000', '0,0.00', '0,0')}} expires in&nbsp;
                  <span v-if="days > 0">{{ days }} day{{ days === 1 ? '' : 's' }} </span>
                  <span v-else-if="hours || minutes > 1">
                    <span class="mr-2" v-if="hours">{{ hours }} hour{{ hours === 1 ? '' : 's' }} </span>
                    <span v-if="minutes">{{ minutes }} minute{{ minutes === 1 ? '' : 's' }}</span>
                  </span>
                  <span v-else-if="seconds">{{ seconds }} second{{ seconds === 1 ? '' : 's' }}</span>)
                </template>
              </CountdownClock>
            </div>
            <div class="grow flex flex-row items-center pl-2 pr-3">
              <div class="h-4 w-full bg-linear-to-r from-transparent to-argon-700/10"></div>
              <div class="flex items-center justify-center">
                <svg viewBox="7 5 5 10" fill="currentColor" class="text-argon-700/10 h-7" xmlns="http://www.w3.org/2000/svg">
                  <path d="M7 5l5 5-5 5" fill="currentColor" />
                </svg>
              </div>
            </div>
            <button @click="showCollectOverlay = true" class="bg-white border border-argon-600/20 hover:bg-argon-600/10 inner-button-shadow cursor-pointer rounded-md px-8 py-2 font-bold text-argon-600 focus:outline-none">
              Collect Revenue
            </button>
          </div>
          <div v-else-if="myVault.data.pendingCosignUtxoIds.size" class="px-6 flex flex-row items-center w-full h-full">
            <div class="flex flex-row items-center text-lg relative text-slate-800/90">
              <SigningIcon class="h-10 w-10 inline-block mr-4 relative text-argon-800/60" />
              <strong>{{myVault.data.pendingCosignUtxoIds.size || 2}} bitcoin transaction{{myVault.data.pendingCosignUtxoIds.size === 1 ? '' : 's'}} require signing at a penalty of {{ currency.symbol }}{{ microgonToMoneyNm(myVault.data.pendingCollectRevenue).formatIfElse('< 1_000', '0,0.00', '0,0') }}</strong>&nbsp;(expires in&nbsp;
              <CountdownClock :time="nextCollectDueDate" v-slot="{ hours, minutes, days }">
                <span v-if="days > 0">{{ days }} day{{ days === 1 ? '' : 's' }} </span>
                <template v-else>
                  <span class="mr-2" v-if="hours">{{ hours }} hour{{ hours === 1 ? '' : 's' }} </span>
                  <span v-if="minutes">{{ minutes }} minute{{ minutes === 1 ? '' : 's' }}</span>
                </template>
              </CountdownClock>)
            </div>
            <div class="grow flex flex-row items-center pl-2 pr-3">
              <div class="h-4 w-full bg-gradient-to-r from-transparent to-argon-700/10"></div>
              <div class="flex items-center justify-center">
                <svg viewBox="7 5 5 10" fill="currentColor" class="text-argon-700/10 h-7" xmlns="http://www.w3.org/2000/svg">
                  <path d="M7 5l5 5-5 5" fill="currentColor" />
                </svg>
              </div>
            </div>
            <button @click="showCollectOverlay = true" class="bg-white border border-argon-600/20 hover:bg-argon-600/10 inner-button-shadow cursor-pointer rounded-md px-8 py-2 font-bold text-argon-600 focus:outline-none">
              Sign Bitcoin Transactions
            </button>
          </div>
          <div v-else-if="!bitcoinLockedValue" class="flex flex-row px-3 items-center w-full h-full">
            <SuccessIcon class="w-10 h-10 text-argon-600 mr-4 relative opacity-80" />
            <div class="opacity-60 relative top-px">Your vault is operational, but it's not earning revenue. You must finish locking your bitcoin!</div>
          </div>
          <div v-else class="flex flex-row px-3 items-center w-full h-full">
            <SuccessIcon class="w-10 h-10 text-argon-600 mr-4 relative opacity-80" />
            <div class="opacity-60 relative top-px">Your vault is operational and in good order!</div>
          </div>
        </div>
      </section>

      <section class="flex flex-row gap-x-2 h-[14%]">
        <TooltipRoot>
          <TooltipTrigger as="div" box stat-box class="flex flex-col w-2/12 !py-4 group">
            <span>
              {{ currency.symbol }}{{ microgonToMoneyNm(bitcoinLockedValue).formatIfElse('< 1_000', '0,0.00', '0,0') }}
            </span>
            <label>Total Bitcoin Locked</label>
          </TooltipTrigger>
          <TooltipContent side="bottom" :sideOffset="-10" align="start" :collisionPadding="9" class="text-md bg-white border border-gray-800/20 rounded-md shadow-2xl z-50 py-4 px-5 w-xs text-slate-900/60">
            The total value of bitcoins that are currently locked in your vault.
            <TooltipArrow :width="27" :height="15" class="fill-white stroke-[0.5px] stroke-gray-800/20 -mt-px" />
          </TooltipContent>
        </TooltipRoot>
        <TooltipRoot>
          <TooltipTrigger box stat-box class="flex flex-col w-2/12 !py-4 group">
            <span class="flex flex-row items-center justify-center space-x-3">
              <span>{{ numeral(rules.securitizationRatio).format('0.[00]') }}</span>
              <span class="!font-light">to</span>
              <span>1</span>
            </span>
            <label>Securitization Ratio</label>
          </TooltipTrigger>
          <TooltipContent side="bottom" :sideOffset="-10" align="start" :collisionPadding="9" class="text-md bg-white border border-gray-800/20 rounded-md shadow-2xl z-50 py-4 px-5 w-sm text-slate-900/60">
            The ratio of argon-to-bitcoin that you have committed as securitization collateral.
            <TooltipArrow :width="27" :height="15" class="fill-white stroke-[0.5px] stroke-gray-800/20 -mt-px" />
          </TooltipContent>
        </TooltipRoot>
        <TooltipRoot>
          <TooltipTrigger box stat-box class="flex flex-col w-2/12 !py-4 group">
            <span>{{ currency.symbol}}{{ microgonToMoneyNm(externalTreasuryBonds).format('0,0.00') }}</span>
            <label>External Treasury Bonds</label>
          </TooltipTrigger>
          <TooltipContent side="bottom" :sideOffset="-10" align="center" :collisionPadding="9" class="text-center text-md bg-white border border-gray-800/20 rounded-md shadow-2xl z-50 py-4 px-5 w-sm text-slate-900/60">
            The amount of external capital invested into your vault's treasury bonds.
            <TooltipArrow :width="27" :height="15" class="fill-white stroke-[0.5px] stroke-gray-800/20 -mt-px" />
          </TooltipContent>
        </TooltipRoot>
        <TooltipRoot>
          <TooltipTrigger box stat-box class="flex flex-col w-2/12 !py-4 group">
            <span>
              {{ currency.symbol}}{{ microgonToMoneyNm(totalTreasuryPoolBonds).formatIfElse('< 1_000', '0,0.00', '0,0') }}
            </span>
            <label>Total Treasury Bonds</label>
          </TooltipTrigger>
          <TooltipContent side="bottom" :sideOffset="-10" align="center" :collisionPadding="9" class="text-center text-md bg-white border border-gray-800/20 rounded-md shadow-2xl z-50 py-4 px-5 w-sm text-slate-900/60">
            Your vault's total capital, both internal and external, that is invested in treasury bonds.
            <TooltipArrow :width="27" :height="15" class="fill-white stroke-[0.5px] stroke-gray-800/20 -mt-px" />
          </TooltipContent>
        </TooltipRoot>
        <TooltipRoot>
          <TooltipTrigger box stat-box class="flex flex-col w-2/12 !py-4 group">
            <span>{{ currency.symbol }}{{ microgonToMoneyNm(revenueMicrogons).formatIfElse('< 1_000', '0,0.00', '0,0') }}</span>
            <label>Total Earnings</label>
          </TooltipTrigger>
          <TooltipContent side="bottom" :sideOffset="-10" align="end" :collisionPadding="9" class="text-right text-md bg-white border border-gray-800/20 rounded-md shadow-2xl z-50 py-4 px-5 w-sm text-slate-900/60">
            Your vault's earnings to-date. This includes bitcoin locking fees and treasury bonds.
            <TooltipArrow :width="27" :height="15" class="fill-white stroke-[0.5px] stroke-gray-800/20 -mt-px" />
          </TooltipContent>
        </TooltipRoot>
        <TooltipRoot>
          <TooltipTrigger box stat-box class="flex flex-col w-2/12 !py-4 group">
            <span>{{ numeral(currentApy).formatIfElseCapped('< 100', '0,0.[00]', '0,0', 9_999) }}%</span>
            <label>Estimated APY</label>
          </TooltipTrigger>
          <TooltipContent side="bottom" :sideOffset="-10" align="end" :collisionPadding="9" class="text-right text-md bg-white border border-gray-800/20 rounded-md shadow-2xl z-50 py-4 px-5 w-sm text-slate-900/60">
            Your vault's rolling annual percentage yield based on total capital committed.
            <TooltipArrow :width="27" :height="15" class="fill-white stroke-[0.5px] stroke-gray-800/20 -mt-px" />
          </TooltipContent>
        </TooltipRoot>
      </section>

      <section class="flex flex-row gap-x-2.5 grow">
        <div box class="flex flex-col w-[22.5%] px-2">
          <header class="border-b border-slate-400/30 py-2 text-[18px] font-bold text-slate-900/80">
            Asset Breakdown
          </header>
          <VaultingAssetBreakdown />
          <div class="grow flex flex-col items-center justify-end">
            <div @click="openVaultEditOverlay" class="relative text-center mb-5 text-argon-600 opacity-70 hover:opacity-100 cursor-pointer">
              <VaultIcon class="w-20 h-20 mt-5 inline-block mb-3" />
              <div>Configure Vault Settings</div>
            </div>
          </div>
        </div>

        <div class="flex flex-col grow gap-y-2">
          <PersonalBitcoin ref="personalBitcoin" />

          <section box class="flex flex-col grow text-center px-2">
            <header class="flex flex-row justify-between text-xl font-bold py-2 text-slate-900/80 border-b border-slate-400/30 select-none">
              <div @click="goToPrevFrame" :class="hasPrevFrame ? 'opacity-60' : 'opacity-20 pointer-events-none'" class="flex flex-row items-center font-light text-base cursor-pointer group hover:opacity-80">
                <ChevronLeftIcon class="w-6 h-6 opacity-50 mx-1 group-hover:opacity-80" />
                PREV
              </div>
              <span class="flex flex-row items-center" :title="'Frame #' + currentFrame?.id">
                <span :title="`Frame #${currentFrame?.id}`" >{{ currentFrameStartDate }} to {{ currentFrameEndDate }}</span>
                <span v-if="currentFrame?.id === latestFrameId" class="inline-block rounded-full bg-green-500/80 w-2.5 h-2.5 ml-2"></span>
              </span>
              <div @click="goToNextFrame" :class="hasNextFrame ? 'opacity-60' : 'opacity-20 pointer-events-none'" class="flex flex-row items-center font-light text-base cursor-pointer group hover:opacity-80">
                NEXT
                <ChevronRightIcon class="w-6 h-6 opacity-50 mx-1 group-hover:opacity-80" />
              </div>
            </header>

            <div class="grow flex flex-col items-center justify-center">
              <div class="pt-5 border-b border-slate-400/20 pb-5 w-full text-slate-800/70">
                This frame's payout is
                <TooltipRoot>
                  <TooltipTrigger as="span" class="font-bold text-argon-600 font-mono hover:bg-argon-300/10 rounded py-1 px-1 -mx-1">
                    {{ currency.symbol }}{{ microgonToMoneyNm(currentFrame.totalTreasuryPayout).format('0,0.00') }}
                  </TooltipTrigger>
                  <TooltipContent side="bottom" :sideOffset="0" align="center" :collisionPadding="9" class="text-center text-md bg-white border border-gray-800/20 rounded-md shadow-2xl z-50 py-4 px-5 w-fit text-slate-900/60">
                    Total network revenue from mining bids.
                    <TooltipArrow :width="27" :height="15" class="fill-white stroke-[0.5px] stroke-gray-800/20 -mt-px" />
                  </TooltipContent>
                </TooltipRoot>
                <template v-if="currentFrame.id === latestFrameId"> (and growing)</template>. You get
                <TooltipRoot>
                  <TooltipTrigger as="span" class="font-bold text-argon-600 font-mono hover:bg-argon-300/10 rounded py-1 px-1 -mx-1">{{ numeral(currentFrame.myTreasuryPercentTake).format('0,[0.0]') }}%</TooltipTrigger>,
                  <TooltipContent side="bottom" :sideOffset="0" align="center" :collisionPadding="9" class="text-center text-md bg-white border border-gray-800/20 rounded-md shadow-2xl z-50 py-4 px-5 w-sm text-slate-900/60">
                    The more capital you invest in treasury bonds, the higher your take-home percentage.
                    <TooltipArrow :width="27" :height="15" class="fill-white stroke-[0.5px] stroke-gray-800/20 -mt-px" />
                  </TooltipContent>
                </TooltipRoot>
                which equals
                <TooltipRoot>
                  <TooltipTrigger as="span" class="font-bold text-argon-600 font-mono hover:bg-argon-300/10 rounded py-1 px-1 -mx-1">{{ currency.symbol }}{{ microgonToMoneyNm(currentFrame.myTreasuryPayout).format('0,0.00') }}</TooltipTrigger>
                  <TooltipContent side="bottom" :sideOffset="0" align="center" :collisionPadding="9" class="text-center text-md bg-white border border-gray-800/20 rounded-md shadow-2xl z-50 py-4 px-5 w-fit text-slate-900/60">
                    This is what your vault has earned so far today.
                    <TooltipArrow :width="27" :height="15" class="fill-white stroke-[0.5px] stroke-gray-800/20 -mt-px" />
                  </TooltipContent>
                </TooltipRoot>
                <span class="hidden lg:inline"> in earnings</span>.
              </div>

              <div class="flex flex-row w-full grow gap-x-2 mt-2">
                <TooltipRoot>
                  <TooltipTrigger as="div" stat-box no-padding class="flex flex-col w-1/3 h-full">
                    <div class="relative size-28">
                      <svg class="size-full -rotate-90" viewBox="0 0 36 36" xmlns="http://www.w3.org/2000/svg">
                        <circle cx="18" cy="18" r="16" fill="none" class="stroke-current text-gray-200 dark:text-neutral-700" stroke-width="3"></circle>
                        <circle cx="18" cy="18" r="16" fill="none" class="stroke-current text-argon-600 dark:text-argon-500" stroke-width="3" stroke-dasharray="100" :stroke-dashoffset="100-currentFrame.progress" stroke-linecap="butt"></circle>
                      </svg>

                      <div class="absolute top-1/2 start-1/2 transform -translate-y-1/2 -translate-x-1/2">
                        <span class="text-center !text-[30px] font-bold text-argon-600 dark:text-argon-500">{{ Math.round(currentFrame.progress) }}%</span>
                      </div>
                    </div>
                  </TooltipTrigger>
                  <TooltipContent side="bottom" :sideOffset="-10" align="center" :collisionPadding="9" class="text-left text-md bg-white border border-gray-800/20 rounded-md shadow-2xl z-50 py-4 px-5 w-xs text-slate-900/60">
                    This progress of the current frame, which is equivalent to approximately 24 hours.
                    <TooltipArrow :width="27" :height="15" class="fill-white stroke-[0.5px] stroke-gray-800/20 -mt-px" />
                  </TooltipContent>
                </TooltipRoot>

                <div class="h-full w-[1px] bg-slate-400/30"></div>

                <TooltipRoot>
                  <TooltipTrigger as="div" stat-box no-padding class="flex flex-col w-1/3 h-full pb-3">
                    <span data-testid="TotalBlocksMined">{{ currency.symbol }}{{ microgonToMoneyNm(currentFrame.bitcoinChangeMicrogons).format('0,0.00') }}</span>
                    <label class="relative block w-full">
                      Bitcoin Lock Change
                      <HealthIndicatorBar :percent="currentFrame.bitcoinPercentUsed" />
                    </label>
                  </TooltipTrigger>
                  <TooltipContent side="bottom" :sideOffset="-10" align="center" :collisionPadding="9" class="text-center text-md bg-white border border-gray-800/20 rounded-md shadow-2xl z-50 py-4 px-5 w-xs text-slate-900/60">
                    The change (+/-) in bitcoin value held by your vault during this frame.
                    <TooltipArrow :width="27" :height="15" class="fill-white stroke-[0.5px] stroke-gray-800/20 -mt-px" />
                  </TooltipContent>
                </TooltipRoot>

                <div class="h-full w-[1px] bg-slate-400/30"></div>

                <TooltipRoot>
                  <TooltipTrigger as="div" stat-box no-padding class="flex flex-col w-1/3 h-full pb-3">
                    <span data-testid="TotalBlocksMined">{{ currency.symbol }}{{ microgonToMoneyNm(currentFrame.treasuryChangeMicrogons).format('0,0.00') }}</span>
                    <label class="relative block w-full">
                      Treasury Bond Change
                      <HealthIndicatorBar :percent="currentFrame.treasuryPercentActivated" />
                    </label>
                  </TooltipTrigger>
                  <TooltipContent side="bottom" :sideOffset="-10" align="center" :collisionPadding="9" class="text-center text-md bg-white border border-gray-800/20 rounded-md shadow-2xl z-50 py-4 px-5 w-xs text-slate-900/60">
                    The change (+/-) in treasury bonds held by your vault during this frame.
                    <TooltipArrow :width="27" :height="15" class="fill-white stroke-[0.5px] stroke-gray-800/20 -mt-px" />
                  </TooltipContent>
                </TooltipRoot>

                <div class="h-full w-[1px] bg-slate-400/30"></div>

                <TooltipRoot>
                  <TooltipTrigger as="div" stat-box no-padding class="flex flex-col w-1/3 h-full pb-3">
                    <span data-testid="TotalBlocksMined">{{ numeral(currentFrame.frameProfitPercent).format('0,0') }}%</span>
                    <label class="relative block w-full">
                      Current Frame Profit
                      <HealthIndicatorBar :percent="currentFrame.profitMaximizationPercent" />
                    </label>
                  </TooltipTrigger>
                  <TooltipContent side="bottom" :sideOffset="-10" align="center" :collisionPadding="9" class="text-right text-md bg-white border border-gray-800/20 rounded-md shadow-2xl z-50 py-4 px-5 w-xs text-slate-900/60">
                    The profit percentage earned by your vault during this frame.
                    <TooltipArrow :width="27" :height="15" class="fill-white stroke-[0.5px] stroke-gray-800/20 -mt-px" />
                  </TooltipContent>
                </TooltipRoot>

              </div>
            </div>
          </section>

          <section box class="relative flex flex-col h-[39.1%] !pb-0.5 px-2">
            <FrameSlider ref="frameSliderRef" :chartItems="chartItems" @changedFrame="updateSliderFrame" />
          </section>
        </div>
      </section>
    </div>
  </TooltipProvider>

  <!-- Overlays -->
  <VaultCollectOverlay
    v-if="showCollectOverlay"
    @close="showCollectOverlay = false"
  />

  <VaultEditOverlay
    v-if="showEditOverlay"
    @close="showEditOverlay = false"
  />

</template>

<script lang="ts">
export interface IVaultFrameRecord {
  id: number;
  date: string;
  firstTick: number;
  progress: number;
  totalTreasuryPayout: bigint;
  myTreasuryPayout: bigint;
  myTreasuryPercentTake: number;
  bitcoinChangeMicrogons: bigint;
  treasuryChangeMicrogons: bigint;
  frameProfitPercent: number;
  bitcoinPercentUsed: number;
  treasuryPercentActivated: number;
  profitMaximizationPercent: number;
}

const currentFrame = Vue.ref({
  id: 0,
  date: '',
  firstTick: 0,
  progress: 0,
  bitcoinChangeMicrogons: 0n,
  treasuryChangeMicrogons: 0n,
  totalTreasuryPayout: 0n,
  myTreasuryPercentTake: 0,
  myTreasuryPayout: 0n,
  frameProfitPercent: 0,
  bitcoinPercentUsed: 0,
  treasuryPercentActivated: 0,
  profitMaximizationPercent: 0,
} as IVaultFrameRecord);

const sliderFrameIndex = Vue.ref(0);
</script>

<script setup lang="ts">
import * as Vue from 'vue';
import dayjs from 'dayjs';
import relativeTime from 'dayjs/plugin/relativeTime';
import utc from 'dayjs/plugin/utc';
import { useCurrency } from '../../stores/currency';
import numeral, { createNumeralHelpers } from '../../lib/numeral';
import { useMyVault, useVaults } from '../../stores/vaults.ts';
import { useConfig } from '../../stores/config.ts';
import CountdownClock from '../../components/CountdownClock.vue';
import { ChevronLeftIcon, ChevronRightIcon } from '@heroicons/vue/24/outline';
import { TICK_MILLIS } from '../../lib/Env.ts';
import VaultCollectOverlay from '../../overlays/VaultCollectOverlay.vue';
import VaultEditOverlay from '../../overlays/VaultEditOverlay.vue';
import SigningIcon from '../../assets/signing.svg?component';
import MoneyIcon from '../../assets/money.svg?component';
import FrameSlider, { IChartItem } from '../../components/FrameSlider.vue';
import SuccessIcon from '../../assets/success.svg?component';
import VaultIcon from '../../assets/vault.svg?component';
import HealthIndicatorBar from '../../components/HealthIndicatorBar.vue';
import { MiningFrames, NetworkConfig, TreasuryPool } from '@argonprotocol/apps-core';
import { TooltipProvider, TooltipRoot, TooltipTrigger, TooltipContent, TooltipArrow } from 'reka-ui';
import { IVaultFrameStats } from '../../interfaces/IVaultStats.ts';
import { getMainchainClient, getMiningFrames } from '../../stores/mainchain.ts';
import { calculateAPY, getPercent, percentOf } from '../../lib/Utils.ts';
import PersonalBitcoin from './components/PersonalBitcoin.vue';
import { useBitcoinLocks } from '../../stores/bitcoin.ts';
import VaultingAssetBreakdown from '../../components/VaultingAssetBreakdown.vue';

dayjs.extend(relativeTime);
dayjs.extend(utc);

const myVault = useMyVault();
const vaults = useVaults();
const bitcoinLocks = useBitcoinLocks();
const config = useConfig();
const currency = useCurrency();

const rules = config.vaultingRules;

const latestFrameId = Vue.computed(() => {
  return frameRecords.value.at(-1)?.id ?? 0;
});
const frameSliderRef = Vue.ref<InstanceType<typeof FrameSlider> | null>(null);
const frameRecords = Vue.ref<IVaultFrameRecord[]>([]);
const chartItems = Vue.ref<IChartItem[]>([]);
const personalBitcoin = Vue.ref<InstanceType<typeof PersonalBitcoin> | null>(null);

const { microgonToMoneyNm } = createNumeralHelpers(currency);

// For the Vault UI countdown clock
const nextCollectDueDate = Vue.computed(() => {
  return dayjs.utc(myVault.data.nextCollectDueDate);
});

const pendingCollectTxMetadata = Vue.computed(() => {
  return myVault.data.pendingCollectTxInfo?.tx.metadataJson;
});

const totalTreasuryPoolBonds = Vue.computed(() => {
  return internalTreasuryPoolBonds.value + externalTreasuryBonds.value;
});

const internalTreasuryPoolBonds = Vue.computed(() => {
  const revenue = myVault.data.stats;
  if (!revenue) return 0n;
  return revenue.changesByFrame
    .slice(0, 10)
    .filter(x => x.frameId >= myVault.data.currentFrameId - 10)
    .reduce((acc, change) => acc + (change.treasuryPool.vaultCapital ?? 0n), 0n);
});

const externalTreasuryBonds = Vue.computed(() => {
  const revenue = myVault.data.stats;
  if (!revenue) return 0n;
  return revenue.changesByFrame
    .slice(0, 10)
    .filter(x => x.frameId >= myVault.data.currentFrameId - 10)
    .reduce((acc, change) => acc + (change.treasuryPool.externalCapital ?? 0n), 0n);
});

const bitcoinLockedValue = Vue.computed<bigint>(() => {
  if (!myVault.createdVault) return 0n;
  return myVault.createdVault.activatedSecuritization() - myVault.createdVault.getRelockCapacity();
});

const currentApy = Vue.computed(() => {
  const { earnings, activeFrames, averageCapitalDeployed } = myVault.revenue();
  if (earnings === 0n) return 0;
  return calculateAPY(averageCapitalDeployed, averageCapitalDeployed + earnings, activeFrames);
});

const revenueMicrogons = Vue.computed(() => {
  const { earnings } = myVault.revenue();
  return earnings;
});

const showCollectOverlay = Vue.ref(false);
const showEditOverlay = Vue.ref(false);

const hasNextFrame = Vue.computed(() => {
  return sliderFrameIndex.value < frameRecords.value.length - 1;
});

const hasPrevFrame = Vue.computed(() => {
  return sliderFrameIndex.value > 0;
});

const currentFrameStartDate = Vue.computed(() => {
  if (!currentFrame.value.firstTick) {
    return '-----';
  }
  const date = dayjs.utc(currentFrame.value.firstTick * TICK_MILLIS);
  return date.local().format('MMMM D, h:mm A');
});

const currentFrameEndDate = Vue.computed(() => {
  const lastTick = miningFrames.getTickEnd(currentFrame.value.id);
  if (!lastTick) {
    return '-----';
  }
  const date = dayjs.utc(lastTick * TICK_MILLIS);
  return date.local().add(1, 'minute').format('MMMM D, h:mm A');
});

function goToPrevFrame() {
  frameSliderRef.value?.goToPrevFrame();
}

function goToNextFrame() {
  frameSliderRef.value?.goToNextFrame();
}

function updateSliderFrame(newFrameIndex: number) {
  sliderFrameIndex.value = newFrameIndex;
  currentFrame.value = frameRecords.value[newFrameIndex];
}

function openVaultEditOverlay() {
  showEditOverlay.value = true;
}

const miningFrames = getMiningFrames();

function updateLatestFrameProgress() {
  if (frameRecords.value.length === 0) return;
  const latestFrame = frameRecords.value.at(-1);
  if (!latestFrame) return;
  if (currentFrame.value.id === latestFrame.id) {
    const ticksPerFrame = NetworkConfig.rewardTicksPerFrame;
    const rewardTicksRemaining = ticksPerFrame - miningFrames.getFrameRewardTicksRemaining();
    latestFrame.progress = (rewardTicksRemaining / ticksPerFrame) * 100;
    if (latestFrame.progress > 100) {
      latestFrame.progress = 100;
    }
  }
}

let frameIdLoaded: number | undefined = undefined;
async function loadChartData(currentFrameId?: number) {
  const revenue = myVault.data.stats;

  currentFrameId ??= miningFrames.currentFrameId;
  if (frameIdLoaded === currentFrameId) {
    return;
  }
  frameIdLoaded = currentFrameId;
  console.log('Load chart data to frame', currentFrameId);

  const treasuryPoolCapitalByFrame: { [frameId: string]: { capitalRaised: bigint; payout: bigint } } = {};
  const frameIds: number[] = [];
  for (let frameId = Math.max(0, currentFrameId - 365); frameId <= currentFrameId; frameId++) {
    treasuryPoolCapitalByFrame[frameId] = { capitalRaised: 0n, payout: 0n };
    frameIds.push(frameId);
  }

  for (const vaultStats of Object.values(vaults.stats?.vaultsById || {})) {
    for (const change of vaultStats.changesByFrame || []) {
      if (!treasuryPoolCapitalByFrame[change.frameId]) continue;
      treasuryPoolCapitalByFrame[change.frameId].payout += change.treasuryPool.totalEarnings;
      treasuryPoolCapitalByFrame[change.frameId].capitalRaised +=
        change.treasuryPool.externalCapital + change.treasuryPool.vaultCapital;
    }
  }
  const records: IVaultFrameRecord[] = [];
  const myVaultRevenueByFrame = (revenue?.changesByFrame ?? []).reduce(
    (acc, frame) => {
      acc[frame.frameId] = frame;
      return acc;
    },
    {} as { [frameId: number]: IVaultFrameStats },
  );

  const trailingTreasuryCapitalAmounts: [capital: bigint, frameId: number][] = [];

  let maxFrameProfitPercent = 0;
  let treasuryPercentActivated = 0;
  let bitcoinPercentUsed = 0;
  for (const frameId of frameIds) {
    const treasuryAtFrame = treasuryPoolCapitalByFrame[frameId];
    const startTick = miningFrames.getTickStart(frameId);
    const startingDate = MiningFrames.getTickDate(startTick);

    const myFrameRevenue = myVaultRevenueByFrame[frameId];
    const record = {
      id: frameId,
      date: dayjs.utc(startingDate).toISOString(),
      firstTick: startTick,
      progress: 100,
      totalTreasuryPayout: treasuryAtFrame.payout,
      myTreasuryPayout: 0n,
      myTreasuryPercentTake: 0,
      bitcoinChangeMicrogons: 0n,
      treasuryChangeMicrogons: 0n,
      frameProfitPercent: 0,
      bitcoinPercentUsed: 0,
      treasuryPercentActivated: 0,
      profitMaximizationPercent: 0,
    };
    records.push(record);
    const trailingTreasuryCapitalTotal = trailingTreasuryCapitalAmounts.slice(0, 9).reduce((acc, [capital]) => {
      return acc + capital;
    }, 0n);
    const rollingTreasuryCapital = trailingTreasuryCapitalTotal + (trailingTreasuryCapitalAmounts[9]?.[0] ?? 0n);
    if (frameId === currentFrameId && myVault.createdVault) {
      record.progress = miningFrames.getCurrentFrameProgress();
      const client = await getMainchainClient(false);
      record.totalTreasuryPayout = await TreasuryPool.getTreasuryPayoutPotential(client);
      const securitization = myVault.createdVault.securitization;
      const activatedSecuritization = myVault.createdVault.activatedSecuritization();
      const { vaultActivatedCapital, totalActivatedCapital } = await TreasuryPool.getActiveCapital(
        client,
        myVault.createdVault.vaultId ?? 0,
      );
      record.myTreasuryPercentTake = getPercent(vaultActivatedCapital, totalActivatedCapital);
      record.myTreasuryPayout = percentOf(record.totalTreasuryPayout, record.myTreasuryPercentTake);

      bitcoinPercentUsed =
        activatedSecuritization > 0n
          ? getPercent(activatedSecuritization - myVault.createdVault.getRelockCapacity(), securitization)
          : 0;
      treasuryPercentActivated = getPercent(trailingTreasuryCapitalTotal + vaultActivatedCapital, securitization);
      record.frameProfitPercent = getPercent(
        record.myTreasuryPayout + (myFrameRevenue?.bitcoinFeeRevenue ?? 0n),
        securitization + vaultActivatedCapital,
      );

      record.bitcoinChangeMicrogons = myFrameRevenue?.microgonLiquidityAdded ?? 0n;
      if (rollingTreasuryCapital !== undefined) {
        record.treasuryChangeMicrogons = trailingTreasuryCapitalTotal + vaultActivatedCapital - rollingTreasuryCapital;
      }
      // NOTE: don't add to trailing capital since this is still being updated
    } else if (myFrameRevenue) {
      const {
        securitizationRelockable,
        securitizationActivated,
        securitization,
        bitcoinFeeRevenue,
        microgonLiquidityAdded,
        treasuryPool: {
          externalCapital: poolExternalCapital,
          vaultCapital: poolVaultCapital,
          totalEarnings: poolTotalEarnings,
          vaultEarnings: poolVaultEarnings,
        },
      } = myFrameRevenue;
      const vaultActivatedCapital = poolExternalCapital + poolVaultCapital;
      bitcoinPercentUsed = getPercent(securitizationActivated - (securitizationRelockable ?? 0n), securitization);
      treasuryPercentActivated = getPercent(trailingTreasuryCapitalTotal + vaultActivatedCapital, securitization);

      record.myTreasuryPayout = poolTotalEarnings;
      record.myTreasuryPercentTake = getPercent(vaultActivatedCapital, treasuryAtFrame.capitalRaised);
      record.bitcoinChangeMicrogons = microgonLiquidityAdded;
      if (rollingTreasuryCapital !== undefined) {
        record.treasuryChangeMicrogons = trailingTreasuryCapitalTotal + vaultActivatedCapital - rollingTreasuryCapital;
      }
      record.frameProfitPercent = getPercent(
        poolVaultEarnings + bitcoinFeeRevenue,
        securitization + vaultActivatedCapital,
      );

      trailingTreasuryCapitalAmounts.unshift([vaultActivatedCapital, frameId]);
      if (trailingTreasuryCapitalAmounts.length > 10) {
        trailingTreasuryCapitalAmounts.length = 10;
      }
    }
    // Always update the percents. If there's no frame entry, it means 0 activity that frame
    record.treasuryPercentActivated = treasuryPercentActivated;
    record.bitcoinPercentUsed = bitcoinPercentUsed;
    record.profitMaximizationPercent = getPercent(bitcoinPercentUsed * treasuryPercentActivated, 100 * 100);
    maxFrameProfitPercent = Math.max(maxFrameProfitPercent, record.frameProfitPercent);
  }

  const items: IChartItem[] = [];
  for (const [index, frame] of records.entries()) {
    const item = {
      id: frame.id,
      date: frame.date,
      score: (frame.frameProfitPercent / maxFrameProfitPercent) * 100,
      isFiller: !myVaultRevenueByFrame[frame.id],
      previous: items[index - 1],
      next: undefined,
    };
    items.push(item);
  }

  for (const [index, item] of items.entries()) {
    item.next = items[index + 1];
  }

  chartItems.value = items;
  frameRecords.value = records;
}

let onFrameSubscription: { unsubscribe: () => void };
let onTickSubscription: { unsubscribe: () => void };

Vue.onMounted(async () => {
  await miningFrames.load();
  await myVault.load();
  await myVault.subscribe();
  await bitcoinLocks.load();

  Vue.watch(
    () => vaults.stats!.vaultsById,
    () => loadChartData(),
    { deep: true },
  );

  onFrameSubscription = miningFrames.onFrameId(async frameId => {
    await loadChartData(frameId);
  });

  onTickSubscription = miningFrames.onTick(() => {
    void updateLatestFrameProgress();
  });

  await loadChartData();
});

Vue.onUnmounted(() => {
  onFrameSubscription.unsubscribe();
  onTickSubscription.unsubscribe();
  myVault.unsubscribe();
});
</script>

<style scoped>
@reference "../../main.css";

[box] {
  @apply rounded border-[1px] border-slate-400/30 bg-white py-2 shadow;
}

[stat-box] {
  @apply text-argon-600 relative flex flex-col items-center justify-center;
  &:hover::before {
    @apply bg-argon-200/10 absolute top-2 right-2 bottom-2 left-2 rounded;
    content: '';
  }
  &[no-padding]:hover::before {
    @apply top-0 right-0 bottom-0 left-0;
  }
  span {
    @apply font-mono text-3xl font-bold;
  }
  label {
    @apply group-hover:text-argon-600/60 mt-1 text-sm text-gray-500;
  }
}

[spinner] {
  @apply h-6 min-h-6 w-6 min-w-6;
  &.active {
    border-radius: 50%;
    border: 10px solid;
    border-color: rgba(166, 0, 212, 0.15) rgba(166, 0, 212, 0.25) rgba(166, 0, 212, 0.35) rgba(166, 0, 212, 0.5);
    animation: rotation 1s linear infinite;
  }
}
</style>
