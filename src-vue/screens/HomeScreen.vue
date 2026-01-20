<!-- prettier-ignore -->
<template>
  <TooltipProvider :disableHoverableContent="true" class="flex h-full flex-col">
    <div class="flex h-full grow flex-col justify-stretch gap-y-2 px-2.5 py-2.5">
      <section box class="flex flex-row items-center !py-1 px-1 text-slate-900/90">
        <div @click="openPortfolio(PortfolioTab.ProfitAnalysis)" class="w-[86%] h-full flex flex-row items-center text-slate-600/70 relative z-30 pl-4 py-1 cursor-pointer hover:bg-linear-to-r from-argon-600/10 to-transparent">
          <div>
            <RoiIcon class="relative inline-block h-5 w-5 text-argon-600/80 mr-1 top-[-3px]" />
            Your <span class="font-mono font-bold text-argon-600 tracking-tighter">
            {{ currency.symbol }}{{ microgonToMoneyNm(portfolio.originalCapitalInvested).format('0,0') }}</span> Investment Has Returned
            <span class="font-mono font-bold text-argon-600 tracking-tighter">{{ numeral(portfolio.originalCapitalRoi).formatCapped('0,0.0[0]', 9_999) }}% TD</span>
          </div>
          <div class="relative h-3 grow bg-slate-600/16 mr-16 ml-4">
            <div class="absolute h-3 bg-white w-10 left-full rotate-[35deg] top-[10px] -translate-x-[5px]">
              <div class="h-full w-full bg-slate-600/16" />
              <LineArrow class="absolute -top-[200%] left-full rotate-[25deg] -translate-x-1 text-slate-600/16" />
            </div>
          </div>
        </div>
        <div class="w-[28%]" />
        <div @click="openPortfolio(PortfolioTab.GrowthProjections)" class="w-[86%] flex flex-row items-center text-slate-600/50 relative z-10 pr-4 py-1 cursor-pointer hover:bg-linear-to-l from-argon-600/10 to-transparent">
          <div class="relative h-3 grow bg-slate-600/16 ml-16">
            <div class="absolute h-3 bg-white w-14 right-full rotate-[-35deg] top-[15px] translate-x-[8px]">
              <div class="h-full w-full bg-slate-600/16" />
            </div>
          </div>
          <LineArrow class="text-slate-600/16 mr-1" />
          <div class="text-right">
            Your Data Predicts a Future Return of
            <span class="font-mono font-bold text-argon-600 tracking-tighter">{{ numeral(portfolio.projectedApy).formatIfElseCapped('< 1000', '0,0.0[0]', '0,0', 9_999) }}% APY</span>
            <ProjectionsIcon class="relative inline-block h-5 w-5  text-argon-600/60 ml-2 -top-px" />
          </div>
        </div>
      </section>
      <div class="flex flex-row items-stretch gap-x-2" ref="startButtonsRef">
        <section box class="flex flex-col min-h-60 w-1/3 px-2">
          <header
            class="flex flex-row border-b border-slate-400/30 py-2 text-[18px] font-bold text-slate-900/80 uppercase"
          >
            <span class="grow pl-3">Your Mining Operations</span>
            <CopyAddressMenu :walletType="WalletType.miningHold" class="mr-1" />
            <AssetMenu :walletType="WalletType.miningHold" class="pr-3" />
          </header>
          <div class="flex grow flex-row pt-2 text-center" v-if="config.isMinerInstalled">
            <div class="flex w-1/2 flex-col items-center gap-x-2">
              <div StatWrapper class="flex h-1/2 w-full flex-col border-b border-slate-600/20 pb-1">
                <div Stat class="text-2xl!">
                  {{ currency.symbol
                  }}{{ microgonToMoneyNm(portfolio.miningExternalInvested).formatIfElse('<1000', '0,0.[00]', '0,0') }}
                </div>
                <label>Capital Invested</label>
              </div>
              <div StatWrapper class="flex h-1/2 w-full flex-col pt-1.5">
                <div Stat class="text-2xl!">
                  {{ numeral(myMiningRoi).formatIfElseCapped('< 100', '0.[000]', '0,0', 9_999) }}%
                </div>
                <label>Current ROI</label>
              </div>
            </div>
            <div class="mx-2 h-full w-px bg-slate-600/20" />
            <div class="flex w-1/2 flex-col items-center gap-x-2">
              <div StatWrapper class="flex h-1/2 w-full flex-col border-b border-slate-600/20 pb-1">
                <div Stat class="text-2xl!">
                  {{ currency.symbol
                  }}{{ microgonToMoneyNm(myMiningEarnings).formatIfElse('<1000', '0,0.[00]', '0,0') }}
                </div>
                <label>Earnings-to-Date</label>
              </div>
              <div StatWrapper class="flex h-1/2 w-full flex-col pt-1.5">
                <div Stat class="text-2xl!">
                  {{ numeral(myMiningApy).formatIfElseCapped('< 100', '0.[000]', '0,0', 9_999) }}%
                </div>
                <label>Projected APY</label>
              </div>
            </div>
          </div>
          <div v-else class="grow flex flex-col px-3">
            <p class="grow pt-3 pb-2 font-light text-slate-900/80">
              Argon's Miners secure the network by maintaining consensus and printing new Argons when needed. This puts
              them in a unique position to profit from the growth of the Argon ecosystem.
            </p>
            <button
              @click="setupMining"
              class="bg-argon-500 hover:bg-argon-600 border-argon-700 inner-button-shadow my-3 flex w-full max-w-180 cursor-pointer flex-row items-center justify-center rounded-md border px-5 py-2 text-lg font-bold text-white">
              Set Up Your Mining Operations
              <ChevronDoubleRightIcon class="relative ml-1 size-5" />
            </button>
          </div>
        </section>

        <section box class="flex flex-col min-h-60 w-1/3 px-2 relative">
          <div class="flex flex-col w-[92%] absolute top-[-28%] bottom-0 left-[4%] pointer-events-none">
            <div class="h-[30%] relative">
              <BankmoreTop1 Bank class="relative w-full h-full z-20" />
              <BankmoreTopBg class="absolute top-0 left-0 w-full h-full scale-120 text-white z-10" />
              <ArgonLogo class="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 text-slate-700/30 h-[40px] z-20 mt-1" />
            </div>
            <div class="flex flex-col grow relative z-10">
              <BanklessTop2 Bank class="w-full opacity-80" />
              <div class="grow relative overflow-hidden flex flex-col items-center justify-center">
                <div class="w-fit">
                  <div class="font-base text-slate-600/50 text-center">YOUR CURRENT VALUE</div>
                  <div class="font-mono text-3xl font-bold text-argon-600 text-center mt-1 tracking-tighter">
                    {{ currency.symbol }}{{ totalNetWorth[0] }}.<span class="opacity-50">{{ totalNetWorth[1] }}</span>
                  </div>
                  <button
                    @click="openPortfolio(PortfolioTab.Overview)"
                    class="inner-button-shadow pointer-events-auto relative z-10 cursor-pointer border border-argon-600 hover:bg-argon-600/5 text-argon-600 font-bold px-4 py-[3px] mt-4 -mb-1 rounded mx-auto block whitespace-nowrap w-full"
                  >
                    Open Portfolio
                  </button>
                </div>
                <BanklessMiddle Bank class="absolute -top-1 bottom-0 w-full opacity-80" />
              </div>
              <BanklessBottom1 Bank class="-mt-0.5 w-full opacity-80" />
            </div>
            <div class="overflow-hidden relative top-[-3px]">
              <BanklessBottom2 Bank class="w-full relative top-[3px] opacity-80" />
            </div>
          </div>
        </section>

        <section box class="flex min-h-60 w-1/3 flex-col px-2">
          <header
            class="flex flex-row border-b border-slate-400/30 py-2 text-[18px] font-bold text-slate-900/80 uppercase">
            <span class="pl-3 grow">Your Vaulting Operations</span>
            <CopyAddressMenu :walletType="WalletType.vaulting" class="mr-1" />
            <AssetMenu :walletType="WalletType.vaulting" class="mr-3" />
          </header>
          <div class="flex grow flex-row pt-2 text-center" v-if="config.isVaultActivated">
            <div class="flex w-1/2 flex-col items-center gap-x-2">
              <div StatWrapper class="flex h-1/2 w-full flex-col border-b border-slate-600/20 pb-1">
                <div Stat class="text-2xl!">
                  {{ currency.symbol
                  }}{{ microgonToMoneyNm(portfolio.vaultingExternalInvested).formatIfElse('<1000', '0,0.[00]', '0,0') }}
                </div>
                <label>Capital Invested</label>
              </div>
              <div StatWrapper class="flex h-1/2 w-full flex-col pt-1.5">
                <div Stat class="text-2xl!">
                  {{ numeral(myVaultRoi).formatIfElseCapped('< 100', '0.[00]', '0,0', 9_999) }}%
                </div>
                <label>Current ROI</label>
              </div>
            </div>
            <div class="mx-2 h-full w-px bg-slate-600/20" />
            <div class="flex w-1/2 flex-col items-center gap-x-2">
              <div StatWrapper class="flex h-1/2 w-full flex-col border-b border-slate-600/20 pb-1">
                <div Stat class="text-2xl!">
                  {{ currency.symbol }}{{ microgonToMoneyNm(myVaultEarnings).formatIfElse('<1000', '0,0.[00]', '0,0') }}
                </div>
                <label>Earnings-to-Date</label>
              </div>
              <div StatWrapper class="flex h-1/2 w-full flex-col pt-1.5">
                <div Stat class="text-2xl!">
                  {{ numeral(myVaultApy).formatIfElseCapped('< 100', '0.[000]', '0,0', 9_999) }}%
                </div>
                <label>Projected APY</label>
              </div>
            </div>
          </div>
          <div v-else class="px-3">
            <p class="py-3 font-light text-slate-900/80">
              Argon's Stabilization Vaults lock Bitcoins into special contracts that provide price stability for the
              stablecoin and make it impossible to death-spiral. In return, vaults earn all revenue generated by mining bids.
            </p>
            <button
              @click="setupVault"
              class="bg-argon-500 hover:bg-argon-600 border-argon-700 inner-button-shadow my-4 flex w-full max-w-180 cursor-pointer flex-row items-center justify-center rounded-md border px-5 py-2 text-lg font-bold text-white">
              Setup Your Stabilization Vault
              <ChevronDoubleRightIcon class="relative ml-1 size-5" />
            </button>
          </div>
        </section>
      </div>

      <section StatsBox box class="flex grow flex-col justify-center px-2 !pb-0">
        <header
          class="relative mx-1 mt-5 flex flex-row items-start justify-stretch px-12 text-[20px] font-bold text-slate-900/80 uppercase">
          <div class="relative top-5 mr-2 h-5 w-3 bg-slate-600/16">
            <div class="absolute -top-5 h-5 w-5 rounded-tl-xl border-t-12 border-l-12 text-slate-600/16" />
          </div>
          <div class="mr-5 h-3 flex-grow bg-slate-600/16" />
          <div class="-mt-2">The Global Ecosystem</div>
          <div class="ml-5 h-3 flex-grow bg-slate-600/16" />
          <div class="relative top-5 ml-2 h-9 w-3 bg-slate-600/16">
            <div class="absolute -top-5 right-0 h-5 w-5 rounded-tr-xl border-t-12 border-r-12 text-slate-600/16" />
            <LineArrow class="absolute top-full left-1/2 z-10 -translate-x-1/2 -translate-y-4/12 rotate-90 text-slate-600/16" />
          </div>
        </header>
        <div class="mt-2 -mb-2 flex w-full grow flex-row">
          <div class="flex w-1/3 flex-col">
            <div class="relative h-px w-full bg-gradient-to-l from-slate-600/0 to-slate-600/20 to-[50%]">
              <div class="absolute -top-3 left-12 bg-white px-1"><div class="relative h-7 w-3 bg-slate-600/16" /></div>
            </div>
            <div StatWrapper class="ml-10 h-1/4">
              <div Stat>
                {{ currency.symbol
                }}{{ microgonToMoneyNm(miningStats.aggregatedBidCosts).formatIfElse('< 1_000', '0,0.[00]', '0,0') }}
              </div>
              <label>Mining Bids this Epoch</label>
            </div>
            <div class="relative h-px w-full bg-gradient-to-l from-slate-600/0 to-slate-600/20 to-[50%]">
              <div class="absolute -top-4 left-12 bg-white px-1">
                <div class="relative h-9 w-3 bg-slate-600/16" />
                <LineArrow
                  class="absolute bottom-full left-1/2 z-10 -translate-x-1/2 translate-y-1/2 -rotate-90 text-slate-600/16" />
              </div>
            </div>
            <div StatWrapper class="ml-10 h-1/4">
              <div class="flex flex-row items-center">
                <div Stat>{{ miningStats.activeMiningSeatCount }}</div>
                <div class="relative mr-5 ml-7 h-3 flex-grow bg-slate-600/16">
                  <LineArrow class="absolute top-1/2 right-full z-10 -translate-y-1/2 -rotate-180 text-slate-600/16" />
                </div>
              </div>
              <label>Active Miners</label>
            </div>
            <div class="relative h-px w-full bg-gradient-to-l from-slate-600/0 to-slate-600/20 to-[50%]">
              <div class="absolute -top-4 left-12 bg-white px-1">
                <div class="relative h-9 w-3 bg-slate-600/16" />
                <LineArrow
                  class="absolute top-full left-1/2 z-10 -translate-x-1/2 -translate-y-1/2 rotate-90 text-slate-600/16" />
              </div>
            </div>
            <div StatWrapper class="ml-10 h-1/4">
              <div Stat>
                {{ currency.symbol
                }}{{ microgonToMoneyNm(miningStats.aggregatedBlockRewards).formatIfElse('< 1_000', '0,0.[00]', '0,0') }}
              </div>
              <label>Base Mining Rewards</label>
            </div>
            <div class="relative h-px w-full bg-gradient-to-l from-slate-600/0 to-slate-600/20 to-[50%]">
              <div class="absolute -top-4 left-12 bg-white px-1">
                <div class="relative h-9 w-3 bg-slate-600/16" />
                <LineArrow
                  class="absolute top-full left-1/2 z-10 -translate-x-1/2 -translate-y-1/2 rotate-90 text-slate-600/16" />
              </div>
            </div>

            <div class="ml-10 flex h-[20%] pt-[5%] flex-row items-center space-x-4">
              <div StatWrapper>
                <div Stat>{{ micronotToArgonotNm(micronotsInCirculation).format('0,0') }}</div>
                <label>Argonot Circulation</label>
              </div>
              <div class="pb-6 text-4xl font-bold text-slate-600/20">+</div>
              <div class="relative flex h-full flex-col">
                <div class="absolute bottom-full left-1/2 h-[calc(275%-30px)] -translate-x-1/2 bg-white px-1">
                  <div class="relative h-full w-3 bg-slate-600/16" />
                </div>
                <div class="absolute bottom-[calc(375%-22px)] left-1/2 z-10 w-1/2 translate-x-[5px] bg-white">
                  <div
                    class="absolute top-0 left-[-11px] h-5 w-5 rounded-tl-xl border-t-12 border-l-12 text-slate-600/16" />
                  <div class="relative ml-[9px] h-3 w-full bg-slate-600/16" />
                </div>
                <div class="relative grow">
                  <div class="absolute bottom-2 left-1/2 h-full -translate-x-1/2 bg-white px-1">
                    <div class="relative h-full w-3 bg-slate-600/16" />
                  </div>
                </div>
                <div StatWrapper>
                  <div Stat>{{ microgonToArgonNm(microgonsInCirculation).format('0,0') }}</div>
                  <label>Argon Circulation</label>
                </div>
                <div class="grow" />
              </div>
              <div class="relative flex h-full grow flex-col">
                <div class="absolute bottom-[calc(375%-22px)] -left-6 z-10 w-[calc(100%-4px)] bg-white">
                  <div class="relative h-3 w-full bg-slate-600/16" />
                  <LineArrow class="absolute top-1/2 left-full z-10 -translate-y-1/2 text-slate-600/16" />
                </div>
                <div class="grow" />
                <div class="relative -top-2.5 mr-3 ml-3 h-3 bg-slate-600/16">
                  <LineArrow class="absolute top-1/2 right-full z-10 -translate-y-1/2 -rotate-180 text-slate-600/16" />
                </div>
                <div class="grow" />
              </div>
            </div>
          </div>

          <div class="flex w-1/3 flex-col items-center">
            <div class="text-md flex h-1/4 w-full flex-col items-stretch">
              <div
                class="relative grow px-0.5 text-slate-500/50"
                v-for="scenario in aboveTargetScenarios"
                :key="scenario.earningsPotentialPercent">
                <div
                  class="absolute top-0 left-[-5%] h-px w-[55%] bg-linear-to-r from-transparent to-slate-600/20 to-10%" />
                <div
                  class="absolute top-0 right-[-5%] h-px w-[55%] bg-linear-to-l from-transparent to-slate-600/20 to-10%" />
                <div
                  :class="currencyFadeClass"
                  class="flex h-full flex-row items-center justify-between transition-opacity duration-400 ease-in-out">
                  <div class="font-bold">IF</div>
                  <div>prices rise to</div>
                  <span class="font-mono font-bold text-red-700/50">
                    {{ currencySymbol }}{{ microgonToNm(scenario.microgons, currencyKey).format('0,0.00') }}
                  </span>
                  <span class="text-center">THEN</span>
                  <div>miners earn</div>
                  <span class="text-right font-mono font-semibold text-green-700/60">
                    +{{ numeral(scenario.earningsPotentialPercent).format('0,0') }}%
                  </span>
                </div>
              </div>
            </div>
            <div class="-mb-1 flex h-1/4 w-full flex-col">
              <div
                class="flex grow flex-col rounded-lg border border-slate-600/50 text-center shadow-md shadow-slate-600/20">
                <div
                  :class="currencyFadeClass"
                  class="flex grow flex-col items-center justify-center transition-opacity duration-400 ease-in-out">
                  <div class="font-base text-slate-600/50">
                    <template v-if="currency.targetOffset">
                      PRICE IS {{ currencySymbol }}{{ microgonToNm(targetDiff, currencyKey).format('0.00[0]') }}
                      <template v-if="currency.targetOffset > 0">ABOVE</template>
                      <template v-else>BELOW</template>
                      TARGET
                    </template>
                    <template v-else>PRICE IS AT TARGET</template>
                  </div>
                  <div ArgonPrice class="flex flex-row items-center justify-center gap-x-4 font-mono">
                    {{ currencySymbol }}{{ microgonToNm(1_000_000n, currencyKey).format('0,0.00') }}
                    <span>/</span>
                    ARGN
                  </div>
                </div>
                <div class="mx-1 h-px bg-slate-600/20" />
                <ul
                  @mouseover="mouseoverCurrencyKey"
                  @mouseout="mouseoutCurrencyKey"
                  class="relative flex flex-row items-center text-base font-light text-slate-600/70"
                >
                  <div
                    :style="{ left: currencyLeftPos }"
                    class="pointer-events-none absolute top-1 h-[calc(100%-8px)] w-[calc(25%-8px)] translate-x-[4px] rounded bg-slate-400/10 transition-[left] duration-150 ease-in-out"
                  />
                  <li
                    @click="startSetCurrencyKey(UnitOfMeasurement.USD)"
                    :class="[currencyKey === UnitOfMeasurement.USD ? 'font-semibold' : 'opacity-50']"
                    class="w-1/4 cursor-pointer py-1 hover:font-semibold hover:opacity-80">
                    {{ UnitOfMeasurement.USD }}
                  </li>
                  <li class="my-1 h-[calc(100%-8px)] w-px bg-slate-600/40" />
                  <li
                    @click="startSetCurrencyKey(UnitOfMeasurement.EUR)"
                    :class="[currencyKey === UnitOfMeasurement.EUR ? 'font-semibold' : 'opacity-50']"
                    class="w-1/4 cursor-pointer py-1 hover:font-semibold hover:opacity-80">
                    {{ UnitOfMeasurement.EUR }}
                  </li>
                  <li class="my-1 h-[calc(100%-8px)] w-px bg-slate-600/40" />
                  <li
                    @click="startSetCurrencyKey(UnitOfMeasurement.GBP)"
                    :class="[currencyKey === UnitOfMeasurement.GBP ? 'font-semibold' : 'opacity-50']"
                    class="w-1/4 cursor-pointer py-1 hover:font-semibold hover:opacity-80">
                    {{ UnitOfMeasurement.GBP }}
                  </li>
                  <li class="my-1 h-[calc(100%-8px)] w-px bg-slate-600/40" />
                  <li
                    @click="startSetCurrencyKey(UnitOfMeasurement.INR)"
                    :class="[currencyKey === UnitOfMeasurement.INR ? 'font-semibold' : 'opacity-50']"
                    class="w-1/4 cursor-pointer py-1 hover:font-semibold hover:opacity-80">
                    {{ UnitOfMeasurement.INR }}
                  </li>
                </ul>
              </div>
            </div>

            <div class="text-md relative top-2 flex h-1/4 w-full flex-col items-stretch">
              <div
                class="relative grow px-0.5 text-slate-500/50"
                v-for="scenario in belowTargetScenarios"
                :key="scenario.earningsPotentialPercent">
                <div
                  class="absolute bottom-0 left-[-5%] h-px w-[55%] bg-linear-to-r from-transparent to-slate-600/20 to-10%" />
                <div
                  class="absolute right-[-5%] bottom-0 h-px w-[55%] bg-linear-to-l from-transparent to-slate-600/20 to-10%" />
                <div
                  :class="currencyFadeClass"
                  class="flex h-full flex-row items-center justify-between transition-opacity duration-400 ease-in-out">
                  <div class="font-bold">IF</div>
                  <div>prices fall to</div>
                  <span class="font-mono font-bold text-red-700/50">
                    {{ currencySymbol }}{{ microgonToNm(scenario.microgons, currencyKey).format('0,0.00') }}
                  </span>
                  <span class="text-center">THEN</span>
                  <div>bitcoiners earn</div>
                  <span class="text-right font-mono font-semibold text-green-700/60">
                    +{{ numeral(scenario.earningsPotentialPercent).format('0,0') }}%
                  </span>
                </div>
              </div>
              <div
                v-if="belowTargetScenarios.length"
                class="relative -mt-4 -mb-2 flex flex-row text-2xl text-slate-500/40">
                <div
                  class="absolute bottom-0 left-[-5%] h-px w-[55%] bg-linear-to-r from-transparent to-slate-600/20 to-10%" />
                <div
                  class="absolute right-[-5%] bottom-0 h-px w-[55%] bg-linear-to-l from-transparent to-slate-600/20 to-10%" />
                <div class="grow text-left">...</div>
                <div class="grow text-right">...</div>
              </div>
              <div
                v-if="belowTargetScenarios.length"
                :class="currencyFadeClass"
                class="relative top-1.5 flex flex-row items-center justify-between px-0.5 pt-1 text-slate-500/50 transition-opacity duration-400 ease-in-out">
                <div class="font-bold">IF</div>
                <div>prices fall to</div>
                <span class="font-mono font-bold text-red-700/50">
                  {{ currencySymbol
                  }}{{ microgonToNm(vaultingStats.finalPriceAfterTerraCollapse, currencyKey).format('0,0.000') }}
                </span>
                <span class="text-center">THEN</span>
                <div>bitcoiners earn</div>
                <span class="text-right font-mono font-semibold text-green-700/60">
                  +{{ numeral(terraPercentReturn).format('0,0') }}%
                </span>
              </div>
            </div>

            <div StatWrapper class="mt-2 flex h-[20%] pt-[5%] w-full flex-col text-center">
              <div class="relative mt-3 mb-5 grow rounded-t-lg border border-b-0 border-slate-400/50 px-4 pt-4 pb-2">
                <div class="absolute top-1/4 -right-0.5 -left-0.5 h-3/4 bg-gradient-to-b from-transparent to-white" />
                <div Stat class="relative z-10 mt-1 -mb-1">
                  {{ numeral(vaultingStats.argonBurnCapacity).format('0,0') }}
                </div>
                <label class="relative z-10">Argon Circulation Burn Capacity</label>
              </div>
            </div>
          </div>

          <div class="flex w-1/3 flex-col text-right">
            <div class="relative h-px w-full bg-gradient-to-r from-slate-600/0 to-slate-600/20 to-[50%]">
              <div class="absolute -top-3 right-12 bg-white px-1"><div class="relative h-7 w-3 bg-slate-600/16" /></div>
            </div>
            <div StatWrapper class="mr-10 h-1/4">
              <div Stat>
                {{ currency.symbol
                }}{{ microgonToMoneyNm(vaultingStats.epochEarnings).formatIfElse('< 1_000', '0,0.[00]', '0,0') }}
              </div>
              <label>Vaulting Revenue this Epoch</label>
            </div>
            <div class="relative h-px w-full bg-gradient-to-r from-slate-600/0 to-slate-600/20 to-[50%]">
              <div class="absolute -top-4 right-12 bg-white px-1">
                <div class="relative h-9 w-3 bg-slate-600/16" />
                <LineArrow
                  class="absolute top-full left-1/2 z-10 -translate-x-1/2 -translate-y-1/2 rotate-90 text-slate-600/16" />
              </div>
            </div>
            <div StatWrapper class="mr-10 h-1/4">
              <div class="flex flex-row items-center">
                <div class="relative mr-7 ml-5 h-3 flex-grow bg-slate-600/16">
                  <LineArrow class="absolute top-1/2 left-full z-10 -translate-y-1/2 text-slate-600/16" />
                </div>
                <div Stat>{{ vaultingStats.vaultCount }}</div>
              </div>
              <label>Active Vaults</label>
            </div>
            <div class="relative h-px w-full bg-gradient-to-r from-slate-600/0 to-slate-600/20 to-[50%]">
              <div class="absolute -top-4 right-12 bg-white px-1">
                <div class="relative h-9 w-3 bg-slate-600/16" />
                <LineArrow
                  class="absolute top-full left-1/2 z-10 -translate-x-1/2 -translate-y-1/2 rotate-90 text-slate-600/16" />
              </div>
            </div>
            <div StatWrapper class="mr-10 h-1/4">
              <div Stat>
                {{ currency.symbol
                }}{{ microgonToMoneyNm(activatedSecuritization).formatIfElse('< 1_000', '0,0.[00]', '0,0') }}
              </div>
              <label>Bitcoin Security</label>
            </div>
            <div class="relative h-px w-full bg-gradient-to-r from-slate-600/0 to-slate-600/20 to-[50%]">
              <div class="absolute -top-4 right-12 bg-white px-1">
                <div class="relative h-9 w-3 bg-slate-600/16" />
                <LineArrow
                  class="absolute top-full left-1/2 z-10 -translate-x-1/2 -translate-y-1/2 rotate-90 text-slate-600/16" />
              </div>
            </div>

            <div class="mr-10 flex h-[20%] pt-[5%] flex-row items-center justify-end space-x-4">
              <div class="relative flex h-full grow flex-col">
                <div class="absolute -right-6 bottom-[calc(375%-22px)] z-10 w-[calc(100%-4px)] bg-white">
                  <div class="relative h-3 w-full bg-slate-600/16" />
                  <LineArrow class="absolute top-1/2 right-full z-10 -translate-y-1/2 -rotate-180 text-slate-600/16" />
                </div>
                <div class="grow" />
                <div class="relative -top-2.5 mr-1 ml-5 h-3 bg-slate-600/16">
                  <LineArrow class="absolute top-1/2 right-full z-10 -translate-y-1/2 -rotate-180 text-slate-600/16" />
                </div>
                <div class="grow" />
              </div>

              <div class="relative flex h-full flex-col">
                <div class="absolute bottom-full left-1/2 h-[calc(275%-30px)] -translate-x-1/2 bg-white px-1">
                  <div class="relative h-full w-3 bg-slate-600/16" />
                </div>
                <div class="absolute right-1/2 bottom-[calc(375%-22px)] z-10 w-1/2 translate-x-[-14px] bg-white">
                  <div
                    class="absolute top-0 right-[-20px] h-5 w-5 rounded-tr-xl border-t-12 border-r-12 text-slate-600/16" />
                  <div class="relative mr-[9px] h-3 w-full bg-slate-600/16" />
                </div>
                <div class="relative grow">
                  <div class="absolute bottom-2 left-1/2 h-full -translate-x-1/2 bg-white px-1">
                    <div class="relative h-full w-3 bg-slate-600/16" />
                  </div>
                </div>
                <div StatWrapper>
                  <div Stat>
                    {{ numeral(vaultingStats.bitcoinLocked).formatIfElse('> 1', '0,0.[00]', '0.[000000]') }}
                  </div>
                  <label>Vaulted Bitcoins</label>
                </div>
                <div class="grow" />
              </div>
              <div class="relative left-1 pb-6 text-4xl font-bold text-slate-600/20">+</div>
              <div StatWrapper>
                <div Stat>
                  {{ currency.symbol
                  }}{{ microgonToMoneyNm(liquidityReceived).formatIfElse('< 1_000', '0,0.[00]', '0,0') }}
                </div>
                <label>Liquidity Received</label>
              </div>
            </div>
          </div>
        </div>
      </section>
    </div>
  </TooltipProvider>
</template>

<script setup lang="ts">
import * as Vue from 'vue';
import { getCurrency } from '../stores/currency.ts';
import numeral, { createNumeralHelpers } from '../lib/numeral.ts';
import { getMyVault, getVaults } from '../stores/vaults.ts';
import { useVaultingStats } from '../stores/vaultingStats.ts';
import { useMiningStats } from '../stores/miningStats.ts';
import { TooltipProvider } from 'reka-ui';
import { ScreenKey } from '../interfaces/IConfig.ts';
import { useController } from '../stores/controller.ts';
import { getDbPromise } from '../stores/helpers/dbPromise.ts';
import { getWalletBalances, getWalletKeys, useWallets } from '../stores/wallets.ts';
import { getStats } from '../stores/stats.ts';
import { getConfig } from '../stores/config.ts';
import { ICurrencyKey, MICRONOTS_PER_ARGONOT, UnitOfMeasurement } from '../lib/Currency';
import BigNumber from 'bignumber.js';
import LineArrow from '../components/asset-breakdown/LineArrow.vue';
import {
  bigIntAbs,
  bigNumberToBigInt,
  calculateAPY,
  calculateProfitPct,
  GlobalVaultingStats,
} from '@argonprotocol/apps-core';
import { ChevronDoubleRightIcon } from '@heroicons/vue/24/outline';
import { useTour } from '../stores/tour.ts';
import BankmoreTop1 from '../assets/bankmore-top1.svg';
import BankmoreTopBg from '../assets/bankmore-top-bg.svg';
import BanklessTop2 from '../assets/bankless-top2.svg';
import BanklessMiddle from '../assets/bankless-middle.svg';
import BanklessBottom1 from '../assets/bankless-bottom1.svg';
import BanklessBottom2 from '../assets/bankless-bottom2.svg';
import RoiIcon from '../assets/roi.svg';
import ArgonLogo from '../assets/resources/argon.svg?component';
import ProjectionsIcon from '../assets/projections.svg';
import basicEmitter from '../emitters/basicEmitter.ts';
import { PortfolioTab } from '../panels/interfaces/IPortfolioTab.ts';
import AssetMenu from './components/AssetMenu.vue';
import { WalletType } from '../lib/Wallet.ts';
import CopyAddressMenu from './components/CopyAddressMenu.vue';
import { usePortfolio } from '../stores/portfolio.ts';

const controller = useController();
const vaultingStats = useVaultingStats();
const miningStats = useMiningStats();
const tour = useTour();
const wallets = useWallets();
const portfolio = usePortfolio();
const vaults = getVaults();
const currency = getCurrency();
const myMinerStats = getStats();
const myVault = getMyVault();
const config = getConfig();

const { microgonToNm, microgonToArgonNm, microgonToMoneyNm, micronotToArgonotNm } = createNumeralHelpers(currency);

const startButtonsRef = Vue.ref<HTMLElement | null>(null);

const microgonsPerArgonot = Vue.ref(0n);
const microgonsPerBitcoin = Vue.ref(0n);
const currencyKey = Vue.ref<ICurrencyKey>(UnitOfMeasurement.USD);

const currencyIsEngaged = Vue.ref(false);
const currencyFadeClass = Vue.ref('');
const currencyLeftPos = Vue.ref('0%');
const currencyPositions: ICurrencyKey[] = [
  UnitOfMeasurement.USD,
  UnitOfMeasurement.EUR,
  UnitOfMeasurement.GBP,
  UnitOfMeasurement.INR,
];

const activatedSecuritization = Vue.ref(0n);

const aboveTargetScenarios = Vue.ref<{ microgons: bigint; earningsPotentialPercent: number }[]>([]);
const belowTargetScenarios = Vue.ref<{ microgons: bigint; earningsPotentialPercent: number }[]>([]);

const microgonsInCirculation = Vue.ref(0n);
const micronotsInCirculation = Vue.ref(0n);

const liquidityReceived = Vue.ref(0n);

const myMiningEarnings = Vue.computed(() => {
  const { microgonsMinedTotal, microgonsMintedTotal, micronotsMinedTotal, framedCost } = myMinerStats.global;
  const microgonValueOfMicronotsMined = currency.convertMicronotTo(micronotsMinedTotal, UnitOfMeasurement.Microgon);
  return microgonsMintedTotal + microgonsMinedTotal + microgonValueOfMicronotsMined - framedCost;
});

const myMiningRoi = Vue.computed(() => {
  return (
    calculateProfitPct(portfolio.miningExternalInvested, portfolio.miningExternalInvested + myMiningEarnings.value) *
    100
  );
});

const myMiningApy = Vue.computed(() => {
  const rewards = portfolio.miningExternalInvested + myMiningEarnings.value;
  return calculateAPY(portfolio.miningExternalInvested, rewards, myMinerStats.activeFrames);
});

const myVaultEarnings = Vue.computed(() => {
  return myVault.revenue().earnings;
});

const myVaultApy = Vue.computed(() => {
  const { earnings, activeFrames } = myVault.revenue();
  if (earnings === 0n) return 0;
  return calculateAPY(portfolio.vaultingExternalInvested, portfolio.vaultingExternalInvested + earnings, activeFrames);
});

const myVaultRoi = Vue.computed(() => {
  const investment = portfolio.vaultingExternalInvested;
  const returnValue = portfolio.vaultingExternalInvested + myVaultEarnings.value;
  if (investment === 0n) return 0;
  return calculateProfitPct(investment, returnValue) * 100;
});

const currencySymbol = Vue.computed(() => {
  return currency.recordsByKey[currencyKey.value].symbol;
});

const targetDiff = Vue.computed(() => {
  const target = 1_000_000n;
  const adjusted = currency.adjustByTargetOffset(target);
  return bigIntAbs(adjusted - target);
});

const terraPercentReturn = Vue.computed(() => {
  const usdPriceAfterTerraCollapse = currency.convertMicrogonTo(
    vaultingStats.finalPriceAfterTerraCollapse,
    UnitOfMeasurement.USD,
  );
  return getBitcoinReturnAsPercent(usdPriceAfterTerraCollapse);
});

const totalNetWorth = Vue.computed(() => {
  if (!currency.isLoaded) {
    return ['--', '--'];
  }
  const value = microgonToMoneyNm(wallets.totalNetWorth).format('0,0.00');
  return value.split('.');
});

function mouseoverCurrencyKey() {
  currencyIsEngaged.value = true;
}

function mouseoutCurrencyKey() {
  currencyIsEngaged.value = false;
}

function finishSetCurrencyKey(key: ICurrencyKey) {
  const posIndex = currencyPositions.indexOf(key);
  currencyLeftPos.value = posIndex <= 0 ? '0%' : `${posIndex * 25}%`;
  currencyKey.value = key;

  const oneArgonBn = BigNumber(1_000_000n);

  const nextTier = 10 + Math.ceil(currency.targetOffset * 10) * 10;
  const startingOffset = nextTier - currency.targetOffset * 10;

  aboveTargetScenarios.value = [];
  belowTargetScenarios.value = [];

  for (let i = 4; i >= 1; i--) {
    const earningsPotentialPercent = startingOffset + (i - 1) * 10;
    const adjustFactorBn = BigNumber(earningsPotentialPercent).dividedBy(100).plus(1);
    const simulatedPriceBn = oneArgonBn.multipliedBy(adjustFactorBn);
    const simulatedPrice = bigNumberToBigInt(simulatedPriceBn);
    aboveTargetScenarios.value.push({
      microgons: simulatedPrice,
      earningsPotentialPercent,
    });
  }

  for (const percentOffTarget of [5, 20, 40]) {
    const adjustFactorBn = BigNumber(100).minus(percentOffTarget).dividedBy(100);
    const simulatedPriceBn = oneArgonBn.multipliedBy(adjustFactorBn);
    const simulatedPrice = bigNumberToBigInt(simulatedPriceBn);
    const simulatedPriceInUsd = currency.convertMicrogonTo(simulatedPrice, UnitOfMeasurement.USD);
    const earningsPotentialPercent = getBitcoinReturnAsPercent(simulatedPriceInUsd);
    belowTargetScenarios.value.push({
      microgons: simulatedPrice,
      earningsPotentialPercent,
    });
  }
}

function setupVault() {
  controller.setScreenKey(ScreenKey.Vaulting);
  controller.backButtonTriggersHome = true;
  config.isPreparingVaultSetup = true;
}

function setupMining() {
  controller.setScreenKey(ScreenKey.Mining);
  controller.backButtonTriggersHome = true;
  config.isPreparingMinerSetup = true;
}

function getBitcoinReturnAsPercent(simulatedPriceInUsd: number): number {
  const r = currency.adjustByTargetOffset(simulatedPriceInUsd);
  const argonsRequired = GlobalVaultingStats.calculateUnlockBurnPerBitcoinDollar(r);
  const argonCost = argonsRequired * simulatedPriceInUsd;
  return ((1 - argonCost) / argonCost) * 100;
}

async function loadNetworkStats() {
  await vaults.load();

  const list = Object.values(vaults.vaultsById);
  for (const vault of list) {
    activatedSecuritization.value += vaults.activatedSecuritization(vault.vaultId);
  }
}

let currencyRotationInterval: ReturnType<typeof setTimeout> | undefined;
let setCurrencyKeyTimeout: ReturnType<typeof setTimeout> | undefined;

function startSetCurrencyKey(key: ICurrencyKey, shouldClearRotation: boolean = true) {
  if (!currency.isLoaded) return;
  if (setCurrencyKeyTimeout) clearTimeout(setCurrencyKeyTimeout);
  if (shouldClearRotation) clearInterval(currencyRotationInterval);

  currencyFadeClass.value = 'opacity-10';
  setCurrencyKeyTimeout = setTimeout(() => {
    finishSetCurrencyKey(key);
    currencyFadeClass.value = 'opacity-100';
  }, 400);
}

function openPortfolio(tab: PortfolioTab) {
  basicEmitter.emit('openPortfolioPanel', tab);
}

tour.registerPositionCheck('startButtons', () => {
  const rect = startButtonsRef.value?.getBoundingClientRect().toJSON() || { left: 0, right: 0, top: 0, bottom: 0 };
  rect.left -= 20;
  rect.right += 20;
  rect.top -= 20;
  rect.bottom += 20;
  return rect;
});

Vue.onMounted(async () => {
  await config.isLoadedPromise;
  await currency.isLoadedPromise;
  await vaults.load();
  await vaultingStats.isLoadedPromise;
  await miningStats.isLoadedPromise;
  await portfolio.isLoadedPromise;
  await loadNetworkStats();
  await myVault.load();

  await myMinerStats.subscribeToDashboard();
  await myMinerStats.load();

  finishSetCurrencyKey(currencyKey.value);
  microgonsPerArgonot.value = currency.microgonsPer.ARGNOT;
  microgonsPerBitcoin.value = currency.microgonsPer.BTC;

  microgonsInCirculation.value = await currency.fetchMicrogonsInCirculation();
  micronotsInCirculation.value = await currency.fetchMicronotsInCirculation();
  liquidityReceived.value = await currency.fetchBitcoinLiquidityReceived();

  currencyRotationInterval = setInterval(() => {
    if (currencyIsEngaged.value) return;

    const currentIndex = currencyPositions.indexOf(currencyKey.value);
    const isLastIndex = currentIndex >= 3;
    const nextIndex = isLastIndex ? 0 : currentIndex + 1;
    const nextKey = currencyPositions[nextIndex];
    startSetCurrencyKey(nextKey, false);
    if (isLastIndex) {
      clearInterval(currencyRotationInterval);
    }
  }, 5e3);
});

Vue.onUnmounted(() => {
  void myMinerStats.unsubscribeFromDashboard();
  clearInterval(currencyRotationInterval);
});
</script>

<style>
@reference "../main.css";

svg[Bank] {
  .hasStroke {
    @apply stroke-slate-800/50 stroke-1;
  }
}
</style>

<style scoped>
@reference "../main.css";

[box] {
  @apply rounded border-[1px] border-slate-400/30 bg-white py-2 shadow;
}

[StatWrapper] {
  @apply flex flex-col justify-center gap-y-1;
  [Stat] {
    @apply text-argon-600 font-mono text-2xl font-extrabold;
  }
  header {
    @apply text-3xl;
  }
  label {
    @apply -mt-1 text-sm font-medium text-slate-700/50;
  }
}

[ArgonPrice] {
  @apply text-argon-600 text-4xl font-extrabold whitespace-nowrap lg:text-[2.5rem] xl:text-5xl;
  span {
    @apply font-light opacity-30;
  }
}
</style>
