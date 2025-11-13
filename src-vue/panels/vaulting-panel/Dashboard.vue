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
          <header class="text-[18px] font-bold py-2 text-slate-900/80 border-b border-slate-400/30">
            Asset Breakdown
          </header>
          <ul class="relative flex flex-col items-center whitespace-nowrap w-full min-h-6/12 mb-4 text-md">
            <li class="flex flex-col w-full min-h-[calc(100%/7)] py-1">
              <HoverCardRoot :openDelay="200" :closeDelay="100">
                <HoverCardTrigger as="div" class="flex flex-row items-center w-full pt-1 hover:text-argon-600 hover:bg-argon-200/10 rounded">
                  <ArgonIcon class="w-7 h-7 text-argon-600/70 mr-2" />
                  <div class="grow">Unused Argons</div>
                  <div class="pr-1">
                    {{ currency.symbol
                    }}{{ microgonToMoneyNm(wallets.vaultingWallet.availableMicrogons).format('0,0.00') }}
                  </div>
                </HoverCardTrigger>
                <HoverCardContent align="center" side="right" :avoidCollisions="false" class="bg-white border border-gray-800/20 rounded-md shadow-2xl z-50 py-4 px-5 w-fit text-slate-900/60">
                  <p class="break-words whitespace-normal">
                     These argons are not currently being used.
                  </p>
                  <HoverCardArrow :width="27" :height="15" class="fill-white stroke-[0.5px] stroke-gray-800/20 -mt-px" />
                </HoverCardContent>
              </HoverCardRoot>
              <div class="flex flex-col ml-9 gap-y-1 text-slate-900/60">
                <HoverCardRoot :openDelay="200" :closeDelay="100">
                  <HoverCardTrigger as="div" class="border-t border-gray-600/20 border-dashed pt-2 relative hover:text-argon-600 hover:bg-argon-200/10 rounded">
                    <ArrowTurnDownRightIcon class="w-5 h-5 text-slate-600/40 absolute top-1/2 -translate-y-1/2 -translate-x-[130%] left-0" />
                    {{ microgonToArgonNm(pendingMintingValue).format('0,0.[00]') }} Pending Mints
                  </HoverCardTrigger>
                  <HoverCardContent align="start" :alignOffset="-20" side="right" :avoidCollisions="false" class="bg-white border border-gray-800/20 rounded-md shadow-2xl z-50 py-4 px-5 w-md text-slate-900/60">
                    <p v-if="pendingMintingValue" class="break-words whitespace-normal">
                      These have been earned, but they have not yet been minted. Minting is determined
                      by supply and demand, which means, although you're guaranteed to get them, the timeframe is unknown.
                    </p>
                    <p v-else class="break-words whitespace-normal">
                      This is where you'll see argons that are earned but not yet minted. You currently have zero argons waiting in the minting queue.
                    </p>
                    <HoverCardArrow :width="27" :height="15" class="fill-white stroke-[0.5px] stroke-gray-800/20 -mt-px" />
                  </HoverCardContent>
                </HoverCardRoot>
                <HoverCardRoot :openDelay="200" :closeDelay="100">
                  <HoverCardTrigger as="div" class="border-t border-gray-600/20 border-dashed pt-2 relative hover:text-argon-600">
                    <ArrowTurnDownRightIcon class="w-5 h-5 text-slate-600/40 absolute top-1/2 -translate-y-1/2 -translate-x-[130%] left-0" />
                    <template v-if="!myVault.data.pendingAllocateTxInfo">
                    {{ microgonToArgonNm(sidelinedMicrogons).format('0,0.[00]') }} Sidelined
                    </template>
                    <template v-else>
                      {{ microgonToArgonNm(myVault.data.pendingAllocateTxInfo.tx.metadataJson.addedSecuritizationMicrogons +
                        myVault.data.pendingAllocateTxInfo.tx.metadataJson.addedTreasuryMicrogons).format('0,0.[00]') }} Activation in
                      Progress
                    </template>
                  </HoverCardTrigger>
                  <HoverCardContent align="start" :alignOffset="-20" side="right" :avoidCollisions="false" class="bg-white border border-gray-800/20 rounded-md shadow-2xl z-50 py-4 px-5 w-md text-slate-900/60">
                    <p class="break-words whitespace-normal">
                      <template v-if="!myVault.data.pendingAllocateTxInfo">
                        These argons are available for use. Click the Activate button to distribute them
                      between bitcoin securitization and treasury bonds.
                      </template>
                      <template v-else>
                        These argons are currently being activated. Once the activation transaction is finalized,
                        they will be distributed between bitcoin securitization and treasury bonds.
                      </template>
                    </p>
                    <div class="flex flex-row items-center border-t border-gray-600/20 pt-4 mt-3 w-full">
                      <button class="text-white font-bold px-5 py-2 rounded-md cursor-pointer w-full text-base bg-argon-600"
                              @click="openActivateOverlay">
                        <template v-if="!myVault.data.pendingAllocateTxInfo">
                          Activate these Unused Argons
                        </template>
                        <template v-else>
                          View Activation Progress
                        </template>
                      </button>
                    </div>
                    <HoverCardArrow :width="27" :height="15" class="fill-white stroke-[0.5px] stroke-gray-800/20 -mt-px" />
                  </HoverCardContent>
                </HoverCardRoot>
                <HoverCardRoot :openDelay="200" :closeDelay="100">
                  <HoverCardTrigger as="div" class="border-t border-gray-600/20 border-dashed pt-2 relative hover:text-argon-600 hover:bg-argon-200/10 rounded">
                    <ArrowTurnDownRightIcon class="w-5 h-5 text-slate-600/40 absolute top-1/2 -translate-y-1/2 -translate-x-[130%] left-0" />
                    {{ microgonToArgonNm(operationalMicrogons).format('0,0.[00]') }} Reserved for Operations
                  </HoverCardTrigger>
                  <HoverCardContent align="start" :alignOffset="-20" side="right" :avoidCollisions="false" class="bg-white border border-gray-800/20 rounded-md shadow-2xl z-50 py-4 px-5 w-md text-slate-900/60">
                    <p v-if="operationalMicrogons" class="break-words whitespace-normal">
                      These are reserved for transaction fees required by vault operations. If this drops too low, you will
                      be unable to perform basic tasks such as collecting revenue or locking/unlocking bitcoins.
                    </p>
                    <p v-else class="break-words whitespace-normal">
                      This is the amount of argons reserved for operations. You need to add an argon to your vault's wallet
                      so that it can perform basic tasks such as collecting revenue or locking/unlocking bitcoins.
                    </p>
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
                    }}{{ micronotToMoneyNm(activatedSecuritization + pendingSecuritization + waitingSecuritization).format('0,0.00') }}
                  </div>
                </HoverCardTrigger>
                <HoverCardContent align="start" :alignOffset="-20" side="right" :avoidCollisions="false" class="bg-white border border-gray-800/20 rounded-md shadow-2xl z-50 py-4 px-5 w-md text-slate-900/60">
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
                  <HoverCardContent align="start" :alignOffset="-20" side="right" :avoidCollisions="false" class="bg-white border border-gray-800/20 rounded-md shadow-2xl z-50 py-4 px-5 w-md text-slate-900/60">
                    <p class="break-words whitespace-normal">
                      These argons have not yet been applied to your vault's securitization. They are waiting for new bitcoins to be added to your vault.
                    </p>
                    <div class="flex flex-row items-center border-t border-gray-600/20 pt-4 mt-3 w-full">
                      <button class="bg-argon-600 hover:bg-argon-700 text-white font-bold px-5 py-2 rounded-md cursor-pointer w-full text-base">
                        Deactivate these Argons from Bitcoin Security
                      </button>
                    </div>
                    <HoverCardArrow :width="27" :height="15" class="fill-white stroke-[0.5px] stroke-gray-800/20 -mt-px" />
                  </HoverCardContent>
                </HoverCardRoot>
                <HoverCardRoot :openDelay="200" :closeDelay="100">
                  <HoverCardTrigger as="div" class="border-t border-gray-600/20 border-dashed pt-2 relative hover:text-argon-600">
                    <ArrowTurnDownRightIcon class="w-5 h-5 text-slate-600/40 absolute top-1/2 -translate-y-1/2 -translate-x-[130%] left-0" />
                    {{ microgonToArgonNm(pendingSecuritization).format('0,0.[00]') }} Pending Finalization
                  </HoverCardTrigger>
                  <HoverCardContent align="start" :alignOffset="-20" side="right" :avoidCollisions="false" class="bg-white border border-gray-800/20 rounded-md shadow-2xl z-50 py-4 px-5 w-md text-slate-900/60">
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
                  <HoverCardContent align="start" :alignOffset="-20" side="right" :avoidCollisions="false" class="bg-white border border-gray-800/20 rounded-md shadow-2xl z-50 py-4 px-5 w-md text-slate-900/60">
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
                <HoverCardContent align="start" :alignOffset="-20" side="right" :avoidCollisions="false" class="bg-white border border-gray-800/20 rounded-md shadow-2xl z-50 py-4 px-5 w-md text-slate-900/60">
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
                  <HoverCardContent align="start" :alignOffset="-20" side="right" :avoidCollisions="false" class="bg-white border border-gray-800/20 rounded-md shadow-2xl z-50 py-4 px-5 w-md text-slate-900/60">
                    <p class="break-words whitespace-normal">
                      This capital is sitting idle because your vault does not have enough bitcoin. The amount
                      in treasury bonds cannot exceed the bitcoin value in your vault.
                    </p>
                    <div class="flex flex-row items-center border-t border-gray-600/20 pt-4 mt-3 w-full">
                      <button class="bg-argon-600 hover:bg-argon-700 text-white font-bold px-5 py-2 rounded-md cursor-pointer text-base">
                        Deactivate these Argons from Treasury Bonds</button>
                        <!-- {{ microgonToArgonNm(pendingTreasuryPoolInvestment).format('0,0.[00]') }} -->
                    </div>
                    <HoverCardArrow :width="27" :height="15" class="fill-white stroke-[0.5px] stroke-gray-800/20 -mt-px" />
                  </HoverCardContent>
                </HoverCardRoot>
                <HoverCardRoot :openDelay="200" :closeDelay="100">
                  <HoverCardTrigger as="div" class="border-t border-gray-600/20 border-dashed pt-2 relative hover:text-argon-600">
                    <ArrowTurnDownRightIcon class="w-5 h-5 text-slate-600/40 absolute top-1/2 -translate-y-1/2 -translate-x-[130%] left-0" />
                    {{ microgonToArgonNm(activatedTreasuryPoolInvestment).format('0,0.[00]') }} Actively In Use
                  </HoverCardTrigger>
                  <HoverCardContent align="start" :alignOffset="-20" side="right" :avoidCollisions="false" class="bg-white border border-gray-800/20 rounded-md shadow-2xl z-50 py-4 px-5 w-md text-slate-900/60">
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
            <li class="flex flex-row items-center w-full border-t border-gray-600/50 py-2 text-red-900/70"
                v-if="[BitcoinLockStatus.LockedAndIsMinting, BitcoinLockStatus.LockedAndMinted].includes(personalUtxo?.status as any)">
              <HoverCardRoot :openDelay="200" :closeDelay="100">
                <HoverCardTrigger as="div" class="flex flex-row items-center w-full hover:text-argon-600">
                  <div class="grow pl-1"><span class="hidden xl:inline">Cost to</span> Unlock Bitcoin</div>
                  <div class="pr-1">
                    -{{ currency.symbol
                    }}{{ microgonToMoneyNm(unlockPrice).format('0,0.[00]') }}
                  </div>
                </HoverCardTrigger>
                <HoverCardContent align="start" :alignOffset="-20" side="right" :avoidCollisions="false" class="bg-white border border-gray-800/20 rounded-md shadow-2xl z-50 py-4 px-5 w-md text-slate-900/60">
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
                    }}{{ microgonToMoneyNm(myVault.metadata?.operationalFeeMicrogons ?? 0n).format('0,0.00') }}
                  </div>
                </HoverCardTrigger>
                <HoverCardContent align="start" :alignOffset="-20" side="right" :avoidCollisions="false" class="bg-white border border-gray-800/20 rounded-md shadow-2xl z-50 py-4 px-5 w-md text-slate-900/60">
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
                <HoverCardContent align="start" :alignOffset="-20" side="right" :avoidCollisions="false" class="bg-white border border-gray-800/20 rounded-md shadow-2xl z-50 py-4 px-5 w-fit text-slate-900/60">
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
          <PersonalBitcoin ref="personalBitcoin" />

          <section box class="flex flex-col grow text-center px-2">
            <header class="flex flex-row justify-between text-xl font-bold py-2 text-slate-900/80 border-b border-slate-400/30">
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
                    This progress of the current frame, which is equivalent to 24 hours.
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

  <VaultActivateOverlay
    v-if="showActivateOverlay"
    @close="showActivateOverlay = false"
  />
</template>

<script lang="ts">
interface IVaultFrameRecord {
  id: number;
  date: string;
  firstTick: number;
  lastTick: number;
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
  lastTick: 0,
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
import ArgonIcon from '../../assets/resources/argon.svg?component';
import ArgonotIcon from '../../assets/resources/argonot.svg?component';
import { ChevronLeftIcon, ChevronRightIcon } from '@heroicons/vue/24/outline';
import { TICK_MILLIS } from '../../lib/Env.ts';
import VaultCollectOverlay from '../../overlays/VaultCollectOverlay.vue';
import VaultEditOverlay from '../../overlays/VaultEditOverlay.vue';
import VaultActivateOverlay from '../../overlays/VaultActivateOverlay.vue';
import SigningIcon from '../../assets/signing.svg?component';
import MoneyIcon from '../../assets/money.svg?component';
import { useWallets } from '../../stores/wallets';
import FrameSlider, { IChartItem } from '../../components/FrameSlider.vue';
import SuccessIcon from '../../assets/success.svg?component';
import VaultIcon from '../../assets/vault.svg?component';
import HealthIndicatorBar from '../../components/HealthIndicatorBar.vue';
import { bigIntMax, MiningFrames, TreasuryPool } from '@argonprotocol/apps-core';
import { ArrowTurnDownRightIcon } from '@heroicons/vue/24/outline';
import { HoverCardArrow, HoverCardContent, HoverCardRoot, HoverCardTrigger } from 'reka-ui';
import { TooltipProvider, TooltipRoot, TooltipTrigger, TooltipContent, TooltipArrow } from 'reka-ui';
import { BitcoinLockStatus } from '../../lib/db/BitcoinLocksTable.ts';
import { IVaultFrameStats } from '../../interfaces/IVaultStats.ts';
import { getMainchainClient, getMining } from '../../stores/mainchain.ts';
import { calculateAPY, getPercent, percentOf } from '../../lib/Utils.ts';
import PersonalBitcoin from './components/PersonalBitcoin.vue';
import { useBitcoinLocks } from '../../stores/bitcoin.ts';
import { MyVault } from '../../lib/MyVault.ts';

dayjs.extend(relativeTime);
dayjs.extend(utc);

const myVault = useMyVault();
const vaults = useVaults();
const wallets = useWallets();
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

const { microgonToMoneyNm, micronotToMoneyNm, microgonToArgonNm } = createNumeralHelpers(currency);

// For the Vault UI countdown clock
const nextCollectDueDate = Vue.computed(() => {
  return dayjs.utc(myVault.data.nextCollectDueDate);
});

const pendingCollectTxMetadata = Vue.computed(() => {
  return myVault.data.pendingCollectTxInfo?.tx.metadataJson;
});

const personalUtxo = Vue.computed(() => personalBitcoin.value?.personalUtxo);
const unlockPrice = Vue.computed(() => personalBitcoin.value?.unlockPrice ?? 0n);

const activatedSecuritization = Vue.computed(() => {
  return myVault.createdVault?.activatedSecuritization() ?? 0n;
});

const pendingSecuritization = Vue.computed(() => {
  return myVault.createdVault?.argonsPendingActivation ?? 0n;
});

const waitingSecuritization = Vue.computed(() => {
  const securitization = myVault.createdVault?.securitization ?? 0n;
  return securitization - (activatedSecuritization.value + pendingSecuritization.value);
});

const totalTreasuryPoolBonds = Vue.computed(() => {
  return internalTreasuryPoolBonds.value + externalTreasuryBonds.value;
});

const sidelinedMicrogons = Vue.computed(() => {
  return bigIntMax(wallets.vaultingWallet.availableMicrogons - MyVault.OperationalReserves, 0n);
});

const operationalMicrogons = Vue.computed(() => {
  if (wallets.vaultingWallet.availableMicrogons < MyVault.OperationalReserves)
    return wallets.vaultingWallet.availableMicrogons;
  return MyVault.OperationalReserves;
});

const internalTreasuryPoolBonds = Vue.computed(() => {
  const revenue = myVault.data.stats;
  if (!revenue) return 0n;
  return revenue.changesByFrame
    .slice(0, 10)
    .filter(x => x.frameId >= myVault.data.currentFrameId - 10)
    .reduce((acc, change) => acc + (change.treasuryPool.vaultCapital ?? 0n), 0n);
});

const activatedTreasuryPoolInvestment = Vue.computed(() => {
  return internalTreasuryPoolBonds.value;
});

const pendingTreasuryPoolInvestment = Vue.computed(() => {
  return myVault.data.prebondedMicrogons ?? 0n;
});

const externalTreasuryBonds = Vue.computed(() => {
  const revenue = myVault.data.stats;
  if (!revenue) return 0n;
  return revenue.changesByFrame
    .slice(0, 10)
    .filter(x => x.frameId >= myVault.data.currentFrameId - 10)
    .reduce((acc, change) => acc + (change.treasuryPool.externalCapital ?? 0n), 0n);
});

const totalVaultValue = Vue.computed(() => {
  return (
    wallets.totalVaultingResources -
    (unlockPrice.value + myVault.data.pendingCollectRevenue + pendingMintingValue.value)
  );
});

const bitcoinLockedValue = Vue.computed<bigint>(() => {
  if (!myVault.createdVault) return 0n;
  return myVault.createdVault.activatedSecuritization() - myVault.createdVault.getRelockCapacity();
});

const pendingMintingValue = Vue.computed<bigint>(() => {
  return bitcoinLocks.totalMintPending;
});

async function openActivateOverlay() {
  showActivateOverlay.value = true;
}

const currentApy = Vue.computed(() => {
  const stats = myVault.data.stats;
  if (!stats) return 0;

  const capitalDeployed: bigint[] = [];
  let sum = 0n;
  let startingFrame: number | undefined = undefined;
  let oldestFrame: number | undefined = undefined;
  for (const change of stats.changesByFrame) {
    if (change.uncollectedEarnings === 0n) {
      sum += change.bitcoinFeeRevenue ?? 0n;
      sum += change.treasuryPool.vaultEarnings ?? 0n;
    }
    if (change.bitcoinFeeRevenue > 0n || change.treasuryPool.vaultEarnings > 0n) {
      startingFrame = Math.max(startingFrame ?? change.frameId, change.frameId);
      oldestFrame = Math.min(oldestFrame ?? change.frameId, change.frameId);
    }
    capitalDeployed.push(change.securitization + change.treasuryPool.vaultCapital);
  }

  const averageCapitalDeployed =
    capitalDeployed.reduce((acc, val) => acc + val, 0n) / BigInt(capitalDeployed.length || 1);
  const frames = (oldestFrame !== undefined && startingFrame !== undefined)
    ? startingFrame - oldestFrame + 1
    : undefined;
  return calculateAPY(averageCapitalDeployed, averageCapitalDeployed + revenueMicrogons.value, frames);
});

const revenueMicrogons = Vue.computed(() => {
  const stats = myVault.data.stats;
  if (!stats) return 0n;
  let sum = stats.baseline.feeRevenue ?? 0n;
  for (const change of stats.changesByFrame) {
    if (change.uncollectedEarnings === 0n) {
      sum += change.bitcoinFeeRevenue ?? 0n;
      sum += change.treasuryPool.vaultEarnings ?? 0n;
    }
  }
  return sum;
});

const showCollectOverlay = Vue.ref(false);
const showEditOverlay = Vue.ref(false);
const showActivateOverlay = Vue.ref(false);

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
  if (!currentFrame.value.lastTick) {
    return '-----';
  }
  const date = dayjs.utc(currentFrame.value.lastTick * TICK_MILLIS);
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

function updateLatestFrameProgress() {
  if (frameRecords.value.length === 0) return;
  const latestFrame = frameRecords.value.at(-1);
  if (!latestFrame) return;
  if (currentFrame.value.id === latestFrame.id) {
    const ticksPerFrame = MiningFrames.ticksPerFrame;
    const currentTick = MiningFrames.calculateCurrentTickFromSystemTime();
    const tickRange = MiningFrames.getTickRangeForFrame(latestFrame.id);
    latestFrame.progress = ((currentTick - tickRange[0]) / ticksPerFrame) * 100;
    if (latestFrame.progress > 100) {
      latestFrame.progress = 100;
    }
  }
}

const mining = getMining();

let frameIdLoaded: number | undefined = undefined;
async function loadChartData(currentFrameId?: number) {
  const revenue = myVault.data.stats;

  const ticksPerFrame = MiningFrames.ticksPerFrame;
  const currentTick = MiningFrames.calculateCurrentTickFromSystemTime();
  currentFrameId ??= await mining.getCurrentFrameId();
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

  let treasuryPercentActivated = 0;
  let bitcoinPercentUsed = 0;
  for (const frameId of frameIds) {
    const treasuryAtFrame = treasuryPoolCapitalByFrame[frameId];
    const tickRange = MiningFrames.getTickRangeForFrame(frameId);
    const [startingDate] = MiningFrames.frameToDateRange(frameId);

    const myFrameRevenue = myVaultRevenueByFrame[frameId];
    const record = {
      id: frameId,
      date: dayjs.utc(startingDate).toISOString(),
      firstTick: tickRange[0],
      lastTick: tickRange[1],
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
      record.progress = Math.min(((currentTick - tickRange[0]) / ticksPerFrame) * 100, 100);
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
  }

  const items: IChartItem[] = [];
  for (const [index, frame] of records.entries()) {
    const item = {
      id: frame.id,
      date: frame.date,
      score: Number(frame.myTreasuryPayout),
      isFiller: false,
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

Vue.onMounted(async () => {
  await myVault.load();
  await myVault.subscribe();
  await bitcoinLocks.load();

  Vue.watch(
    () => vaults.stats!.vaultsById,
    () => loadChartData(),
    { deep: true },
  );

  const onFrameSubscription = await mining.onFrameId(async frameId => {
    await loadChartData(frameId);
  });

  const onTickSubscription = await mining.onTick(() => {
    updateLatestFrameProgress();
  });

  Vue.onUnmounted(() => {
    onFrameSubscription.unsubscribe();
    onTickSubscription.unsubscribe();
    myVault.unsubscribe();
  });

  await loadChartData();
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
    @apply text-3xl font-bold;
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
