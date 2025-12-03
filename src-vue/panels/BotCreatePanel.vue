<!-- prettier-ignore -->
<template>
  <DialogRoot class="absolute inset-0 z-10" :open="true">
    <DialogPortal>
      <DialogOverlay asChild>
        <BgOverlay @close="cancelPanel" />
      </DialogOverlay>

      <DialogContent @escapeKeyDown="cancelPanel" :aria-describedby="undefined">
        <BotTour v-if="currentTourStep" @close="closeTour" @changeStep="currentTourStep = $event" :getPositionCheck="getTourPositionCheck" />
        <div
          :ref="draggable.setModalRef"
          :style="{
            // TODO: Need to fix draggable so it works for this overlay
            // top: `calc(50% + ${draggable.modalPosition.y}px)`,
            // left: `calc(50% + ${draggable.modalPosition.x}px)`,
            // transform: 'translate(-50%, -50%)',
            // cursor: draggable.isDragging ? 'grabbing' : 'default',
          }"
          class="BotCreatePanel absolute top-[40px] left-3 right-3 bottom-3 flex flex-col rounded-md border border-black/30 inner-input-shadow bg-argon-menu-bg text-left z-20 transition-all focus:outline-none"
          style="box-shadow: 0px -1px 2px 0 rgba(0, 0, 0, 0.1), inset 0 2px 0 rgba(255, 255, 255, 1)"
        >
          <BgOverlay v-if="hasEditBoxOverlay" @close="cancelEditOverlay" :showWindowControls="false" rounded="md" class="z-100" />
          <div v-if="isSuggestingTour" class="absolute inset-0 bg-black/20 z-20 rounded-md"></div>
          <div class="flex flex-col h-full w-full">
            <h2
              @mousedown="draggable.onMouseDown($event)"
              class="relative text-3xl font-bold text-left border-b border-slate-300 pt-5 pb-4 pl-3 mx-4 text-[#672D73]"
              style="box-shadow: 0 1px 4px rgba(0, 0, 0, 0.1)"
            >
              <DialogTitle as="div" class="relative z-10">Configure Your Mining Bot</DialogTitle>
              <div @click="cancelPanel" class="absolute top-[22px] right-0 z-10 flex items-center justify-center text-sm/6 font-semibold cursor-pointer border rounded-md w-[30px] h-[30px] focus:outline-none border-slate-400/60 hover:border-slate-500/70 hover:bg-[#D6D9DF]">
                <XMarkIcon class="w-5 h-5 text-[#B74CBA] stroke-4" />
              </div>
            </h2>

            <div v-if="isLoaded" class="flex flex-col grow relative w-full">
              <DialogDescription class="text-gray-600 font-light py-6 pl-10 pr-[6%]">
                Investor Console uses an automated bidding bot to maximize your chance of winning seats, and this screen allows you to
                configure the rules for how this bot should make decisions on your behalf. Use your mouse to explore the various
                settings and their impact on your potential profits.
                <PopoverRoot :open="isSuggestingTour">
                  <PopoverTrigger asChild>
                    <div :class="[isSuggestingTour ? '' : 'hover:underline']" class="inline-block relative cursor-pointer text-argon-600/80 hover:text-argon-800 decoration-dashed underline-offset-4 z-30" @click="startTour">
                      <span class="relative z-10 font-semibold">Take our quick mining tour</span>
                      <div v-if="isSuggestingTour" class="border rounded-full border-argon-600/30 bg-white/50 absolute -top-0 -left-2 -right-2 -bottom-0"></div>
                    </div>
                  </PopoverTrigger>
                  <PopoverPortal>
                    <PopoverContent @escapeKeyDown="stopSuggestingTour" side="bottom" class="rounded-lg p-5 -translate-y-1 w-[400px] bg-white shadow-sm border border-slate-800/30 z-1000">
                      <p class="text-gray-800 font-light">We recommend first-time miners start with a brief tour of how to use this overlay.</p>
                      <div class="flex flex-row space-x-2 mt-6">
                        <button @click="stopSuggestingTour" tabindex="-1" class="cursor-pointer grow rounded-md border border-slate-500/30 px-4 py-1 focus:outline-none">Not Now</button>
                        <button @click="startTour" tabindex="0" class="cursor-pointer grow rounded-md bg-argon-button border border-argon-button-hover hover:bg-argon-button-hover text-white font-bold inner-button-shadow px-4 py-1 focus:outline-none">Start Tour</button>
                      </div>
                      <PopoverArrow :width="24" :height="12" class="fill-white stroke-gray-400/50 shadow-2xl -mt-px" />
                    </PopoverContent>
                  </PopoverPortal>
                </PopoverRoot>.
              </DialogDescription>

              <section class="flex flex-row border-t border-b border-slate-500/30 text-center pt-8 pb-8 px-3.5 mx-5 justify-stretch">
                <div class="w-1/2 flex flex-col grow">
                  <div PrimaryStat :isTouring="currentTourStep === 1" ref="capitalToCommitElement" class="flex flex-col grow group border border-slate-500/30 rounded-lg shadow-sm">
                    <header StatHeader class="mx-0.5 pt-5 pb-0 relative">
                      <tooltip side="top" content="The amount you're willing to invest in mining seats">
                        Capital {{ config.isMinerInstalled ? 'Committed' : 'to Commit' }}
                      </tooltip>
                    </header>
                    <div class="grow flex flex-col mt-3 border-t border-slate-500/30 border-dashed w-10/12 mx-auto">
                      <div class="text-gray-500/60 border-b border-slate-500/30 border-dashed py-3 w-full">
                        To secure <tooltip content="Customize this in the Capital Allocation box below">your goal</tooltip> of
                        {{getEpochSeatGoalCount()}} mining seats <tooltip content="An epoch is equivalent to ten days">per epoch</tooltip>, you need
                      </div>
                      <div class="flex flex-row items-center justify-center grow relative h-26 font-bold font-mono text-argon-600">
                        <NeedMoreCapitalHover v-if="minimumCapitalCommitment > capitalCommitment" :calculator="calculator" :seat-goal-count="getEpochSeatGoalCount()" :ideal-capital-commitment="minimumCapitalCommitment" @increase-capital-commitment="acceptMinimumCapitalCommitment()" />
                        <InputArgon v-model="capitalCommitment" :min="0n" :maxDecimals="2" @input="handleCapitalCommitmentInput" />
                        <CapitalOverlay align="end">
                          <PiechartIcon PiechartIcon class="ml-1 w-10 h-10 text-gray-300 hover:!text-argon-600" />
                        </CapitalOverlay>
                      </div>
                      <div class="text-gray-500/60 border-t border-slate-500/30 border-dashed py-5 w-full mx-auto">
                        This is the <tooltip content="Click the capital amount listed above to directly change your commitment">amount of capital you'll need</tooltip> for acquiring<br/>
                        <tooltip content="Argons are the stable currency of the network">
                          {{ microgonToArgonNm(rules.initialMicrogonRequirement).formatIfElse('<100', '0,0.[00]', '0,0') }}
                          argon{{ microgonToArgonNm(rules.initialMicrogonRequirement).formatIfElse('<100', '0.[00]', '0,0') === '1' ? '' : 's' }}
                        </tooltip>
                        and
                        <tooltip content="Argonots are the ownership tokens of the network">
                          {{ micronotToArgonotNm(rules.initialMicronotRequirement).formatIfElse('<100', '0.00', '0,0') }}
                          argonot{{ micronotToArgonotNm(rules.initialMicronotRequirement).formatIfElse('<100', '0.[00]', '0,0') === '1' ? '' : 's' }}
                        </tooltip>
                        at their <tooltip content="Prices reflect as closely as possible the real-time rates on Uniswap's trading exchange">current market rates</tooltip>.
                      </div>
                    </div>
                  </div>
                </div>
                <div class="flex flex-col items-center justify-center text-3xl mx-2 text-center">
                  <span class="relative -top-1 opacity-50">
                    =
                  </span>
                </div>
                <div class="w-1/2 flex flex-col grow">
                  <div PrimaryStat :isTouring="currentTourStep === 2" ref="returnOnCapitalElement" class="flex flex-col grow group border border-slate-500/30 rounded-lg shadow-sm">
                    <header StatHeader class="mx-0.5 pt-5 pb-0 relative">
                      <tooltip side="top" content="The amount you might earn on your capital">
                        Return on Capital
                      </tooltip>
                    </header>
                    <div class="grow flex flex-col mt-3 border-t border-slate-500/30 border-dashed w-10/12 mx-auto">
                      <div class="text-gray-500/60 border-b border-slate-500/30 border-dashed py-3 w-full">
                        Your capital is <tooltip content="This is not a guarantee, simply an estimate">estimated</tooltip> to return
                        {{ numeral(epochPercentageYield).formatCapped('0,0.00', 999_999) }}% <tooltip content="An epoch is equivalent to ten days">per epoch</tooltip>
                        at an <tooltip content="Annual Percent Yield">APY</tooltip> of
                      </div>
                      <div class="flex flex-row items-center justify-center grow relative h-26 text-6xl font-bold font-mono text-argon-600">
                        <span>~{{ numeral(averageAPY).formatIfElseCapped('>=100', '0,0', '0,0.00', 999_999) }}%</span>
                        <ReturnsOverlay align="start">
                          <PiechartIcon PiechartIcon class="ml-4 w-10 h-10 text-gray-300 hover:!text-argon-600" />
                        </ReturnsOverlay>
                      </div>
                      <div class="text-gray-500/60 border-t border-slate-500/30 border-dashed py-5 w-full">
                      This represents the <tooltip content="It's a blend between multiple possibilities">average return</tooltip> between
                      your <tooltip content="Your bot's opening bid each day">starting</tooltip> <br />
                      <tooltip content="Your bot's opening bid each day">bid</tooltip> and
                      <tooltip content="The price your bot won't go above">maximum bid</tooltip>,
                      between <tooltip content="Customize this in the Ecosystem Growth box below">slow growth</tooltip> and
                      <tooltip content="Customize this in the Ecosystem Growth box below">fast growth</tooltip>.
                    </div>
                    </div>
                  </div>
                </div>
              </section>

              <BotSettings ref="botSettings" @toggleEditBoxOverlay="(x: boolean) => hasEditBoxOverlay = x" @update:data="updateCapitalRequirements" :includeProjections="true" />
            </div>
            <div v-else class="grow flex items-center justify-center">Loading...</div>

            <div class="flex flex-row justify-end border-t border-slate-300 mx-4 py-4 space-x-4 rounded-b-lg">
              <div class="flex flex-row space-x-4 justify-center items-center">
                <ActiveBidsOverlayButton :loadFromMainchain="true" class="mr-10">
                  <span class="text-argon-600/70 cursor-pointer">Show Existing Mining Bids</span>
                </ActiveBidsOverlayButton>
                <button @click="cancelPanel" tabindex="-1" class="border border-argon-button/50 hover:border-argon-button text-xl font-bold text-gray-500 px-7 py-1 rounded-md cursor-pointer">
                  <span>Cancel</span>
                </button>
                <tooltip asChild :calculateWidth="() => calculateElementWidth(saveButtonElement)" side="top" content="Clicking this button does not commit you to anything.">
                  <button @click="saveRules" tabindex="0" ref="saveButtonElement" class="bg-argon-button hover:border-argon-800 text-xl font-bold text-white px-7 py-1 rounded-md cursor-pointer">
                    <span v-if="!isSaving">{{ isBrandNew ? 'Initialize' : 'Update' }} Rules</span>
                    <span v-else>{{ isBrandNew ? 'Initializing' : 'Updating' }} Rules...</span>
                  </button>
                </tooltip>
              </div>
            </div>
          </div>
        </div>
      </DialogContent>
    </DialogPortal>
  </DialogRoot>
</template>

<script setup lang="ts">
import * as Vue from 'vue';
import BigNumber from 'bignumber.js';
import {
  DialogContent,
  DialogDescription,
  DialogOverlay,
  DialogPortal,
  DialogRoot,
  DialogTitle,
  PopoverArrow,
  PopoverContent,
  PopoverPortal,
  PopoverRoot,
  PopoverTrigger,
} from 'reka-ui';
import { useConfig } from '../stores/config.ts';
import { useCurrency } from '../stores/currency.ts';
import { getBiddingCalculator, getBiddingCalculatorData } from '../stores/mainchain.ts';
import numeral, { createNumeralHelpers } from '../lib/numeral.ts';
import BgOverlay from '../components/BgOverlay.vue';
import { XMarkIcon } from '@heroicons/vue/24/outline';
import {
  BidAmountAdjustmentType,
  BidAmountFormulaType,
  bigIntMax,
  type IBiddingRules,
  JsonExt,
} from '@argonprotocol/apps-core';
import ActiveBidsOverlayButton from '../overlays/ActiveBidsOverlayButton.vue';
import { bigIntCeil, bigNumberToInteger } from '@argonprotocol/apps-core/src/utils.ts';
import InputArgon from '../components/InputArgon.vue';
import NeedMoreCapitalHover from '../overlays/bot/NeedMoreCapitalHover.vue';
import ReturnsOverlay from '../overlays/bot/BotReturns.vue';
import CapitalOverlay from '../overlays/bot/BotCapital.vue';
import { useBot } from '../stores/bot.ts';
import PiechartIcon from '../assets/piechart.svg?component';
import Tooltip from '../components/Tooltip.vue';
import { ITourPos } from '../stores/tour.ts';
import BotTour from './bot-create-tour/Base.vue';
import { useController } from '../stores/controller.ts';
import Draggable from '../overlays/helpers/Draggable.ts';
import BotSettings from '../components/BotSettings.vue';

const emit = defineEmits<{
  (e: 'close'): void;
}>();

const calculator = getBiddingCalculator();
const calculatorData = getBiddingCalculatorData();

let previousBiddingRules: string | null = null;

const currency = useCurrency();
const config = useConfig();
const bot = useBot();
const controller = useController();

const draggable = Vue.reactive(new Draggable());
const { microgonToArgonNm, micronotToArgonotNm } = createNumeralHelpers(currency);

const rules = Vue.computed(() => {
  return config.biddingRules as IBiddingRules;
});

const isBrandNew = Vue.ref(true);
const isSuggestingTour = Vue.ref(false);
const currentTourStep = Vue.ref<number>(0);
const isLoaded = Vue.ref(false);
const isSaving = Vue.ref(false);
const hasEditBoxOverlay = Vue.ref(false);

const capitalToCommitElement = Vue.ref<HTMLElement | null>(null);
const returnOnCapitalElement = Vue.ref<HTMLElement | null>(null);
const botSettings = Vue.ref<typeof BotSettings | null>(null);
const saveButtonElement = Vue.ref<HTMLElement | null>(null);

const probableMinSeats = Vue.ref(0);
const probableMaxSeats = Vue.ref(0);

const startingBidAmount = Vue.ref(0n);
const maximumBidAmount = Vue.ref(0n);

const startingBidAtSlowGrowthAPY = Vue.ref(0);
const startingBidAtFastGrowthAPY = Vue.ref(0);
const maximumBidAtSlowGrowthAPY = Vue.ref(0);
const maximumBidAtFastGrowthAPY = Vue.ref(0);

const capitalCommitment = Vue.ref(0n);
const minimumCapitalCommitment = Vue.ref(0n);

const averageAPY = Vue.ref(0);
const averageEarnings = Vue.ref(0n);
const epochPercentageYield = Vue.ref(0);

function getTourPositionCheck(name: string): ITourPos {
  if (name === 'capitalToCommit') {
    const rect = capitalToCommitElement.value?.getBoundingClientRect() as DOMRect;
    return {
      left: rect.left,
      top: rect.top,
      right: rect.left + rect.width,
      bottom: rect.top + rect.height,
      width: rect.width,
      height: rect.height,
    };
  } else if (name === 'returnOnCapital') {
    const rect = returnOnCapitalElement.value?.getBoundingClientRect() as DOMRect;
    return {
      left: rect.left,
      top: rect.top,
      right: rect.left + rect.width,
      bottom: rect.top + rect.height,
      width: rect.width,
      height: rect.height,
    };
  } else if (name === 'configBoxes') {
    const rect = botSettings.value?.getBoundingClientRect() as DOMRect;
    const left = rect.left + 20;
    const width = rect.width - 40;
    return {
      left: left,
      top: rect.top,
      right: left + width,
      bottom: rect.top + rect.height,
      width: width,
      height: rect.height,
    };
  } else if (name === 'saveButton') {
    const rect = saveButtonElement.value?.getBoundingClientRect() as DOMRect;
    const left = rect.left - 10;
    const width = rect.width + 20;
    const top = rect.top - 10;
    const height = rect.height + 20;
    return { left: left, top: top, right: left + width, bottom: top + height, width: width, height: height };
  } else {
    return { left: 100, top: 100, right: 200, bottom: 200, width: 100, height: 100 };
  }
}

function calculateElementWidth(element: HTMLElement | null) {
  if (!element) return;
  const elementWidth = element.getBoundingClientRect().width;
  return `${elementWidth}px`;
}

function getEpochSeatGoalCount() {
  return calculatorData.getEpochSeatGoalCount(rules.value);
}

function cancelEditOverlay() {
  botSettings.value?.closeEditBoxOverlay();
}

function cancelPanel() {
  if (hasEditBoxOverlay.value) return;

  if (previousBiddingRules) {
    config.biddingRules = JsonExt.parse<IBiddingRules>(previousBiddingRules);
  }
  emit('close');
}

async function saveRules() {
  isSaving.value = true;

  let didSave = false;
  if (rules.value) {
    await config.saveBiddingRules();
    didSave = true;
  }

  isSaving.value = false;
  emit('close');
  if (config.isMinerInstalled && didSave) {
    try {
      await bot.resyncBiddingRules();
    } catch (error) {
      console.error('Failed to reload server bidding rules:', error);
    }
  }
}

function handleCapitalCommitmentInput() {
  console.log('RUNNING handleCapitalCommitmentInput', capitalCommitment.value);
  rules.value.initialCapitalCommitment = capitalCommitment.value;

  const projections = calculator.runProjections(rules.value, 'maximum');
  rules.value.initialMicrogonRequirement = projections.microgonRequirement;
  rules.value.initialMicronotRequirement = projections.micronotRequirement;
}

function updateAPYs() {
  calculator.updateBiddingRules(rules.value);
  calculator.calculateBidAmounts();

  startingBidAmount.value = calculator.startingBidAmount;
  maximumBidAmount.value = calculator.maximumBidAmount;

  startingBidAtSlowGrowthAPY.value = calculator.startingBidAtSlowGrowthAPY;
  startingBidAtFastGrowthAPY.value = calculator.startingBidAtFastGrowthAPY;
  maximumBidAtSlowGrowthAPY.value = calculator.maximumBidAtSlowGrowthAPY;
  maximumBidAtFastGrowthAPY.value = calculator.maximumBidAtFastGrowthAPY;

  averageAPY.value = calculator.averageAPY;

  const epochStartingSlowYield = calculator.calculateTenDayYield('starting', 'slow');
  const epochStartingFastYield = calculator.calculateTenDayYield('starting', 'fast');
  const epochMaximumSlowYield = calculator.calculateTenDayYield('maximum', 'slow');
  const epochMaximumFastYield = calculator.calculateTenDayYield('maximum', 'fast');
  epochPercentageYield.value =
    (epochStartingSlowYield + epochStartingFastYield + epochMaximumSlowYield + epochMaximumFastYield) / 4;

  const maxAffordableSeats =
    calculatorData.maximumMicronotsForBid === 0n
      ? 0n
      : rules.value.initialMicronotRequirement / calculatorData.maximumMicronotsForBid;

  const probableMinSeatsBn =
    calculator.maximumBidAmount === 0n
      ? new BigNumber(0)
      : BigNumber(rules.value.initialMicrogonRequirement).dividedBy(calculator.maximumBidAmount);
  probableMinSeats.value = Math.max(bigNumberToInteger(probableMinSeatsBn), 0);
  if (probableMinSeats.value > Number(maxAffordableSeats)) {
    probableMinSeats.value = Number(maxAffordableSeats);
  }

  const probableMaxSeatsBn =
    calculator.startingBidAmount === 0n
      ? new BigNumber(0)
      : BigNumber(rules.value.initialMicrogonRequirement).dividedBy(calculator.startingBidAmount);
  probableMaxSeats.value = Math.min(bigNumberToInteger(probableMaxSeatsBn), calculatorData.maxPossibleMiningSeatCount);
  if (probableMaxSeats.value > Number(maxAffordableSeats)) {
    probableMaxSeats.value = Number(maxAffordableSeats);
  }

  const safeProbableMinSeats = Number.isFinite(probableMinSeats.value)
    ? Math.max(0, Math.trunc(probableMinSeats.value))
    : 0;
  const safeProbableMaxSeats = Number.isFinite(probableMaxSeats.value)
    ? Math.max(0, Math.trunc(probableMaxSeats.value))
    : 0;

  probableMinSeats.value = safeProbableMinSeats;
  probableMaxSeats.value = Math.min(safeProbableMaxSeats, calculatorData.maxPossibleMiningSeatCount);

  const slowGrowthEarnings = BigInt(safeProbableMinSeats) * calculator.slowGrowthRewards;
  const fastGrowthEarnings = BigInt(safeProbableMaxSeats) * calculator.fastGrowthRewards;
  averageEarnings.value = (slowGrowthEarnings + fastGrowthEarnings) / 2n;
}

function updateCapitalRequirements() {
  updateTokenRequirements();
  updateMinimumCapitalCommitment();
}

function updateTokenRequirements() {
  const projections = calculator.runProjections(rules.value, 'maximum');
  rules.value.initialMicrogonRequirement = projections.microgonRequirement;
  rules.value.initialMicronotRequirement = projections.micronotRequirement;
  if (rules.value.initialCapitalCommitment) {
    capitalCommitment.value = rules.value.initialCapitalCommitment;
  } else {
    capitalCommitment.value = projections.capitalCommitment;
  }
}

function updateMinimumCapitalCommitment() {
  const { microgonRequirement, micronotRequirement } = calculator.runProjections(rules.value, 'maximum', true);
  const commitment = currency.micronotToMicrogon(micronotRequirement) + microgonRequirement;
  minimumCapitalCommitment.value = bigIntMax(0n, bigIntCeil(commitment, 10_000n));
}

function acceptMinimumCapitalCommitment() {
  capitalCommitment.value = minimumCapitalCommitment.value;
  rules.value.initialCapitalCommitment = undefined;
}

function startTour() {
  currentTourStep.value = 1;
  isSuggestingTour.value = false;
}

function closeTour() {
  currentTourStep.value = 0;
}

function stopSuggestingTour() {
  controller.stopSuggestingBotTour = true;
  isSuggestingTour.value = false;
}

Vue.onMounted(async () => {
  isLoaded.value = false;
  isBrandNew.value = !config.hasSavedBiddingRules;
  isSuggestingTour.value = isBrandNew.value && !controller.stopSuggestingBotTour;

  calculator.onLoad(() => updateCapitalRequirements());
  await calculator.load();
  Vue.watch(rules, () => updateAPYs(), { deep: true });

  previousBiddingRules = JsonExt.stringify(config.biddingRules);

  updateAPYs();
  updateCapitalRequirements();
  if (!rules.value.initialCapitalCommitment) {
    acceptMinimumCapitalCommitment();
  }

  if (isBrandNew.value && startingBidAtFastGrowthAPY.value > 20_000) {
    /*
      The default startingBidFormulaType is set at PreviousDayLow, which at least on testnet, is creating a
      situation where the projected returns are astronomically high (and seemingly unrealistic). In order to
      create a more realistic projected return, we're setting the startingBidFormulaType to 12% below BreakevenAtSlowGrowth.
      We might remove this IF block in the future, but it seems a good safety fix for now.
    */
    rules.value.startingBidFormulaType = BidAmountFormulaType.BreakevenAtSlowGrowth;
    rules.value.startingBidAdjustmentType = BidAmountAdjustmentType.Relative;
    rules.value.startingBidAdjustRelative = -12.0;
    updateAPYs();
    updateCapitalRequirements();
    if (!rules.value.initialCapitalCommitment) {
      acceptMinimumCapitalCommitment();
    }
  }
  isLoaded.value = true;
});
</script>

<style>
@reference "../main.css";

.BotCreatePanel {
  h2 {
    position: relative;
    &:before {
      @apply from-argon-menu-bg bg-gradient-to-r to-transparent;
      content: '';
      display: block;
      width: 30px;
      position: absolute;
      z-index: 1;
      left: -5px;
      top: 0;
      bottom: -5px;
    }
    &:after {
      @apply from-argon-menu-bg bg-gradient-to-l to-transparent;
      content: '';
      display: block;
      width: 30px;
      position: absolute;
      z-index: 1;
      right: -5px;
      top: 0;
      bottom: -5px;
    }
  }

  [StatHeader] {
    @apply group-hover:text-argon-600/70 text-lg font-bold text-[#a08fb7];
  }

  [PrimaryStat] {
    @apply relative;

    [tooltip] {
      @apply text-argon-600/60 transition-all duration-300;

      &:focus {
        @apply text-argon-600;
      }
    }

    &:hover,
    &[isTouring='true'] {
      [tooltip] {
        @apply text-argon-600 cursor-help;
      }
      [PiechartIcon] {
        animation: BotCreatePanel-fadeToArgon 2s ease-in-out 1;
      }
    }

    [InputFieldWrapper] {
      @apply text-argon-600 border-none font-mono text-6xl font-bold !outline-none hover:bg-transparent focus:!outline-none;
      box-shadow: none;
    }
    [NumArrows] {
      @apply relative top-2;
    }
    svg[NumArrowUp],
    svg[NumArrowDown] {
      @apply size-[24px];
    }

    [StatHeader] {
      @apply text-argon-600/70;
      background: linear-gradient(to bottom, oklch(0.88 0.09 320 / 0.2) 0%, transparent 100%);
      text-shadow: 1px 1px 0 white;
    }
  }

  section div[MainWrapper] {
    @apply cursor-pointer;

    &:hover {
      @apply bg-argon-20;
      [MainRule]::before {
        background: linear-gradient(to right, var(--color-argon-20) 0%, transparent 100%);
      }
      [MainRule]::after {
        background: linear-gradient(to left, var(--color-argon-20) 0%, transparent 100%);
      }
      [StatHeader] {
        @apply text-argon-600/70;
      }
      [EditIcon] {
        @apply w-4.5 min-w-4.5 opacity-100;
      }
    }

    [StatHeader] {
      @apply pt-1;
    }

    [EditIcon] {
      @apply text-argon-600/50 relative z-10 -mt-0.5 ml-2 h-4.5 min-h-4.5 w-0 min-w-0 opacity-0 transition-all duration-300;
    }

    [MainRule] {
      @apply text-argon-700/80 relative my-1.5 border-t border-b border-dashed border-slate-500/30 py-1 text-center font-mono font-bold;
      &::before {
        content: '';
        display: block;
        width: 10%;
        height: calc(100% + 4px);
        background: linear-gradient(to right, var(--color-argon-menu-bg) 0%, transparent 100%);
        position: absolute;
        top: -2px;
        left: 0;
      }
      &::after {
        content: '';
        display: block;
        width: 10%;
        height: calc(100% + 4px);
        background: linear-gradient(to left, var(--color-argon-menu-bg) 0%, transparent 100%);
        position: absolute;
        top: -2px;
        right: 0;
      }
      span {
        @apply relative z-10;
      }
    }
  }
}

@keyframes BotCreatePanel-fadeToArgon {
  0% {
    color: rgb(209 213 219); /* text-gray-300 */
    transform: scale(1);
  }
  30% {
    color: oklch(0.48 0.24 320); /* text-argon-600 */
    transform: scale(1.15);
  }
  100% {
    color: rgb(209 213 219); /* text-gray-300 */
    transform: scale(1);
  }
}
</style>
