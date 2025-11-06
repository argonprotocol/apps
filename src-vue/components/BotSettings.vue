<template>
  <div ref="editBoxParent" class="relative flex grow flex-col px-5 text-lg">
    <EditBoxOverlay
      v-if="editBoxOverlayId"
      :id="editBoxOverlayId"
      :position="editBoxOverlayPosition"
      :previousId="editBoxOverlayPreviousId"
      :nextId="editBoxOverlayNextId"
      @close="closeEditBoxOverlay"
      @goTo="(id: any) => openEditBoxOverlay(id)"
      @update:data="updateAPYs" />
    <section class="my-2 flex h-1/2 grow flex-row">
      <div MainWrapperParent ref="startingBidParent" :class="[includeProjections ? 'w-1/3' : 'w-1/2']">
        <tooltip
          asChild
          :calculateWidth="() => calculateElementWidth(startingBidParent)"
          side="top"
          content="This is your starting bid price. Don't put it too low or you'll be forced to pay unneeded transaction fees in order to submit a rebid.">
          <div
            MainWrapper
            @click="openEditBoxOverlay('startingBid')"
            class="flex h-full w-full flex-col items-center justify-center px-8">
            <div StatHeader>Starting Bid</div>
            <div v-if="startingBidAmountOverride" MainRule class="flex w-full flex-row items-center justify-center">
              <div class="flex flex-row items-center justify-center space-x-2">
                <AlertIcon class="relative -top-0.5 inline-block h-5 w-5 text-yellow-700" />
                <span class="text-gray-500/60 line-through">
                  {{ currency.symbol }}{{ microgonToMoneyNm(startingBidAmount).format('0,0.00') }}
                </span>
                <span>{{ currency.symbol }}{{ microgonToMoneyNm(startingBidAmountOverride).format('0,0.00') }}</span>
              </div>
              <EditIcon EditIcon />
            </div>
            <div v-else MainRule class="flex w-full flex-row items-center justify-center">
              <span>{{ currency.symbol }}{{ microgonToMoneyNm(startingBidAmount).format('0,0.00') }}</span>
              <EditIcon EditIcon />
            </div>
            <div class="text-md text-gray-500/60">
              <span v-if="rules.startingBidFormulaType === BidAmountFormulaType.Custom">Custom Value</span>
              <template v-else>
                <span>{{ rules.startingBidFormulaType }}</span>
                <span
                  v-if="
                    rules.startingBidAdjustmentType === BidAmountAdjustmentType.Absolute &&
                    rules.startingBidAdjustAbsolute
                  ">
                  {{ rules.startingBidAdjustAbsolute > 0 ? '+' : '-' }}{{ currency.symbol
                  }}{{
                    microgonToMoneyNm(
                      rules.startingBidAdjustAbsolute < 0n
                        ? -rules.startingBidAdjustAbsolute
                        : rules.startingBidAdjustAbsolute,
                    ).format('0.00')
                  }}
                </span>
                <span v-else-if="rules.startingBidAdjustRelative">
                  &nbsp;{{ rules.startingBidAdjustRelative > 0 ? '+' : '-'
                  }}{{ numeral(Math.abs(rules.startingBidAdjustRelative)).format('0.[00]') }}%
                </span>
              </template>
            </div>
          </div>
        </tooltip>
      </div>

      <div class="mx-2 w-[1px] bg-slate-300/80" />

      <div MainWrapperParent ref="maximumBidParent" :class="[includeProjections ? 'w-1/3' : 'w-1/2']">
        <tooltip
          asChild
          :calculateWidth="() => calculateElementWidth(maximumBidParent)"
          side="top"
          content="Your mining bot will never submit a bid above this price. If other bidders go higher than this, you will be knocked out of contention.">
          <div
            MainWrapper
            @click="openEditBoxOverlay('maximumBid')"
            class="flex h-full w-full flex-col items-center justify-center px-8">
            <div StatHeader>Maximum Bid</div>
            <div v-if="maximumBidAmountOverride" MainRule class="flex w-full flex-row items-center justify-center">
              <div class="flex flex-row items-center justify-center space-x-2">
                <AlertIcon class="relative -top-0.5 inline-block h-5 w-5 text-yellow-700" />
                <span class="text-gray-500/60 line-through">
                  {{ currency.symbol }}{{ microgonToMoneyNm(maximumBidAmount).format('0,0.00') }}
                </span>
                <span>{{ currency.symbol }}{{ microgonToMoneyNm(maximumBidAmountOverride).format('0,0.00') }}</span>
              </div>
              <EditIcon EditIcon />
            </div>
            <div v-else MainRule class="flex w-full flex-row items-center justify-center">
              <span>{{ currency.symbol }}{{ microgonToMoneyNm(maximumBidAmount).format('0,0.00') }}</span>
              <EditIcon EditIcon />
            </div>
            <div class="text-md text-gray-500/60">
              <span v-if="rules.maximumBidFormulaType === BidAmountFormulaType.Custom">Custom Value</span>
              <template v-else>
                <span>{{ rules.maximumBidFormulaType }}</span>
                <span
                  v-if="
                    rules.maximumBidAdjustmentType === BidAmountAdjustmentType.Absolute &&
                    rules.maximumBidAdjustAbsolute
                  ">
                  {{ rules.maximumBidAdjustAbsolute > 0 ? '+' : '-' }}{{ currency.symbol
                  }}{{ microgonToMoneyNm(bigIntAbs(rules.maximumBidAdjustAbsolute)).format('0.00') }}
                </span>
                <span v-else-if="rules.maximumBidAdjustRelative">
                  &nbsp;{{ rules.maximumBidAdjustRelative > 0 ? '+' : '-'
                  }}{{ numeral(Math.abs(rules.maximumBidAdjustRelative)).format('0.[00]') }}%
                </span>
              </template>
            </div>
          </div>
        </tooltip>
      </div>

      <div v-if="props.includeProjections" class="mx-2 w-[1px] bg-slate-300/80" />

      <Teleport defer to="#expectedGrowthParent" :disabled="props.includeProjections">
        <div
          MainWrapperParent
          ref="rebiddingStrategyParent"
          :class="[includeProjections ? 'w-1/3' : 'w-full']"
          class="relative flex h-full flex-col items-center justify-center">
          <tooltip
            asChild
            :calculateWidth="() => calculateElementWidth(rebiddingStrategyParent)"
            side="top"
            :content="`If your bids get knocked out of contention, your bot will wait ${rules.rebiddingDelay} minute${rules.rebiddingDelay === 1 ? '' : 's'} before submitting a new bid at ${currency.symbol}${microgonToMoneyNm(rules.rebiddingIncrementBy).format('0.00')} above the current winning bid.`">
            <div
              MainWrapper
              @click="openEditBoxOverlay('rebiddingStrategy')"
              class="flex h-full w-full flex-col items-center justify-center px-8">
              <div StatHeader>Rebidding Strategy</div>
              <div MainRule class="flex w-full flex-row items-center justify-center">
                <span>+{{ currency.symbol }}{{ microgonToMoneyNm(rules.rebiddingIncrementBy).format('0.00') }}</span>
                <EditIcon EditIcon />
              </div>
              <div class="text-md text-gray-500/60">
                Delay By {{ rules.rebiddingDelay }} Minute{{ rules.rebiddingDelay === 1 ? '' : 's' }}
              </div>
            </div>
          </tooltip>
        </div>
      </Teleport>
    </section>

    <div class="flex h-[1px] flex-row">
      <div :class="[includeProjections ? 'w-1/3' : 'w-1/2']" class="bg-slate-300/80"></div>
      <div class="mx-2 w-[1px]"></div>
      <div :class="[includeProjections ? 'w-1/3' : 'w-1/2']" class="bg-slate-300/80"></div>
      <div v-if="props.includeProjections" class="mx-2 w-[1px]"></div>
      <div v-if="props.includeProjections" class="w-1/3 bg-slate-300/80"></div>
    </div>

    <section class="my-2 flex h-1/2 grow flex-row">
      <div
        v-if="!props.includeProjections"
        id="expectedGrowthParent"
        :class="[includeProjections ? 'w-1/3' : 'w-1/2']"
        class="relative flex flex-row items-center justify-center" />

      <div v-if="!props.includeProjections" class="mx-2 w-[1px] bg-slate-300/80" />

      <div
        MainWrapperParent
        ref="capitalAllocationParent"
        :class="[includeProjections ? 'w-1/3' : 'w-1/2']"
        class="relative flex flex-col items-center justify-center">
        <tooltip
          asChild
          :calculateWidth="() => calculateElementWidth(capitalAllocationParent)"
          side="top"
          :content="`This is your bot's goal, not its ceiling. If the bot can snag more than ${seatGoalText()}, it will do so. If it fails to achieve its goal, it will alert you in the app.`">
          <div
            MainWrapper
            @click="openEditBoxOverlay('capitalAllocation')"
            class="flex h-full w-full flex-col items-center justify-center px-8">
            <div StatHeader>Capital Allocation</div>
            <div MainRule v-if="rules.seatGoalType === SeatGoalType.Max && rules.seatGoalCount === 0" class="w-full">
              Disabled
            </div>
            <div MainRule v-else class="flex w-full flex-row items-center justify-center">
              <span>{{ rules.seatGoalType }} {{ rules.seatGoalCount }} Seats Per {{ rules.seatGoalInterval }}</span>
              <EditIcon EditIcon />
            </div>
            <div class="text-md text-gray-500/60">
              {{
                rules.seatGoalType === SeatGoalType.Max ? 'Stop After Goal Reached' : 'Reinvest Profits from Operation'
              }}
            </div>
          </div>
        </tooltip>
      </div>

      <div v-if="props.includeProjections" class="mx-2 w-[1px] bg-slate-300/80" />

      <div
        v-if="props.includeProjections"
        MainWrapperParent
        ref="expectedGrowthParent"
        class="relative flex w-1/3 flex-col items-center justify-center">
        <tooltip
          asChild
          :calculateWidth="() => calculateElementWidth(expectedGrowthParent)"
          side="top"
          content="These numbers don't affect your bot's decisions; they only factor into the Estimated APY shown above. Argons is growth in circulation; Argonots is change in token price. Both are factored annually.">
          <div
            MainWrapper
            @click="openEditBoxOverlay('expectedGrowth')"
            class="flex h-full w-full flex-col items-center justify-center">
            <div StatHeader>Ecosystem Growth</div>
            <div class="flex w-full flex-row items-center justify-center px-8 text-center font-mono">
              <div MainRule class="flex w-5/12 flex-row items-center justify-center">
                <span>{{ numeral(rules.argonCirculationGrowthPctMin).formatIfElse('0', '0', '+0.[0]') }}%</span>
                <span class="text-md px-1.5 text-gray-500/60">to</span>
                <span>{{ numeral(rules.argonCirculationGrowthPctMax).formatIfElse('0', '0', '+0.[0]') }}%</span>
                <EditIcon EditIcon />
              </div>
              <span class="text-md w-2/12 text-gray-500/60">&nbsp;and&nbsp;</span>
              <div MainRule class="flex w-5/12 flex-row items-center justify-center">
                <span>{{ numeral(rules.argonotPriceChangePctMin).formatIfElse('0', '0', '+0.[0]') }}%</span>
                <span class="text-md px-1.5 text-gray-500/60">to</span>
                <span>{{ numeral(rules.argonotPriceChangePctMax).formatIfElse('0', '0', '+0.[0]') }}%</span>
                <EditIcon EditIcon />
              </div>
            </div>
            <div class="flex w-full flex-row items-center justify-center px-10 text-center font-mono">
              <div class="text-md flex w-5/12 flex-row items-center justify-center px-1 text-gray-500/60">Argons</div>
              <span class="text-md w-2/12 text-gray-500/60">&nbsp;</span>
              <div class="text-md flex w-5/12 flex-row items-center justify-center text-gray-500/60">Argonots</div>
            </div>
          </div>
        </tooltip>
      </div>

      <div v-if="props.includeProjections" class="mx-2 w-[1px] bg-slate-300/80" />

      <div
        v-if="props.includeProjections"
        MainWrapperParent
        ref="cloudMachineParent"
        class="relative flex w-1/3 flex-col items-center justify-center">
        <tooltip
          asChild
          :calculateWidth="() => calculateElementWidth(cloudMachineParent)"
          side="top"
          content="You can leave this server configuration box as-is for now. Later in the process, we'll guide you through the step-by-step flow of how to set up a new Mining Machine. Don't worry, it's easy.">
          <div
            MainWrapper
            @click="openEditBoxOverlay('cloudMachine')"
            class="flex h-full w-full flex-col items-center justify-center px-8">
            <div StatHeader>Mining Machine</div>
            <div MainRule class="flex w-full flex-row items-center justify-center tracking-widest">
              <span>{{ config.serverDetails.ipAddress || '0.0.0.0' }}</span>
              <EditIcon EditIcon />
            </div>
            <div class="text-md font-mono text-gray-500/60">
              {{ config.isMinerInstalled ? 'Existing Server' : 'New Server' }}
            </div>
          </div>
        </tooltip>
      </div>
    </section>
  </div>
</template>

<script setup lang="ts">
import * as Vue from 'vue';
import { useConfig } from '../stores/config';
import { useCurrency } from '../stores/currency';
import { useBot } from '../stores/bot';
import AlertIcon from '../assets/alert.svg?component';
import EditIcon from '../assets/edit.svg?component';
import {
  BidAmountAdjustmentType,
  BidAmountFormulaType,
  BiddingCalculator,
  type IBiddingRules,
  SeatGoalType,
} from '@argonprotocol/apps-core';
import EditBoxOverlay, { type IEditBoxOverlayTypeForMining } from '../overlays/EditBoxOverlay.vue';
import numeral, { createNumeralHelpers } from '../lib/numeral';
import { bigIntAbs } from '@argonprotocol/apps-core/src/utils';
import { getBiddingCalculator } from '../stores/mainchain';
import Tooltip from '../components/Tooltip.vue';

const props = defineProps<{
  includeProjections?: boolean;
}>();

const emit = defineEmits<{
  (e: 'toggleEditBoxOverlay', value: boolean): void;
  (e: 'update:data', calculator: BiddingCalculator): void;
}>();

const currency = useCurrency();
const calculator = getBiddingCalculator();
const bot = useBot();
const config = useConfig();

const { microgonToMoneyNm } = createNumeralHelpers(currency);

const rules = Vue.computed(() => {
  return config.biddingRules as IBiddingRules;
});

const startingBidParent = Vue.ref<HTMLElement | null>(null);
const maximumBidParent = Vue.ref<HTMLElement | null>(null);
const rebiddingStrategyParent = Vue.ref<HTMLElement | null>(null);
const capitalAllocationParent = Vue.ref<HTMLElement | null>(null);
const expectedGrowthParent = Vue.ref<HTMLElement | null>(null);
const cloudMachineParent = Vue.ref<HTMLElement | null>(null);

const editBoxItems: Record<
  IEditBoxOverlayTypeForMining,
  { isProjection: boolean; element: Vue.Ref<HTMLElement | null> }
> = {
  startingBid: { isProjection: false, element: startingBidParent },
  maximumBid: { isProjection: false, element: maximumBidParent },
  rebiddingStrategy: { isProjection: false, element: rebiddingStrategyParent },
  capitalAllocation: { isProjection: false, element: capitalAllocationParent },
  expectedGrowth: { isProjection: true, element: expectedGrowthParent },
  cloudMachine: { isProjection: true, element: cloudMachineParent },
};

const editBoxParent = Vue.ref<HTMLElement | null>(null);
const editBoxOverlayId = Vue.ref<IEditBoxOverlayTypeForMining | null>(null);
const editBoxOverlayPosition = Vue.ref<{ top?: number; left?: number; width?: number } | undefined>(undefined);
const editBoxOverlayPreviousId = Vue.ref<IEditBoxOverlayTypeForMining | undefined>();
const editBoxOverlayNextId = Vue.ref<IEditBoxOverlayTypeForMining | undefined>();

const startingBidAmount = Vue.ref(0n);
const maximumBidAmount = Vue.ref(0n);
const startingBidAmountOverride = Vue.ref<bigint | null>(null);
const maximumBidAmountOverride = Vue.ref<bigint | null>(null);

function calculateElementWidth(element: HTMLElement | null) {
  if (!element) return;
  const elementWidth = element.getBoundingClientRect().width;
  return `${elementWidth}px`;
}

function openEditBoxOverlay(id: IEditBoxOverlayTypeForMining) {
  const selectedElem = selectElement(id);
  const selectedRect = selectedElem?.getBoundingClientRect() as DOMRect;
  const editBoxParentRect = editBoxParent.value?.getBoundingClientRect() as DOMRect;

  editBoxOverlayPosition.value = {
    top: selectedRect.top - editBoxParentRect.top - editBoxParentRect.height / 2,
    left: selectedRect.left - editBoxParentRect.left,
    width: selectedRect.width,
  };
  editBoxOverlayId.value = id;
  editBoxOverlayPreviousId.value = selectPreviousId(id);
  editBoxOverlayNextId.value = selectNextId(id);
  emit('toggleEditBoxOverlay', true);
}

function selectElement(id: IEditBoxOverlayTypeForMining): HTMLElement | null {
  return editBoxItems[id as keyof typeof editBoxItems].element.value as HTMLElement | null;
}

function selectPreviousId(id: IEditBoxOverlayTypeForMining): IEditBoxOverlayTypeForMining | undefined {
  const editBoxOverlayIds = Object.keys(editBoxItems) as IEditBoxOverlayTypeForMining[];

  let idIndex = editBoxOverlayIds.indexOf(id);

  while (true) {
    idIndex--;
    const nextId = editBoxOverlayIds[idIndex];
    if (nextId === undefined) {
      idIndex = editBoxOverlayIds.length;
      continue;
    }

    const item = editBoxItems[nextId];
    if (props.includeProjections || !item.isProjection) {
      return nextId as IEditBoxOverlayTypeForMining;
    }
  }
}

function selectNextId(id: IEditBoxOverlayTypeForMining): IEditBoxOverlayTypeForMining | undefined {
  const editBoxOverlayIds = Object.keys(editBoxItems) as IEditBoxOverlayTypeForMining[];

  let idIndex = editBoxOverlayIds.indexOf(id);

  while (true) {
    idIndex++;
    const nextId = editBoxOverlayIds[idIndex];
    if (nextId === undefined) {
      idIndex = -1;
      continue;
    }

    const item = editBoxItems[nextId];
    if (props.includeProjections || !item.isProjection) {
      return nextId as IEditBoxOverlayTypeForMining;
    }
  }
}

function closeEditBoxOverlay() {
  editBoxOverlayId.value = null;
  emit('toggleEditBoxOverlay', false);
}

function seatGoalText() {
  if (rules.value.seatGoalType === SeatGoalType.MaxPercent || rules.value.seatGoalType === SeatGoalType.MinPercent) {
    return `${rules.value.seatGoalPercent}% of all seats`;
  } else {
    return `${rules.value.seatGoalCount} seats`;
  }
}

function updateAPYs() {
  calculator.updateBiddingRules(rules.value);
  calculator.calculateBidAmounts();

  startingBidAmount.value = calculator.startingBidAmount;
  maximumBidAmount.value = calculator.maximumBidAmount;

  startingBidAmountOverride.value = calculator.startingBidAmountOverride;
  maximumBidAmountOverride.value = calculator.maximumBidAmountOverride;
  emit('update:data', calculator);
}

Vue.watch(
  rules,
  () => {
    updateAPYs();
  },
  { deep: true },
);
Vue.onMounted(() => updateAPYs());

defineExpose({
  closeEditBoxOverlay,
});
</script>
