<!-- prettier-ignore -->
<template>
  <TooltipProvider :disableHoverableContent="true" data-testid="Dashboard" class="flex flex-col h-full">
    <div class="flex flex-col h-full px-2.5 py-2.5 gap-y-2 justify-stretch grow">
      <section box class="flex flex-row items-center text-slate-900/90 !py-3">
        <div class="flex flex-row items-center w-full min-h-[6%]">
          <div v-if="vault.data.pendingCollectRevenue" class="px-6 flex flex-row items-center w-full h-full">
            <div class="flex flex-row items-center text-lg relative text-slate-800/90">
              <MoneyIcon class="h-10 w-10 inline-block mr-4 relative top-1 text-argon-800/60" />
              <strong>{{ currency.symbol }}{{ microgonToMoneyNm(vault.data.pendingCollectRevenue).formatIfElse('< 1_000', '0,0.00', '0,0') }} is waiting to be collected</strong>&nbsp;(expires in&nbsp;
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
              Collect Revenue
            </button>
          </div>
          <div v-else-if="vault.data.pendingCosignUtxoIds.size" class="px-6 flex flex-row items-center w-full h-full">
            <div class="flex flex-row items-center text-lg relative text-slate-800/90">
              <SigningIcon class="h-10 w-10 inline-block mr-4 relative text-argon-800/60" />
              <strong>{{vault.data.pendingCosignUtxoIds.size || 2}} bitcoin transaction{{vault.data.pendingCosignUtxoIds.size === 1 ? '' : 's'}} require signing at a penalty of {{ currency.symbol }}{{ microgonToMoneyNm(vault.data.pendingCollectRevenue).formatIfElse('< 1_000', '0,0.00', '0,0') }}</strong>&nbsp;(expires in&nbsp;
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
          <TooltipContent side="bottom" :sideOffset="-10" align="start" :collisionPadding="9" class="bg-white border border-gray-800/20 rounded-md shadow-2xl z-50 p-4 w-fit text-slate-900/60">
            The total value of bitcoin currently locked in your vault.
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
          <TooltipContent side="bottom" :sideOffset="-10" align="start" :collisionPadding="9" class="bg-white border border-gray-800/20 rounded-md shadow-2xl z-50 p-4 w-sm text-slate-900/60">
            The ratio of argon-to-bitcoin that you have committed as securitization collateral.
            <TooltipArrow :width="27" :height="15" class="fill-white stroke-[0.5px] stroke-gray-800/20 -mt-px" />
          </TooltipContent>
        </TooltipRoot>
        <TooltipRoot>
          <TooltipTrigger box stat-box class="flex flex-col w-2/12 !py-4 group">
            <span>{{ currency.symbol}}0.00</span>
            <label>External Treasury Bonds</label>
          </TooltipTrigger>
          <TooltipContent side="bottom" :sideOffset="-10" align="center" :collisionPadding="9" class="text-center bg-white border border-gray-800/20 rounded-md shadow-2xl z-50 p-4 w-sm text-slate-900/60">
            The amount of external capital invested into your vault's treasury bonds.
            <TooltipArrow :width="27" :height="15" class="fill-white stroke-[0.5px] stroke-gray-800/20 -mt-px" />
          </TooltipContent>
        </TooltipRoot>
        <TooltipRoot>
          <TooltipTrigger box stat-box class="flex flex-col w-2/12 !py-4 group">
            <span>
              {{ currency.symbol}}{{ microgonToMoneyNm(activatedTreasuryPoolInvestment).formatIfElse('< 1_000', '0,0.00', '0,0') }}
            </span>
            <label>Total Treasury Bonds</label>
          </TooltipTrigger>
          <TooltipContent side="bottom" :sideOffset="-10" align="center" :collisionPadding="9" class="text-center bg-white border border-gray-800/20 rounded-md shadow-2xl z-50 p-4 w-sm text-slate-900/60">
            Your vault's total capital, both internal and external, that is invested in treasury bonds.
            <TooltipArrow :width="27" :height="15" class="fill-white stroke-[0.5px] stroke-gray-800/20 -mt-px" />
          </TooltipContent>
        </TooltipRoot>
        <TooltipRoot>
          <TooltipTrigger box stat-box class="flex flex-col w-2/12 !py-4 group">
            <span>{{ currency.symbol }}{{ microgonToMoneyNm(revenueMicrogons).formatIfElse('< 1_000', '0,0.00', '0,0') }}</span>
            <label>Total Earnings</label>
          </TooltipTrigger>
          <TooltipContent side="bottom" :sideOffset="-10" align="end" :collisionPadding="9" class="text-right bg-white border border-gray-800/20 rounded-md shadow-2xl z-50 p-4 w-sm text-slate-900/60">
            Your vault's earnings to-date. This includes bitcoin locking fees and treasury bonds.
            <TooltipArrow :width="27" :height="15" class="fill-white stroke-[0.5px] stroke-gray-800/20 -mt-px" />
          </TooltipContent>
        </TooltipRoot>
        <TooltipRoot>
          <TooltipTrigger box stat-box class="flex flex-col w-2/12 !py-4 group">
            <span>{{ numeral(apy).formatIfElseCapped('< 100', '0,0.[00]', '0,0', 9_999) }}%</span>
            <label>Current APY</label>
          </TooltipTrigger>
          <TooltipContent side="bottom" :sideOffset="-10" align="end" :collisionPadding="9" class="text-right bg-white border border-gray-800/20 rounded-md shadow-2xl z-50 p-4 w-sm text-slate-900/60">
            Your vault's rolling annual percentage yield based on total capital committed.
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
            <li class="flex flex-col w-full min-h-[calc(100%/7)] py-2">
              <HoverCardRoot :openDelay="200" :closeDelay="100">
                <HoverCardTrigger as="div" class="flex flex-row items-center w-full hover:text-argon-600">
                  <ArgonIcon class="w-7 h-7 text-argon-600/70 mr-2" />
                  <div class="grow">Unused Argons</div>
                  <div class="pr-1">
                    {{ currency.symbol
                    }}{{ microgonToMoneyNm(wallets.vaultingWallet.availableMicrogons).format('0,0.00') }}
                  </div>
                </HoverCardTrigger>
                <HoverCardContent align="start" :alignOffset="-20" side="right" :avoidCollisions="false" class="bg-white border border-gray-800/20 rounded-md shadow-2xl z-50 p-4 w-fit text-slate-900/60">
                  <p class="break-words whitespace-normal">
                     These argons are not currently being used.
                  </p>
                  <HoverCardArrow :width="27" :height="15" class="fill-white stroke-[0.5px] stroke-gray-800/20 -mt-px" />
                </HoverCardContent>
              </HoverCardRoot>
              <div class="flex flex-col ml-9 gap-y-1 text-slate-900/60">
                <HoverCardRoot :openDelay="200" :closeDelay="100">
                  <HoverCardTrigger as="div" class="border-t border-gray-600/20 border-dashed pt-2 relative hover:text-argon-600">
                    <ArrowTurnDownRightIcon class="w-5 h-5 text-slate-600/40 absolute top-1/2 -translate-y-1/2 -translate-x-[130%] left-0" />
                    {{ microgonToArgonNm(pendingMintingValue).format('0,0.[00]') }} Pending Mints
                  </HoverCardTrigger>
                  <HoverCardContent align="start" :alignOffset="-20" side="right" :avoidCollisions="false" class="bg-white border border-gray-800/20 rounded-md shadow-2xl z-50 p-4 w-md text-slate-900/60">
                    <p v-if="pendingMintingValue" class="break-words whitespace-normal">
                      These have been earned, but they have not yet been minted. Minting is determined
                      by supply and demand, which means, although you're guaranteed to get them, the timeframe is unknown.
                    </p>
                    <p v-else class="break-words whitespace-normal">
                      You have no argons that are in the minting queue.
                    </p>
                    <HoverCardArrow :width="27" :height="15" class="fill-white stroke-[0.5px] stroke-gray-800/20 -mt-px" />
                  </HoverCardContent>
                </HoverCardRoot>
                <HoverCardRoot :openDelay="200" :closeDelay="100">
                  <HoverCardTrigger as="div" class="border-t border-gray-600/20 border-dashed pt-2 relative hover:text-argon-600">
                    <ArrowTurnDownRightIcon class="w-5 h-5 text-slate-600/40 absolute top-1/2 -translate-y-1/2 -translate-x-[130%] left-0" />
                    {{ microgonToArgonNm(wallets.vaultingWallet.availableMicrogons).formatIfElse('< 100', '0,0.[00]', '0,0') }} Needs Allocation
                  </HoverCardTrigger>
                  <HoverCardContent align="start" :alignOffset="-20" side="right" :avoidCollisions="false" class="bg-white border border-gray-800/20 rounded-md shadow-2xl z-50 p-4 w-md text-slate-900/60">
                    <p class="break-words whitespace-normal">
                      These argons are available for use. Click the Allocate button, and they will be distributed
                      between securitization and treasury bonds according to the rules in your config.
                    </p>
                    <div class="flex flex-row items-center border-t border-gray-600/20 pt-4 mt-3 w-full">
                      <button class="bg-argon-600 hover:bg-argon-700 text-white font-bold px-5 py-2 rounded-md cursor-pointer">
                        Allocate These {{ microgonToArgonNm(wallets.vaultingWallet.availableMicrogons).formatIfElse('< 100', '0,0.[00]', '0,0') }} Argons to Vault
                      </button>
                    </div>
                    <HoverCardArrow :width="27" :height="15" class="fill-white stroke-[0.5px] stroke-gray-800/20 -mt-px" />
                  </HoverCardContent>
                </HoverCardRoot>
              </div>
            </li>
            <li class="flex flex-col w-full border-t border-gray-600/20 border-dashed py-2">
              <HoverCardRoot :openDelay="200" :closeDelay="100">
                <HoverCardTrigger as="div" class="flex flex-row items-center w-full  hover:text-argon-600">
                  <ArgonotIcon class="w-7 h-7 text-argon-600/70 mr-2" />
                  <div class="grow">Bitcoin Security</div>
                  <div class="pr-1">
                    {{ currency.symbol
                    }}{{ micronotToMoneyNm(activatedSecuritization + waitingSecuritization).format('0,0.00') }}
                  </div>
                </HoverCardTrigger>
                <HoverCardContent align="start" :alignOffset="-20" side="right" :avoidCollisions="false" class="bg-white border border-gray-800/20 rounded-md shadow-2xl z-50 p-4 w-md text-slate-900/60">
                  <p class="break-words whitespace-normal">
                    This is the total capital applied to your vault's bitcoin securitization. It insures that anyone who locks
                    bitcoin in your vault will be able to claim their bitcoin back in full.
                  </p>
                  <HoverCardArrow :width="27" :height="15" class="fill-white stroke-[0.5px] stroke-gray-800/20 -mt-px" />
                </HoverCardContent>
              </HoverCardRoot>
              <div class="flex flex-col ml-9 gap-y-1 text-slate-900/60">
                <HoverCardRoot :openDelay="200" :closeDelay="100">
                  <HoverCardTrigger as="div" class="border-t border-gray-600/20 border-dashed pt-2 relative hover:text-argon-600">
                    <ArrowTurnDownRightIcon class="w-5 h-5 text-slate-600/40 absolute top-1/2 -translate-y-1/2 -translate-x-[130%] left-0" />
                    {{ microgonToArgonNm(waitingSecuritization).format('0,0.[00]') }} Waiting for Usage
                  </HoverCardTrigger>
                  <HoverCardContent align="start" :alignOffset="-20" side="right" :avoidCollisions="false" class="bg-white border border-gray-800/20 rounded-md shadow-2xl z-50 p-4 w-md text-slate-900/60">
                    <p class="break-words whitespace-normal">
                      These argons have not yet been applied to your vault's securitization. They are waiting for bitcoins.
                    </p>
                    <div class="flex flex-row items-center border-t border-gray-600/20 pt-4 mt-3 w-full">
                      <button class="bg-argon-600 hover:bg-argon-700 text-white font-bold px-5 py-2 rounded-md cursor-pointer">
                        Remove These {{ microgonToArgonNm(waitingSecuritization).format('0,0.[00]') }} Argons from Securitization
                      </button>
                    </div>
                    <HoverCardArrow :width="27" :height="15" class="fill-white stroke-[0.5px] stroke-gray-800/20 -mt-px" />
                  </HoverCardContent>
                </HoverCardRoot>
                <HoverCardRoot :openDelay="200" :closeDelay="100">
                  <HoverCardTrigger as="div" class="border-t border-gray-600/20 border-dashed pt-2 relative hover:text-argon-600">
                    <ArrowTurnDownRightIcon class="w-5 h-5 text-slate-600/40 absolute top-1/2 -translate-y-1/2 -translate-x-[130%] left-0" />
                    {{ microgonToArgonNm(pendingSecuritization).format('0,0.[00]') }} Pending Activation
                  </HoverCardTrigger>
                  <HoverCardContent align="start" :alignOffset="-20" side="right" :avoidCollisions="false" class="bg-white border border-gray-800/20 rounded-md shadow-2xl z-50 p-4 w-md text-slate-900/60">
                    <p class="break-words whitespace-normal">
                      These argons are already committed to bitcoins pending in your vault. However, these bitcoins are still in the process
                      of locking. Once completed, these argons will move to "Actively In Use".
                    </p>
                    <HoverCardArrow :width="27" :height="15" class="fill-white stroke-[0.5px] stroke-gray-800/20 -mt-px" />
                  </HoverCardContent>
                </HoverCardRoot>
                <HoverCardRoot :openDelay="200" :closeDelay="100">
                  <HoverCardTrigger as="div" class="border-t border-gray-600/20 border-dashed pt-2 relative hover:text-argon-600">
                    <ArrowTurnDownRightIcon class="w-5 h-5 text-slate-600/40 absolute top-1/2 -translate-y-1/2 -translate-x-[130%] left-0" />
                    {{ microgonToArgonNm(activatedSecuritization).format('0,0.[00]') }} Actively In Use
                  </HoverCardTrigger>
                  <HoverCardContent align="start" :alignOffset="-20" side="right" :avoidCollisions="false" class="bg-white border border-gray-800/20 rounded-md shadow-2xl z-50 p-4 w-md text-slate-900/60">
                    <p v-if="activatedSecuritization" class="break-words whitespace-normal">
                      These argons are currently being used to securitize your vault's bitcoin.
                    </p>
                    <p v-else class="break-words whitespace-normal">
                      You have no argons actively being used to securitize bitcoins.
                    </p>
                    <HoverCardArrow :width="27" :height="15" class="fill-white stroke-[0.5px] stroke-gray-800/20 -mt-px" />
                  </HoverCardContent>
                </HoverCardRoot>
              </div>
            </li>
            <li class="flex flex-col w-full border-t border-gray-600/20 border-dashed py-2">
              <HoverCardRoot :openDelay="200" :closeDelay="100">
                <HoverCardTrigger as="div" class="flex flex-row items-center w-full hover:text-argon-600">
                  <ArgonotIcon class="w-7 h-7 text-argon-600/70 mr-2" />
                  <div class="grow">Treasury Bonds</div>
                  <div class="pr-1">
                    {{ currency.symbol
                    }}{{ micronotToMoneyNm(activatedTreasuryPoolInvestment + pendingTreasuryPoolInvestment).format('0,0.00') }}
                  </div>
                </HoverCardTrigger>
                <HoverCardContent align="start" :alignOffset="-20" side="right" :avoidCollisions="false" class="bg-white border border-gray-800/20 rounded-md shadow-2xl z-50 p-4 w-md text-slate-900/60">
                  <p class="break-words whitespace-normal">
                    This is the capital that has been allocated to your vault's treasury bonds.
                  </p>
                  <HoverCardArrow :width="27" :height="15" class="fill-white stroke-[0.5px] stroke-gray-800/20 -mt-px" />
                </HoverCardContent>
              </HoverCardRoot>
              <div class="flex flex-col ml-9 gap-y-1 text-slate-900/60">
                <HoverCardRoot :openDelay="200" :closeDelay="100">
                  <HoverCardTrigger as="div" class="border-t border-gray-600/20 border-dashed pt-2 relative hover:text-argon-600">
                    <ArrowTurnDownRightIcon class="w-5 h-5 text-slate-600/40 absolute top-1/2 -translate-y-1/2 -translate-x-[130%] left-0" />
                    {{ microgonToArgonNm(pendingTreasuryPoolInvestment).format('0,0.[00]') }} Waiting for Usage
                  </HoverCardTrigger>
                  <HoverCardContent align="start" :alignOffset="-20" side="right" :avoidCollisions="false" class="bg-white border border-gray-800/20 rounded-md shadow-2xl z-50 p-4 w-md text-slate-900/60">
                    <p class="break-words whitespace-normal">
                      This capital is sitting idle because your vault does not have enough bitcoin. The amount
                      in treasury bonds cannot exceed the bitcoin value in your vault.
                    </p>
                    <div class="flex flex-row items-center border-t border-gray-600/20 pt-4 mt-3 w-full">
                      <button class="bg-argon-600 hover:bg-argon-700 text-white font-bold px-5 py-2 rounded-md cursor-pointer">
                        Remove These {{ microgonToArgonNm(pendingTreasuryPoolInvestment).format('0,0.[00]') }} Argons from Securitization</button>
                    </div>
                    <HoverCardArrow :width="27" :height="15" class="fill-white stroke-[0.5px] stroke-gray-800/20 -mt-px" />
                  </HoverCardContent>
                </HoverCardRoot>
                <HoverCardRoot :openDelay="200" :closeDelay="100">
                  <HoverCardTrigger as="div" class="border-t border-gray-600/20 border-dashed pt-2 relative hover:text-argon-600">
                    <ArrowTurnDownRightIcon class="w-5 h-5 text-slate-600/40 absolute top-1/2 -translate-y-1/2 -translate-x-[130%] left-0" />
                    {{ microgonToArgonNm(activatedTreasuryPoolInvestment).format('0,0.[00]') }} Actively In Use
                  </HoverCardTrigger>
                  <HoverCardContent align="start" :alignOffset="-20" side="right" :avoidCollisions="false" class="bg-white border border-gray-800/20 rounded-md shadow-2xl z-50 p-4 w-md text-slate-900/60">
                    <p v-if="activatedTreasuryPoolInvestment" class="break-words whitespace-normal">
                      These argons are actively generating yield for your vault through treasury bond investments.
                    </p>
                    <p v-else class="break-words whitespace-normal">
                      You have no argons actively being applied to treasury bond investments.
                    </p>
                    <HoverCardArrow :width="27" :height="15" class="fill-white stroke-[0.5px] stroke-gray-800/20 -mt-px" />
                  </HoverCardContent>
                </HoverCardRoot>
              </div>
            </li>
            <li class="flex flex-row items-center w-full border-t border-gray-600/50 py-2 text-red-900/70">
              <HoverCardRoot :openDelay="200" :closeDelay="100">
                <HoverCardTrigger as="div" class="flex flex-row items-center w-full hover:text-argon-600">
                  <div class="grow pl-1"><span class="hidden xl:inline">Cost to</span> Unlock Bitcoin</div>
                  <div class="pr-1">
                    -{{ currency.symbol
                    }}{{ microgonToMoneyNm(costToRelease).format('0,0.[00]') }}
                  </div>
                </HoverCardTrigger>
                <HoverCardContent align="start" :alignOffset="-20" side="right" :avoidCollisions="false" class="bg-white border border-gray-800/20 rounded-md shadow-2xl z-50 p-4 w-md text-slate-900/60">
                  <p class="break-words whitespace-normal">
                    This is what it will cost to unlock your personal bitcoin.
                  </p>
                  <HoverCardArrow :width="27" :height="15" class="fill-white stroke-[0.5px] stroke-gray-800/20 -mt-px" />
                </HoverCardContent>
              </HoverCardRoot>
            </li>
            <li class="flex flex-row items-center w-full border-t border-gray-600/20 border-dashed py-2 text-red-900/70">
              <HoverCardRoot :openDelay="200" :closeDelay="100">
                <HoverCardTrigger as="div" class="flex flex-row items-center w-full hover:text-red-600">
                  <div class="grow pl-1"><span class="hidden xl:inline">Operational</span> Expenses</div>
                  <div class="pr-1">
                    -{{ currency.symbol
                    }}{{ microgonToMoneyNm(vault.metadata?.operationalFeeMicrogons ?? 0n).format('0,0.00') }}
                  </div>
                </HoverCardTrigger>
                <HoverCardContent align="start" :alignOffset="-20" side="right" :avoidCollisions="false" class="bg-white border border-gray-800/20 rounded-md shadow-2xl z-50 p-4 w-md text-slate-900/60">
                  <p class="break-words whitespace-normal">
                    The summation of all operational expenses that have been paid since your vault's inception.
                  </p>
                  <HoverCardArrow :width="27" :height="15" class="fill-white stroke-[0.5px] stroke-gray-800/20 -mt-px" />
                </HoverCardContent>
              </HoverCardRoot>
            </li>
            <li class="flex flex-row items-center justify-between w-full border-t border-b border-gray-600/50 py-2 font-bold">
              <HoverCardRoot :openDelay="200" :closeDelay="100">
                <HoverCardTrigger as="div" class="flex flex-row items-center w-full hover:text-argon-600">
                  <div class="grow pl-1">Total Value</div>
                  <div class="pr-1">
                    {{ currency.symbol }}{{ microgonToMoneyNm(totalVaultValue).format('0,0.00') }}
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
            <div @click="openVaultEditOverlay" class="relative text-center mb-5 text-argon-600 opacity-70 hover:opacity-100 cursor-pointer">
              <VaultIcon class="w-20 h-20 mt-5 inline-block mb-3" />
              <div>Configure Vault Settings</div>
            </div>
          </div>
        </div>

        <div class="flex flex-col grow gap-y-2">
          <section class="flex flex-col">
            <div v-if="personalUtxo?.status === BitcoinLockStatus.LockInitialized && !lockInitializeHasExpired" class="grow flex flex-row items-center justify-start pl-[3%] pr-[3%] !py-5 border-[1.5px] border-dashed border-slate-900/30 m-0.5">
              <BitcoinIcon class="w-22 inline-block mr-7 -rotate-24 relative top-px fade-in-out" />
              <div class="flex flex-col items-start justify-center grow">
                <div class="text-xl font-bold opacity-60 border-b border-argon-600/20 pb-1.5 mb-1.5">Your {{ numeral(currency.satsToBtc(personalUtxo?.satoshis ?? 0n)).format('0,0.[00000000]') }} BTC Is Being Locked</div>
                <div class="relative text-argon-700/80 pt-0.5 font-bold text-md pointer-events-none fade-in-out">Actively Monitoring Network for Incoming Bitcoin</div>
              </div>
              <div class="flex flex-col items-center justify-center">
                <button @click="showFinishLockingOverlay = true" class="whitespace-nowrap bg-argon-600 text-white text-lg font-bold px-5 lg:px-10 py-2 rounded-md cursor-pointer relative top-1">
                  Finish Locking
                </button>
                <div class="opacity-40 italic mt-2.5">
                  Expires in
                  <CountdownClock :time="lockInitializeExpirationTime" v-slot="{ days, hours, minutes }">
                    <template v-if="days > 0">
                      {{ days }} day{{days === 1 ? '' : 's'}}
                    </template>
                    <template v-else>
                      {{ hours }}h {{ minutes }}m
                    </template>
                  </CountdownClock>
                </div>
              </div>
            </div>
            <div v-else-if="(personalUtxo?.status === BitcoinLockStatus.LockInitialized && lockInitializeHasExpired) || personalUtxo?.status === BitcoinLockStatus.ReleaseComplete" class="grow flex flex-row items-center justify-start px-[3%] py-5 border-[1.5px] border-dashed border-slate-900/30 m-0.5">
              <div class="flex flex-col items-start justify-center grow pr-16 text-argon-800/70">
                <div class="text-xl font-bold opacity-60">No Bitcoin Attached to this Vault</div>
                <div class="font-light">
                  Vaults require bitcoin in order to function properly and generate revenue<br/>
                  opportunities for their owners. Click the button to add a bitcoin.
                </div>
              </div>
              <div class="flex flex-col items-center justify-center">
                <button @click="showAddOverlay = true" class="bg-argon-600 text-white whitespace-nowrap text-lg font-bold px-12 py-2 rounded-md cursor-pointer">Add a Bitcoin</button>
              </div>
            </div>
            <div v-else-if="personalUtxo?.status === BitcoinLockStatus.LockProcessingOnBitcoin" @click="showFinishLockingOverlay = true" class="cursor-pointer hover:bg-white/50 row flex flex-row items-center justify-start pl-[3%] pr-[3%] !py-5 border-[1.5px] border-dashed border-slate-900/30 m-0.5">
              <div class="flex flex-row items-center justify-center w-full fade-in-out">
                <BitcoinIcon class="w-22 inline-block mr-7 -rotate-24 opacity-80 relative top-px" />
                <div class="flex flex-col items-start justify-center grow pr-5">
                  <div class="text-xl font-bold opacity-60 pb-1.5">
                    Your {{ numeral(currency.satsToBtc(personalUtxo?.satoshis ?? 0n)).format('0,0.[00000000]') }} BTC Lock Is Being Processed by Bitcoin's Network
                  </div>
                  <ProgressBar :progress="50" />
                </div>
              </div>
            </div>
            <div v-else-if="personalUtxo?.status === BitcoinLockStatus.LockReceivedWrongAmount" @click="showFinishLockingOverlay = true" class="grow text-red-700 flex flex-row items-center justify-start pl-[3%] pr-[3%] !py-5 border-[1.5px] border-dashed border-slate-900/30 m-0.5 cursor-pointer hover:bg-white/50">
              <BitcoinIcon class="w-22 inline-block mr-7 -rotate-24 opacity-80 relative top-px" />
              <div class="flex flex-col items-start justify-center grow">
                <div class="text-xl font-bold opacity-80 border-b border-argon-600/20 pb-1.5 mb-1.5">
                  Your {{ numeral(currency.satsToBtc(personalUtxo?.satoshis ?? 0n)).format('0,0.[00000000]') }} BTC Locking Failed
                </div>
                <div class="opacity-60">
                  The amount of bitcoin you sent was incorrect. It could not be accepted by Argon.
                </div>
              </div>
            </div>
            <div v-else-if="[BitcoinLockStatus.LockedAndMinting, BitcoinLockStatus.LockedAndMinted].includes(personalUtxo?.status!)" box class="grow flex flex-row items-center justify-start pl-[5%] pr-[3%] !py-5">
              <BitcoinIcon class="w-22 inline-block mr-5 -rotate-24 opacity-60" />
              <div class="flex flex-col items-start justify-center grow">
                <div class="text-xl font-bold opacity-60">
                  {{ numeral(currency.satsToBtc(personalUtxo?.satoshis ?? 0n)).format('0,0.[00000000]') }} BTC Locked (Value = {{ currency.symbol }}{{ microgonToMoneyNm(btcMarketRate).format('0,0.[00]') }})
                </div>
                <div class="opacity-40">
                  {{ currency.symbol}}{{ microgonToMoneyNm(personalUtxo?.liquidityPromised ?? 0n).format('0,0.[00]') }} Liquidity {{ personalUtxo?.status === BitcoinLockStatus.LockedAndMinting ? 'Promised' : 'Received'}}
                  /
                  {{ currency.symbol }}{{ microgonToMoneyNm(costToRelease).format('0,0.[00]') }} to Unlock
                </div>
              </div>
              <div class="flex flex-col gap-x-3 xl:flex-row-reverse items-center justify-center whitespace-nowrap">
                <div class="flex flex-row space-x-2 items-center justify-center">
                  <button @click="showReleaseOverlay=true" class="bg-argon-600 hover:bg-argon-700 text-white text-lg font-bold px-4 py-2 rounded-md cursor-pointer">Unlock Bitcoin</button>
                  <!-- <span class="opacity-40">or</span>
                  <button class="bg-argon-600 hover:bg-argon-700 text-white text-lg font-bold px-4 py-2 rounded-md cursor-pointer">Ratchet</button> -->
                </div>
                <div class="opacity-40 italic mt-1">
                  Expires in
                  <CountdownClock :time="lockExpirationTime" v-slot="{ hours, minutes, days }">
                    <template v-if="days === 0">
                      {{ hours }}h {{ minutes }}m
                    </template>
                    <template v-else>
                      {{ days }} Day{{ days > 1 ? 's' : '' }}
                    </template>
                  </CountdownClock>
                </div>
              </div>
            </div>
            <div v-else-if="personalUtxo?.status === BitcoinLockStatus.ReleaseSubmittingToArgon" @click="showReleaseOverlay=true" box class="grow flex flex-row items-center justify-start pl-[5%] pr-[3%] !py-5 opacity-80 hover:opacity-100 !bg-white/50 hover:!bg-white/100 cursor-pointer">
              <div class="flex flex-row items-center justify-center w-full fade-in-out">
                <BitcoinIcon class="w-24 inline-block mr-7 -rotate-24 relative top-px" />
                <div class="flex flex-col items-start justify-center grow">
                  <div class="text-xl font-bold opacity-60">
                    Unlocking Your {{ numeral(currency.satsToBtc(personalUtxo?.satoshis ?? 0n)).format('0,0.[00000000]') }} BTC <span class="font-light opacity-60">(Step 1 of 4)</span>
                  </div>
                  <div class="flex flex-row items-center justify-start w-full pr-5 mt-1 space-x-3">
                    <div class="whitespace-nowrap uppercase opacity-80 font-bold text-argon-600">Requesting Release from Argon Network</div>
                  </div>
                </div>
              </div>
            </div>
            <div v-else-if="personalUtxo?.status === BitcoinLockStatus.ReleaseWaitingForVault" @click="showReleaseOverlay=true" box class="grow flex flex-row items-center justify-start pl-[5%] pr-[3%] !py-5 opacity-80 hover:opacity-100 !bg-white/50 hover:!bg-white/100 cursor-pointer">
              <div class="flex flex-row items-center justify-center w-full fade-in-out">
                <BitcoinIcon class="w-24 inline-block mr-7 -rotate-24 opacity-80 relative top-px" />
                <div class="flex flex-col items-start justify-center grow">
                  <div class="text-xl font-bold opacity-60">
                    Unlocking Your {{ numeral(currency.satsToBtc(personalUtxo?.satoshis ?? 0n)).format('0,0.[00000000]') }} BTC <span class="font-light opacity-60">(Step 2 of 4)</span>
                  </div>
                  <div class="flex flex-row items-center justify-center w-full pr-5 mt-1 space-x-3">
                    <div class="whitespace-nowrap uppercase opacity-60">Waiting for Vault</div>
                    <ProgressBar :progress="50" class="!h-6 mt-0.5" />
                  </div>
                </div>
              </div>
            </div>
            <div v-else-if="personalUtxo?.status === BitcoinLockStatus.ReleaseSubmittingToBitcoin" @click="showReleaseOverlay=true" box class="grow flex flex-row items-center justify-start pl-[5%] pr-[3%] !py-5 opacity-80 hover:opacity-100 !bg-white/50 hover:!bg-white/100 cursor-pointer">
              <div class="flex flex-row items-center justify-center w-full fade-in-out">
                <BitcoinIcon class="w-24 inline-block mr-7 -rotate-24 relative top-px" />
                <div class="flex flex-col items-start justify-center grow">
                  <div class="text-xl font-bold opacity-60">
                    Unlocking Your {{ numeral(currency.satsToBtc(personalUtxo?.satoshis ?? 0n)).format('0,0.[00000000]') }} BTC <span class="font-light opacity-60">(Step 3 of 4)</span>
                  </div>
                  <div class="flex flex-row items-center justify-start w-full pr-5 mt-1 space-x-3">
                    <div class="whitespace-nowrap uppercase opacity-80 font-bold text-argon-600">Submitting Transfer to Bitcoin Network</div>
                  </div>
                </div>
              </div>
            </div>
            <div v-else-if="personalUtxo?.status === BitcoinLockStatus.ReleaseProcessingOnBitcoin" @click="showReleaseOverlay=true" box class="grow flex flex-row items-center justify-start pl-[5%] pr-[3%] !py-5 opacity-80 hover:opacity-100 !bg-white/50 hover:!bg-white/100 cursor-pointer">
              <div class="flex flex-row items-center justify-center w-full fade-in-out">
                <BitcoinIcon class="w-24 inline-block mr-7 -rotate-24 relative top-px" />
                <div class="flex flex-col items-start justify-center grow">
                  <div class="text-xl font-bold opacity-60">
                    Unlocking Your {{ numeral(currency.satsToBtc(personalUtxo?.satoshis ?? 0n)).format('0,0.[00000000]') }} BTC <span class="font-light opacity-60">(Step 4 of 4)</span>
                  </div>
                  <div class="flex flex-row items-center justify-center w-full pr-5 mt-1 space-x-3">
                    <div class="whitespace-nowrap uppercase opacity-60">Finalizing On Bitcoin</div>
                    <ProgressBar :progress="50" class="!h-6 mt-0.5" />
                  </div>
                </div>
              </div>
            </div>
          </section>

          <section box class="flex flex-col grow text-center px-2">
            <header class="flex flex-row justify-between text-xl font-bold py-2 text-slate-900/80 border-b border-slate-400/30">
              <div @click="goToPrevFrame" :class="hasPrevFrame ? 'opacity-60' : 'opacity-20 pointer-events-none'" class="flex flex-row items-center font-light text-base cursor-pointer group hover:opacity-80">
                <ChevronLeftIcon class="w-6 h-6 opacity-50 mx-1 group-hover:opacity-80" />
                PREV
              </div>
              <span class="flex flex-row items-center" :title="'Frame #' + currentFrame?.id">
                <span>{{ currentFrameStartDate }} to {{ currentFrameEndDate }}</span>
                <span v-if="currentFrame?.id > stats.latestFrameId - 10" class="inline-block rounded-full bg-green-500/80 w-2.5 h-2.5 ml-2"></span>
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
                  <TooltipTrigger as="span" class="font-bold text-argon-600 font-mono">
                    {{ currency.symbol }}{{ microgonToMoneyNm(currentFrame.totalTreasuryPayout).format('0,0.00') }}
                  </TooltipTrigger>
                  <TooltipContent side="bottom" :sideOffset="-10" align="center" :collisionPadding="9" class="text-center bg-white border border-gray-800/20 rounded-md shadow-2xl z-50 p-4 w-fit text-slate-900/60">
                    Total network revenue from mining bids.
                    <TooltipArrow :width="27" :height="15" class="fill-white stroke-[0.5px] stroke-gray-800/20 -mt-px" />
                  </TooltipContent>
                </TooltipRoot>
                (and growing), of which your take is 
                <TooltipRoot>
                  <TooltipTrigger as="span" class="font-bold text-argon-600 font-mono">0%</TooltipTrigger>,
                  <TooltipContent side="bottom" :sideOffset="-10" align="center" :collisionPadding="9" class="text-center bg-white border border-gray-800/20 rounded-md shadow-2xl z-50 p-4 w-sm text-slate-900/60">
                    The more capital you invest in treasury bonds, the higher your take-home percentage.
                    <TooltipArrow :width="27" :height="15" class="fill-white stroke-[0.5px] stroke-gray-800/20 -mt-px" />
                  </TooltipContent>
                </TooltipRoot>
                equaling 
                <TooltipRoot>
                  <TooltipTrigger as="span" class="font-bold text-argon-600 font-mono">{{ currency.symbol }}{{ microgonToMoneyNm(currentFrame.myTreasuryPayout).format('0,0.00') }}</TooltipTrigger>
                  <TooltipContent side="bottom" :sideOffset="-10" align="center" :collisionPadding="9" class="text-center bg-white border border-gray-800/20 rounded-md shadow-2xl z-50 p-4 w-fit text-slate-900/60">
                    This is what your vault has earned so far today.
                    <TooltipArrow :width="27" :height="15" class="fill-white stroke-[0.5px] stroke-gray-800/20 -mt-px" />
                  </TooltipContent>
                </TooltipRoot>
                <span class="hidden lg:inline"> in earnings</span>
              </div>

              <div class="flex flex-row w-full grow gap-x-2 mt-2">
                <TooltipRoot>
                  <TooltipTrigger as="div" stat-box class="flex flex-col w-1/3 h-full">
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
                  <TooltipContent side="bottom" :sideOffset="-10" align="center" :collisionPadding="9" class="text-center bg-white border border-gray-800/20 rounded-md shadow-2xl z-50 p-4 w-sm text-slate-900/60">
                    This progress of the current frame, which is equivalent to 24 hours.
                    <TooltipArrow :width="27" :height="15" class="fill-white stroke-[0.5px] stroke-gray-800/20 -mt-px" />
                  </TooltipContent>
                </TooltipRoot>

                <div class="h-full w-[1px] bg-slate-400/30"></div>

                <TooltipRoot>
                  <TooltipTrigger as="div" stat-box class="flex flex-col w-1/3 h-full pb-3">
                    <span data-testid="TotalBlocksMined">{{ currency.symbol }}0.00</span>
                    <label class="relative block w-full">
                      Bitcoin Lock Change
                      <HealthIndicatorBar :percent="getPercent(100, 100)" />
                    </label>
                  </TooltipTrigger>
                  <TooltipContent side="bottom" :sideOffset="-10" align="center" :collisionPadding="9" class="text-center bg-white border border-gray-800/20 rounded-md shadow-2xl z-50 p-4 w-sm text-slate-900/60">
                    The change (+/-) in bitcoin value held by your vault during this frame.
                    <TooltipArrow :width="27" :height="15" class="fill-white stroke-[0.5px] stroke-gray-800/20 -mt-px" />
                  </TooltipContent>
                </TooltipRoot>

                <div class="h-full w-[1px] bg-slate-400/30"></div>

                <TooltipRoot>
                  <TooltipTrigger as="div" stat-box class="flex flex-col w-1/3 h-full pb-3">
                    <span data-testid="TotalBlocksMined">{{ currency.symbol }}0.00</span>
                    <label class="relative block w-full">
                      Treasury Bond Change
                      <HealthIndicatorBar :percent="getPercent(0, 100)" />
                    </label>
                  </TooltipTrigger>
                  <TooltipContent side="bottom" :sideOffset="-10" align="center" :collisionPadding="9" class="text-center bg-white border border-gray-800/20 rounded-md shadow-2xl z-50 p-4 w-sm text-slate-900/60">
                    The change (+/-) in treasury bonds held by your vault during this frame.
                    <TooltipArrow :width="27" :height="15" class="fill-white stroke-[0.5px] stroke-gray-800/20 -mt-px" />
                  </TooltipContent>
                </TooltipRoot>

                <div class="h-full w-[1px] bg-slate-400/30"></div>

                <TooltipRoot>
                  <TooltipTrigger as="div" stat-box class="flex flex-col w-1/3 h-full pb-3">
                    <span data-testid="TotalBlocksMined">0%</span>
                    <label class="relative block w-full">
                      Current Frame Profit
                      <HealthIndicatorBar :percent="getPercent(0, 100)" />
                    </label>
                  </TooltipTrigger>
                  <TooltipContent side="bottom" :sideOffset="-10" align="center" :collisionPadding="9" class="text-center bg-white border border-gray-800/20 rounded-md shadow-2xl z-50 p-4 w-sm text-slate-900/60">
                    The profit percentage earn by your vault during this frame.
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
  <BitcoinFinishLockingOverlay
    v-if="showFinishLockingOverlay && personalUtxo"
    :lock="personalUtxo"
    @close="showFinishLockingOverlay = false"
  />

  <BitcoinReleaseOverlay
    v-if="showReleaseOverlay && personalUtxo"
    :lock="personalUtxo"
    @close="showReleaseOverlay = false"
  />

  <VaultCollectOverlay
    v-if="showCollectOverlay"
    @close="showCollectOverlay = false"
  />

  <BitcoinAddOverlay
    v-if="showAddOverlay"
    @close="showAddOverlay = false"
  />

  <VaultEditOverlay
    v-if="showEditOverlay"
    @close="showEditOverlay = false"
  />
</template>

<script lang="ts">
const currentFrame = Vue.ref({
  id: 0,
  date: '',
  firstTick: 0,
  lastTick: 0,
  score: 0,
  progress: 0,
  totalTreasuryPayout: 0n,
  myTreasuryPayout: 0n,
});

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
import { MyVault } from '../../lib/MyVault.ts';
import CountdownClock from '../../components/CountdownClock.vue';
import { useBitcoinLocks } from '../../stores/bitcoin.ts';
import ArgonIcon from '../../assets/resources/argon.svg?component';
import ArgonotIcon from '../../assets/resources/argonot.svg?component';
import { ChevronLeftIcon, ChevronRightIcon } from '@heroicons/vue/24/outline';
import { TICK_MILLIS } from '../../lib/Env.ts';
import BitcoinFinishLockingOverlay from '../../overlays/BitcoinFinishLockingOverlay.vue';
import BitcoinReleaseOverlay from '../../overlays/BitcoinReleaseOverlay.vue';
import VaultCollectOverlay from '../../overlays/VaultCollectOverlay.vue';
import BitcoinAddOverlay from '../../overlays/BitcoinAddOverlay.vue';
import VaultEditOverlay from '../../overlays/VaultEditOverlay.vue';
import SigningIcon from '../../assets/signing.svg?component';
import MoneyIcon from '../../assets/money.svg?component';
import { useWallets } from '../../stores/wallets';
import FrameSlider, { IChartItem } from '../../components/FrameSlider.vue';
import { useStats } from '../../stores/stats';
import BitcoinIcon from '../../assets/wallets/bitcoin-thin.svg?component';
import SuccessIcon from '../../assets/success.svg?component';
import VaultIcon from '../../assets/vault.svg?component';
import HealthIndicatorBar from '../../components/HealthIndicatorBar.vue';
import BigNumber from 'bignumber.js';
import { MiningFrames } from '@argonprotocol/commander-core';
import { bigIntMin } from '@argonprotocol/commander-core/src/utils.ts';
import { ArrowTurnDownRightIcon } from '@heroicons/vue/24/outline';
import { HoverCardArrow, HoverCardContent, HoverCardRoot, HoverCardTrigger } from 'reka-ui';
import { TooltipProvider, TooltipRoot, TooltipTrigger, TooltipContent, TooltipArrow } from 'reka-ui';
import { BitcoinLockStatus } from '../../lib/db/BitcoinLocksTable.ts';
import { IMempoolFundingStatus } from '../../lib/BitcoinLocksStore.ts';
import ProgressBar from '../../components/ProgressBar.vue';

dayjs.extend(relativeTime);
dayjs.extend(utc);

const vault = useMyVault();
const vaults = useVaults();
const wallets = useWallets();
const bitcoinLocks = useBitcoinLocks();
const config = useConfig();
const currency = useCurrency();
const stats = useStats();

const rules = config.vaultingRules;

interface IFrameRecord {
  id: number;
  date: string;
  firstTick: number;
  lastTick: number;
  score: number;
  progress: number;
  totalTreasuryPayout: bigint;
  myTreasuryPayout: bigint;
}

const frameSliderRef = Vue.ref<InstanceType<typeof FrameSlider> | null>(null);
const frameRecords = Vue.ref<IFrameRecord[]>([]);
const chartItems = Vue.ref<IChartItem[]>([]);

const { microgonToMoneyNm, micronotToMoneyNm, microgonToArgonNm } = createNumeralHelpers(currency);

// For the Vault UI countdown clock
const nextCollectDueDate = Vue.computed(() => {
  return dayjs.utc(vault.data.nextCollectDueDate);
});

const personalUtxo = Vue.computed(() => {
  const utxoId = vault.metadata?.personalUtxoId;
  return utxoId ? bitcoinLocks.data.locksById[utxoId] : null;
});

const mempoolLockingStatus = Vue.ref<IMempoolFundingStatus | undefined>(undefined);
const lockExpirationTime = Vue.ref(dayjs.utc());
const lockInitializeExpirationTime = Vue.ref(dayjs.utc().add(1, 'day'));
const lockInitializeHasExpired = Vue.computed(() => {
  return dayjs.utc().isAfter(lockInitializeExpirationTime.value);
});

const btcMarketRate = Vue.ref(0n);

const costToRelease = Vue.computed(() => {
  return bigIntMin(personalUtxo.value?.peggedPrice ?? 0n, btcMarketRate.value);
}) as Vue.ComputedRef<bigint>;

const mintPercent = Vue.computed(() => {
  const utxo = personalUtxo.value;
  if (!utxo) return 0n;
  const { mintAmount, mintPending } = utxo.ratchets[0];
  if (mintPending === 0n) return 100;
  return (100 * Number(mintAmount - mintPending)) / Number(mintAmount);
});

const vaultCapital = Vue.computed(() => {
  const { microgonsForVaulting } = MyVault.getMicrogoonSplit(config.vaultingRules);
  return microgonsForVaulting;
});

const activatedSecuritization = Vue.computed(() => {
  return vault.createdVault?.activatedSecuritization() ?? 0n;
});

const pendingSecuritization = Vue.computed(() => {
  return vault.createdVault?.argonsPendingActivation ?? 0n;
});

const waitingSecuritization = Vue.computed(() => {
  const { microgonsForSecuritization } = MyVault.getMicrogoonSplit(config.vaultingRules);
  return microgonsForSecuritization - (activatedSecuritization.value + pendingSecuritization.value);
});

const ownTreasuryPoolCapitalDeployed = Vue.computed(() => {
  const treasuryPool = vault.data.stats;
  if (!treasuryPool) return 0n;
  return treasuryPool.changesByFrame
    .slice(0, 10)
    .reduce((acc, change) => acc + (change.treasuryPool.vaultCapital ?? 0n), 0n);
});

const activatedTreasuryPoolInvestment = Vue.computed(() => {
  const { microgonsForTreasury } = MyVault.getMicrogoonSplit(config.vaultingRules);
  return bigIntMin(microgonsForTreasury, activatedSecuritization.value);
});

const pendingTreasuryPoolInvestment = Vue.computed(() => {
  const { microgonsForTreasury } = MyVault.getMicrogoonSplit(config.vaultingRules);
  return microgonsForTreasury - activatedTreasuryPoolInvestment.value;
});

const capitalInUse = Vue.computed(() => {
  return activatedSecuritization.value + ownTreasuryPoolCapitalDeployed.value;
});

const totalVaultValue = Vue.computed(() => {
  return wallets.totalVaultingResources - (costToRelease.value + vault.data.pendingCollectRevenue);
});

const bitcoinLockedValue = Vue.computed<bigint>(() => {
  return vault.createdVault!.activatedSecuritization() ?? 0n;
});

const pendingMintingValue = Vue.computed<bigint>(() => {
  return bitcoinLocks.totalMintPending;
});

const apy = Vue.computed(() => {
  const stats = vault.data.stats;
  if (!stats) return 0;
  let ytdRevenue = 0n;
  const capitalDeployed: bigint[] = [];
  let framesRemaining = 365; // Assuming 365 frames for a year
  for (const change of stats.changesByFrame) {
    ytdRevenue += change.bitcoinFeeRevenue;
    ytdRevenue += change.treasuryPool.vaultEarnings;
    capitalDeployed.push(change.securitization + change.treasuryPool.vaultCapital);
    framesRemaining -= 1;
    if (framesRemaining <= 0) break;
  }
  if (framesRemaining > 0) {
    ytdRevenue += stats.baseline.feeRevenue;
  }
  const averageCapitalDeployed =
    capitalDeployed.reduce((acc, val) => acc + val, 0n) / BigInt(capitalDeployed.length || 1);
  return (Number(ytdRevenue) * 100) / Number(averageCapitalDeployed);
});

const revenueMicrogons = Vue.computed(() => {
  const stats = vault.data.stats;
  if (!stats) return 0n;
  let sum = stats.baseline.feeRevenue ?? 0n;
  for (const change of stats.changesByFrame) {
    sum += change.bitcoinFeeRevenue ?? 0n;
    sum += change.treasuryPool.vaultEarnings ?? 0n;
  }
  return sum;
});

const bitcoinTransactions = Vue.computed(() => {
  const stats = vault.data.stats;
  if (!stats) return 0;
  let sum = stats.baseline.bitcoinLocks ?? 0;
  for (const change of stats.changesByFrame) {
    sum += change.bitcoinLocksCreated ?? 0;
  }
  return sum;
});

const showFinishLockingOverlay = Vue.ref(false);
const showReleaseOverlay = Vue.ref(false);
const showCollectOverlay = Vue.ref(false);
const showAddOverlay = Vue.ref(false);
const showEditOverlay = Vue.ref(false);

const hasNextFrame = Vue.computed(() => {
  return sliderFrameIndex.value < frameRecords.value.length - 1;
});

const hasPrevFrame = Vue.computed(() => {
  return sliderFrameIndex.value > 0;
});

const currentFrameStartDate = Vue.computed(() => {
  if (!currentFrame.value.firstTick) {
    console.log('currentFrame', currentFrame.value);
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

const treasuryPoolCapitalByFrame = Vue.computed(() => {
  const myVaultId = vault.createdVault?.vaultId;
  if (!myVaultId) return {};

  const byFrame: { [frameId: string]: { me: bigint; total: bigint } } = {};

  for (const [vaultId, vaultStats] of Object.entries(vaults.stats?.vaultsById || {})) {
    for (const change of vaultStats.changesByFrame || []) {
      byFrame[change.frameId - 1] ??= { me: 0n, total: 0n };
      byFrame[change.frameId - 1].total += change.treasuryPool.totalEarnings;
      if (vaultId === myVaultId.toString()) {
        byFrame[change.frameId - 1].me += change.treasuryPool.totalEarnings;
      }
    }
  }
  return byFrame;
});

function updateLockExpiration() {
  if (personalUtxo.value) {
    bitcoinLocks.load().then(() => {
      const expirationMillis = bitcoinLocks.approximateExpirationTime(personalUtxo.value!);
      lockExpirationTime.value = dayjs.utc(expirationMillis);
    });
  }
}

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

function getPercent(value: bigint | number, total: bigint | number): number {
  if (total === 0n || total === 0) return 0;
  return BigNumber(value).dividedBy(total).multipliedBy(100).toNumber();
}

function openVaultEditOverlay() {
  showEditOverlay.value = true;
}

async function loadChartData() {
  const ticksPerFrame = MiningFrames.ticksPerFrame;
  const currentTick = MiningFrames.calculateCurrentTickFromSystemTime();
  const startingDate = dayjs.utc().startOf('day');
  const startingTickRange = MiningFrames.getTickRangeForFrame(stats.latestFrameId);
  const progress = ((currentTick - startingTickRange[0]) / ticksPerFrame) * 100;

  const records: IFrameRecord[] = [
    {
      id: stats.latestFrameId,
      date: startingDate.format('YYYY-MM-DD'),
      firstTick: startingTickRange[0],
      lastTick: startingTickRange[1],
      totalTreasuryPayout: treasuryPoolCapitalByFrame.value[stats.latestFrameId]?.total || 0n,
      myTreasuryPayout: treasuryPoolCapitalByFrame.value[stats.latestFrameId]?.me || 0n,
      score: 100,
      progress,
    },
  ];

  while (records.length < 365) {
    const earliestRecord = records[0];
    if (!earliestRecord) break;
    const previousDay = dayjs.utc(earliestRecord.date).subtract(1, 'day');
    if (previousDay.isBefore(dayjs.utc('2025-01-01'))) {
      break;
    }

    const blankRecord = {
      id: earliestRecord.id - 1,
      date: previousDay.format('YYYY-MM-DD'),
      firstTick: earliestRecord.firstTick - ticksPerFrame,
      lastTick: earliestRecord.lastTick - ticksPerFrame,
      myTreasuryPayout: 0n,
      totalTreasuryPayout: 0n,
      score: 0,
      progress: 100,
    };
    records.unshift(blankRecord);
  }

  let isFiller = true;
  const items: any[] = [];
  for (const [index, frame] of records.entries()) {
    if (isFiller && frame.score > 0) {
      const previousItem = items[index - 1];
      previousItem && (previousItem.isFiller = false);
      isFiller = false;
    }
    const item = {
      date: frame.date,
      score: frame.score,
      progress: frame.progress,
      frameId: frame.id,
      totalTreasuryPayout: frame.totalTreasuryPayout,
      myTreasuryPayout: frame.myTreasuryPayout,
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
  frameRecords.value = records;
}

Vue.watch(personalUtxo, async () => {
  if (!personalUtxo.value) return;
  bitcoinLocks.confirmAddress(personalUtxo.value);
  bitcoinLocks.load().then(() => {
    lockInitializeExpirationTime.value = dayjs.utc(bitcoinLocks.verifyExpirationTime(personalUtxo.value!));
  });
  btcMarketRate.value = await vaults.getMarketRate(personalUtxo.value.satoshis).catch(() => 0n);
});

Vue.onMounted(async () => {
  await vault.load();
  await vault.subscribe();
  await bitcoinLocks.load();
  await bitcoinLocks.subscribeToArgonBlocks();

  updateLockExpiration();

  if (personalUtxo.value) {
    const utxo = personalUtxo.value;

    if ([BitcoinLockStatus.LockInitialized, BitcoinLockStatus.LockProcessingOnBitcoin].includes(utxo.status)) {
      await bitcoinLocks.monitorLockProcessingOnBitcoin(utxo, x => (mempoolLockingStatus.value = x));
    }

    // if ([BitcoinLockStatus.ReleaseWaitingForVault].includes(utxo.status)) {
    //   await bitcoinLocks.monitorLockProcessingOnBitcoin(utxo, x => (mempoolLockingStatus.value = x));
    // }

    btcMarketRate.value = await vaults.getRedemptionRate(utxo).catch(() => 0n);
    lockInitializeExpirationTime.value = dayjs.utc(bitcoinLocks.verifyExpirationTime(utxo));

    personalUtxo.value.status = BitcoinLockStatus.ReleaseSubmittingToArgon;
    lockInitializeExpirationTime.value = dayjs.utc().subtract(1, 'day');
  }

  await loadChartData();
});

Vue.onUnmounted(() => {
  vault.unsubscribe();
  bitcoinLocks.unsubscribeFromArgonBlocks();
  bitcoinLocks.stopMonitoringLockProcessingOnBitcoin();
});
</script>

<style scoped>
@reference "../../main.css";

[box] {
  @apply rounded border-[1px] border-slate-400/30 bg-white py-2 shadow;
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

.fade-in-out {
  animation: fadeInOut 1s ease-in-out infinite;
  &:hover {
    animation: none !important;
  }
}

@keyframes fadeInOut {
  0%,
  100% {
    opacity: 0.4;
  }
  50% {
    opacity: 1;
  }
}
</style>
