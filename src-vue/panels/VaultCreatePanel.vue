<!-- prettier-ignore -->
<template>
  <DialogRoot class="absolute inset-0 z-10" :open="true">
    <DialogPortal>
      <DialogOverlay asChild>
        <BgOverlay @close="cancelPanel" />
      </DialogOverlay>

      <DialogContent @escapeKeyDown="cancelPanel" :aria-describedby="undefined">
        <VaultTour v-if="currentTourStep" @close="closeTour" @changeStep="currentTourStep = $event" :getPositionCheck="getTourPositionCheck" />
        <div
          class="VaultCreatePanel absolute top-[40px] left-3 right-3 bottom-3 flex flex-col rounded-md border border-black/30 inner-input-shadow bg-argon-menu-bg text-left z-20 transition-all focus:outline-none"
          style="box-shadow: 0 -1px 2px 0 rgba(0, 0, 0, 0.1), inset 0 2px 0 rgba(255, 255, 255, 1)">
          <BgOverlay v-if="hasEditBoxOverlay" @close="closeEditBoxOverlay" :showWindowControls="false" rounded="md" class="z-100" />
          <div v-if="isSuggestingTour" class="absolute inset-0 bg-black/20 z-20 rounded-md"></div>
          <div class="flex flex-col h-full w-full">
            <h2
              class="relative text-3xl font-bold text-left border-b border-slate-300 pt-5 pb-4 pl-3 mx-4 text-[#672D73]"
              style="box-shadow: 0 1px 4px rgba(0, 0, 0, 0.1)"
            >
              <DialogTitle as="div" class="relative z-10">Configure Your Stabilization Vault</DialogTitle>
              <div @click="cancelPanel" class="absolute top-[22px] right-0 z-10 flex items-center justify-center text-sm/6 font-semibold cursor-pointer border rounded-md w-[30px] h-[30px] focus:outline-none border-slate-400/60 hover:border-slate-500/70 hover:bg-[#D6D9DF]">
                <XMarkIcon class="w-5 h-5 text-[#B74CBA] stroke-4" />
              </div>
            </h2>

            <div v-if="isLoaded" class="flex flex-col grow relative w-full">
              <DialogDescription class="text-gray-600 font-light py-6 pl-10 pr-[6%]">
                Vaults are special holding mechanisms that stabilize the Argon stablecoin and provide liquidity to the broader network.
                You can earn revenue by creating and managing these vaults. Use the screen below to configure your vault.
                <PopoverRoot :open="isSuggestingTour">
                  <PopoverTrigger asChild>
                    <div :class="[isSuggestingTour ? '' : 'hover:underline']" class="inline-block relative cursor-pointer text-argon-600/80 hover:text-argon-800 decoration-dashed underline-offset-4 z-30" @click="startTour">
                      <span class="relative z-10 font-semibold">Take our quick vaulting tour</span>
                      <div v-if="isSuggestingTour" class="border rounded-full border-argon-600/30 bg-white/50 absolute -top-0 -left-2 -right-2 -bottom-0"></div>
                    </div>
                  </PopoverTrigger>
                  <PopoverPortal>
                    <PopoverContent @escapeKeyDown="stopSuggestingTour" side="bottom" class="rounded-lg p-5 -translate-y-1 w-[400px] bg-white shadow-sm border border-slate-800/30 z-1000">
                      <p class="text-gray-800 font-light">We recommend first-time vaulters start with a brief tour of how to use this panel.</p>
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
                      <tooltip side="top" content="The amount you're willing to invest in your vault">
                        Capital {{ config.isVaultActivated ? 'Committed' : 'to Commit' }}
                      </tooltip>
                    </header>
                    <div class="grow flex flex-col mt-3 border-t border-slate-500/30 border-dashed w-10/12 mx-auto">
                      <div class="text-gray-500/60 border-b border-slate-500/30 border-dashed py-3 w-full">
                        You are <tooltip content="We'll show you how to create it in the next step">creating a new vault</tooltip> with a
                        <tooltip content="This includes everything, even transaction fees">total capital need</tooltip> of
                      </div>
                      <div class="flex flex-row items-center justify-center grow relative h-26 font-bold font-mono text-argon-600">
                        <InputArgon v-model="rules.baseMicrogonCommitment" :min="1_000_000_000n" :minDecimals="0" class="focus:outline-none" />
                        <CapitalOverlay align="end">
                          <div class="relative ml-1 w-10 h-10">
                            <PiechartIcon PiechartIcon class="absolute top-0 left-0 w-10 h-10 text-gray-300 hover:!text-argon-600 pointer-events-none" />
                          </div>
                        </CapitalOverlay>
                      </div>
                      <div class="text-gray-500/60 border-t border-slate-500/30 border-dashed py-5 w-full mx-auto">
                        <tooltip content="The amount shown is what you're are committing">This capital</tooltip> will allow you to
                        <tooltip content="The total amount of bitcoin your vault can lock">secure {{ numeral(btcSpaceAvailable).format('0,0.[00000000]') }} in BTC</tooltip><br/>
                        with a
                        <tooltip content="This is funded by revenue from mining auctions">treasury pool</tooltip> investment <tooltip content="You are not required to participate in the treasury">options</tooltip> of
                        <tooltip content="This can be invested by yourself or third parties">{{ microgonToArgonNm(poolSpace).format('0,0.[00]') }} argons</tooltip>.
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
                        Your <tooltip content="This is not a guarantee, simply an estimate">vault is expected</tooltip>
                        to earn {{ currency.symbol }}{{ microgonToMoneyNm(averageEpochEarnings).format('0,0.00') }}
                        <tooltip content="An epoch is equivalent to ten days">per epoch</tooltip> at an <tooltip content="Annual Percent Yield">APY</tooltip> of
                      </div>
                      <div class="flex flex-row items-center justify-center grow relative h-26 text-6xl font-bold font-mono text-argon-600">
                        <span>~{{ numeral(averageAPY).formatIfElseCapped('>=100', '0,0', '0,0.00', 999_999) }}%</span>
                        <ReturnsOverlay align="start">
                          <PiechartIcon PiechartIcon class="ml-4 w-10 h-10 text-gray-300 hover:!text-argon-600" />
                        </ReturnsOverlay>
                      </div>
                      <div class="text-gray-500/60 border-t border-slate-500/30 border-dashed py-5 w-full">
                      This <tooltip content="It's more of a blended approximation">represents an average</tooltip> of all your estimated vaulting<br/>
                      returns
                      <template v-if="vaultLowUtilizationAPY < 999_999 || vaultHighUtilizationAPY < 999_999">
                        which range between
                        <tooltip content="This is the minimum APY we expect">{{ numeral(vaultLowUtilizationAPY).formatIfElseCapped('>=100', '0,0', '0,0.[00]', 999_999) }}%</tooltip>
                        and <tooltip content="This is the maximum APY we expect">{{ numeral(vaultHighUtilizationAPY).formatIfElseCapped('>=100', '0,0', '0,0.[00]', 999_999) }}%</tooltip> APY.
                      </template>
                      <template v-else>
                        at the <tooltip content="Customize your projected utilization ranges below">full range of projected utilization levels</tooltip>.
                      </template>
                    </div>
                    </div>
                  </div>
                </div>
              </section>

              <VaultSettings ref="vaultSettings" @toggleEditBoxOverlay="(x: boolean) => hasEditBoxOverlay = x" :includeProjections="true" />
            </div>
            <div v-else class="grow flex items-center justify-center">Loading...</div>

            <div class="flex flex-row justify-end border-t border-slate-300 mx-4 py-4 space-x-4 rounded-b-lg">
              <div class="flex flex-row space-x-4 justify-center items-center">
                <ExistingNetworkVaultsOverlayButton class=" mr-10" />
                <button @click="cancelPanel" class="border border-argon-button/50 text-xl font-bold text-gray-500 px-7 py-1 rounded-md cursor-pointer">
                  <span>Cancel</span>
                </button>
                <Tooltip asChild :calculateWidth="() => calculateElementWidth(saveButtonElement)" side="top" content="Clicking this button does not commit you to anything.">
                  <button @click="saveRules" ref="saveButtonElement" class="bg-argon-button text-xl font-bold text-white px-7 py-1 rounded-md cursor-pointer">
                    <span v-if="!isSaving">{{ isBrandNew ? 'Initialize' : 'Update' }} Rules</span>
                    <span v-else>{{ isBrandNew ? 'Initializing' : 'Updating' }} Rules...</span>
                  </button>
                </Tooltip>
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
import { getVaultCalculator } from '../stores/mainchain.ts';
import { useCurrency } from '../stores/currency.ts';
import numeral, { createNumeralHelpers } from '../lib/numeral.ts';
import BgOverlay from '../components/BgOverlay.vue';
import { XMarkIcon } from '@heroicons/vue/24/outline';
import { JsonExt } from '@argonprotocol/apps-core';
import IVaultingRules from '../interfaces/IVaultingRules.ts';
import InputArgon from '../components/InputArgon.vue';
import ExistingNetworkVaultsOverlayButton from '../overlays/ExistingNetworkVaultsOverlayButton.vue';
import CapitalOverlay from '../overlays/vault/VaultCapital.vue';
import ReturnsOverlay from '../overlays/vault/VaultReturns.vue';
import VaultTour from './vault-create-tour/Base.vue';
import PiechartIcon from '../assets/piechart.svg?component';
import Tooltip from '../components/Tooltip.vue';
import { ITourPos } from '../stores/tour.ts';
import { useController } from '../stores/controller.ts';
import VaultSettings from '../components/VaultSettings.vue';

const config = useConfig();
const currency = useCurrency();
const controller = useController();
const { microgonToMoneyNm, microgonToArgonNm } = createNumeralHelpers(currency);
const emit = defineEmits<{
  (e: 'close'): void;
}>();
let previousVaultingRules: string | null = null;

const rules = Vue.computed(() => {
  return config.vaultingRules as IVaultingRules;
});

const calculator = getVaultCalculator();

const isBrandNew = Vue.ref(true);
const isSuggestingTour = Vue.ref(false);
const currentTourStep = Vue.ref<number>(0);
const isLoaded = Vue.ref(false);
const isSaving = Vue.ref(false);
const hasEditBoxOverlay = Vue.ref(false);

const capitalToCommitElement = Vue.ref<HTMLElement | null>(null);
const returnOnCapitalElement = Vue.ref<HTMLElement | null>(null);
const vaultSettings = Vue.ref<typeof VaultSettings | null>(null);
const saveButtonElement = Vue.ref<HTMLElement | null>(null);

const averageAPY = Vue.ref(0);
const averageEpochEarnings = Vue.ref(0n);

const vaultLowUtilizationAPY = Vue.ref(0);
const vaultHighUtilizationAPY = Vue.ref(0);
const externalLowUtilizationAPY = Vue.ref(0);
const externalHighUtilizationAPY = Vue.ref(0);

const btcSpaceAvailable = Vue.ref(0);
const poolSpace = Vue.ref(0n);

const hasExternalPoolCapitalLow = Vue.ref(false);
const hasExternalPoolCapitalHigh = Vue.ref(false);

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
    const rect = vaultSettings.value?.getBoundingClientRect() as DOMRect;
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

function cancelPanel() {
  if (hasEditBoxOverlay.value) return;

  if (previousVaultingRules) {
    config.vaultingRules = JsonExt.parse<IVaultingRules>(previousVaultingRules);
  }
  emit('close');
}

function closeEditBoxOverlay() {
  vaultSettings.value?.closeEditBoxOverlay();
}

async function saveRules() {
  isSaving.value = true;

  if (rules.value) {
    await config.saveVaultingRules();
  }

  isSaving.value = false;
  emit('close');
}

function updateAPYs() {
  const btcSpaceInMicrogons = calculator.calculateBtcSpaceInMicrogons();
  btcSpaceAvailable.value = currency.microgonToBtc(btcSpaceInMicrogons);

  vaultLowUtilizationAPY.value = calculator.calculateInternalAPY('Low', 'Low');
  vaultHighUtilizationAPY.value = calculator.calculateInternalAPY('High', 'High');
  externalLowUtilizationAPY.value = calculator.calculateExternalAPY('Low', 'Low');
  externalHighUtilizationAPY.value = calculator.calculateExternalAPY('High', 'High');

  hasExternalPoolCapitalLow.value = calculator.calculateExternalPoolCapital('Low', 'Low') > 0;
  hasExternalPoolCapitalHigh.value = calculator.calculateExternalPoolCapital('High', 'High') > 0;

  averageAPY.value = (vaultLowUtilizationAPY.value + vaultHighUtilizationAPY.value) / 2;

  const highVaultRevenue = calculator.calculateInternalRevenue('High', 'High');
  const lowVaultRevenue = calculator.calculateInternalRevenue('Low', 'Low');
  averageEpochEarnings.value = (highVaultRevenue + lowVaultRevenue) / 2n;

  poolSpace.value = calculator.calculateTotalPoolSpace('High');
}

function startTour() {
  currentTourStep.value = 1;
  isSuggestingTour.value = false;
}

function closeTour() {
  currentTourStep.value = 0;
}

function stopSuggestingTour() {
  controller.stopSuggestingVaultTour = true;
  isSuggestingTour.value = false;
}

Vue.watch(rules, () => updateAPYs(), { deep: true });

Vue.onMounted(async () => {
  isLoaded.value = false;
  isBrandNew.value = !config.hasSavedVaultingRules;
  isSuggestingTour.value = isBrandNew.value && !controller.stopSuggestingVaultTour;

  await calculator.load(rules.value);
  previousVaultingRules = JsonExt.stringify(config.vaultingRules);
  updateAPYs();

  isLoaded.value = true;
});
</script>

<style>
@reference "../main.css";

.VaultCreatePanel {
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

    &:hover {
      [tooltip] {
        @apply text-argon-600;
      }
      [PiechartIcon] {
        animation: fadeToArgon 2s ease-in-out 1;
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
        @apply inline-block;
      }
    }

    [StatHeader] {
      @apply pt-1;
    }

    [EditIcon] {
      @apply text-argon-600/50 relative z-10 -mt-0.5 ml-2 hidden h-4.5 min-h-4.5 w-4.5 min-w-4.5;
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

  @keyframes fadeToArgon {
    0% {
      color: rgb(209 213 219); /* text-gray-300 */
    }
    10% {
      color: oklch(0.48 0.24 320); /* text-argon-600 */
    }
    100% {
      color: rgb(209 213 219); /* text-gray-300 */
    }
  }
}
</style>
