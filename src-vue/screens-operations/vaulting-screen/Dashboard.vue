<!-- prettier-ignore -->
<template>
  <div data-testid="VaultingDashboard" class="flex flex-col h-full">
    <div class="flex flex-col h-full px-2.5 py-2.5 gap-y-2 justify-stretch grow">
      <TooltipProvider :disableHoverableContent="true">
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
      </TooltipProvider>

      <section class="flex flex-row gap-x-2.5 grow">
        <div box class="flex flex-col w-[22.5%] px-2">
          <header class="flex flex-row items-center px-1 border-b border-slate-400/30 pt-2 pb-3 text-[18px] font-bold text-slate-900/80">
            <div class="grow">Vaulting Assets</div>
            <CopyAddressMenu :walletType="WalletType.vaulting" class="mr-1" />
            <AssetMenu :walletType="WalletType.vaulting" />
          </header>
          <VaultingAssetBreakdown />
          <div class="grow border-t border-slate-600/40 flex flex-col items-center justify-center">
            <a target="_blank" href="https://argon.network/docs/mining-operations" class="flex flex-row items-center text-center text-argon-600/60! hover:text-argon-600! cursor-pointer">
              <div>Learn About Vaulting</div>
              <ArrowTopRightOnSquareIcon class="w-5 ml-2" />
            </a>
          </div>
          <div class="flex flex-row items-end border-t border-slate-600/20 pt-2 text-md">
            <div @click="openPortfolioPanel(PortfolioTab.ProfitAnalysis)" class="grow relative text-center text-argon-600 opacity-70 hover:opacity-100 cursor-pointer">
              <RoiIcon class="w-6 h-6 mt-2 inline-block mb-2" />
              <div>Profits</div>
            </div>
            <div class="w-px h-full bg-slate-600/20" />
            <div @click="openPortfolioPanel(PortfolioTab.GrowthProjections)" class="grow relative text-center text-argon-600 opacity-70 hover:opacity-100 cursor-pointer">
              <ProjectionsIcon class="w-6 h-6 mt-2 inline-block mb-2" />
              <div>Projections</div>
            </div>
            <div class="w-px h-full bg-slate-600/20" />
            <div @click="openVaultEditOverlay" class="grow relative text-center text-argon-600 opacity-70 hover:opacity-100 cursor-pointer">
              <ConfigIcon class="w-6 h-6 mt-2 inline-block mb-2" />
              <div>Settings</div>
            </div>
          </div>
        </div>

        <div class="flex flex-col grow gap-y-2">
          <section box class="flex flex-col grow text-center px-2">
            <header class="flex flex-row justify-between text-xl font-bold py-2 text-slate-900/80 border-b border-slate-400/30 select-none">
              <div @click="goToPrevFrame" :class="hasPrevFrame ? 'opacity-60' : 'opacity-20 pointer-events-none'" class="flex flex-row items-center font-light text-base cursor-pointer group hover:opacity-80">
                <ChevronLeftIcon class="w-6 h-6 opacity-50 mx-1 group-hover:opacity-80" />
                PREV
              </div>
              <span class="flex flex-row items-center" :title="'Frame #' + currentFrame.id">
                <span>{{ currentFrameStartDate }} to {{ currentFrameEndDate }}</span>
                <span v-if="currentFrameIsActive" class="inline-block rounded-full bg-green-500/80 w-2.5 h-2.5 ml-2"></span>
              </span>
              <div v-if="currentFrame.progress >= 100" @click="goToNextFrame" class="flex flex-row opacity-60 items-center font-light text-base cursor-pointer group hover:opacity-80">
                NEXT
                <ChevronRightIcon class="w-6 h-6 opacity-50 mx-1 group-hover:opacity-80" />
              </div>
              <div v-else class="flex flex-row opacity-60 items-center font-light text-base group px-2">
                {{ numeral(currentFrame.progress).format('0.0') }}%
              </div>
            </header>
            <div class="flex flex-col h-full">
              <div class="flex flex-row items-center w-full gap-x-3 text-base my-4 px-2.5">
                <div class="text-slate-700/80">Grow revenue by expanding your network</div>
                <div class="grow flex flex-row gap-x-3 text-argon-600">
                  <button @click="openVaultMembersOverlay" class="grow border border-slate-600/50 rounded-lg py-0.5 cursor-pointer hover:bg-argon-100/20">
                    Manage Members
                  </button>
                  <button @click="openVaultInvitesOverlay" class="grow border border-slate-600/50 rounded-lg py-0.5 cursor-pointer hover:bg-argon-100/20">
                    Manage Member Invites
                  </button>
                  <button class="grow border border-slate-600/50 rounded-lg py-0.5 cursor-pointer hover:bg-argon-100/20">
                    Optimize Revenue
                  </button>
                </div>
              </div>
              <div class="flex flex-row items-stretch gap-x-2 w-full grow px-2">
                <div BitcoinMap class="w-1/2 relative">
                  <TreemapChart
                    :total="bitcoinMapTotal"
                    :items="bitcoinMapItems"
                    theme="btc"
                    :remainderLabel="bitcoinRemainderLabel"
                    :remainder-display-value="bitcoinRemainderDisplayValue"
                    @tile-click="handleBitcoinTileClick"
                  />
                  <ArrowCalloutButton
                    v-if="[OperationalStepId.LiquidLock].includes(controller.activeGuideId!)"
                    class="absolute top-1/2 right-2 -translate-y-1/2 translate-x-full z-50"
                    guidance="Click the vaulting tab to begin."
                  />
                </div>
                <div BondMap class="w-1/2">
                  <TreemapChart
                    v-if="bondMapTotal"
                    :total="bondMapTotal"
                    :items="bondMapItems"
                    theme="argon"
                    remainder-label="Available Bonds"
                    :remainder-minimum="10000"
                    :remainder-display-value="formatMoney(bondMapRemainder)"
                    @tile-click="handleBondTileClick"
                  />
                  <div v-else class="w-full h-full border-2 border-dashed border-slate-400/50 text-slate-400/70 flex flex-col items-center justify-center">
                    No Bonds Available
                  </div>
                </div>
              </div>
              <TooltipProvider :disableHoverableContent="true">
                <div class="pt-4 pb-3">
                  <div class="mb-2 flex items-center gap-x-3 text-center">
                    <span class="h-px grow bg-slate-400/30"></span>
                  </div>
                  <div class="grid grid-cols-3 gap-x-4 gap-y-5 text-center text-base leading-none text-slate-700/80 pt-3">
                    <TooltipRoot :delayDuration="200">
                      <TooltipTrigger as="div" class="cursor-help">{{currency.symbol}}{{ microgonToMoneyNm(vaultingBreakdown.securityMicrogons).format('0,0.00') }} In Potential BTC Locks</TooltipTrigger>
                      <TooltipContent side="bottom" :sideOffset="4" :collisionPadding="9" class="text-md z-50 w-xs rounded-md border border-gray-800/20 bg-white px-4 py-3 text-left leading-5.5 font-light text-slate-900/60 shadow-2xl">
                        The total argon value of bitcoin that could be locked in your vault based on your securitization commitment.
                        <TooltipArrow :width="27" :height="15" class="-mt-px fill-white stroke-gray-800/20 stroke-[0.5px]" />
                      </TooltipContent>
                    </TooltipRoot>
                    <TooltipRoot :delayDuration="200">
                      <TooltipTrigger as="div" class="cursor-help">{{currency.symbol}}{{ microgonToMoneyNm(potentialDailyRevenue).formatIfElse('< 1_000', '0,0.00', '0,0') }} Potential Daily Revenue</TooltipTrigger>
                      <TooltipContent side="bottom" :sideOffset="4" :collisionPadding="9" class="text-md z-50 w-xs rounded-md border border-gray-800/20 bg-white px-4 py-3 text-left leading-5.5 font-light text-slate-900/60 shadow-2xl">
                        The current potential earnings from the bid pool if all your capital is used for bitcoin security and external funders buy all possible bonds. This number will update until the mining auction closes.
                        <TooltipArrow :width="27" :height="15" class="-mt-px fill-white stroke-gray-800/20 stroke-[0.5px]" />
                      </TooltipContent>
                    </TooltipRoot>
                    <TooltipRoot :delayDuration="200">
                      <TooltipTrigger as="div" class="cursor-help">{{currency.symbol}}{{ microgonToMoneyNm(vaultingBreakdown.treasuryMicrogonsMaxCapacity).format('0,0.00') }} In Potential Bond Buys</TooltipTrigger>
                      <TooltipContent side="bottom" :sideOffset="4" :collisionPadding="9" class="text-md z-50 w-xs rounded-md border border-gray-800/20 bg-white px-4 py-3 text-left leading-5.5 font-light text-slate-900/60 shadow-2xl">
                        The total treasury bond capacity available for purchase, based on your active bitcoin locks.
                        <TooltipArrow :width="27" :height="15" class="-mt-px fill-white stroke-gray-800/20 stroke-[0.5px]" />
                      </TooltipContent>
                    </TooltipRoot>
                    <TooltipRoot :delayDuration="200">
                      <TooltipTrigger as="div" class="cursor-help">{{ numeral(vaultingBreakdown.securityMicrogonsActivatedPct).format('0,0.[00]') }}% of Allowed BTC Is Locked</TooltipTrigger>
                      <TooltipContent side="bottom" :sideOffset="4" :collisionPadding="9" class="text-md z-50 w-xs rounded-md border border-gray-800/20 bg-white px-4 py-3 text-left leading-5.5 font-light text-slate-900/60 shadow-2xl">
                        The percentage of your vault's bitcoin security space that is currently filled with active locks.
                        <TooltipArrow :width="27" :height="15" class="-mt-px fill-white stroke-gray-800/20 stroke-[0.5px]" />
                      </TooltipContent>
                    </TooltipRoot>
                    <TooltipRoot :delayDuration="200">
                      <TooltipTrigger as="div" class="cursor-help">{{ numeral(revenueCapturedPct).format('0,0.[00]') }}% of Potential Revenue Captured</TooltipTrigger>
                      <TooltipContent side="bottom" :sideOffset="4" :collisionPadding="9" class="text-md z-50 w-xs rounded-md border border-gray-800/20 bg-white px-4 py-3 text-left leading-5.5 font-light text-slate-900/60 shadow-2xl">
                        How much of your vault's potential mining pool revenue is being earned. Maximize this by using your capital for bitcoin security and funding treasury externally.
                        <TooltipArrow :width="27" :height="15" class="-mt-px fill-white stroke-gray-800/20 stroke-[0.5px]" />
                      </TooltipContent>
                    </TooltipRoot>
                    <TooltipRoot :delayDuration="200">
                      <TooltipTrigger as="div" class="cursor-help">{{ numeral(vaultingBreakdown.treasuryMicrogonsTotalActivatedPct).format('0,0.[00]')}}% of Allowed Bonds Are Secured</TooltipTrigger>
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
              :chartItems="chartItems"
              :selectedIndex="sliderFrameIndex"
              @changedFrame="updateSliderFrame" />
          </section>
        </div>
      </section>
    </div>

    <!-- Overlays -->
    <VaultEditOverlay
      v-if="showEditOverlay"
      @close="showEditOverlay = false"
    />

    <BitcoinLockDetailOverlay
      v-if="showLockDetailOverlay"
      :lock="selectedLock!"
      @close="closeLockDetailOverlay"
      @unlock="onUnlockFromDetail"
    />

    <BondDetailOverlay
      v-if="showBondDetailOverlay && selectedBondHolder"
      :holder="selectedBondHolder"
      @close="closeBondDetailOverlay"
    />

  </div>
</template>

<script lang="ts">
import type { IChartItem } from '../../interfaces/IChartItem.ts';
import type { IVaultFrameRecord } from '../../interfaces/IVaultFrameRecord';
import * as Vue from 'vue';
import dayjs from 'dayjs';
import utc from 'dayjs/plugin/utc';
import FrameSlider from '../../components/FrameSlider.vue';

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

dayjs.extend(utc);
const frameSliderRef = Vue.ref<InstanceType<typeof FrameSlider> | null>(null);
const frameRecords = Vue.ref<IVaultFrameRecord[]>([]);
const chartItems = Vue.ref<IChartItem[]>([]);
</script>

<script setup lang="ts">
import { createNumeralHelpers } from '../../lib/numeral.ts';
import { getCurrency } from '../../stores/currency';
import numeral from '../../lib/numeral';
import { getMyVault, getVaults } from '../../stores/vaults.ts';
import type { IExternalBitcoinLock, IFrameBondHolder } from '../../lib/MyVault.ts';
import { getConfig } from '../../stores/config.ts';
import { ArrowTopRightOnSquareIcon, ChevronLeftIcon, ChevronRightIcon } from '@heroicons/vue/24/outline';
import { TICK_MILLIS } from '../../lib/Env.ts';
import VaultEditOverlay from '../../overlays-operations/VaultEditOverlay.vue';
import BitcoinLockDetailOverlay from '../../overlays-operations/BitcoinLockDetailOverlay.vue';
import BondDetailOverlay from '../../overlays-operations/BondDetailOverlay.vue';
import AssetMenu from '../components/AssetMenu.vue';
import ConfigIcon from '../../assets/config.svg?component';
import { NetworkConfig, bigIntMin, calculateAPY, MoveTo, TreasuryPool } from '@argonprotocol/apps-core';
import { BigNumber } from 'bignumber.js';
import { TooltipProvider, TooltipRoot, TooltipTrigger, TooltipContent, TooltipArrow } from 'reka-ui';
import { getMiningFrames } from '../../stores/mainchain.ts';
import { getBitcoinLocks } from '../../stores/bitcoin.ts';
import VaultingAssetBreakdown from '../components/VaultingAssetBreakdown.vue';
import RoiIcon from '../../assets/roi.svg';
import ProjectionsIcon from '../../assets/rocket.svg';
import { PortfolioTab } from '../../panels/interfaces/IPortfolioTab.ts';
import basicEmitter from '../../emitters/basicEmitter.ts';
import CopyAddressMenu from '../components/CopyAddressMenu.vue';
import { WalletType } from '../../lib/Wallet.ts';
import { ProfitAnalysis } from '../../lib/ProfitAnalysis.ts';
import { useVaultingAssetBreakdown } from '../../stores/vaultingAssetBreakdown.ts';
import TreemapChart, { type TileStatus } from '../../components/TreemapChart.vue';
import { BitcoinLockStatus, type IBitcoinLockRecord } from '../../lib/db/BitcoinLocksTable.ts';
import { OperationalStepId, OperationsTab, useOperationsController } from '../../stores/operationsController.ts';
import ArrowCalloutButton from '../../components/ArrowCalloutButton.vue';

dayjs.extend(utc);

const myVault = getMyVault();
const vaults = getVaults();
const controller = useOperationsController();
const bitcoinLocks = getBitcoinLocks();
const config = getConfig();
const currency = getCurrency();

const vaultingBreakdown = useVaultingAssetBreakdown();

const rules = config.vaultingRules;

const latestFrameId = Vue.computed(() => {
  return frameRecords.value.at(-1)?.id ?? 0;
});

const { microgonToMoneyNm } = createNumeralHelpers(currency);

const totalTreasuryPoolBonds = Vue.computed(() => {
  return TreasuryPool.totalBondedCapital(myVault.data.bondFunders);
});

const internalTreasuryPoolBonds = Vue.computed(() => {
  return vaultingBreakdown.treasuryMicrogons;
});

const externalTreasuryBonds = Vue.computed(() => {
  return TreasuryPool.externalBondedCapital(myVault.data.bondFunders);
});

const bitcoinLockedValue = Vue.computed<bigint>(() => {
  return vaultingBreakdown.securityMicrogonsActivated;
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

const potentialDailyRevenue = Vue.computed(() => {
  if (!myVault.createdVault) return 0n;

  const { distributableBidPool, globalCapital, myVaultCapital } = myVault.data.currentFrameBondData;
  const sats = BigInt(myVault.createdVault.securitizedSatoshis ?? 0);
  const btcValue = sats > 0n ? currency.priceIndex.getBtcMicrogonPrice(sats) : 0n;

  return TreasuryPool.potentialDailyRevenue({
    distributableBidPool,
    globalActiveCapital: globalCapital,
    myActiveCapital: myVaultCapital,
    fullTreasuryCapacity: btcValue / 10n,
    operatorKeepPct: 100 - (rules.profitSharingPct ?? 0),
  });
});

const revenueCapturedPct = Vue.computed(() => {
  const allFunds =
    vaultingBreakdown.sidelinedMicrogons + vaultingBreakdown.treasuryMicrogons + vaultingBreakdown.securityMicrogons;
  if (allFunds <= 0n) return 0;

  const securityFactor = BigNumber(vaultingBreakdown.securityMicrogonsActivated).dividedBy(BigNumber(allFunds));

  const totalCapacity = vaultingBreakdown.securityMicrogons + vaultingBreakdown.treasuryMicrogonsMaxCapacity;
  const activated = vaultingBreakdown.securityMicrogonsActivated + vaultingBreakdown.treasuryMicrogonsTotalActivated;
  const utilizationFactor =
    totalCapacity > 0n ? BigNumber(activated).dividedBy(BigNumber(totalCapacity)) : BigNumber(0);

  return securityFactor.multipliedBy(utilizationFactor).multipliedBy(100).toNumber();
});

function formatMoney(value: bigint) {
  return `${currency.symbol}${microgonToMoneyNm(value).format('0,0')}`;
}

const bitcoinMapTotal = Vue.computed(() => {
  return vaultingBreakdown.securityMicrogons;
});

type MapItem = {
  id: string;
  label: string;
  amount: bigint;
  displayValue?: string;
  emphasis?: 'default' | 'strong';
  status?: TileStatus;
};

function deriveExternalLockStatus(ext: IExternalBitcoinLock): BitcoinLockStatus {
  // isPending is set from BitcoinLock.isFunded — true means funded
  if (ext.isPending) return BitcoinLockStatus.LockPendingFunding;
  return BitcoinLockStatus.LockedAndMinted;
}

function formatLockLabel(lock: IBitcoinLockRecord): string {
  const btc = currency.convertSatToBtc(lock.satoshis);
  return `${numeral(btc).format('0,0.[0000]')} BTC`;
}

function getLockTileStatus(lock: IBitcoinLockRecord): TileStatus {
  if (bitcoinLocks.isLockedStatus(lock)) return 'active';
  if (bitcoinLocks.isReleaseStatus(lock)) return 'active';
  return 'pending';
}

const localLocksByUuid = Vue.computed(() => {
  const map: Record<string, IBitcoinLockRecord> = {};
  const locks = bitcoinLocks.getActiveLocks();
  for (const lock of locks) {
    map[lock.uuid] = lock;
  }
  return map;
});

function handleBondTileClick(key: string) {
  if (key === '__remainder__') {
    basicEmitter.emit('openMoveCapitalOverlay', {
      walletType: WalletType.vaulting,
      moveTo: MoveTo.VaultingTreasury,
    });
    return;
  }
  if (key.startsWith('funder:')) {
    const accountId = key.slice(7);
    const holder = myVault.data.currentFrameBondData.bondHolders.find(h => h.accountId === accountId);
    if (holder) {
      selectedBondHolder.value = holder;
      showBondDetailOverlay.value = true;
    }
    return;
  }
}

function handleBitcoinTileClick(key: string) {
  if (key === '__remainder__') {
    if (bitcoinRemainderIsSmall.value) {
      basicEmitter.emit('openMoveCapitalOverlay', {
        walletType: WalletType.vaulting,
        moveTo: MoveTo.VaultingSecurity,
        maxAmount: bitcoinMapRemainder.value,
      });
    } else {
      openLockingOverlay();
    }
    return;
  }

  // Local lock
  const lock = localLocksByUuid.value[key];
  if (lock) {
    if (bitcoinLocks.isLockedStatus(lock) || bitcoinLocks.isReleaseStatus(lock)) {
      openLockDetailOverlay(lock);
    } else {
      openLockingOverlay(lock);
    }
    return;
  }

  // External lock (key is "chain:<utxoId>")
  if (key.startsWith('chain:')) {
    const utxoId = Number(key.slice(6));
    const extLock = myVault.data.externalLocks[utxoId];
    if (extLock) {
      openLockDetailOverlay({
        utxoId: extLock.utxoId,
        satoshis: extLock.satoshis,
        liquidityPromised: extLock.liquidityPromised,
        status: deriveExternalLockStatus(extLock),
        lockDetails: extLock.lockDetails,
      } as IBitcoinLockRecord);
    }
  }
}

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

  const localLocks = bitcoinLocks.getActiveLocks();
  for (const lock of localLocks) {
    const microgons = bitcoinLocks.getDisplayLiquidityPromised(lock);
    const tileStatus = getLockTileStatus(lock);
    items.push({
      id: lock.uuid,
      label: formatLockLabel(lock),
      amount: microgons,
      displayValue: formatMoney(microgons),
      emphasis: bitcoinLocks.isLockedStatus(lock) ? 'strong' : 'default',
      status: tileStatus,
    });
  }

  for (const extLock of Object.values(myVault.data.externalLocks)) {
    const microgons = extLock.liquidityPromised ?? 0n;
    const btc = currency.convertSatToBtc(extLock.satoshis);
    const hasPendingCosign = myVault.data.pendingCosignUtxosById.has(extLock.utxoId);
    const status: TileStatus = extLock.isPending ? 'pending' : hasPendingCosign ? 'pending' : 'active';
    items.push({
      id: `chain:${extLock.utxoId}`,
      label: `${numeral(btc).format('0,0.[0000]')} BTC`,
      amount: microgons,
      displayValue: formatMoney(microgons),
      emphasis: 'strong',
      status,
    });
  }

  return items;
});

const bitcoinMapRemainder = Vue.computed(() => {
  const used = bitcoinMapItems.value.reduce((sum, item) => sum + item.amount, 0n);
  return bitcoinMapTotal.value > used ? bitcoinMapTotal.value - used : 0n;
});

const bitcoinRemainderIsSmall = Vue.computed(() => {
  const total = bitcoinMapTotal.value;
  if (total <= 0n) return true;
  return bitcoinMapRemainder.value * 100n < total;
});

const bitcoinRemainderLabel = Vue.computed(() => {
  return bitcoinRemainderIsSmall.value ? 'Add BTC Space' : 'Unused BTC Space';
});

const bitcoinRemainderDisplayValue = Vue.computed(() => {
  return bitcoinRemainderIsSmall.value ? '' : formatMoney(bitcoinMapRemainder.value);
});

const bondMapTotal = Vue.computed(() => {
  return vaultingBreakdown.treasuryMicrogonsMaxCapacity / 10n;
});

const treasuryBondsActivated = Vue.computed(() => {
  return bigIntMin(vaultingBreakdown.treasuryMicrogons, vaultingBreakdown.treasuryMicrogonsMaxCapacity);
});

const bondMapItems = Vue.computed((): MapItem[] => {
  // Historical frames: fall back to aggregated internal/external tiles
  if (!currentFrameIsActive.value) {
    const items: MapItem[] = [];
    if (treasuryBondsActivated.value > 0n) {
      items.push({
        id: 'internal-bonds',
        label: 'Treasury Bonds',
        amount: treasuryBondsActivated.value,
        displayValue: formatMoney(treasuryBondsActivated.value),
        emphasis: 'strong',
      });
    }
    if (externalTreasuryBonds.value > 0n) {
      items.push({
        id: 'external-bonds',
        label: 'External Treasury Bonds',
        amount: externalTreasuryBonds.value,
        displayValue: formatMoney(externalTreasuryBonds.value),
      });
    }
    return items;
  }

  // Current frame: per-holder tiles from vaultPoolsByFrame
  const holders = myVault.data.currentFrameBondData.bondHolders;
  const items: MapItem[] = [];

  for (const holder of holders) {
    if (holder.bondedAmount > 0n) {
      items.push({
        id: `funder:${holder.accountId}`,
        label: formatMoney(holder.bondedAmount),
        amount: holder.bondedAmount,
        emphasis: holder.isOperator ? 'strong' : 'default',
      });
    }
  }

  // If no frame data yet, fall back to aggregated data
  if (holders.length === 0) {
    if (treasuryBondsActivated.value > 0n) {
      items.push({
        id: 'internal-bonds',
        label: 'Treasury Bonds',
        amount: treasuryBondsActivated.value,
        displayValue: formatMoney(treasuryBondsActivated.value),
        emphasis: 'strong',
      });
    }
    if (externalTreasuryBonds.value > 0n) {
      items.push({
        id: 'external-bonds',
        label: 'External Treasury Bonds',
        amount: externalTreasuryBonds.value,
        displayValue: formatMoney(externalTreasuryBonds.value),
      });
    }
  }

  return items;
});

const bondMapRemainder = Vue.computed(() => {
  const used = bondMapItems.value.reduce((sum, item) => sum + item.amount, 0n);
  return bondMapTotal.value > used ? bondMapTotal.value - used : 0n;
});

const showEditOverlay = Vue.ref(false);
const showLockDetailOverlay = Vue.ref(false);
const showBondDetailOverlay = Vue.ref(false);
const selectedLock = Vue.ref<IBitcoinLockRecord | undefined>(undefined);
const selectedBondHolder = Vue.ref<IFrameBondHolder | undefined>(undefined);

function openLockingOverlay(lock?: IBitcoinLockRecord) {
  basicEmitter.emit('openBitcoinLock', { lock });
}

function openLockDetailOverlay(lock: IBitcoinLockRecord) {
  selectedLock.value = lock;
  showLockDetailOverlay.value = true;
}

function closeLockDetailOverlay() {
  showLockDetailOverlay.value = false;
  selectedLock.value = undefined;
}

function closeBondDetailOverlay() {
  showBondDetailOverlay.value = false;
  selectedBondHolder.value = undefined;
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

const hasNextFrame = Vue.computed(() => {
  return sliderFrameIndex.value < frameRecords.value.length - 1;
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
  showEditOverlay.value = true;
}

function openPortfolioPanel(tab: PortfolioTab) {
  basicEmitter.emit('openPortfolioPanel', tab);
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

async function loadChartData(currentFrameId?: number) {
  const profitAnalysis = new ProfitAnalysis(vaults, myVault, miningFrames, currentFrameId);
  await profitAnalysis.update();

  chartItems.value = profitAnalysis.items;
  frameRecords.value = profitAnalysis.records;
  const targetFrameId = currentFrameId ?? currentFrame.value.id;
  currentFrame.value =
    frameRecords.value.find(frame => frame.id === targetFrameId) ?? frameRecords.value.at(-1) ?? currentFrame.value;
}

function openVaultInvitesOverlay() {
  basicEmitter.emit('openVaultInvitesOverlay');
}

function openVaultMembersOverlay() {
  basicEmitter.emit('openVaultMembersOverlay');
}

let onFrameSubscription: { unsubscribe: () => void };
let onTickSubscription: { unsubscribe: () => void };

Vue.onMounted(async () => {
  await miningFrames.load();
  await myVault.load();
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
