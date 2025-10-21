<!-- prettier-ignore -->
<template>
  <TooltipProvider :disableHoverableContent="true" data-testid="Dashboard" class="flex flex-col h-full">
    <div :class="stats.isLoaded ? '' : 'opacity-30 pointer-events-none'" class="flex flex-col h-full px-2.5 py-2.5 gap-y-2 justify-stretch grow">
      <section class="flex flex-row gap-x-2 h-[14%]">
        <TooltipRoot>
          <TooltipTrigger as="div" box stat-box class="flex flex-col w-2/12 !py-4 group">
            <span>{{ stats.global.seatsTotal || 0 }}</span>
            <label>Total Mining Seat{{ stats.global.seatsTotal === 1 ? '' : 's' }}</label>
          </TooltipTrigger>
          <TooltipContent side="bottom" :sideOffset="-10" align="start" :collisionPadding="9" class="bg-white border border-gray-800/20 rounded-md shadow-2xl z-50 p-4 w-xs text-slate-900/60">
            The number of mining seats you've controlled over the previous year.
            <TooltipArrow :width="27" :height="15" class="fill-white stroke-[0.5px] stroke-gray-800/20 -mt-px" />
          </TooltipContent>
        </TooltipRoot>
        <TooltipRoot>
          <TooltipTrigger as="div" box stat-box class="flex flex-col w-2/12 !py-4 group">
            <span>{{ numeral(stats.global.framesCompleted).format('0,0.[00]') }}</span>
            <label>Frame{{ stats.global.framesCompleted === 1 ? '' : 's' }} Completed</label>
          </TooltipTrigger>
          <TooltipContent side="bottom" :sideOffset="-10" align="start" :collisionPadding="9" class="bg-white border border-gray-800/20 rounded-md shadow-2xl z-50 p-4 w-xs text-slate-900/60">
            The number of frames that you've mined over the previous year.
            <TooltipArrow :width="27" :height="15" class="fill-white stroke-[0.5px] stroke-gray-800/20 -mt-px" />
          </TooltipContent>
        </TooltipRoot>
        <TooltipRoot>
          <TooltipTrigger as="div" box stat-box class="flex flex-col w-2/12 !py-4 group">
            <span>{{ numeral(stats.global.framesRemaining).format('0,0.[00]') }}</span>
            <label>Frame{{ stats.global.framesRemaining === 1 ? '' : 's' }} Remaining</label>
          </TooltipTrigger>
          <TooltipContent side="bottom" :sideOffset="-10" align="center" :collisionPadding="9" class="text-center bg-white border border-gray-800/20 rounded-md shadow-2xl z-50 p-4 w-xs text-slate-900/60">
            The number of future frames for which you own mining rights.
            <TooltipArrow :width="27" :height="15" class="fill-white stroke-[0.5px] stroke-gray-800/20 -mt-px" />
          </TooltipContent>
        </TooltipRoot>
        <TooltipRoot>
          <TooltipTrigger as="div" box stat-box class="flex flex-col w-2/12 !py-4 group">
            <span>
              {{ currency.symbol }}{{ microgonToMoneyNm(globalMicrogonsInvested).formatIfElse('< 100', '0.00', '0,0') }}
            </span>
            <label>Relative Total Cost</label>
          </TooltipTrigger>
          <TooltipContent side="bottom" :sideOffset="-10" align="center" :collisionPadding="9" class="text-center bg-white border border-gray-800/20 rounded-md shadow-2xl z-50 p-4 w-xs text-slate-900/60">
            Your total cost for mining frames that have already completed.
            <TooltipArrow :width="27" :height="15" class="fill-white stroke-[0.5px] stroke-gray-800/20 -mt-px" />
          </TooltipContent>
        </TooltipRoot>
        <TooltipRoot>
          <TooltipTrigger as="div" box stat-box class="flex flex-col w-2/12 !py-4 group">
            <span>
              {{ currency.symbol }}{{ microgonToMoneyNm(globalMicrogonsEarned).formatIfElse('< 100', '0.00', '0,0') }}
            </span>
            <label>Relative Total Earnings</label>
          </TooltipTrigger>
          <TooltipContent side="bottom" :sideOffset="-10" align="end" :collisionPadding="9" class="text-right bg-white border border-gray-800/20 rounded-md shadow-2xl z-50 p-4 w-xs text-slate-900/60">
            The total amount you've earned from completed mining frames.
            <TooltipArrow :width="27" :height="15" class="fill-white stroke-[0.5px] stroke-gray-800/20 -mt-px" />
          </TooltipContent>
        </TooltipRoot>
        <TooltipRoot>
          <TooltipTrigger as="div" box stat-box class="flex flex-col w-2/12 !py-4 group">
            <span>{{ numeral(globalAPY).formatIfElseCapped('< 100', '0.[00]', '0,0', 9_999) }}%</span>
            <label>Current APY</label>
          </TooltipTrigger>
          <TooltipContent side="bottom" :sideOffset="-10" align="end" :collisionPadding="9" class="text-right bg-white border border-gray-800/20 rounded-md shadow-2xl z-50 p-4 w-xs text-slate-900/60">
            Your annual percentage yield based on frames that have been completed.
            <TooltipArrow :width="27" :height="15" class="fill-white stroke-[0.5px] stroke-gray-800/20 -mt-px" />
          </TooltipContent>
        </TooltipRoot>
      </section>

      <section class="flex flex-row gap-x-2.5 grow">
        <div box class="flex flex-col w-[22.5%] px-2">
          <header class="text-[18px] font-bold py-2 text-slate-900/80 border-b border-slate-400/30">
            Asset Breakdown
          </header>
          <ul class="relative flex flex-col items-center whitespace-nowrap w-full min-h-6/12 mb-4 text-md">
            <li class="flex flex-col w-full min-h-[calc(100%/7)] pt-2 pb-3">
              <HoverCardRoot :openDelay="200" :closeDelay="100">
                <HoverCardTrigger as="div" class="flex flex-row items-center w-full hover:text-argon-600">
                  <ArgonIcon class="w-7 h-7 text-argon-600/70 mr-2" />
                  <div class="grow">Available Argons</div>
                  <div class="pr-1">
                    {{ currency.symbol
                    }}{{ microgonToMoneyNm(wallets.miningWallet.availableMicrogons).format('0,0.00') }}
                  </div>
                </HoverCardTrigger>
                <HoverCardContent align="start" :alignOffset="-20" side="right" :avoidCollisions="false" class="bg-white border border-gray-800/20 rounded-md shadow-2xl z-50 p-4 w-fit text-slate-900/60">
                  <p class="break-words whitespace-normal">
                     These argons are currently sitting unused.
                  </p>
                  <HoverCardArrow :width="27" :height="15" class="fill-white stroke-[0.5px] stroke-gray-800/20 -mt-px" />
                </HoverCardContent>
              </HoverCardRoot>
              <div class="flex flex-col ml-9 gap-y-1 text-slate-900/60">
                <HoverCardRoot :openDelay="200" :closeDelay="100">
                  <HoverCardTrigger as="div" class="border-t border-gray-600/20 border-dashed pt-2 relative hover:text-argon-600">
                    <ArrowTurnDownRightIcon class="w-5 h-5 text-slate-600/40 absolute top-1/2 -translate-y-1/2 -translate-x-[130%] left-0" />
                    {{microgonToArgonNm(unallocatedMicrogons).format('0,0.[00]')}} Needs Allocation
                  </HoverCardTrigger>
                  <HoverCardContent align="start" :alignOffset="-20" side="right" :avoidCollisions="false" class="bg-white border border-gray-800/20 rounded-md shadow-2xl z-50 p-4 w-md text-slate-900/60">
                    <p class="break-words whitespace-normal">
                      These argons are available but unallocated. Click the Allocate button to enable your
                      bot to use them to win more mining seats.
                    </p>
                    <div class="flex flex-row items-center border-t border-gray-600/20 pt-4 mt-3 w-full">
                      <button class="bg-argon-600 hover:bg-argon-700 text-white font-bold px-5 py-2 rounded-md cursor-pointer" @click="allocateMicrogons()">
                        Allocate These {{ microgonToArgonNm(unallocatedMicrogons).formatIfElse('< 100', '0,0.[00]', '0,0') }} Argons to Mining
                      </button>
                    </div>
                    <HoverCardArrow :width="27" :height="15" class="fill-white stroke-[0.5px] stroke-gray-800/20 -mt-px" />
                  </HoverCardContent>
                </HoverCardRoot>
                <HoverCardRoot :openDelay="200" :closeDelay="100">
                  <HoverCardTrigger as="div" class="border-t border-gray-600/20 border-dashed pt-2 relative hover:text-argon-600">
                    <ArrowTurnDownRightIcon class="w-5 h-5 text-slate-600/40 absolute top-1/2 -translate-y-1/2 -translate-x-[130%] left-0" />
                    {{microgonToArgonNm(unusedMicrogons).format('0,0.[00]')}} Waiting for Usage
                  </HoverCardTrigger>
                  <HoverCardContent align="start" :alignOffset="-20" side="right" :avoidCollisions="false" class="bg-white border border-gray-800/20 rounded-md shadow-2xl z-50 p-4 w-md text-slate-900/60">
                    <p class="break-words whitespace-normal">
                      These argons have been allocated for mining, but your bot hasn't found a competitively priced bid.
                    </p>
                    <HoverCardArrow :width="27" :height="15" class="fill-white stroke-[0.5px] stroke-gray-800/20 -mt-px" />
                  </HoverCardContent>
                </HoverCardRoot>
              </div>
            </li>
            <li class="flex flex-col w-full border-t border-gray-600/20 border-dashed pt-2 pb-3">
              <HoverCardRoot :openDelay="200" :closeDelay="100">
                <HoverCardTrigger as="div" class="flex flex-row items-center w-full hover:text-argon-600">
                  <ArgonotIcon class="w-7 h-7 text-argon-600/70 mr-2" />
                  <div class="grow">Available Argonots</div>
                  <div class="pr-1">
                    {{ currency.symbol
                    }}{{ micronotToArgonotNm(wallets.miningWallet.availableMicronots).format('0,0.00') }}
                  </div>
                </HoverCardTrigger>
                <HoverCardContent align="start" :alignOffset="-20" side="right" :avoidCollisions="false" class="bg-white border border-gray-800/20 rounded-md shadow-2xl z-50 p-4 w-fit text-slate-900/60">
                  <p class="break-words whitespace-normal">
                    These argonots are currently sitting unused.
                  </p>
                  <HoverCardArrow :width="27" :height="15" class="fill-white stroke-[0.5px] stroke-gray-800/20 -mt-px" />
                </HoverCardContent>
              </HoverCardRoot>
              <div class="flex flex-col ml-9 gap-y-1 text-slate-900/60">
                <HoverCardRoot :openDelay="200" :closeDelay="100">
                  <HoverCardTrigger as="div" class="border-t border-gray-600/20 border-dashed pt-2 relative hover:text-argon-600">
                    <ArrowTurnDownRightIcon class="w-5 h-5 text-slate-600/40 absolute top-1/2 -translate-y-1/2 -translate-x-[130%] left-0" />
                    {{micronotToArgonotNm(unallocatedMicronots).format('0,0.[00]')}} Needs Allocation
                  </HoverCardTrigger>
                  <HoverCardContent align="start" :alignOffset="-20" side="right" :avoidCollisions="false" class="bg-white border border-gray-800/20 rounded-md shadow-2xl z-50 p-4 w-md text-slate-900/60">
                    <p class="break-words whitespace-normal">
                      These argonots are available but unallocated. Click the Allocate button to enable your
                      bot to use them to win more mining seats.
                    </p>
                    <div class="flex flex-row items-center border-t border-gray-600/20 pt-4 mt-3 w-full">
                      <button class="bg-argon-600 hover:bg-argon-700 text-white font-bold px-5 py-2 rounded-md cursor-pointer" @click="allocateMicronots">
                        Allocate These {{ micronotToArgonotNm(unallocatedMicronots).formatIfElse('< 100', '0,0.[00]', '0,0') }} Argonots to Mining
                      </button>
                    </div>
                    <HoverCardArrow :width="27" :height="15" class="fill-white stroke-[0.5px] stroke-gray-800/20 -mt-px" />
                  </HoverCardContent>
                </HoverCardRoot>
                <HoverCardRoot :openDelay="200" :closeDelay="100">
                  <HoverCardTrigger as="div" class="border-t border-gray-600/20 border-dashed pt-2 relative hover:text-argon-600">
                    <ArrowTurnDownRightIcon class="w-5 h-5 text-slate-600/40 absolute top-1/2 -translate-y-1/2 -translate-x-[130%] left-0" />
                    {{micronotToArgonotNm(unusedMicronots).format('0,0.[00]')}} Waiting for Usage
                  </HoverCardTrigger>
                  <HoverCardContent align="start" :alignOffset="-20" side="right" :avoidCollisions="false" class="bg-white border border-gray-800/20 rounded-md shadow-2xl z-50 p-4 w-md text-slate-900/60">
                    <p class="break-words whitespace-normal">
                      These argonots have been allocated for mining, but your bot hasn't found a competitively priced bid.
                    </p>
                    <HoverCardArrow :width="27" :height="15" class="fill-white stroke-[0.5px] stroke-gray-800/20 -mt-px" />
                  </HoverCardContent>
                </HoverCardRoot>
              </div>
            </li>
            <li class="flex flex-row items-center w-full border-t border-gray-600/20 border-dashed py-2">
              <HoverCardRoot :openDelay="200" :closeDelay="100">
                <HoverCardTrigger as="div" class="flex flex-row items-center w-full hover:text-argon-600">
                  <MiningBidIcon class="w-7 h-7 text-argon-600/70 mr-2" />
                  <div class="grow">Winning <span class="hidden 2xl:inline">Mining</span> Bids ({{ numeral(stats.myMiningBids.bidCount).format('0,0') }})</div>
                  <div class="pr-1">
                    {{ currency.symbol
                    }}{{ microgonToMoneyNm(wallets.miningBidValue).format('0,0.00') }}
                  </div>
                </HoverCardTrigger>
                <HoverCardContent align="start" :alignOffset="-20" side="right" :avoidCollisions="false" class="bg-white border border-gray-800/20 rounded-md shadow-2xl z-50 p-4 w-md text-slate-900/60">
                  <p class="break-words whitespace-normal">
                    You have a total of {{ numeral(stats.myMiningBids.bidCount).format('0,0') }} winning bids in today's mining auction. They
                    include both argons and argonots at a total value of {{ currency.symbol }}{{ microgonToMoneyNm(wallets.miningBidValue).format('0,0.00') }}:
                  </p>

                  <table class="text-slate-800/50 w-full my-3">
                    <thead>
                      <tr>
                        <th class="w-1/4 h-10">Token</th>
                        <th class="w-1/4 text-right">Per Seat</th>
                        <th class="w-1/4 text-right">Total</th>
                        <th class="w-1/4 h-10 text-right">Value</th>
                      </tr>
                    </thead>
                    <tbody>
                      <tr>
                        <td class="pr-5 border-t border-gray-600/20 h-10">Argons</td>
                        <td class="border-t border-gray-600/20 text-right">{{ microgonToMoneyNm(wallets.miningBidValue).format('0,0.00') }}</td>
                        <td class="border-t border-gray-600/20 text-right">{{ microgonToMoneyNm(wallets.miningBidValue).format('0,0.00') }}</td>
                        <td class="border-t border-gray-600/20 text-right">{{ currency.symbol }}{{ microgonToMoneyNm(wallets.miningBidValue).format('0,0.00') }}</td>
                      </tr>
                      <tr>
                        <td class="pr-5 border-y border-gray-600/20 h-10">Argonots</td>
                        <td class="border-y border-gray-600/20 text-right">{{ microgonToMoneyNm(wallets.miningBidValue).format('0,0.00') }}</td>
                        <td class="border-y border-gray-600/20 text-right">{{ microgonToMoneyNm(wallets.miningBidValue).format('0,0.00') }}</td>
                        <td class="border-y border-gray-600/20 text-right">{{ currency.symbol }}{{ microgonToMoneyNm(wallets.miningBidValue).format('0,0.00') }}</td>
                      </tr>
                    </tbody>
                  </table>

                  <p class="break-words whitespace-normal">
                    If any bids lose, all associated tokens will automatically revert back to your mining wallet.
                </p>
                  <HoverCardArrow :width="27" :height="15" class="fill-white stroke-[0.5px] stroke-gray-800/20 -mt-px" />
                </HoverCardContent>
              </HoverCardRoot>
            </li>
            <li class="flex flex-row items-center w-full border-t border-gray-600/20 border-dashed py-2">
              <HoverCardRoot :openDelay="200" :closeDelay="100">
                <HoverCardTrigger as="div" class="flex flex-row items-center w-full hover:text-argon-600">
                  <MiningSeatIcon class="w-7 h-7 text-argon-600/70 mr-2" />
                  <div class="grow">Active <span class="hidden 2xl:inline">Mining</span> Seats ({{ numeral(stats.myMiningSeats.seatCount).format('0,0') }})</div>
                  <div class="pr-1">
                    {{ currency.symbol
                    }}{{ microgonToMoneyNm(wallets.miningSeatValue).format('0,0.00') }}
                  </div>
                </HoverCardTrigger>
                <HoverCardContent align="start" :alignOffset="-20" side="right" :avoidCollisions="false" class="bg-white border border-gray-800/20 rounded-md shadow-2xl z-50 p-4 w-md text-slate-900/60">
                  <p class="break-words whitespace-normal">
                    You have a total of {{ numeral(stats.myMiningSeats.seatCount).format('0,0') }} active mining seats. You won them using
                    a combination of argons and argonots. They have an currently estimated value of {{ currency.symbol }}{{ microgonToMoneyNm(wallets.miningSeatValue).format('0,0.00') }}.
                  </p>
                  <p class="break-words whitespace-normal mt-3">
                    These mining seats have {{ numeral(stats.myMiningSeats.micronotsStakedTotal).format('0,0') }} argonots
                    which will be released back into your wallet once the associated mining cycle completes.
                  </p>
                  <HoverCardArrow :width="27" :height="15" class="fill-white stroke-[0.5px] stroke-gray-800/20 -mt-px" />
                </HoverCardContent>
              </HoverCardRoot>
            </li>
            <li class="flex flex-row items-center w-full  border-t border-gray-600/40 py-2 text-red-900/70">
              <HoverCardRoot :openDelay="200" :closeDelay="100">
                <HoverCardTrigger as="div" class="flex flex-row items-center w-full hover:text-red-600">
                  <div class="grow pl-1"><span class="hidden 2xl:inline">Operational</span> Expenses</div>
                  <div class="pr-1">
                    -{{ currency.symbol
                    }}{{ microgonToMoneyNm(stats.global.transactionFeesTotal).format('0,0.00') }}
                  </div>
                </HoverCardTrigger>
                <HoverCardContent align="start" :alignOffset="-20" side="right" :avoidCollisions="false" class="bg-white border border-gray-800/20 rounded-md shadow-2xl z-50 p-4 w-md text-slate-900/60">
                  <p class="break-words whitespace-normal">
                    The summation of all operational expenses that have been paid since you started mining.
                  </p>
                  <HoverCardArrow :width="27" :height="15" class="fill-white stroke-[0.5px] stroke-gray-800/20 -mt-px" />
                </HoverCardContent>
              </HoverCardRoot>
            </li>
            <li class="flex flex-row items-center justify-between w-full border-t border-b border-gray-600/40 py-2 font-bold">
              <HoverCardRoot :openDelay="200" :closeDelay="100">
                <HoverCardTrigger as="div" class="flex flex-row items-center w-full hover:text-argon-600">
                  <div class="grow pl-1">Total Value</div>
                  <div class="pr-1">
                    {{ currency.symbol
                    }}{{ microgonToMoneyNm(wallets.totalMiningResources).format('0,0.00') }}
                  </div>
                </HoverCardTrigger>
                <HoverCardContent align="start" :alignOffset="-20" side="right" :avoidCollisions="false" class="bg-white border border-gray-800/20 rounded-md shadow-2xl z-50 p-4 w-fit text-slate-900/60">
                  <p class="break-words whitespace-normal font-normal">
                    The total value of your vault's assets.
                  </p>
                  <HoverCardArrow :width="27" :height="15" class="fill-white stroke-[0.5px] stroke-gray-800/20 -mt-px" />
                </HoverCardContent>
              </HoverCardRoot>
            </li>
          </ul>
          <div class="grow flex flex-col items-center justify-end">
            <div @click="openBotEditOverlay" class="relative text-center mb-5 text-argon-600 opacity-70 hover:opacity-100 cursor-pointer">
              <MinerIcon class="w-20 h-20 mt-5 inline-block mb-1" />
              <div>Configure Bot Settings</div>
            </div>
          </div>
        </div>

        <div class="flex flex-col grow gap-y-2">
          <section box class="flex flex-col text-center px-2 h-[15%]">
            <div class="flex flex-row pt-2 pb-1 h-full">
              <TooltipRoot>
                <TooltipTrigger as="div" class="flex flex-col w-4/12 items-center justify-center gap-x-2 pb-2 pt-3 hover:text-argon-600">
                  <div class="font-bold">Bitcoin Node</div>
                  <div class="flex flex-row items-center justify-center gap-x-2 whitespace-nowrap">
                    <div>Last Block</div>
                    <CountupClock as="span" :time="lastBitcoinActivityAt" v-slot="{ hours, minutes, seconds, isNull }" class="font-mono">
                      <template v-if="hours">{{ hours }}h, </template>
                      <template v-if="minutes || hours">{{ minutes }}m{{ !isNull && !hours ? ', ' : '' }}</template>
                      <template v-if="!isNull && !hours">{{ seconds }}s ago</template>
                      <template v-else-if="isNull">-- ----</template>
                    </CountupClock>
                    <BitcoinBlocksOverlay :position="'right'">
                      <span class="flex items-center justify-center group border border-transparent hover:border-argon-200 rounded cursor-pointer w-7 h-7 relative top-0.5">
                        <BlocksIcon class="w-4.5 h-4.5 group-hover:text-argon-600" />
                      </span>
                    </BitcoinBlocksOverlay>
                  </div>
                </TooltipTrigger>
                <TooltipContent side="bottom" :sideOffset="-10" align="center" :collisionPadding="9" class="bg-white border border-gray-800/20 rounded-md shadow-2xl z-50 p-4 w-sm text-slate-900/60">
                  Your mining software runs a lightweight bitcoin node to monitor transactions related to locking and unlocking.
                  <TooltipArrow :width="27" :height="15" class="fill-white stroke-[0.5px] stroke-gray-800/20 -mt-px" />
                </TooltipContent>
              </TooltipRoot>

              <div class="h-full w-[1px] bg-slate-400/30"></div>

              <TooltipRoot>
                <TooltipTrigger as="div" class="flex flex-col w-4/12 items-center justify-center gap-x-2 pb-2 pt-3 hover:text-argon-600">
                  <div class="font-bold">Argon Node</div>
                  <div class="flex flex-row items-center justify-center gap-x-2 whitespace-nowrap">
                    <div>Last Block</div>
                    <CountupClock as="span" :time="lastArgonActivityAt" v-slot="{ hours, minutes, seconds, isNull }" class="font-mono">
                      <template v-if="hours">{{ hours }}h, </template>
                      <template v-if="minutes || hours">{{ minutes }}m{{ !isNull && !hours ? ', ' : '' }}</template>
                      <template v-if="!isNull && !hours">{{ seconds }}s ago</template>
                      <template v-else-if="isNull">-- ----</template>
                    </CountupClock>
                    <ArgonBlocksOverlay :position="'left'">
                      <span class="flex items-center justify-center group border border-transparent hover:border-argon-200 rounded cursor-pointer w-7 h-7 relative top-0.5">
                        <BlocksIcon class="w-4.5 h-4.5 group-hover:text-argon-600" />
                      </span>
                    </ArgonBlocksOverlay>
                  </div>
                </TooltipTrigger>
                <TooltipContent side="bottom" :sideOffset="-10" align="center" :collisionPadding="9" class="bg-white border border-gray-800/20 rounded-md shadow-2xl z-50 p-4 w-sm text-slate-900/60">
                  This is the core of your mining operations. It's a full argon node that helps manage and operate the network.
                  <TooltipArrow :width="27" :height="15" class="fill-white stroke-[0.5px] stroke-gray-800/20 -mt-px" />
                </TooltipContent>
              </TooltipRoot>

              <div class="h-full w-[1px] bg-slate-400/30"></div>

              <TooltipRoot>
                <TooltipTrigger as="div" class="flex flex-col w-4/12 items-center justify-center gap-x-2 pb-1 pt-3 hover:text-argon-600">
                  <div class="font-bold">Mining Bot</div>
                  <div class="flex flex-row items-center justify-center gap-x-2 whitespace-nowrap">
                    <div>Last Active</div>
                    <CountupClock as="span" :time="botActivityLastUpdatedAt" v-slot="{ hours, minutes, seconds, isNull }" class="font-mono">
                      <template v-if="hours">{{ hours }}h, </template>
                      <template v-if="minutes || hours">{{ minutes }}m{{ !isNull && !hours ? ', ' : '' }}</template>
                      <template v-if="!isNull && !hours">{{ seconds }}s ago</template>
                      <template v-else-if="isNull">-- ----</template>
                    </CountupClock>
                    <ActiveBidsOverlayButton :position="'left'" class="ml-1.5">
                      <span class="flex items-center justify-center group border border-transparent hover:border-argon-200 rounded cursor-pointer w-7 h-7 relative top-0.5">
                        <AuctionIcon class="w-5 h-5 group-hover:text-argon-600" />
                      </span>
                    </ActiveBidsOverlayButton>
                    <BotHistoryOverlayButton :position="'left'">
                      <span class="flex items-center justify-center group border border-transparent hover:border-argon-200 rounded cursor-pointer w-7 h-7 relative top-0.5">
                        <ActivityIcon class="w-5 h-5 group-hover:text-argon-600" />
                      </span>
                    </BotHistoryOverlayButton>
                  </div>
                </TooltipTrigger>
                <TooltipContent side="bottom" :sideOffset="-10" align="center" :collisionPadding="9" class="bg-white border border-gray-800/20 rounded-md shadow-2xl z-50 p-4 w-sm text-slate-900/60">
                  This is your personal mining bot. It works while you're sleeping, monitoring auctions and placing bids on your behalf.
                  <TooltipArrow :width="27" :height="15" class="fill-white stroke-[0.5px] stroke-gray-800/20 -mt-px" />
                </TooltipContent>
              </TooltipRoot>
            </div>
          </section>

          <section box class="flex flex-col grow text-center px-2">
            <header class="flex flex-row justify-between text-xl font-bold py-2 text-slate-900/80 border-b border-slate-400/30">
              <div @click="goToPrevFrame" :class="hasPrevFrame ? 'opacity-60' : 'opacity-20 pointer-events-none'" class="flex flex-row items-center font-light text-base cursor-pointer group hover:opacity-80">
                <ChevronLeftIcon class="w-6 h-6 opacity-50 mx-1 group-hover:opacity-80" />
                PREV
              </div>
              <span class="flex flex-row items-center" :title="'Frame #' + currentFrame.id">
                <span>{{ currentFrameStartDate }} to {{ currentFrameEndDate }}</span>
                <span v-if="stats.selectedFrameId > stats.latestFrameId - 10" class="inline-block rounded-full bg-green-500/80 w-2.5 h-2.5 ml-2"></span>
              </span>
              <div @click="goToNextFrame" :class="hasNextFrame ? 'opacity-60' : 'opacity-20 pointer-events-none'" class="flex flex-row items-center font-light text-base cursor-pointer group hover:opacity-80">
                NEXT
                <ChevronRightIcon class="w-6 h-6 opacity-50 mx-1 group-hover:opacity-80" />
              </div>
            </header>
            <div v-if="currentFrame.seatCountActive" class="flex flex-row h-full">
              <div class="flex flex-col w-full h-full pt-2 gap-y-2">
                <div class="flex flex-row w-full h-1/2 gap-x-2">

                  <TooltipRoot>
                    <TooltipTrigger as="div" stat-box class="flex flex-col w-1/3 h-full border-b border-slate-400/30 pb-3 group">
                      <span>{{ currentFrame.seatCountActive }}</span>
                      <label class="relative block w-full">
                        Active Mining Seat{{ currentFrame.seatCountActive === 1 ? '' : 's' }}
                        <p class="absolute -bottom-4 uppercase h-[10px] text-center w-full text-xs text-gray-400">Out of {{ currentFrame.allMinersCount }} in network</p>
                      </label>
                    </TooltipTrigger>
                    <TooltipContent side="bottom" :sideOffset="-20" align="center" :collisionPadding="9" class="text-center bg-white border border-gray-800/20 rounded-md shadow-2xl z-50 p-4 w-xs text-slate-900/60">
                      The number of seats actively mining on your behalf during this frame.
                      <TooltipArrow :width="27" :height="15" class="fill-white stroke-[0.5px] stroke-gray-800/20 -mt-px" />
                    </TooltipContent>
                  </TooltipRoot>

                  <div class="h-full w-[1px] bg-slate-400/30"></div>

                  <TooltipRoot>
                    <TooltipTrigger as="div" stat-box class="flex flex-col w-1/3 h-full border-b border-slate-400/30 pb-3 group">
                      <span data-testid="TotalBlocksMined" :data-value=" currentFrame.blocksMinedTotal">{{ numeral(currentFrame.blocksMinedTotal).format('0,0') }}</span>
                      <label class="relative block w-full">
                        Blocks Mined
                        <HealthIndicatorBar :percent="getPercent(currentFrame.blocksMinedTotal, currentFrame.expected.blocksMinedTotal)" />
                      </label>
                    </TooltipTrigger>
                    <TooltipContent side="bottom" :sideOffset="-20" align="center" :collisionPadding="9" class="text-center bg-white border border-gray-800/20 rounded-md shadow-2xl z-50 p-4 w-xs text-slate-900/60">
                      You were expected to mine {{ numeral(currentFrame.expected.blocksMinedTotal).format('0,0') }} blocks by this point. You are at {{ numeral(getPercent(currentFrame.blocksMinedTotal, currentFrame.expected.blocksMinedTotal)).format('0.[00]') }}% of goal.
                      <TooltipArrow :width="27" :height="15" class="fill-white stroke-[0.5px] stroke-gray-800/20 -mt-px" />
                    </TooltipContent>
                  </TooltipRoot>

                  <div class="h-full w-[1px] bg-slate-400/30"></div>

                  <TooltipRoot>
                    <TooltipTrigger as="div" stat-box class="flex flex-col w-1/3 h-full border-b border-slate-400/30 pb-3 group">
                      <span>
                        {{
                          microgonToArgonNm(
                            currentFrame.microgonsMinedTotal + currentFrame.microgonsMintedTotal,
                          ).formatIfElse('< 1_000', '0,0.00', '0,0')
                        }}
                      </span>
                      <label class="relative block w-full">
                        Argons Collected
                        <HealthIndicatorBar :percent="getPercent(currentFrame.microgonsMinedTotal + currentFrame.microgonsMintedTotal, currentFrame.expected.microgonsMinedTotal + currentFrame.expected.microgonsMintedTotal)" />
                      </label>
                    </TooltipTrigger>
                    <TooltipContent side="bottom" :sideOffset="-20" align="center" :collisionPadding="9" class="text-center bg-white border border-gray-800/20 rounded-md shadow-2xl z-50 p-4 w-xs text-slate-900/60">
                      You were expected to collect {{ microgonToArgonNm(currentFrame.expected.microgonsMinedTotal).format('0,0.00') }} argons by this point. You are at {{ numeral(getPercent(currentFrame.microgonsMinedTotal + currentFrame.microgonsMintedTotal, currentFrame.expected.microgonsMinedTotal)).format('0.[00]') }}% of goal.
                      <TooltipArrow :width="27" :height="15" class="fill-white stroke-[0.5px] stroke-gray-800/20 -mt-px" />
                    </TooltipContent>
                  </TooltipRoot>

                  <div class="h-full w-[1px] bg-slate-400/30"></div>

                  <TooltipRoot>
                    <TooltipTrigger as="div" stat-box class="flex flex-col w-1/3 h-full border-b border-slate-400/30 pb-3 group">
                      <span>
                        {{
                          microgonToMoneyNm(currentFrame.micronotsMinedTotal).formatIfElse('< 1_000', '0,0.00', '0,0')
                        }}
                      </span>
                      <label class="relative block w-full" :title="'Expected Argonots Collected ' + micronotToMoneyNm(currentFrame.expected.micronotsMinedTotal).format('0,0.00')">
                        Argonots Collected
                        <HealthIndicatorBar :percent="getPercent(currentFrame.micronotsMinedTotal, currentFrame.expected.micronotsMinedTotal)" />
                      </label>
                    </TooltipTrigger>
                    <TooltipContent side="bottom" :sideOffset="-20" align="center" :collisionPadding="9" class="text-center bg-white border border-gray-800/20 rounded-md shadow-2xl z-50 p-4 w-xs text-slate-900/60">
                      You were expected to collect {{ micronotToArgonotNm(currentFrame.expected.micronotsMinedTotal).format('0,0.00') }} argonots by this point. You are at {{ numeral(getPercent(currentFrame.micronotsMinedTotal, currentFrame.expected.micronotsMinedTotal)).format('0.[00]') }}% of goal.
                      <TooltipArrow :width="27" :height="15" class="fill-white stroke-[0.5px] stroke-gray-800/20 -mt-px" />
                    </TooltipContent>
                  </TooltipRoot>

                </div>

                <div class="flex flex-row w-full h-1/2 gap-x-2">

                  <TooltipRoot>
                    <TooltipTrigger as="div" stat-box class="flex flex-col w-1/3 h-full group">
                      <div class="relative size-28">
                        <svg class="size-full -rotate-90" viewBox="0 0 36 36" xmlns="http://www.w3.org/2000/svg">
                          <circle cx="18" cy="18" r="16" fill="none" class="stroke-current text-gray-200 dark:text-neutral-700" stroke-width="3"></circle>
                          <circle cx="18" cy="18" r="16" fill="none" class="stroke-current text-argon-600 dark:text-argon-500" stroke-width="3" stroke-dasharray="100" :stroke-dashoffset="100-currentFrame.progress" stroke-linecap="butt"></circle>
                        </svg>

                        <div class="absolute top-1/2 start-1/2 transform -translate-y-1/2 -translate-x-1/2">
                          <span class="text-center text-2xl font-bold text-argon-600 dark:text-argon-500">{{ Math.round(currentFrame.progress) }}%</span>
                        </div>
                      </div>
                    </TooltipTrigger>
                    <TooltipContent side="bottom" :sideOffset="-20" align="center" :collisionPadding="9" class="text-center bg-white border border-gray-800/20 rounded-md shadow-2xl z-50 p-4 w-xs text-slate-900/60">
                      In the world of Argon, a frame represents 24 hours. This shows how much of the frame is complete.
                      <TooltipArrow :width="27" :height="15" class="fill-white stroke-[0.5px] stroke-gray-800/20 -mt-px" />
                    </TooltipContent>
                  </TooltipRoot>

                  <div class="h-full w-[1px] bg-slate-400/30"></div>

                  <TooltipRoot>
                    <TooltipTrigger as="div" stat-box class="flex flex-col w-1/3 h-full pb-3 group">
                      <span>
                        {{ currency.symbol
                        }}{{ microgonToMoneyNm(currentFrameCost).formatIfElse('< 1_000', '0,0.00', '0,0') }}
                      </span>
                      <label>{{ currentFrame.progress < 100 ? 'Relative' : '' }} Frame Cost</label>
                    </TooltipTrigger>
                    <TooltipContent side="bottom" :sideOffset="-20" align="center" :collisionPadding="9" class="text-center bg-white border border-gray-800/20 rounded-md shadow-2xl z-50 p-4 w-xs text-slate-900/60">
                      This is how much you paid for the right to mine the current frame that has completed ({{ numeral(currentFrame.progress).format('0.[00]') }}%).
                      <TooltipArrow :width="27" :height="15" class="fill-white stroke-[0.5px] stroke-gray-800/20 -mt-px" />
                    </TooltipContent>
                  </TooltipRoot>

                  <div class="h-full w-[1px] bg-slate-400/30"></div>

                  <TooltipRoot>
                    <TooltipTrigger as="div" stat-box class="flex flex-col w-1/3 h-full pb-3 group">
                      <span>
                        {{ currency.symbol
                        }}{{ microgonToMoneyNm(currentFrameEarnings).formatIfElse('< 1_000', '0,0.00', '0,0') }}
                      </span>
                      <label class="relative block w-full">
                        {{ currentFrame.progress < 100 ? 'Relative' : '' }} Frame Earnings
                        <HealthIndicatorBar :percent="getPercent(currentFrameEarnings, expectedFrameEarnings)" />
                      </label>
                    </TooltipTrigger>
                    <TooltipContent side="bottom" :sideOffset="-20" align="center" :collisionPadding="9" class="text-center bg-white border border-gray-800/20 rounded-md shadow-2xl z-50 p-4 w-xs text-slate-900/60">
                      You were expected to earn {{ currency.symbol}}{{ microgonToMoneyNm(expectedFrameEarnings).format('0,0.00') }}
                      by this point. You are at {{ numeral(getPercent(currentFrameEarnings, expectedFrameEarnings)).format('0.[00]') }}% of goal.
                      <TooltipArrow :width="27" :height="15" class="fill-white stroke-[0.5px] stroke-gray-800/20 -mt-px" />
                    </TooltipContent>
                  </TooltipRoot>

                  <div class="h-full w-[1px] bg-slate-400/30"></div>

                  <TooltipRoot>
                    <TooltipTrigger as="div" stat-box class="flex flex-col w-1/3 h-full pb-3 group">
                      <span>{{ numeral(currentFrameProfit).formatIfElseCapped('< 100', '0.[00]', '0,0', 9_999) }}%</span>
                      <label class="relative block w-full">
                        {{ currentFrame.progress < 100 ? 'Current' : '' }} Frame Profit
                        <HealthIndicatorBar :percent="getPercent(currentFrameProfit, expectedFrameProfit)" />
                      </label>
                    </TooltipTrigger>
                    <TooltipContent side="bottom" :sideOffset="-20" align="center" :collisionPadding="9" class="text-center bg-white border border-gray-800/20 rounded-md shadow-2xl z-50 p-4 w-xs text-slate-900/60">
                      Your profits were expected to be {{ numeral(expectedFrameProfit).format('0,0.00') }}%
                      by this point. You are at {{ numeral(getPercent(currentFrameProfit, expectedFrameProfit)).format('0.[00]') }}% of goal.
                      <TooltipArrow :width="27" :height="15" class="fill-white stroke-[0.5px] stroke-gray-800/20 -mt-px" />
                    </TooltipContent>
                  </TooltipRoot>

                </div>
              </div>
            </div>
            <div v-else-if="currentFrame.id === stats.latestFrameId" class="flex flex-col items-center justify-center h-full text-slate-900/20 text-2xl font-bold">
              You Have No Mining Seats
            </div>
            <div v-else class="flex flex-col items-center justify-center h-full text-slate-900/20 text-2xl font-bold">
              You Had No Mining Seats During This Frame
            </div>
          </section>

          <section box class="relative flex flex-col h-[35%] !pb-0.5 px-2">
            <FrameSlider ref="frameSliderRef" :chartItems="chartItems" @changedFrame="updateSliderFrame" />
          </section>
        </div>
      </section>
    </div>
  </TooltipProvider>

  <BotEditOverlay
    v-if="showEditOverlay"
    @close="showEditOverlay = false"
  />
</template>

<script lang="ts">
import * as Vue from 'vue';
import { IDashboardFrameStats } from '../../interfaces/IStats.ts';
import dayjs from 'dayjs';
import { ArrowTurnDownRightIcon } from '@heroicons/vue/24/outline';
import relativeTime from 'dayjs/plugin/relativeTime';
import utc from 'dayjs/plugin/utc';

// storing refs outside of setup to avoid re-creation on each setup call and speed ui load
const currentFrame = Vue.ref<IDashboardFrameStats>({
  id: 0,
  date: '',
  firstTick: 0,
  lastTick: 0,
  allMinersCount: 0,
  seatCountActive: 0,
  seatCostTotalFramed: 0n,
  microgonToUsd: [0n],
  microgonToArgonot: [0n],
  blocksMinedTotal: 0,

  micronotsMinedTotal: 0n,
  microgonsMinedTotal: 0n,
  microgonsMintedTotal: 0n,
  microgonFeesCollectedTotal: 0n,
  microgonValueOfRewards: 0n,

  progress: 0,
  profit: 0,
  profitPct: 0,
  score: 0,

  expected: {
    blocksMinedTotal: 0,
    micronotsMinedTotal: 0n,
    microgonsMinedTotal: 0n,
    microgonsMintedTotal: 0n,
  },
});
const sliderFrameIndex = Vue.ref(0);

dayjs.extend(relativeTime);
dayjs.extend(utc);
</script>

<script setup lang="ts">
import { BigNumber } from 'bignumber.js';
import { calculateAPY } from '../../lib/Utils';
import { useStats } from '../../stores/stats';
import { useCurrency } from '../../stores/currency';
import { ChevronLeftIcon, ChevronRightIcon } from '@heroicons/vue/24/outline';
import CountupClock from '../../components/CountupClock.vue';
import numeral, { createNumeralHelpers } from '../../lib/numeral';
import AuctionIcon from '../../assets/auction.svg?component';
import ActivityIcon from '../../assets/activity.svg?component';
import BlocksIcon from '../../assets/blocks.svg?component';
import ActiveBidsOverlayButton from '../../overlays/ActiveBidsOverlayButton.vue';
import BotHistoryOverlayButton from '../../overlays/BotHistoryOverlayButton.vue';
import { TICK_MILLIS } from '../../lib/Env.ts';
import { useWallets } from '../../stores/wallets';
import MinerIcon from '../../assets/miner.svg?component';
import HealthIndicatorBar from '../../components/HealthIndicatorBar.vue';
import ArgonIcon from '../../assets/resources/argon.svg?component';
import ArgonotIcon from '../../assets/resources/argonot.svg?component';
import MiningBidIcon from '../../assets/resources/mining-bid.svg?component';
import MiningSeatIcon from '../../assets/resources/mining-seat.svg?component';
import ArgonBlocksOverlay from '../../overlays/ArgonBlocksOverlay.vue';
import BitcoinBlocksOverlay from '../../overlays/BitcoinBlocksOverlay.vue';
import FrameSlider from '../../components/FrameSlider.vue';
import { IChartItem } from '../../components/FrameSlider.vue';
import BotEditOverlay from '../../overlays/BotEditOverlay.vue';
import { HoverCardRoot, HoverCardTrigger, HoverCardContent, HoverCardArrow } from 'reka-ui';
import { TooltipProvider, TooltipRoot, TooltipTrigger, TooltipContent, TooltipArrow } from 'reka-ui';
import { useConfig } from '../../stores/config.ts';

const stats = useStats();
const currency = useCurrency();
const config = useConfig();

const wallets = useWallets();

const frameSliderRef = Vue.ref<InstanceType<typeof FrameSlider> | null>(null);
const chartItems = Vue.ref<IChartItem[]>([]);

const showEditOverlay = Vue.ref(false);

function getPercent(value: bigint | number, total: bigint | number): number {
  if (total === 0n || total === 0) return 0;
  return BigNumber(value).dividedBy(total).multipliedBy(100).toNumber();
}

const { microgonToMoneyNm, micronotToMoneyNm, microgonToArgonNm, micronotToArgonotNm } = createNumeralHelpers(currency);

const unallocatedMicrogons = Vue.computed(() => {
  const extra = wallets.miningWallet.availableMicrogons - unusedMicrogons.value;
  return extra > 0n ? extra : 0n;
});

const unusedMicrogons = Vue.computed(() => {
  const unused = wallets.microgonsCommittedToMiningBot - wallets.miningSeatMicrogons - wallets.miningBidMicrogons;
  return unused > 0n ? unused : 0n;
});

const unallocatedMicronots = Vue.computed(() => {
  const extra = wallets.miningWallet.availableMicronots - unusedMicronots.value;
  return extra > 0n ? extra : 0n;
});

const unusedMicronots = Vue.computed(() => {
  const unused = wallets.micronotsCommittedToMiningBot - wallets.miningSeatMicronots - wallets.miningBidMicronots;
  return unused > 0n ? unused : 0n;
});

function allocateMicrogons() {
  config.biddingRules.baseMicrogonCommitment += unallocatedMicrogons.value;
  config.save();
}

function allocateMicronots() {
  config.biddingRules.baseMicronotCommitment += unallocatedMicronots.value;
  config.save();
}

const globalMicrogonsEarned = Vue.computed(() => {
  const {
    microgonsMinedTotal: totalMicrogonsMined,
    microgonsMintedTotal: totalMicrogonsMinted,
    micronotsMinedTotal: totalMicronotsMined,
  } = stats.global;
  return totalMicrogonsMined + totalMicrogonsMinted + currency.micronotToMicrogon(totalMicronotsMined);
});

const globalMicrogonsInvested = Vue.computed(() => {
  return stats.global.framedCost;
});

const globalAPY = Vue.computed(() => {
  return calculateAPY(globalMicrogonsInvested.value, globalMicrogonsEarned.value);
});

const currentFrameEarnings = Vue.computed(() => {
  if (!currentFrame.value.seatCountActive) return 0n;

  const { microgonsMinedTotal, microgonsMintedTotal, micronotsMinedTotal } = currentFrame.value;
  const microgons = microgonsMinedTotal + microgonsMintedTotal;
  return microgons + currency.micronotToMicrogon(micronotsMinedTotal);
});

const expectedFrameEarnings = Vue.computed(() => {
  if (!currentFrame.value.seatCountActive) return 0n;

  const { expected } = currentFrame.value;
  const microgons = expected.microgonsMinedTotal + expected.microgonsMintedTotal;
  return microgons + currency.micronotToMicrogon(expected.micronotsMinedTotal);
});

const currentFrameCost = Vue.computed(() => {
  if (!currentFrame.value.seatCountActive) return 0n;
  return currentFrame.value.seatCostTotalFramed;
});

const currentFrameProfit = Vue.computed(() => {
  const earningsBn = BigNumber(currentFrameEarnings.value);
  const costBn = BigNumber(currentFrameCost.value);
  const profitBn = earningsBn.minus(costBn).dividedBy(costBn).multipliedBy(100);
  return profitBn.toNumber();
});

const expectedFrameProfit = Vue.computed(() => {
  const earningsBn = BigNumber(expectedFrameEarnings.value);
  const costBn = BigNumber(currentFrameCost.value);
  const profitBn = earningsBn.minus(costBn).dividedBy(costBn).multipliedBy(100);
  return profitBn.toNumber();
});

const currentFrameStartDate = Vue.computed(() => {
  if (!currentFrame.value.firstTick) {
    return '-----';
  }
  const date = dayjs.utc(currentFrame.value.firstTick * TICK_MILLIS);
  return date.local().format('MMMM D, h:mm A');
});

const currentFrameEndDate = Vue.computed(() => {
  if (!currentFrame.value.lastTick) {
    return '-----';
  }
  const date = dayjs.utc(currentFrame.value.lastTick * TICK_MILLIS);
  return date.local().add(1, 'minute').format('MMMM D, h:mm A');
});

const lastBitcoinActivityAt = Vue.computed(() => {
  const lastActivity = stats.serverState.bitcoinBlocksLastUpdatedAt;
  return lastActivity ? dayjs.utc(lastActivity).local() : null;
});

const lastArgonActivityAt = Vue.computed(() => {
  const lastActivity = stats.serverState.argonBlocksLastUpdatedAt;
  return lastActivity ? dayjs.utc(lastActivity).local() : null;
});

const botActivityLastUpdatedAt = Vue.computed(() => {
  const lastActivity = stats.serverState.botActivityLastUpdatedAt;
  return lastActivity ? dayjs.utc(lastActivity).local() : null;
});

const hasNextFrame = Vue.computed(() => {
  return sliderFrameIndex.value < stats.frames.length - 1;
});

const hasPrevFrame = Vue.computed(() => {
  return sliderFrameIndex.value > 0;
});

function goToPrevFrame() {
  frameSliderRef.value?.goToPrevFrame();
}

function goToNextFrame() {
  frameSliderRef.value?.goToNextFrame();
}

function openBotEditOverlay() {
  showEditOverlay.value = true;
}

function loadChartData() {
  let isFiller = true;
  const items: IChartItem[] = [];
  for (const [index, frame] of stats.frames.entries()) {
    if (isFiller && frame.seatCountActive > 0) {
      const previousItem = items[index - 1];
      previousItem && (previousItem.isFiller = false);
      isFiller = false;
    }
    const item = {
      date: frame.date,
      score: frame.score,
      isFiller,
      previous: items[index - 1],
      next: undefined,
    };
    items.push(item);
  }

  for (const [index, item] of items.entries()) {
    item.next = items[index + 1];
  }

  chartItems.value = items;
}

function updateSliderFrame(newFrameIndex: number) {
  sliderFrameIndex.value = newFrameIndex;
  currentFrame.value = stats.frames[newFrameIndex];
}

Vue.watch(
  () => stats.frames,
  () => loadChartData(),
);

Vue.onMounted(() => {
  stats.subscribeToDashboard();
  stats.subscribeToActivity();
  loadChartData();
});

Vue.onUnmounted(() => {
  stats.unsubscribeFromDashboard();
  stats.unsubscribeFromActivity();
});
</script>

<style scoped>
@reference "../../main.css";

[box] {
  @apply min-h-20 rounded border-[1px] border-slate-400/30 bg-white py-2 shadow;
}

[stat-box] {
  @apply text-argon-600 flex flex-col items-center justify-center;
  span {
    @apply text-3xl font-bold;
  }
  label {
    @apply group-hover:text-argon-600/60 mt-1 text-sm text-gray-500;
  }
}
</style>
