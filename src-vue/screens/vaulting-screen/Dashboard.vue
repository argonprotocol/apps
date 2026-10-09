<!-- prettier-ignore -->
<template>
  <div data-testid="VaultingDashboard" class="flex flex-col h-full">
    <div class="flex flex-col h-full gap-y-2 justify-stretch grow">
      <TooltipProvider :disableHoverableContent="true">
        <section class="flex flex-row gap-x-2 h-[14%]">
          <TooltipRoot>
            <TooltipTrigger as="div" box stat-box class="flex flex-col w-[20%] !py-4 group">
              <span>
                <template v-if="vaultingBreakdown.bitcoinLockedValueMicrogons !== undefined">{{ currency.symbol }}{{ microgonToMoneyNm(vaultingBreakdown.bitcoinLockedValueMicrogons).formatIfElse('< 1_000', '0,0.00', '0,0') }}</template>
                <template v-else>&mdash;</template>
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
              <span v-if="revenueMicrogons !== undefined">{{ microgonToMoneyNm(revenueMicrogons).formatCurrency(currency.symbol, 1_000) }}</span>
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
                  >
                    <template #displayValue="{ item }">
                      <Tooltip v-if="item.key === bitcoinMapOverflow.lock?.id" as-child>
                        <span tabindex="0" aria-label="Bitcoin exceeds vault capacity" class="inline-flex items-center gap-1 text-yellow-800">
                          <AlertIcon class="size-4 shrink-0" />
                          {{ item.displayValue }}
                        </span>
                        <template #content>
                          Bitcoin exceeds your vault’s capacity by {{ currency.symbol }}{{ microgonToMoneyNm(bitcoinMapOverflow.microgons).format('0,0', Math.ceil) }}. Add securitization to cover it.
                        </template>
                      </Tooltip>
                      <span v-else class="opacity-60">{{ item.displayValue }}</span>
                    </template>
                    <template #footer="{ rectangles }">
                      <Tooltip
                        v-if="bitcoinMapOverflow.lock && !rectangles.some(rect => rect.key === bitcoinMapOverflow.lock?.id && !rect.isCompact)"
                        as-child
                      >
                        <div tabindex="0" aria-label="Bitcoin exceeds vault capacity" class="flex items-center justify-center gap-1 rounded border border-yellow-400 bg-yellow-100 px-2 py-1 text-sm text-yellow-800">
                          <AlertIcon class="size-4 shrink-0" />
                          {{ bitcoinMapOverflow.lock?.label }} · {{ bitcoinMapOverflow.lock?.displayValue }}
                        </div>
                        <template #content>
                          Bitcoin exceeds your vault’s capacity by {{ currency.symbol }}{{ microgonToMoneyNm(bitcoinMapOverflow.microgons).format('0,0', Math.ceil) }}. Add securitization to cover it.
                        </template>
                      </Tooltip>
                    </template>
                  </TreemapChart>
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
                  <div class="grid grid-cols-3 items-start gap-x-4 gap-y-5 text-center text-base leading-none text-slate-700/80 pt-3">
                    <TooltipRoot :delayDuration="200">
                      <TooltipTrigger as="div" class="cursor-help">{{currency.symbol}}{{ microgonToMoneyNm(bitcoinLockCapacity).format('0,0.00') }} In Potential BTC Locks</TooltipTrigger>
                      <TooltipContent side="bottom" :sideOffset="4" :collisionPadding="9" class="text-md z-50 w-xs rounded-md border border-gray-800/20 bg-white px-4 py-3 text-left leading-5.5 font-light text-slate-900/60 shadow-2xl">
                        The total argon value of bitcoin that could be locked in your vault based on your securitization commitment.
                        <TooltipArrow :width="27" :height="15" class="-mt-px fill-white stroke-gray-800/20 stroke-[0.5px]" />
                      </TooltipContent>
                    </TooltipRoot>
                    <TooltipRoot :delayDuration="200">
                      <TooltipTrigger as="div" class="cursor-help">
                        {{ microgonToMoneyNm(potentialDailyRevenue).formatCurrency(currency.symbol, 1_000) }}
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
                        class="flex w-full cursor-pointer flex-col items-center justify-start gap-1 hover:underline"
                        @click="openSecuritization('ARGN')"
                      >
                        <span class="inline-flex items-center gap-1" :class="{ 'text-yellow-800': vaultingBreakdown.bitcoinUndersecuritized }">
                          <AlertIcon v-if="vaultingBreakdown.bitcoinUndersecuritized" class="size-4 shrink-0" />
                          <template v-if="vaultingBreakdown.bitcoinUndersecuritized">Only {{ numeral(getCappedPercent(vaultingBreakdown.securityMicrogons, vaultingBreakdown.bitcoinRequiredSecuritizationMicrogons!)).format('0,0.[0]') }}% of BTC Securitizable</template>
                          <template v-else-if="bitcoinMapTotal > 0n">{{ numeral(getCappedPercent(bitcoinMapUsed, bitcoinMapTotal)).format('0,0.[0]') }}% of Bitcoin Is Securitized</template>
                          <template v-else>No Bitcoin Capacity</template>
                        </span>
                        <span v-if="vaultingBreakdown.bitcoinUndersecuritized" class="text-xs text-yellow-800">
                          Add {{ microgonToArgonNm(vaultingBreakdown.bitcoinFundingShortfallMicrogons).format('0,0', Math.ceil) }} ARGN
                        </span>
                      </TooltipTrigger>
                      <TooltipContent side="bottom" :sideOffset="4" :collisionPadding="9" class="text-md z-50 w-xs rounded-md border border-gray-800/20 bg-white px-4 py-3 text-left leading-5.5 font-light text-slate-900/60 shadow-2xl">
                        <template v-if="vaultingBreakdown.bitcoinUndersecuritized">The percentage of your Bitcoin's current market value that your vault's ARGN can cover.</template>
                        <template v-else>The percentage of your vault's Bitcoin capacity in use, capped at 100%.</template>
                        Liquids retain their collateral space. Ordinary locks fill the rest, biggest first.
                        Tile amounts show their full requirement, even when it exceeds the space available.
                        <TooltipArrow :width="27" :height="15" class="-mt-px fill-white stroke-gray-800/20 stroke-[0.5px]" />
                      </TooltipContent>
                    </TooltipRoot>
                    <PopoverRoot v-model:open="revenuePopoverOpen">
                      <PopoverAnchor as-child>
                      <button
                        type="button"
                        class="flex w-full cursor-pointer flex-col items-center justify-start gap-1 hover:underline"
                        data-revenue-capture
                        aria-haspopup="dialog"
                        :aria-expanded="revenuePopoverOpen"
                        @pointerenter="showRevenuePopover"
                        @pointerleave="closeRevenuePopoverLater"
                        @click="pinRevenuePopover"
                      >
                        <span class="flex items-center gap-1" :class="hasArgonotRewardAlert ? 'text-yellow-800' : ''">
                          <AlertIcon v-if="hasArgonotRewardAlert" class="size-4 shrink-0 text-yellow-700" />
                          <template v-if="vaultingBreakdown.revenueCapturedPct !== undefined">{{ numeral(vaultingBreakdown.revenueCapturedPct).format('0,0.0') }}% of Revenue Captured</template>
                          <template v-else>Daily Revenue Capture Unavailable</template>
                        </span>
                      </button>
                      </PopoverAnchor>
                      <PopoverPortal>
                      <PopoverContent aria-label="Maximizing Daily Revenue" @openAutoFocus.prevent @pointerenter="showRevenuePopover" @pointerleave="closeRevenuePopoverLater" side="bottom" :sideOffset="8" :collisionPadding="24" :style="floatingZIndex" class="text-md w-xs rounded-md border border-gray-800/20 bg-white py-3 text-left leading-5.5 font-light text-slate-900/60 shadow-2xl">
                        <template v-if="vaultingBreakdown.revenuePotential?.capturedPercent !== undefined && currentVaultFramePosition && argonBonds.data.frameCapital">
                          <h3 class="border-b border-slate-300 px-4 pb-2 text-base font-semibold text-slate-700">Maximizing Daily Revenue</h3>
                          <table class="w-full text-sm tabular-nums">
                            <tbody>
                              <tr class="group border-b border-slate-100">
                                <th scope="row" class="py-2 pl-4 text-left font-normal">
                                  <span class="inline-flex items-center gap-1">
                                    Bitcoin Locked
                                    <Tooltip @update:open="revenueTooltipOpen = $event" as-child side="left">
                                      <button type="button" aria-label="Bitcoin locked percentage" class="inline-flex cursor-help">
                                        <InformationCircleIcon class="size-3.5" />
                                      </button>
                                      <template #content>Maximize rewards by filling your Bitcoin space and keeping enough Argon securitization for all Bitcoin locks.</template>
                                    </Tooltip>
                                  </span>
                                </th>
                                <td class="py-2 pl-3 text-right">
                                  <span class="inline-flex items-center gap-1">
                                    <Tooltip @update:open="revenueTooltipOpen = $event" v-if="frameBitcoinUndersecuritized" as-child side="left">
                                      <button type="button" aria-label="Bitcoin is undersecuritized" class="inline-flex cursor-help">
                                        <AlertIcon class="size-3.5 text-yellow-700" />
                                      </button>
                                      <template #content>
                                        Bitcoin was undersecuritized when this frame began, reducing the Bitcoin usage counted for rewards.
                                        <template v-if="vaultingBreakdown.bitcoinUndersecuritized">Add Argon securitization to restore it.</template>
                                        <template v-else-if="vaultingBreakdown.bitcoinRequiredSecuritizationMicrogons !== undefined">Your current funding is sufficient; rewards update next frame.</template>
                                      </template>
                                    </Tooltip>
                                    <template v-if="frameBitcoinUsagePercent > 0 && frameBitcoinUsagePercent < 0.1">&lt;0.1%</template>
                                    <template v-else>{{ numeral(frameBitcoinUsagePercent).format('0,0.0') }}%</template>
                                  </span>
                                </td>
                              <td class="w-10 pr-4 pl-2 text-right">
                                  <button type="button" data-revenue-action aria-label="Edit Bitcoin securitization" class="text-argon-600/60 inline-flex cursor-pointer opacity-0 group-hover:opacity-100 focus-visible:opacity-100" @click="openSecuritization('ARGN')">
                                    <EditIcon class="size-3.5" />
                                  </button>
                                </td>
                              </tr>
                              <tr class="group border-b border-slate-100">
                                <th scope="row" class="py-2 pl-4 text-left font-normal">
                                  <span class="inline-flex items-center gap-1">
                                    Argon Bonds
                                    <Tooltip @update:open="revenueTooltipOpen = $event" as-child side="left">
                                      <button type="button" aria-label="Argon bond capacity percentage" class="inline-flex cursor-help">
                                        <InformationCircleIcon class="size-3.5" />
                                      </button>
                                      <template #content>Maximize rewards by selling 100% of your vault’s Argon Bonds.</template>
                                    </Tooltip>
                                  </span>
                                </th>
                                <td class="py-2 pl-3 text-right">
                                  <template v-if="frameBondUsagePercent > 0 && frameBondUsagePercent < 0.1">&lt;0.1%</template>
                                  <template v-else>{{ numeral(frameBondUsagePercent).format('0,0.0') }}%</template>
                                </td>
                              <td class="w-10 pr-4 pl-2 text-right">
                                  <button type="button" data-revenue-action aria-label="Invite bond investors" class="text-argon-600/60 inline-flex cursor-pointer opacity-0 group-hover:opacity-100 focus-visible:opacity-100" @click="openInvestorInvite">
                                    <EditIcon class="size-3.5" />
                                  </button>
                                </td>
                              </tr>
                              <tr class="group border-b border-slate-100">
                                <th scope="row" class="py-2 pl-4 text-left font-normal">
                                  <span class="inline-flex items-center gap-1">
                                    Argonot Securitization
                                    <Tooltip @update:open="revenueTooltipOpen = $event" as-child side="left">
                                      <button type="button" aria-label="Argonot securitization percentage" class="inline-flex cursor-help">
                                        <InformationCircleIcon class="size-3.5" />
                                      </button>
                                      <template #content>
                                        Maximize rewards by locking ARGNOT worth 2× your Argon securitization.
                                        <template v-if="vaultingBreakdown.argonotRewardBacking">
                                          Your vault needs {{ micronotToArgonotNm(vaultingBreakdown.argonotRewardBacking.totalMicronots).format('0,0') }} ARGNOT at the protocol price.
                                        </template>
                                        <template v-else>The required ARGNOT amount is unavailable.</template>
                                      </template>
                                    </Tooltip>
                                  </span>
                                </th>
                                <td class="py-2 pl-3 text-right">
                                  <template v-if="argonotMaxReturnsPercent === undefined">&mdash;</template>
                                  <template v-else-if="argonotMaxReturnsPercent > 0 && argonotMaxReturnsPercent < 0.1">&lt;0.1%</template>
                                  <template v-else>{{ numeral(argonotMaxReturnsPercent).format('0,0.0') }}%</template>
                                </td>
                              <td class="w-10 pr-4 pl-2 text-right">
                                  <button type="button" data-revenue-action aria-label="Edit Argonot securitization" class="text-argon-600/60 inline-flex cursor-pointer opacity-0 group-hover:opacity-100 focus-visible:opacity-100" @click="openSecuritization('ARGNOT')">
                                    <EditIcon class="size-3.5" />
                                  </button>
                                </td>
                              </tr>
                              <tr class="group">
                                <th scope="row" class="py-2 pl-4 text-left font-normal">
                                  <span class="inline-flex items-center gap-1">
                                    Argon Securitization
                                    <Tooltip @update:open="revenueTooltipOpen = $event" as-child side="left">
                                      <button type="button" aria-label="Argon network securitization percentage" class="inline-flex cursor-help">
                                        <InformationCircleIcon class="size-3.5" />
                                      </button>
                                      <template #content>
                                        Increase Argon securitization to earn a larger share of network rewards.
                                        Network target: {{ microgonToArgonNm(argonBonds.data.frameCapital.targetSecuritization).format('0,0') }} ARGN.
                                      </template>
                                    </Tooltip>
                                  </span>
                                </th>
                                <td class="py-2 pl-3 text-right">
                                  <template v-if="vaultingBreakdown.revenuePotential.securitizationPercent === undefined">&mdash;</template>
                                  <template v-else-if="vaultingBreakdown.revenuePotential.securitizationPercent > 0 && vaultingBreakdown.revenuePotential.securitizationPercent < 0.1">&lt;0.1%</template>
                                  <template v-else>{{ numeral(vaultingBreakdown.revenuePotential.securitizationPercent).format('0,0.0') }}%</template>
                                </td>
                              <td class="w-10 pr-4 pl-2 text-right">
                                  <button type="button" data-revenue-action aria-label="Edit Argon securitization" class="text-argon-600/60 inline-flex cursor-pointer opacity-0 group-hover:opacity-100 focus-visible:opacity-100" @click="openSecuritization('ARGN')">
                                    <EditIcon class="size-3.5" />
                                  </button>
                                </td>
                              </tr>
                            </tbody>
                            <tfoot class="border-t border-slate-300 font-semibold text-slate-700">
                              <tr>
                                <th scope="row" class="pt-2 pl-4 text-left font-semibold">Daily Revenue Captured</th>
                                <td class="pt-2 pl-3 text-right">
                                  <template v-if="vaultingBreakdown.revenuePotential.capturedPercent > 0 && vaultingBreakdown.revenuePotential.capturedPercent < 0.1">&lt;0.1%</template>
                                  <template v-else>{{ numeral(vaultingBreakdown.revenuePotential.capturedPercent).format('0,0.0') }}%</template>
                                </td>
                                <td class="w-10 pr-4 pl-2" />
                              </tr>
                            </tfoot>
                          </table>
                          <p class="mt-3 px-4 text-xs">
                            Explore revenue using the
                            <a
                              href="https://argon.network/docs/system-design/economic-drivers#Vaulting"
                              target="_blank"
                              rel="noopener noreferrer"
                              class="text-argon-600 inline-flex items-center gap-1 underline"
                            >
                              calculator
                              <ArrowTopRightOnSquareIcon class="size-3" />
                            </a>.
                          </p>
                        </template>
                        <template v-else>Daily revenue capture is unavailable for this frame.</template>
                        <PopoverPanelArrow class="-translate-y-px" />
                      </PopoverContent>
                      </PopoverPortal>
                    </PopoverRoot>
                    <TooltipRoot :delayDuration="200">
                      <TooltipTrigger as="div" class="cursor-help">{{ numeral(vaultingBreakdown.treasuryBondCapacityUsedPct).format('0,0.0')}}% of Allowed Bonds Are Secured</TooltipTrigger>
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
              @changedFrame="updateSliderFrame">
              <template #tooltipHeader="{ item }">
                {{ dayjs.utc(item.date).local().format('MMMM D, h:mm A') }} to
                {{ dayjs.utc((miningFrames.getTickEnd(item.id) + 1) * TICK_MILLIS).local().format('MMMM D, h:mm A') }}
              </template>
              <template #tooltip="{ item }">
                <div v-if="chartReturnsByFrame[item.id]" class="space-y-3 whitespace-nowrap">
                  <div class="grid grid-cols-3 divide-x divide-slate-300 border-b border-slate-200 py-1 pb-4 text-center">
                    <div class="px-4">
                      <header class="font-semibold text-slate-500">Earnings</header>
                      <div class="text-argon-600 pt-1 font-mono text-3xl font-bold">
                        <template v-if="chartReturnsByFrame[item.id].earningsMicrogons !== undefined">
                          {{ currency.recordsByKey.ARGN.symbol }}{{ microgonToArgonNm(chartReturnsByFrame[item.id].earningsMicrogons!).formatIfElse('< 100', '0,0.00', '0,0') }}
                        </template>
                        <template v-else>&mdash;</template>
                      </div>
                      <p class="mt-1 text-slate-500">
                        <template v-if="chartReturnsByFrame[item.id].frameProfitPercent !== undefined">
                          <template v-if="chartReturnsByFrame[item.id].frameProfitPercent! > 0 && chartReturnsByFrame[item.id].frameProfitPercent! < 0.1">&lt;0.1%</template>
                          <template v-else>{{ numeral(chartReturnsByFrame[item.id].frameProfitPercent).format('0,0.[0]') }}%</template>
                          return
                        </template>
                        <template v-else-if="item.isFiller">Not active</template>
                        <template v-else-if="item.id === miningFrames.currentFrameId">In progress</template>
                        <template v-else>Unavailable</template>
                      </p>
                    </div>
                    <div class="px-4">
                      <header class="font-semibold text-slate-500">Bitcoin Locked</header>
                      <div class="text-argon-600 pt-1 font-mono text-3xl font-bold">
                        <template v-if="chartStatsByFrame[item.id]?.securitization > 0n">
                          {{ numeral(getCappedPercent(chartStatsByFrame[item.id].securitizationActivated, chartStatsByFrame[item.id].securitization)).format('0,0.[0]') }}%
                        </template>
                        <template v-else>&mdash;</template>
                      </div>
                      <p class="mt-1 text-slate-500">of space filled</p>
                    </div>
                    <div class="px-4">
                      <header class="font-semibold text-slate-500">Argon Bonds</header>
                      <div class="text-argon-600 pt-1 font-mono text-3xl font-bold">
                        <template v-if="chartStatsByFrame[item.id]?.securitization > 0n">
                          {{ numeral(getPercent(chartStatsByFrame[item.id].treasuryPool.externalCapital + chartStatsByFrame[item.id].treasuryPool.vaultCapital, chartStatsByFrame[item.id].securitization)).format('0,0.[0]') }}%
                        </template>
                        <template v-else>&mdash;</template>
                      </div>
                      <p class="mt-1 text-slate-500">of space filled</p>
                    </div>
                  </div>
                  <div v-if="chartReturnsByFrame[item.id].earningsMicrogons !== undefined && chartStatsByFrame[item.id]?.bitcoinFeeCouponValueUsed !== undefined">
                    <h4 class="mb-2 font-semibold text-slate-700">Earnings Breakdown</h4>
                    <div class="space-y-1">
                      <p class="flex justify-between gap-6">
                        <span class="text-slate-500">Bitcoin Locking Fees</span>
                        <span>{{ currency.recordsByKey.ARGN.symbol }}{{ microgonToArgonNm(chartStatsByFrame[item.id].bitcoinFeeRevenue - chartStatsByFrame[item.id].bitcoinFeeCouponValueUsed!).format('0,0.00') }}</span>
                      </p>
                      <p class="flex justify-between gap-6">
                        <span class="text-slate-500">Vault Rewards</span>
                        <span>{{ currency.recordsByKey.ARGN.symbol }}{{ microgonToArgonNm(chartReturnsByFrame[item.id].earningsMicrogons! - chartStatsByFrame[item.id].bitcoinFeeRevenue + chartStatsByFrame[item.id].bitcoinFeeCouponValueUsed!).format('0,0.00') }}</span>
                      </p>
                    </div>
                  </div>
                  <div v-if="chartStatsByFrame[item.id]?.securitization > 0n" class="border-t border-slate-200 pt-3">
                    <h4 class="mb-2 font-semibold text-slate-700">Vault Capital</h4>
                    <p class="flex justify-between gap-6">
                      <span class="text-slate-500">Argon Securitization</span>
                      <span>{{ microgonToArgonNm(chartStatsByFrame[item.id].securitization).format('0,0.[00]') }} ARGN</span>
                    </p>
                    <p v-if="chartStatsByFrame[item.id].argonotSecuritizationMicronots !== undefined" class="mt-1 flex justify-between gap-6">
                      <span class="text-slate-500">Argonot Securitization</span>
                      <span>{{ micronotToArgonotNm(chartStatsByFrame[item.id].argonotSecuritizationMicronots!).format('0,0.[00]') }} ARGNOT</span>
                    </p>
                  </div>
                  <div class="border-t border-slate-200 pt-3">
                    <h4 class="mb-2 font-semibold text-slate-700">Network</h4>
                    <p class="flex justify-between gap-6">
                      <span class="text-slate-500">Auction Pool</span>
                      <span v-if="chartNetworkPoolsByFrame[item.id]">{{ microgonToArgonNm(chartNetworkPoolsByFrame[item.id].auctionPoolMicrogons).format('0,0.[00]') }} ARGN</span>
                      <span v-else>&mdash;</span>
                    </p>
                    <p class="mt-1 flex justify-between gap-6">
                      <span class="text-slate-500">
                        <template v-if="chartNetworkPoolsByFrame[item.id]?.includesBondPayments">Vault &amp; Bond Pool</template>
                        <template v-else>Vault Rewards Pool</template>
                      </span>
                      <span v-if="chartNetworkPoolsByFrame[item.id]?.vaultPoolMicrogons !== undefined">{{ microgonToArgonNm(chartNetworkPoolsByFrame[item.id].vaultPoolMicrogons!).format('0,0.[00]') }} ARGN</span>
                      <span v-else>&mdash;</span>
                    </p>
                  </div>
                </div>
              </template>
            </FrameSlider>
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
import { getMyVault, getVaults } from '../../stores/vaults.ts';
import type { IExternalBitcoinLock } from '../../lib/MyVault.ts';
import { getConfig } from '../../stores/config.ts';
import { TICK_MILLIS } from '../../lib/Env.ts';
import BitcoinLockDetailOverlay from '../../overlays/BitcoinLockDetailOverlay.vue';
import BondDetailOverlay from '../../overlays/BondDetailOverlay.vue';
import {
  bigIntMax,
  bigIntMin,
  bigNumberToBigInt,
  BondLot,
  getPercent,
  NetworkConfig,
  TreasuryBonds,
  type IAllVaultStats,
  type IVaultFrameStats,
} from '@argonprotocol/apps-core';
import {
  TooltipProvider,
  TooltipRoot,
  TooltipTrigger,
  TooltipContent,
  TooltipArrow,
  PopoverRoot,
  PopoverAnchor,
  PopoverContent,
  PopoverPortal,
} from 'reka-ui';
import { getMainchainClient, getMiningFrames } from '../../stores/mainchain.ts';
import { getBitcoinLocks } from '../../stores/bitcoin.ts';
import basicEmitter from '../../emitters/basicEmitter.ts';
import { ProfitAnalysis } from '../../lib/ProfitAnalysis.ts';
import { allocateBitcoinVaultSpace, useVaultingAssetBreakdown } from '../../stores/vaultingAssetBreakdown.ts';
import { getArgonBonds } from '../../stores/argonBonds.ts';
import type { IVaultArgonBondState } from '../../lib/ArgonBonds.ts';
import TreemapChart, { type TileStatus } from '../../components/TreemapChart.vue';
import { BitcoinLockStatus, type IBitcoinLockRecord } from '../../lib/db/BitcoinLocksTable.ts';
import { TopTab } from '../../interfaces/IConfig.ts';
import { OperationalStepId, useCertificationController } from '../../stores/certificationController.ts';
import ArrowCalloutButton from '../../components/ArrowCalloutButton.vue';
import { useFinancials } from '../../stores/financials.ts';
import AlertIcon from '../../assets/alert.svg?component';
import EditIcon from '../../assets/edit.svg?component';
import PopoverPanelArrow from '../../components/PopoverPanelArrow.vue';
import { useFloatingZIndex } from '../../overlays/helpers/OverlayZIndex.ts';
import { ArrowTopRightOnSquareIcon, InformationCircleIcon } from '@heroicons/vue/24/outline';
import Tooltip from '../../components/Tooltip.vue';
import { getCappedPercent } from '../../lib/Utils.ts';
import BigNumber from 'bignumber.js';
import { useWallets } from '../../stores/wallets.ts';
import { useMiningStats } from '../../stores/miningStats.ts';

dayjs.extend(utc);

const myVault = getMyVault();
const vaults = getVaults();
const controller = useCertificationController();
const bitcoinLocks = getBitcoinLocks();
const config = getConfig();
const currency = getCurrency();
const argonBonds = getArgonBonds();
const financials = useFinancials();
const wallets = useWallets();
const miningStats = useMiningStats();

const vaultingBreakdown = useVaultingAssetBreakdown();
const currentVaultFramePosition = Vue.computed(() => {
  const vaultId = myVault.vaultId;
  return vaultId == null ? undefined : argonBonds.data.frameCapital?.vaultSecuritizationPositions[vaultId];
});
const revenuePopoverOpen = Vue.ref(false);
let revenuePopoverPinned = false;
let revenuePopoverHovered = false;
const revenueTooltipOpen = Vue.ref(false);
let revenueCloseTimer: ReturnType<typeof setTimeout> | undefined;

function showRevenuePopover() {
  revenuePopoverHovered = true;
  clearTimeout(revenueCloseTimer);
  revenuePopoverOpen.value = true;
}

function closeRevenuePopoverLater() {
  revenuePopoverHovered = false;
  if (revenuePopoverPinned) return;
  if (revenueTooltipOpen.value) return;
  clearTimeout(revenueCloseTimer);
  revenueCloseTimer = setTimeout(() => {
    revenuePopoverOpen.value = false;
  }, 200);
}

function pinRevenuePopover() {
  clearTimeout(revenueCloseTimer);
  revenuePopoverPinned = !revenuePopoverPinned;
  revenuePopoverOpen.value = revenuePopoverPinned;
}

Vue.watch(revenueTooltipOpen, isOpen => {
  if (!isOpen && !revenuePopoverHovered) closeRevenuePopoverLater();
});
Vue.watch(revenuePopoverOpen, isOpen => {
  if (!isOpen) revenuePopoverPinned = false;
});
Vue.onBeforeUnmount(() => clearTimeout(revenueCloseTimer));
const floatingZIndex = useFloatingZIndex();
const frameBitcoinUsagePercent = Vue.computed(() => {
  const position = currentVaultFramePosition.value;
  if (!position) return 0;
  return getCappedPercent(position.activatedSecuritization, position.securitization);
});
const frameBondUsagePercent = Vue.computed(() => {
  const position = currentVaultFramePosition.value;
  if (!position) return 0;
  return getCappedPercent(position.activeBondMicrogons, position.securitization);
});
const argonotMaxReturnsPercent = Vue.computed(() => {
  const position = currentVaultFramePosition.value;
  if (!position) return;
  return getCappedPercent(position.argonotSecuritizationInMicrogons, position.securitization * 2n);
});
const frameBitcoinUndersecuritized = Vue.computed(() => {
  const position = currentVaultFramePosition.value;
  if (!position) return false;
  const shortfall = position.bitcoinLockedMicrogons - position.securitization;
  if (shortfall <= 0n) return false;
  return shortfall * 100n >= position.securitization;
});

const hasArgonotRewardAlert = Vue.computed(() => {
  const backing = vaultingBreakdown.argonotRewardBacking;
  if (!backing) return false;
  if (backing.additionalMicronots > 0n) return true;
  if (backing.withdrawalCancellationMicronots > 0n) return true;
  const potential = vaultingBreakdown.revenuePotential;
  if (potential?.capturedPercent === undefined) return false;
  return (potential.capturedWithMaximumArgonotsPercent ?? 0) > potential.capturedPercent;
});

const latestFrameId = Vue.computed(() => {
  return frameRecords.value.at(-1)?.id ?? 0;
});

const { microgonToMoneyNm, microgonToArgonNm, micronotToArgonotNm } = createNumeralHelpers(currency);

const chartReturnsByFrame = Vue.computed(() => Object.fromEntries(frameRecords.value.map(frame => [frame.id, frame])));
const chartStatsByFrame = Vue.shallowRef<Record<number, IVaultFrameStats>>({});
const chartNetworkPoolsByFrame = Vue.shallowRef<NonNullable<IAllVaultStats['networkPoolsByFrame']>>({});

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
    operatorKeepPct: 100 - (myVault.createdVault.bondProfitSharing?.times(100).toNumber() ?? 0),
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
  requiredMicrogons?: bigint;
  isLiquid?: boolean;
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

const bitcoinLockCapacity = Vue.computed(() => {
  const vault = myVault.createdVault;
  if (!vault) return 0n;
  return bigNumberToBigInt(new BigNumber(vault.securitization).div(vault.securitizationRatio));
});

const bitcoinMapTotal = Vue.computed(() => {
  return vaultingBreakdown.securityMicrogons;
});

const bitcoinMapItems = Vue.computed((): MapItem[] => {
  // Historical frames: collapse to locked vs open aggregate
  if (!currentFrameIsActive.value) {
    const items: MapItem[] = [];
    const activated = bigIntMin(bitcoinMapTotal.value, vaultingBreakdown.securityMicrogonsActivated);
    const pending = bigIntMin(
      bigIntMax(0n, bitcoinMapTotal.value - activated),
      vaultingBreakdown.securityMicrogonsPending,
    );
    if (activated > 0n) {
      items.push({
        id: 'locked-aggregate',
        label: 'Bitcoin Locked',
        amount: activated,
        displayValue: formatMoney(activated),
        emphasis: 'strong',
      });
    }
    if (pending > 0n) {
      items.push({
        id: 'pending-aggregate',
        label: 'Pending Activation',
        amount: pending,
        displayValue: formatMoney(pending),
        status: 'pending',
      });
    }
    return items;
  }

  // Current frame: per-lock items
  const items: MapItem[] = [];
  const allocations = allocateBitcoinVaultSpace(
    [...localVaultLocks.value, ...Object.values(myVault.data.externalLocks).map(lock => lock.lockDetails)],
    bitcoinMapTotal.value,
    currency.priceIndex,
  );

  for (const lock of localVaultLocks.value) {
    const allocation = allocations.get(lock)!;
    const isLiquid = (lock.fissionedSatoshis ?? 0n) > 0n;
    const needsSecuritization = allocation.allocatedMicrogons < allocation.requiredMicrogons;
    const tileIsPending = !isLiquid || needsSecuritization || lock.isHistoryRecoveryPending;

    items.push({
      id: lock.uuid,
      label: formatLockLabel(lock),
      amount: allocation.allocatedMicrogons,
      requiredMicrogons: allocation.requiredMicrogons,
      isLiquid,
      displayValue: formatMoney(allocation.requiredMicrogons),
      emphasis: bitcoinLocks.isLockFunded(lock) && !lock.isHistoryRecoveryPending ? 'strong' : 'default',
      status: tileIsPending ? 'pending' : 'active',
    });
  }

  for (const extLock of Object.values(myVault.data.externalLocks)) {
    const allocation = allocations.get(extLock.lockDetails)!;
    const isLiquid = extLock.lockDetails.fissionedSatoshis > 0n;
    const needsSecuritization = allocation.allocatedMicrogons < allocation.requiredMicrogons;

    items.push({
      id: `chain:${extLock.lockId}`,
      label: formatLockLabel(extLock),
      amount: allocation.allocatedMicrogons,
      requiredMicrogons: allocation.requiredMicrogons,
      isLiquid,
      displayValue: formatMoney(allocation.requiredMicrogons),
      emphasis: 'strong',
      status: !isLiquid || needsSecuritization || extLock.isPending ? 'pending' : 'active',
    });
  }

  return items;
});

const bitcoinMapOverflow = Vue.computed(() => {
  let requiredTotal = 0n;
  let largestLock: MapItem | undefined;
  let largestLiquid: MapItem | undefined;
  for (const item of bitcoinMapItems.value) {
    const required = item.requiredMicrogons ?? item.amount;
    requiredTotal += required;
    if (item.amount === 0n) continue;

    if (item.isLiquid) {
      if (!largestLiquid || required > largestLiquid.requiredMicrogons!) largestLiquid = item;
      continue;
    }

    // The largest displayed ordinary lock carries the vault-wide warning, even if a later lock overflows.
    if (!largestLock || required > largestLock.requiredMicrogons!) largestLock = item;
  }
  const microgons = bigIntMax(0n, requiredTotal - bitcoinMapTotal.value);
  if (microgons === 0n) return { microgons };
  return { microgons, lock: largestLock ?? largestLiquid };
});

const bitcoinMapUsed = Vue.computed(() => {
  return bitcoinMapItems.value.reduce((sum, item) => sum + item.amount, 0n);
});

const bitcoinMapRemainder = Vue.computed(() => {
  return bitcoinMapTotal.value > bitcoinMapUsed.value ? bitcoinMapTotal.value - bitcoinMapUsed.value : 0n;
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

function openSecuritization(fundingAsset: 'ARGN' | 'ARGNOT') {
  revenuePopoverOpen.value = false;
  basicEmitter.emit('openVaultSettingsOverlay', { fundingAsset });
}

function openInvestorInvite() {
  revenuePopoverOpen.value = false;
  basicEmitter.emit('openMemberInviteOverlay');
}

const miningFrames = getMiningFrames();

function loadChartData(currentFrameId?: number) {
  const profitAnalysis = new ProfitAnalysis(myVault, miningFrames, argonBonds, currentFrameId);
  profitAnalysis.update();

  chartItems.value = profitAnalysis.items;
  frameRecords.value = profitAnalysis.records;
  const stats = vaults.stats?.vaultsById[myVault.vaultId!] ?? myVault.data.stats;
  chartStatsByFrame.value = Object.fromEntries((stats?.changesByFrame ?? []).map(frame => [frame.frameId, frame]));
  chartNetworkPoolsByFrame.value = vaults.stats?.networkPoolsByFrame ?? {};
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

Vue.watch(
  () => [myVault.data.stats, vaults.currentState.statsRevision, argonBonds.data.financialRevision] as const,
  () => loadChartData(miningFrames.currentFrameId),
  { deep: true, immediate: true },
);

Vue.onMounted(async () => {
  onFrameSubscription = miningFrames.onFrameId(async frameId => {
    loadChartData(frameId);
    await refreshCurrentFrameBonds();
  });

  const client = await getMainchainClient(false);
  await argonBonds.subscribeGlobal(client);

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
