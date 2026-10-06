<!-- prettier-ignore -->
<template>
  <div data-testid="VaultingDashboard" class="flex flex-col h-full">
    <div class="flex flex-col h-full gap-y-2 justify-stretch grow">
      <TooltipProvider :disableHoverableContent="true">
        <section class="flex flex-row gap-x-2 h-[14%]">
          <TooltipRoot>
            <TooltipTrigger as="div" box stat-box class="flex flex-col w-[20%] !py-4 group">
              <span>
                {{ currency.symbol }}{{ microgonToMoneyNm(bitcoinLockedMarketValue).formatIfElse('< 1_000', '0,0.00', '0,0') }}
              </span>
              <label>Total Bitcoin Locked</label>
            </TooltipTrigger>
            <TooltipContent side="bottom" :sideOffset="-10" align="start" :collisionPadding="9" class="text-md bg-white border border-gray-800/20 rounded-md shadow-2xl z-50 py-4 px-5 w-xs text-slate-900/60">
              The total value of bitcoins that are currently locked in your vault.
              <TooltipArrow :width="27" :height="15" class="fill-white stroke-[0.5px] stroke-gray-800/20 -mt-px" />
            </TooltipContent>
          </TooltipRoot>
<!--          <TooltipRoot>-->
<!--            <TooltipTrigger box stat-box class="flex flex-col w-2/12 !py-4 group">-->
<!--              <span class="flex flex-row items-center justify-center space-x-3">-->
<!--                <span>{{ numeral(rules.securitizationRatio).format('0.[00]') }}</span>-->
<!--                <span class="!font-light">to</span>-->
<!--                <span>1</span>-->
<!--              </span>-->
<!--              <label>Securitization Ratio</label>-->
<!--            </TooltipTrigger>-->
<!--            <TooltipContent side="bottom" :sideOffset="-10" align="start" :collisionPadding="9" class="text-md bg-white border border-gray-800/20 rounded-md shadow-2xl z-50 py-4 px-5 w-sm text-slate-900/60">-->
<!--              The ratio of argon-to-bitcoin that you have committed as securitization collateral.-->
<!--              <TooltipArrow :width="27" :height="15" class="fill-white stroke-[0.5px] stroke-gray-800/20 -mt-px" />-->
<!--            </TooltipContent>-->
<!--          </TooltipRoot>-->
          <TooltipRoot>
            <TooltipTrigger box stat-box class="flex flex-col w-[20%] !py-4 group">
              <span>{{ currency.symbol}}{{ microgonToMoneyNm(externalTreasuryBondMicrogons).format('0,0') }}</span>
              <label>External Treasury Bonds</label>
            </TooltipTrigger>
            <TooltipContent side="bottom" :sideOffset="-10" align="center" :collisionPadding="9" class="text-center text-md bg-white border border-gray-800/20 rounded-md shadow-2xl z-50 py-4 px-5 w-sm text-slate-900/60">
              The amount of external capital invested into your vault's treasury bonds.
              <TooltipArrow :width="27" :height="15" class="fill-white stroke-[0.5px] stroke-gray-800/20 -mt-px" />
            </TooltipContent>
          </TooltipRoot>
          <TooltipRoot>
            <TooltipTrigger box stat-box class="flex flex-col w-[20%] !py-4 group">
              <span>
                {{ currency.symbol}}{{ microgonToMoneyNm(totalTreasuryBondMicrogons).formatIfElse('< 1_000', '0,0.00', '0,0') }}
              </span>
              <label>Total Treasury Bonds</label>
            </TooltipTrigger>
            <TooltipContent side="bottom" :sideOffset="-10" align="center" :collisionPadding="9" class="text-center text-md bg-white border border-gray-800/20 rounded-md shadow-2xl z-50 py-4 px-5 w-sm text-slate-900/60">
              Your vault's total capital, both internal and external, that is invested in treasury bonds.
              <TooltipArrow :width="27" :height="15" class="fill-white stroke-[0.5px] stroke-gray-800/20 -mt-px" />
            </TooltipContent>
          </TooltipRoot>
          <TooltipRoot>
            <TooltipTrigger box stat-box class="flex flex-col w-[20%] !py-4 group">
              <span v-if="revenueMicrogons !== undefined">{{ currency.symbol }}{{ microgonToMoneyNm(revenueMicrogons).formatIfElse('< 1_000', '0,0.00', '0,0') }}</span>
              <span v-else>--</span>
              <label>Total Earnings</label>
            </TooltipTrigger>
            <TooltipContent side="bottom" :sideOffset="-10" align="end" :collisionPadding="9" class="text-right text-md bg-white border border-gray-800/20 rounded-md shadow-2xl z-50 py-4 px-5 w-sm text-slate-900/60">
              Your vault's collected earnings, excluding income attributed to your bonds.
              <TooltipArrow :width="27" :height="15" class="fill-white stroke-[0.5px] stroke-gray-800/20 -mt-px" />
            </TooltipContent>
          </TooltipRoot>
          <TooltipRoot>
            <TooltipTrigger box stat-box class="flex flex-col w-[20%] !py-4 group">
              <span v-if="vaultingReturnToDate !== undefined">
                {{ numeral(vaultingReturnToDate).formatIfElseCapped('< 100', '0,0.[00]', '0,0', 9_999) }}%
              </span>
              <span v-else>--</span>
              <label>Vaulting RTD</label>
            </TooltipTrigger>
            <TooltipContent side="bottom" :sideOffset="-10" align="end" :collisionPadding="9" class="text-right text-md bg-white border border-gray-800/20 rounded-md shadow-2xl z-50 py-4 px-5 w-sm text-slate-900/60">
              Your return to date across the vault's capital, collected earnings, and uncollected revenue.
              <TooltipArrow :width="27" :height="15" class="fill-white stroke-[0.5px] stroke-gray-800/20 -mt-px" />
            </TooltipContent>
          </TooltipRoot>
        </section>
      </TooltipProvider>

      <section class="flex flex-row gap-x-2.5 grow">
        <div class="flex min-h-0 flex-col grow gap-y-2">
          <section box class="flex min-h-0 flex-col grow px-2 text-center">
            <header class="flex flex-row justify-between text-xl font-bold py-2 px-2 text-slate-900/80 border-b border-slate-400/30 select-none">
              <span class="flex flex-row items-center" :title="'Frame #' + currentFrame.id">
                <span>{{ currentFrameStartDate }} to {{ currentFrameEndDate }}</span>
                <span v-if="currentFrameIsActive" class="inline-block rounded-full bg-green-500/80 w-2.5 h-2.5 ml-2"></span>
              </span>
              <div class="flex flex-row items-center gap-x-3">
                <button @click="openVaultEditOverlay" class="flex flex-row items-center font-light text-base cursor-pointer group hover:opacity-80">
                  Config
                </button>
                <div class="w-px h-8/12 bg-slate-600/30" />
                <button @click="basicEmitter.emit('openFlexibleAssetsOverlay')" class="flex flex-row items-center font-light text-base cursor-pointer group hover:opacity-80">
                  Flexible Assets
                  <span v-if="(vaultBondState?.displacedFlexibleBonds ?? 0) > 0" class="ml-1 text-sm text-slate-500">
                    · {{ currency.symbol }}{{ microgonToMoneyNm(BondLot.bondsToMicrogons(vaultBondState!.displacedFlexibleBonds)).format('0,0.[0]') }} displaced
                  </span>
                </button>
                <div class="w-px h-8/12 bg-slate-600/30" />
                <button @click="controller.setTab(TopTab.Onboarding)" class="flex flex-row items-center font-light text-base cursor-pointer group hover:opacity-80">
                  Users
                </button>
              </div>
            </header>
            <div class="flex min-h-0 grow flex-col">
              <div class="flex min-h-0 w-full grow flex-row items-stretch gap-x-2 px-2 pt-4">
                <div BitcoinMap class="relative min-h-0 w-1/2">
                  <TreemapChart
                    :total="bitcoinMapTotal"
                    :items="bitcoinMapItems"
                    theme="btc"
                    remainder-label="Unused BTC Space"
                    :remainder-minimum="bitcoinMapRemainderMinimum"
                    :remainder-display-value="formatMoney(bitcoinMapRemainder)"
                    @tile-click="handleBitcoinTileClick"
                  />
                  <ArrowCalloutButton
                    v-if="[OperationalStepId.LiquidLock].includes(controller.activeGuideId!)"
                    class="absolute top-1/2 right-2 -translate-y-1/2 translate-x-full z-50"
                    guidance="Click the vaulting tab to begin."
                  />
                </div>
                <div BondMap class="min-h-0 w-1/2">
                  <TooltipProvider :delayDuration="200">
                    <TreemapChart
                      v-if="bondMapTotal"
                      :total="bondMapTotal"
                      :items="bondMapItems"
                      theme="argon"
                      remainder-label="Available Bonds"
                      :remainder-minimum="10000"
                      :remainder-display-value="formatMoney(bondMapRemainder)"
                      @tile-click="handleBondTileClick"
                    >
                      <template #label="{ item }">
                        <TooltipRoot v-if="bondLotsByMapId[item.key]?.lot.isFlexible">
                          <TooltipTrigger as="span" aria-label="Flexible bonds" class="inline-flex items-center gap-1.5">
                            <span
                              v-if="item.width >= 80"
                              class="shrink-0 rounded border border-current/40 px-1 py-0.5 text-xs leading-none font-semibold"
                            >{{ item.isCompact || item.width < 100 ? 'F' : 'FLEX' }}</span>
                            {{ item.label }}
                          </TooltipTrigger>
                          <TooltipContent side="bottom" :sideOffset="4" :collisionPadding="9" class="text-md z-50 w-xs rounded-md border border-gray-800/20 bg-white px-4 py-3 text-left leading-5.5 font-light text-slate-900/60 shadow-2xl">
                            <div class="mb-1 font-semibold">Flexible bonds</div>
                            {{ currency.symbol }}{{ microgonToMoneyNm(bondLotsByMapId[item.key].lot.bondMicrogons).format('0,0.[0]') }} held ·
                            {{ currency.symbol }}{{ microgonToMoneyNm(bondLotsByMapId[item.key].capacityMicrogons).format('0,0.[0]') }} in use ·
                            {{ currency.symbol }}{{ microgonToMoneyNm(bondLotsByMapId[item.key].lot.bondMicrogons - bondLotsByMapId[item.key].capacityMicrogons).format('0,0.[0]') }} displaced
                            <TooltipArrow :width="27" :height="15" class="-mt-px fill-white stroke-gray-800/20 stroke-[0.5px]" />
                          </TooltipContent>
                        </TooltipRoot>
                        <template v-else>{{ item.label }}</template>
                      </template>
                    </TreemapChart>
                    <div v-else class="w-full h-full border-2 border-dashed border-slate-400/50 text-slate-400/70 flex flex-col items-center justify-center">
                      No Bonds Available
                    </div>
                  </TooltipProvider>
                </div>
              </div>
              <TooltipProvider :disableHoverableContent="true">
                <div class="pt-4 pb-3">
                  <div class="mb-2 flex items-center gap-x-3 text-center">
                    <span class="h-px grow bg-slate-400/30"></span>
                  </div>
                  <div class="grid grid-cols-3 gap-x-4 gap-y-5 text-center text-base leading-none text-slate-700/80 pt-3">
                    <TooltipRoot :delayDuration="200">
                      <TooltipTrigger as="div" class="cursor-help">{{currency.symbol}}{{ microgonToMoneyNm(bitcoinLockCapacity).format('0,0.00') }} In Potential BTC Locks</TooltipTrigger>
                      <TooltipContent side="bottom" :sideOffset="4" :collisionPadding="9" class="text-md z-50 w-xs rounded-md border border-gray-800/20 bg-white px-4 py-3 text-left leading-5.5 font-light text-slate-900/60 shadow-2xl">
                        The total argon value of bitcoin that could be locked in your vault based on your securitization commitment.
                        <TooltipArrow :width="27" :height="15" class="-mt-px fill-white stroke-gray-800/20 stroke-[0.5px]" />
                      </TooltipContent>
                    </TooltipRoot>
                    <TooltipRoot :delayDuration="200">
                      <TooltipTrigger as="div" class="cursor-help">
                        {{ currency.symbol }}{{ microgonToMoneyNm(potentialDailyRevenue).formatIfElse('< 1_000', '0,0.00', '0,0') }}
                        Potential Daily Revenue
                      </TooltipTrigger>
                      <TooltipContent side="bottom" :sideOffset="4" :collisionPadding="9" class="text-md z-50 w-xs rounded-md border border-gray-800/20 bg-white px-4 py-3 text-left leading-5.5 font-light text-slate-900/60 shadow-2xl">
                        Trailing network auction revenue: {{ currency.symbol }}{{ microgonToMoneyNm(miningStats.aggregatedBidCosts).format('0,0') }}.
                        The daily estimate averages this over a {{ numeral(revenueHistoryDays).format('0,0.[0]') }}-day mining term.
                        Assumes your Bitcoin and bond capacity is filled and you have enough ARGNOT to maximize earnings.
                        <TooltipArrow :width="27" :height="15" class="-mt-px fill-white stroke-gray-800/20 stroke-[0.5px]" />
                      </TooltipContent>
                    </TooltipRoot>
                    <TooltipRoot :delayDuration="200">
                      <TooltipTrigger as="div" class="cursor-help">{{currency.symbol}}{{ microgonToMoneyNm(vaultingBreakdown.treasuryBondCapacityMicrogons).format('0,0.00') }} In Potential Bond Buys</TooltipTrigger>
                      <TooltipContent side="bottom" :sideOffset="4" :collisionPadding="9" class="text-md z-50 w-xs rounded-md border border-gray-800/20 bg-white px-4 py-3 text-left leading-5.5 font-light text-slate-900/60 shadow-2xl">
                        The total treasury bond capacity available for purchase, based on your active bitcoin locks.
                        <TooltipArrow :width="27" :height="15" class="-mt-px fill-white stroke-gray-800/20 stroke-[0.5px]" />
                      </TooltipContent>
                    </TooltipRoot>
                    <TooltipRoot :delayDuration="200">
                      <TooltipTrigger
                        as="button"
                        type="button"
                        class="flex w-full cursor-pointer flex-col items-center justify-center gap-1 hover:underline"
                        @click="openSecuritization"
                      >
                        <span
                          class="flex items-center gap-1"
                          :class="bitcoinMapSecuritizationShortfall ? 'text-yellow-800' : ''"
                        >
                          <AlertIcon
                            v-if="bitcoinMapSecuritizationShortfall > 0n"
                            class="size-4 shrink-0 text-yellow-700"
                          />
                          {{ numeral(vaultingBreakdown.securityMicrogonsActivatedPct).format('0,0.[00]') }}% of Allowed BTC Is Locked
                        </span>
                        <span v-if="bitcoinMapSecuritizationShortfall > 0n" class="text-xs text-yellow-800">
                          Under Securitized
                        </span>
                      </TooltipTrigger>
                      <TooltipContent side="bottom" :sideOffset="4" :collisionPadding="9" class="text-md z-50 w-xs rounded-md border border-gray-800/20 bg-white px-4 py-3 text-left leading-5.5 font-light text-slate-900/60 shadow-2xl">
                        <template v-if="bitcoinMapSecuritizationShortfall > 0n">
                          {{ numeral(vaultingBreakdown.securityMicrogonsActivatedPct).format('0,0.[00]') }}% is the
                          securitization currently assigned to active Bitcoin locks. Their market value exceeds your
                          current securitization by
                          {{ microgonToArgonNm(bitcoinMapSecuritizationShortfall).format('0,0.[00]') }} ARGN. Click to
                          update it.
                        </template>
                        <template v-else>
                          The percentage of your vault's bitcoin security space that is currently filled with active locks.
                        </template>
                        <TooltipArrow :width="27" :height="15" class="-mt-px fill-white stroke-gray-800/20 stroke-[0.5px]" />
                      </TooltipContent>
                    </TooltipRoot>
                    <TooltipRoot :delayDuration="200">
                      <TooltipTrigger
                        as="button"
                        type="button"
                        class="flex w-full cursor-pointer flex-col items-center justify-center gap-1 hover:underline"
                        @click="openSecuritization"
                      >
                        <span class="flex items-center gap-1" :class="hasArgonotRewardAlert ? 'text-yellow-800' : ''">
                          <AlertIcon v-if="hasArgonotRewardAlert" class="size-4 shrink-0 text-yellow-700" />
                          <template v-if="vaultingBreakdown.revenueCapturedPct !== undefined">{{ numeral(vaultingBreakdown.revenueCapturedPct).format('0,0.[00]') }}% of Potential Revenue Captured</template>
                          <template v-else>Potential Revenue Capture Unavailable</template>
                        </span>
                        <span v-if="hasArgonotRewardAlert" class="text-xs text-yellow-800">
                          <template v-if="(vaultingBreakdown.argonotRewardBacking?.additionalMicronots ?? 0n) > 0n">ARGNOT Below Maximum Backing</template>
                          <template v-else-if="(vaultingBreakdown.argonotRewardBacking?.withdrawalCancellationMicronots ?? 0n) > 0n">ARGNOT Withdrawal Reduces Backing</template>
                          <template v-else>ARGNOT Update Applies Next Frame</template>
                        </span>
                      </TooltipTrigger>
                      <TooltipContent side="bottom" :sideOffset="4" :collisionPadding="9" class="text-md z-50 w-xs rounded-md border border-gray-800/20 bg-white px-4 py-3 text-left leading-5.5 font-light text-slate-900/60 shadow-2xl">
                        <template v-if="hasArgonotRewardAlert && vaultingBreakdown.argonotRewardBacking">
                          <template v-if="vaultingBreakdown.argonotRewardBacking.additionalMicronots > 0n">
                            Add {{ micronotToArgonotNm(vaultingBreakdown.argonotRewardBacking.additionalMicronots).format('0,0.[000000]') }} ARGNOT to reach maximum reward backing.
                          </template>
                          <template v-if="vaultingBreakdown.argonotRewardBacking.withdrawalCancellationMicronots > 0n">
                            Cancel {{ micronotToArgonotNm(vaultingBreakdown.argonotRewardBacking.withdrawalCancellationMicronots).format('0,0.[000000]') }} ARGNOT of pending withdrawals to retain maximum reward backing.
                          </template>
                          <template v-if="vaultingBreakdown.argonotRewardBacking.additionalMicronots + vaultingBreakdown.argonotRewardBacking.withdrawalCancellationMicronots === 0n">Your ARGNOT backing is funded. Its reward contribution updates at the next frame.</template>
                          With the current Bitcoin and bond usage, maximum ARGNOT backing would capture
                          {{ numeral(vaultingBreakdown.revenuePotential!.capturedWithMaximumArgonotsPercent).format('0,0.[00]') }}% of potential revenue.
                        </template>
                        <template v-else>How much of your vault's potential network revenue is being earned. Bitcoin locks, bonds, and ARGNOT backing determine this percentage.</template>
                        <TooltipArrow :width="27" :height="15" class="-mt-px fill-white stroke-gray-800/20 stroke-[0.5px]" />
                      </TooltipContent>
                    </TooltipRoot>
                    <TooltipRoot :delayDuration="200">
                      <TooltipTrigger as="div" class="cursor-help">{{ numeral(vaultingBreakdown.treasuryBondCapacityUsedPct).format('0,0.[00]')}}% of Allowed Bonds Are Secured</TooltipTrigger>
                      <TooltipContent side="bottom" :sideOffset="4" :collisionPadding="9" class="text-md z-50 w-xs rounded-md border border-gray-800/20 bg-white px-4 py-3 text-left leading-5.5 font-light text-slate-900/60 shadow-2xl">
                        The percentage of your vault's treasury bond capacity that has been purchased by all investors.
                        <TooltipArrow :width="27" :height="15" class="-mt-px fill-white stroke-gray-800/20 stroke-[0.5px]" />
                      </TooltipContent>
                    </TooltipRoot>
                  </div>
                </div>
              </TooltipProvider>
            </div>
          </section>

          <section box class="relative flex flex-col h-[35%] !pb-0.5 px-2">
            <FrameSlider
              ref="frameSliderRef"
              :navigationDisabled="true"
              :chartItems="chartItems"
              :selectedIndex="sliderFrameIndex"
              @changedFrame="updateSliderFrame" />
          </section>
        </div>
      </section>
    </div>

    <!-- Overlays -->

    <BitcoinLockDetailOverlay
      v-if="showLockDetailOverlay"
      :lock="selectedLock!"
      @close="closeLockDetailOverlay"
      @unlock="onUnlockFromDetail"
    />

    <BondDetailOverlay
      v-if="showBondDetailOverlay && (selectedBondLot || selectedBondPosition)"
      :bondLot="selectedBondLot"
      :position="selectedBondPosition"
      displayContext="vault"
      liquidationAccount="vaulting"
      @close="closeBondDetailOverlay"
    />

  </div>
</template>

<script lang="ts">
import type { IChartItem } from '../../interfaces/IChartItem.ts';
import type { IVaultFrameRecord } from '../../interfaces/IVaultFrameRecord.ts';
import * as Vue from 'vue';
import dayjs from 'dayjs';
import utc from 'dayjs/plugin/utc';
import FrameSlider from '../../components/FrameSlider.vue';

const currentFrame = Vue.ref<IVaultFrameRecord>({ id: 0, date: '', firstTick: 0 });

dayjs.extend(utc);
const frameSliderRef = Vue.ref<InstanceType<typeof FrameSlider> | null>(null);
const frameRecords = Vue.ref<IVaultFrameRecord[]>([]);
const chartItems = Vue.ref<IChartItem[]>([]);
</script>

<script setup lang="ts">
import { createNumeralHelpers } from '../../lib/numeral.ts';
import { getCurrency } from '../../stores/currency.ts';
import numeral from '../../lib/numeral.ts';
import { getMyVault } from '../../stores/vaults.ts';
import type { IExternalBitcoinLock } from '../../lib/MyVault.ts';
import { getConfig } from '../../stores/config.ts';
import { TICK_MILLIS } from '../../lib/Env.ts';
import BitcoinLockDetailOverlay from '../../overlays/BitcoinLockDetailOverlay.vue';
import BondDetailOverlay from '../../overlays/BondDetailOverlay.vue';
import {
  bigIntMax,
  bigNumberToBigInt,
  BondLot,
  NetworkConfig,
  TreasuryBonds,
} from '@argonprotocol/apps-core';
import { TooltipProvider, TooltipRoot, TooltipTrigger, TooltipContent, TooltipArrow } from 'reka-ui';
import { getMainchainClient, getMiningFrames } from '../../stores/mainchain.ts';
import { getBitcoinLocks } from '../../stores/bitcoin.ts';
import basicEmitter from '../../emitters/basicEmitter.ts';
import { ProfitAnalysis } from '../../lib/ProfitAnalysis.ts';
import { useVaultingAssetBreakdown } from '../../stores/vaultingAssetBreakdown.ts';
import { getArgonBonds } from '../../stores/argonBonds.ts';
import type { IVaultArgonBondState } from '../../lib/ArgonBonds.ts';
import TreemapChart, { type TileStatus } from '../../components/TreemapChart.vue';
import { BitcoinLockStatus, type IBitcoinLockRecord } from '../../lib/db/BitcoinLocksTable.ts';
import { TopTab } from '../../interfaces/IConfig.ts';
import { OperationalStepId, useCertificationController } from '../../stores/certificationController.ts';
import ArrowCalloutButton from '../../components/ArrowCalloutButton.vue';
import { useFinancials } from '../../stores/financials.ts';
import AlertIcon from '../../assets/alert.svg?component';
import BigNumber from 'bignumber.js';
import { useWallets } from '../../stores/wallets.ts';
import { useMiningStats } from '../../stores/miningStats.ts';

dayjs.extend(utc);

const myVault = getMyVault();
const controller = useCertificationController();
const bitcoinLocks = getBitcoinLocks();
const config = getConfig();
const currency = getCurrency();
const argonBonds = getArgonBonds();
const financials = useFinancials();
const wallets = useWallets();
const miningStats = useMiningStats();

const vaultingBreakdown = useVaultingAssetBreakdown();
const hasArgonotRewardAlert = Vue.computed(() => {
  const backing = vaultingBreakdown.argonotRewardBacking;
  if (!backing) return false;
  if (backing.additionalMicronots > 0n) return true;
  if (backing.withdrawalCancellationMicronots > 0n) return true;
  const potential = vaultingBreakdown.revenuePotential;
  if (potential?.capturedPercent === undefined) return false;
  return (potential.capturedWithMaximumArgonotsPercent ?? 0) > potential.capturedPercent;
});

const rules = config.vaultingRules;

const latestFrameId = Vue.computed(() => {
  return frameRecords.value.at(-1)?.id ?? 0;
});

const { microgonToArgonNm, microgonToMoneyNm, micronotToArgonotNm } = createNumeralHelpers(currency);

const vaultBondState = Vue.computed<IVaultArgonBondState | undefined>(() => {
  const vaultId = myVault.vaultId;
  return vaultId == null ? undefined : argonBonds.data.vaultsById[vaultId];
});

const currentTreasuryBondFrame = Vue.computed(() => ({
  frameId: vaultBondState.value?.currentFrame.frameId ?? argonBonds.data.currentFrameId,
  globalBonds: argonBonds.data.totalActiveBonds,
  vaultBonds: vaultBondState.value?.currentFrame.vaultBonds ?? 0,
  flexibleBondsEligible: vaultBondState.value?.currentFrame.flexibleBondsEligible ?? 0,
  bondLots: vaultBondState.value?.currentFrame.bondLots ?? [],
}));

const totalTreasuryBondMicrogons = Vue.computed(() => {
  return BondLot.getTotals(vaultBondState.value?.bondLots ?? []).activeBondMicrogons;
});

const externalTreasuryBondMicrogons = Vue.computed(() => {
  return BondLot.bondsToMicrogons(TreasuryBonds.externalActiveBonds(vaultBondState.value?.bondLots ?? []));
});

const vaultingReturnToDate = Vue.computed(() => {
  return financials.financialPositionAggregate.groupSummaries.vaulting.returnSummary.percent;
});

const revenueMicrogons = Vue.computed(() => {
  const group = financials.financialPositionAggregate.groupSummaries.vaulting;
  if (group.state === 'ready' || group.state === 'stale') return group.returnSummary.paidIncome;
});

const revenueHistoryDays = (NetworkConfig.ticksPerCohort * NetworkConfig.tickMillis) / 86_400_000;
const averageDailyNetworkRevenue = Vue.computed(() => {
  return (
    (miningStats.aggregatedBidCosts * 86_400_000n) / BigInt(NetworkConfig.ticksPerCohort * NetworkConfig.tickMillis)
  );
});

const potentialDailyRevenue = Vue.computed(() => {
  if (!myVault.createdVault) return 0n;

  const bondFrame = currentTreasuryBondFrame.value;
  const capital = argonBonds.data.frameCapital;
  if (capital) {
    return (
      argonBonds.vaultRevenuePotential(myVault.createdVault.vaultId, averageDailyNetworkRevenue.value)
        ?.maximumEarnings ?? 0n
    );
  }
  const bondPool = bigNumberToBigInt(
    BigNumber(averageDailyNetworkRevenue.value).times(argonBonds.data.bondPoolPercent),
  );
  return TreasuryBonds.potentialDailyRevenue({
    distributableBidPool: bondPool,
    globalActiveBonds: bondFrame.globalBonds,
    myActiveBonds: bondFrame.vaultBonds,
    fullTreasuryBondCapacity: vaultingBreakdown.treasuryBondPurchaseCapacityBonds,
    operatorKeepPct: 100 - (rules.profitSharingPct ?? 0),
  });
});

function formatMoney(value: bigint) {
  return `${currency.symbol}${microgonToMoneyNm(value).format('0,0')}`;
}

const bitcoinMapRemainderMinimum = Vue.computed(() => {
  return currency.priceIndex.getSatoshiPriceInTargetMicrogons(1000n);
});

type MapItem = {
  id: string;
  label: string;
  amount: bigint;
  displayValue?: string;
  emphasis?: 'default' | 'strong';
  status?: TileStatus;
};

type IBondMapLot = {
  id: string;
  lot: BondLot;
  status: TileStatus;
  capacityMicrogons: bigint;
};

function deriveExternalLockStatus(ext: IExternalBitcoinLock): BitcoinLockStatus {
  if (ext.isPending) return BitcoinLockStatus.LockPendingFunding;
  if (ext.isReleasing) return BitcoinLockStatus.Releasing;
  return BitcoinLockStatus.LockFunded;
}

function formatLockLabel(lock: { satoshis: bigint } | IBitcoinLockRecord): string {
  const satoshis = 'satoshis' in lock ? lock.satoshis : lock.fundedSatoshis || lock.securitizedSatoshis;
  const btc = currency.convertSatToBtc(satoshis);
  return `${numeral(btc).format('0,0.[0000]')} BTC`;
}

function getLockTileStatus(lock: IBitcoinLockRecord): TileStatus {
  if (lock.isHistoryRecoveryPending) return 'pending';
  if (bitcoinLocks.isLockFunded(lock)) return 'active';
  if (bitcoinLocks.isReleaseStatus(lock)) return 'active';
  return 'pending';
}

const localVaultLocks = Vue.computed(() => {
  const vaultId = myVault.createdVault?.vaultId;
  if (!vaultId) return [];

  return bitcoinLocks
    .getAllLocks({ includeHistoryRecoveryPending: true })
    .filter(lock => lock.vaultId === vaultId && !bitcoinLocks.isInactiveForVaultDisplay(lock));
});

const localLocksByUuid = Vue.computed(() => {
  const map: Record<string, IBitcoinLockRecord> = {};
  for (const lock of localVaultLocks.value) {
    map[lock.uuid] = lock;
  }
  return map;
});

function handleBondTileClick(key: string) {
  const bondLot = currentBondMapLots.value.find(bondLot => bondLot.id === key);
  if (bondLot) {
    selectedBondLotId.value = bondLot.lot.id;
    showBondDetailOverlay.value = true;
  }
}

function handleBitcoinTileClick(key: string) {
  // Local lock
  const lock = localLocksByUuid.value[key];
  if (lock) {
    if (lock.isHistoryRecoveryPending) return;

    if (bitcoinLocks.isLockFunded(lock) || bitcoinLocks.isReleaseStatus(lock)) {
      openLockDetailOverlay(lock);
    } else {
      openBitcoinChannel(lock);
    }
    return;
  }

  // External lock (key is "chain:<lockId>")
  if (key.startsWith('chain:')) {
    const lockId = Number(key.slice(6));
    const extLock = myVault.data.externalLocks[lockId];
    if (extLock) {
      openLockDetailOverlay(extLock);
    }
  }
}

const bitcoinLockedMarketValue = Vue.computed(() => {
  let value = 0n;

  for (const lock of localVaultLocks.value) {
    if (!bitcoinLocks.isLockFunded(lock) && !bitcoinLocks.isReleaseStatus(lock)) continue;

    value += currency.convertSatToMicrogon(lock.fundedSatoshis);
  }
  for (const lock of Object.values(myVault.data.externalLocks)) {
    if (lock.isPending) continue;

    value += currency.convertSatToMicrogon(lock.satoshis);
  }

  return value;
});

const bitcoinLockCapacity = Vue.computed(() => {
  const vault = myVault.createdVault;
  if (!vault) return 0n;
  return bigNumberToBigInt(new BigNumber(vault.securitization).div(vault.securitizationRatio));
});

const bitcoinMapTotal = Vue.computed(() => {
  return bigIntMax(vaultingBreakdown.securityMicrogons, bitcoinMapUsed.value);
});

const bitcoinMapItems = Vue.computed((): MapItem[] => {
  // Historical frames: collapse to locked vs open aggregate
  if (!currentFrameIsActive.value) {
    const items: MapItem[] = [];
    if (vaultingBreakdown.securityMicrogonsActivated > 0n) {
      items.push({
        id: 'locked-aggregate',
        label: 'Bitcoin Locked',
        amount: vaultingBreakdown.securityMicrogonsActivated,
        displayValue: formatMoney(vaultingBreakdown.securityMicrogonsActivated),
        emphasis: 'strong',
      });
    }
    if (vaultingBreakdown.securityMicrogonsPending > 0n) {
      items.push({
        id: 'pending-aggregate',
        label: 'Pending Activation',
        amount: vaultingBreakdown.securityMicrogonsPending,
        displayValue: formatMoney(vaultingBreakdown.securityMicrogonsPending),
      });
    }
    return items;
  }

  // Current frame: per-lock items
  const items: MapItem[] = [];

  for (const lock of localVaultLocks.value) {
    const microgons = lock.securitizationCoverageMicrogons ?? 0n;
    const tileStatus = getLockTileStatus(lock);
    items.push({
      id: lock.uuid,
      label: formatLockLabel(lock),
      amount: microgons,
      displayValue: formatMoney(microgons),
      emphasis: bitcoinLocks.isLockFunded(lock) && !lock.isHistoryRecoveryPending ? 'strong' : 'default',
      status: tileStatus,
    });
  }

  for (const extLock of Object.values(myVault.data.externalLocks)) {
    const microgons = extLock.securitizationCoverageMicrogons;
    const status: TileStatus = extLock.isPending ? 'pending' : 'active';
    items.push({
      id: `chain:${extLock.lockId}`,
      label: formatLockLabel(extLock),
      amount: microgons,
      displayValue: formatMoney(microgons),
      emphasis: 'strong',
      status,
    });
  }

  return items;
});

const bitcoinMapUsed = Vue.computed(() => {
  return bitcoinMapItems.value.reduce((sum, item) => sum + item.amount, 0n);
});

const bitcoinMapRemainder = Vue.computed(() => {
  return bitcoinMapTotal.value > bitcoinMapUsed.value ? bitcoinMapTotal.value - bitcoinMapUsed.value : 0n;
});

const bitcoinMapSecuritizationShortfall = Vue.computed(() => {
  return bigIntMax(bitcoinLockedMarketValue.value - vaultingBreakdown.securityMicrogons, 0n);
});

const bondMapTotal = Vue.computed(() => {
  const used = bondMapItems.value.reduce((sum, item) => sum + item.amount, 0n);
  return bigIntMax(used, vaultingBreakdown.treasuryBondCapacityMicrogons);
});

const internalTreasuryBondMicrogonsSecured = Vue.computed(() => {
  return vaultingBreakdown.treasuryBondCapacityUsedMicrogons;
});

const currentBondMapLots = Vue.computed((): IBondMapLot[] => {
  const ordinaryFrameBondLots = currentTreasuryBondFrame.value.bondLots;
  const activeBondLots = (vaultBondState.value?.bondLots ?? []).filter(bondLot => bondLot.activeBonds > 0);
  const { flexibleBonds = 0, displacedFlexibleBonds = 0 } = vaultBondState.value ?? {};

  return activeBondLots.map(bondLot => {
    let capacityMicrogons = bondLot.activeBondMicrogons;
    if (bondLot.isFlexible && flexibleBonds > 0) {
      capacityMicrogons = (capacityMicrogons * BigInt(flexibleBonds - displacedFlexibleBonds)) / BigInt(flexibleBonds);
    }
    const participatesInFrame = ordinaryFrameBondLots.some(entry => entry.lot.id === bondLot.id);
    let status: TileStatus = 'pending';
    if (participatesInFrame) status = 'active';
    if (bondLot.isFlexible && bondLot.earningsDestination === 'VaultForFlexible') status = 'active';

    return {
      id: bondLot.id > 0 ? `lot:${bondLot.id}` : `account:${bondLot.owner}:${bondLot.id}`,
      lot: bondLot,
      status,
      capacityMicrogons,
    };
  });
});

const bondLotsByMapId = Vue.computed(() => Object.fromEntries(currentBondMapLots.value.map(lot => [lot.id, lot])));

const bondMapItems = Vue.computed((): MapItem[] => {
  // Historical frames: fall back to aggregated internal/external tiles
  if (!currentFrameIsActive.value) {
    const items: MapItem[] = [];
    if (internalTreasuryBondMicrogonsSecured.value > 0n) {
      items.push({
        id: 'internal-bonds',
        label: 'Treasury Bonds',
        amount: internalTreasuryBondMicrogonsSecured.value,
        displayValue: formatMoney(internalTreasuryBondMicrogonsSecured.value),
        emphasis: 'strong',
      });
    }
    if (externalTreasuryBondMicrogons.value > 0n) {
      items.push({
        id: 'external-bonds',
        label: 'External Treasury Bonds',
        amount: externalTreasuryBondMicrogons.value,
        displayValue: formatMoney(externalTreasuryBondMicrogons.value),
      });
    }
    return items;
  }

  // Current frame: show the runtime bond lots, and mark any lots missing from the
  // current frame snapshot as pending so fresh purchases still appear immediately.
  const items: MapItem[] = [];

  for (const bondLot of currentBondMapLots.value) {
    const bondMicrogons = bondLot.capacityMicrogons;
    items.push({
      id: bondLot.id,
      label: formatMoney(bondMicrogons),
      amount: bondMicrogons,
      emphasis: bondLot.lot.owner === myVault.createdVault?.operatorAccountId ? 'strong' : 'default',
      status: bondLot.status,
    });
  }

  // If no frame data yet, fall back to aggregated data
  if (items.length === 0) {
    if (internalTreasuryBondMicrogonsSecured.value > 0n) {
      items.push({
        id: 'internal-bonds',
        label: 'Treasury Bonds',
        amount: internalTreasuryBondMicrogonsSecured.value,
        displayValue: formatMoney(internalTreasuryBondMicrogonsSecured.value),
        emphasis: 'strong',
      });
    }
    if (externalTreasuryBondMicrogons.value > 0n) {
      items.push({
        id: 'external-bonds',
        label: 'External Treasury Bonds',
        amount: externalTreasuryBondMicrogons.value,
        displayValue: formatMoney(externalTreasuryBondMicrogons.value),
      });
    }
  }

  return items;
});

const bondMapRemainder = Vue.computed(() => {
  const used = bondMapItems.value.reduce((sum, item) => sum + item.amount, 0n);
  return bondMapTotal.value > used ? bondMapTotal.value - used : 0n;
});

const showLockDetailOverlay = Vue.ref(false);
const showBondDetailOverlay = Vue.ref(false);
const selectedLock = Vue.ref<IBitcoinLockRecord | IExternalBitcoinLock | undefined>(undefined);
const selectedBondLotId = Vue.ref<number>();
const selectedBondLot = Vue.computed(() =>
  vaultBondState.value?.bondLots.find(lot => lot.id === selectedBondLotId.value),
);
const selectedBondPosition = Vue.computed(() => {
  if (selectedBondLotId.value === undefined) return;
  for (const position of financials.financialPositionAggregate.groupSummaries.bonds.positions) {
    if (position.kind !== 'bond') continue;
    if ((position.bondLot?.id ?? position.history?.bondLotId) === selectedBondLotId.value) return position;
  }
});

function openBitcoinChannel(lock?: IBitcoinLockRecord) {
  basicEmitter.emit('openWalletOverlay', {
    wallet: wallets.bitcoinWallet,
    bitcoinChannelUuid: lock?.uuid,
    bitcoinChannelVaultId: myVault.createdVault?.vaultId,
  });
}

function openLockDetailOverlay(lock: IBitcoinLockRecord | IExternalBitcoinLock) {
  selectedLock.value = lock;
  showLockDetailOverlay.value = true;
}

function closeLockDetailOverlay() {
  showLockDetailOverlay.value = false;
  selectedLock.value = undefined;
}

function closeBondDetailOverlay() {
  showBondDetailOverlay.value = false;
  selectedBondLotId.value = undefined;
}

function onUnlockFromDetail(lock: IBitcoinLockRecord) {
  showLockDetailOverlay.value = false;
  selectedLock.value = undefined;
  basicEmitter.emit('openBitcoinUnlock', lock);
}

const sliderFrameIndex = Vue.computed(() => {
  const lastIndex = Math.max(frameRecords.value.length - 1, 0);
  const selectedIndex = frameRecords.value.findIndex(frame => frame.id === currentFrame.value.id);
  return Math.min(Math.max(selectedIndex >= 0 ? selectedIndex : lastIndex, 0), lastIndex);
});

const hasPrevFrame = Vue.computed(() => {
  return false;
  // return sliderFrameIndex.value > 0;
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
  const date = dayjs.utc((lastTick + 1) * TICK_MILLIS);
  return date.local().format('MMMM D, h:mm A');
});

const currentFrameIsActive = Vue.computed(() => {
  return currentFrame.value?.id === latestFrameId.value;
});

function goToPrevFrame() {
  frameSliderRef.value?.goToPrevFrame();
}

function goToNextFrame() {
  frameSliderRef.value?.goToNextFrame();
}

function updateSliderFrame(newFrameIndex: number) {
  const lastIndex = Math.max(frameRecords.value.length - 1, 0);
  const nextFrameIndex = Math.min(Math.max(newFrameIndex, 0), lastIndex);
  const nextFrame = frameRecords.value[nextFrameIndex];
  if (!nextFrame) return;

  currentFrame.value = nextFrame;
}

function openVaultEditOverlay() {
  basicEmitter.emit('openVaultSettingsOverlay');
}

function openSecuritization() {
  basicEmitter.emit('openVaultSettingsOverlay');
}

const miningFrames = getMiningFrames();

function loadChartData(currentFrameId?: number) {
  const profitAnalysis = new ProfitAnalysis(myVault, miningFrames, argonBonds, currentFrameId);
  profitAnalysis.update();

  chartItems.value = profitAnalysis.items;
  frameRecords.value = profitAnalysis.records;
  const targetFrameId = currentFrameId ?? currentFrame.value.id;
  currentFrame.value =
    frameRecords.value.find(frame => frame.id === targetFrameId) ?? frameRecords.value.at(-1) ?? currentFrame.value;
}

async function refreshCurrentFrameBonds() {
  if (myVault.vaultId == null || !myVault.createdVault) return;

  const client = await getMainchainClient(false);
  await argonBonds.refreshVault(
    {
      vaultId: myVault.vaultId,
      operatorAddress: myVault.createdVault.operatorAccountId,
      accountId: myVault.walletKeys.vaultingAddress,
      frameId: currentFrame.value.id,
    },
    client,
  );
}

let onFrameSubscription: { unsubscribe: () => void };

Vue.onMounted(async () => {
  await miningFrames.load();
  await myVault.load();

  Vue.watch(
    () => [myVault.data.stats, argonBonds.data.financialRevision] as const,
    () => loadChartData(),
    { deep: true },
  );

  onFrameSubscription = miningFrames.onFrameId(async frameId => {
    loadChartData(frameId);
    await refreshCurrentFrameBonds();
  });

  const client = await getMainchainClient(false);
  await argonBonds.subscribeGlobal(client);

  loadChartData();
  await refreshCurrentFrameBonds();
});

Vue.onUnmounted(() => {
  onFrameSubscription?.unsubscribe();
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
