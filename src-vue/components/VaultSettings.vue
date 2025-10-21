<template>
  <div ref="editBoxParent" class="relative flex grow flex-col px-5 text-lg">
    <EditBoxOverlay
      v-if="editBoxOverlayId"
      :id="editBoxOverlayId"
      :position="editBoxOverlayPosition"
      :previousId="editBoxOverlayPreviousId"
      :nextId="editBoxOverlayNextId"
      @close="closeEditBoxOverlay"
      @goTo="(id: any) => openEditBoxOverlay(id)" />
    <section class="my-2 flex h-1/2 grow flex-row">
      <div
        v-if="includeProjections"
        MainWrapperParent
        ref="personalBtcParent"
        :class="[includeProjections ? 'w-1/3' : 'w-1/2']">
        <Tooltip
          asChild
          :calculateWidth="() => calculateElementWidth(personalBtcParent)"
          side="top"
          content="You'll probably want to bootstrap your vault with some of your own bitcoin. The more bitcoin, the sooner you'll start earning returns.">
          <div
            MainWrapper
            @click="openEditBoxOverlay('personalBtc')"
            class="flex h-full w-full flex-col items-center justify-center px-8">
            <div StatHeader>Internal Bitcoin Locking</div>
            <div MainRule class="flex w-full flex-row items-center justify-center">
              <span>{{ rules.personalBtcPct }}%</span>
              <EditIcon EditIcon />
            </div>
            <div class="text-md font-mono text-gray-500/60">Your Bitcoin Commitment</div>
          </div>
        </Tooltip>
      </div>

      <div v-if="includeProjections" class="mx-2 w-[1px] bg-slate-300" />

      <div MainWrapperParent ref="securitizationRatioParent" :class="[includeProjections ? 'w-1/3' : 'w-1/2']">
        <Tooltip
          asChild
          :calculateWidth="() => calculateElementWidth(securitizationRatioParent)"
          side="top"
          content="This is the ratio of argons to bitcoins that you are committing. These argons guarantee the bitcoin holders that their assets are safe.">
          <div
            MainWrapper
            @click="openEditBoxOverlay('securitizationRatio')"
            class="flex h-full w-full flex-col items-center justify-center px-8">
            <div StatHeader>Securitization Ratio</div>
            <div MainRule class="flex w-full flex-row items-center justify-center">
              <span class="flex flex-row items-center justify-center space-x-2">
                <span>{{ numeral(rules.securitizationRatio).format('0.[00]') }}</span>
                <span class="font-light">to</span>
                <span>1</span>
              </span>
              <EditIcon EditIcon />
            </div>
            <div class="text-md font-mono text-gray-500/60">Collateral for Bitcoin</div>
          </div>
        </Tooltip>
      </div>

      <div class="mx-2 w-[1px] bg-slate-300" />

      <div MainWrapperParent ref="treasuryFundingParent" :class="[includeProjections ? 'w-1/3' : 'w-1/2']">
        <Tooltip
          asChild
          :calculateWidth="() => calculateElementWidth(treasuryFundingParent)"
          side="top"
          content="This is how much of the Treasury Pool you want to fund with your own capital. If you set to less than 100%, you're relying on the community to fund the rest.">
          <div
            MainWrapper
            @click="openEditBoxOverlay('treasuryFunding')"
            class="flex h-full w-full flex-col items-center justify-center px-8">
            <div StatHeader>Internal Treasury Funding</div>
            <div class="flex w-full flex-row items-center justify-center px-8 text-center font-mono">
              <div MainRule class="flex w-full flex-row items-center justify-center">
                <span>{{ numeral(calculator.calculatePercentOfTreasuryClaimed()).format('0.[00]') }}%</span>
                <EditIcon EditIcon />
              </div>
            </div>
            <div class="text-md font-mono text-gray-500/60">Versus External Funding</div>
          </div>
        </Tooltip>
      </div>
    </section>

    <div class="flex h-[1px] flex-row">
      <div :class="[includeProjections ? 'w-1/3' : 'w-1/2']" class="bg-slate-300"></div>
      <div class="mx-2 w-[1px]"></div>
      <div :class="[includeProjections ? 'w-1/3' : 'w-1/2']" class="bg-slate-300"></div>
      <div v-if="includeProjections" class="mx-2 w-[1px]"></div>
      <div v-if="includeProjections" class="w-1/3 bg-slate-300"></div>
    </div>

    <section class="my-2 flex h-1/2 grow flex-row">
      <div MainWrapperParent ref="btcLockingFeesParent" :class="[includeProjections ? 'w-1/3' : 'w-1/2']">
        <Tooltip
          asChild
          :calculateWidth="() => calculateElementWidth(btcLockingFeesParent)"
          side="top"
          :content="
            rules.personalBtcPct === 100 && !isEditingSettings
              ? 'You have committed 100% of the bitcoin needed to fill your vault, so no locking fees are possible.'
              : 'Each bitcoin transaction that locks in your vault must pay this flat fee for doing so.'
          ">
          <div
            MainWrapper
            @click="openEditBoxOverlay('btcLockingFees')"
            class="flex h-full w-full flex-col items-center justify-center px-8">
            <div StatHeader>Bitcoin Locking Fee</div>
            <div MainRule class="flex w-full flex-row items-center justify-center">
              <span v-if="rules.personalBtcPct === 100 && !isEditingSettings" class="opacity-40">N/A</span>
              <span v-else>
                {{ currency.symbol }}{{ microgonToMoneyNm(rules.btcFlatFee).format('0,0.00') }} +
                {{ numeral(rules.btcPctFee).format('0.[00]') }}%
              </span>
              <EditIcon EditIcon />
            </div>
            <div class="text-md font-mono text-gray-500/60">Per Transaction</div>
          </div>
        </Tooltip>
      </div>

      <div v-if="includeProjections" class="mx-2 w-[1px] bg-slate-300" />

      <div
        v-if="includeProjections"
        MainWrapperParent
        ref="projectedUtilizationParent"
        :class="[includeProjections ? 'w-1/3' : 'w-1/2']">
        <Tooltip
          asChild
          :calculateWidth="() => calculateElementWidth(projectedUtilizationParent)"
          side="top"
          content="This is the percentage of your capital you're willing to fund the treasury pool with.">
          <div
            MainWrapper
            @click="openEditBoxOverlay('projectedUtilization')"
            class="flex h-full w-full flex-col items-center justify-center px-4">
            <div StatHeader>Projected Utilization</div>
            <div class="flex w-full flex-row items-center justify-center px-8 text-center font-mono">
              <div MainRule class="flex w-5/12 flex-row items-center justify-center">
                <span>{{ rules.btcUtilizationPctMin }}%</span>
                <span class="text-md px-1.5 text-gray-500/60">to</span>
                <span>{{ rules.btcUtilizationPctMax }}%</span>
                <EditIcon EditIcon />
              </div>
              <span class="text-md w-2/12 text-gray-500/60">&nbsp;and&nbsp;</span>
              <div MainRule class="flex w-5/12 flex-row items-center justify-center">
                <span>{{ rules.poolUtilizationPctMin }}%</span>
                <span class="text-md px-1.5 text-gray-500/60">to</span>
                <span>{{ rules.poolUtilizationPctMax }}%</span>
                <EditIcon EditIcon />
              </div>
            </div>
            <div class="flex w-full flex-row items-center justify-center px-8 text-center font-mono whitespace-nowrap">
              <div class="text-md flex w-5/12 flex-row items-center justify-center px-1 text-gray-500/60">
                Bitcoin Usage
              </div>
              <span class="text-md w-2/12 text-gray-500/60">&nbsp;</span>
              <div class="text-md flex w-5/12 flex-row items-center justify-center text-gray-500/60">
                Treasury Usage
              </div>
            </div>
          </div>
        </Tooltip>
      </div>

      <div class="mx-2 w-[1px] bg-slate-300" />

      <div MainWrapperParent ref="poolRevenueShareParent" :class="[includeProjections ? 'w-1/3' : 'w-1/2']">
        <Tooltip
          asChild
          :calculateWidth="() => calculateElementWidth(poolRevenueShareParent)"
          side="top"
          :content="
            rules.capitalForTreasuryPct === 50
              ? 'Since you are personally funding 100% of the Treasury Pool, there is no external capital to share profits with.'
              : 'Outside funders can contribute to your Treasury Pool, and in return you agree to share a portion of your profits with them.'
          ">
          <div
            MainWrapper
            @click="openEditBoxOverlay('poolRevenueShare')"
            class="hover:bg-argon-100/20 flex h-full w-full cursor-pointer flex-col items-center justify-center">
            <div StatHeader>Treasury Revenue Split</div>
            <div MainRule class="flex w-full flex-row items-center justify-center">
              <span v-if="rules.capitalForTreasuryPct === 50" class="opacity-40">N/A</span>
              <span v-else>
                {{ numeral(100 - rules.profitSharingPct).format('0.[00]') }}%
                <span class="font-light opacity-40">/</span>
                {{ numeral(rules.profitSharingPct).format('0.[00]') }}%
              </span>
              <EditIcon EditIcon />
            </div>
            <div class="text-md font-mono text-gray-500/60">Internal vs External</div>
          </div>
        </Tooltip>
      </div>
    </section>
  </div>
</template>

<script setup lang="ts">
import * as Vue from 'vue';
import EditBoxOverlay, { type IEditBoxOverlayTypeForVaulting } from '../overlays/EditBoxOverlay.vue';
import EditIcon from '../assets/edit.svg?component';
import IVaultingRules from '../interfaces/IVaultingRules';
import { getVaultCalculator } from '../stores/mainchain';
import { useConfig } from '../stores/config';
import { useCurrency } from '../stores/currency';
import numeral, { createNumeralHelpers } from '../lib/numeral';
import Tooltip from '../components/Tooltip.vue';

const props = defineProps<{
  includeProjections?: boolean;
  isEditingSettings?: boolean;
}>();

const emit = defineEmits<{
  (e: 'toggleEditBoxOverlay', value: boolean): void;
}>();

const config = useConfig();
const currency = useCurrency();
const { microgonToMoneyNm } = createNumeralHelpers(currency);

const rules = Vue.computed(() => {
  return config.vaultingRules as IVaultingRules;
});

const calculator = getVaultCalculator();

const personalBtcParent = Vue.ref<HTMLElement | null>(null);
const securitizationRatioParent = Vue.ref<HTMLElement | null>(null);
const treasuryFundingParent = Vue.ref<HTMLElement | null>(null);
const btcLockingFeesParent = Vue.ref<HTMLElement | null>(null);
const projectedUtilizationParent = Vue.ref<HTMLElement | null>(null);
const poolRevenueShareParent = Vue.ref<HTMLElement | null>(null);

const editBoxItems: Record<
  IEditBoxOverlayTypeForVaulting,
  { isProjection: boolean; element: Vue.Ref<HTMLElement | null> }
> = {
  personalBtc: { isProjection: true, element: personalBtcParent },
  securitizationRatio: { isProjection: false, element: securitizationRatioParent },
  treasuryFunding: { isProjection: false, element: treasuryFundingParent },
  btcLockingFees: { isProjection: false, element: btcLockingFeesParent },
  projectedUtilization: { isProjection: true, element: projectedUtilizationParent },
  poolRevenueShare: { isProjection: false, element: poolRevenueShareParent },
};

const editBoxParent = Vue.ref<HTMLElement | null>(null);
const editBoxOverlayId = Vue.ref<IEditBoxOverlayTypeForVaulting | null>(null);
const editBoxOverlayPosition = Vue.ref<{ top?: number; left?: number; width?: number } | undefined>(undefined);
const editBoxOverlayPreviousId = Vue.ref<IEditBoxOverlayTypeForVaulting | undefined>();
const editBoxOverlayNextId = Vue.ref<IEditBoxOverlayTypeForVaulting | undefined>();

function openEditBoxOverlay(id: IEditBoxOverlayTypeForVaulting) {
  const selectedElem = selectElement(id);
  const selectedRect = selectedElem?.getBoundingClientRect() as DOMRect;
  const editBoxParentRect = editBoxParent.value?.getBoundingClientRect() as DOMRect;

  editBoxOverlayPosition.value = {
    top: selectedRect.top - editBoxParentRect.top,
    left: selectedRect.left - editBoxParentRect.left,
    width: selectedRect.width,
  };
  editBoxOverlayId.value = id;
  editBoxOverlayPreviousId.value = selectPreviousId(id);
  editBoxOverlayNextId.value = selectNextId(id);
  emit('toggleEditBoxOverlay', true);
}

function selectElement(id: IEditBoxOverlayTypeForVaulting): HTMLElement | null {
  return editBoxItems[id as keyof typeof editBoxItems].element.value as HTMLElement | null;
}

function selectPreviousId(id: IEditBoxOverlayTypeForVaulting): IEditBoxOverlayTypeForVaulting | undefined {
  const editBoxOverlayIds = Object.keys(editBoxItems) as IEditBoxOverlayTypeForVaulting[];

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
      return nextId as IEditBoxOverlayTypeForVaulting;
    } else {
      continue;
    }
  }
}

function selectNextId(id: IEditBoxOverlayTypeForVaulting): IEditBoxOverlayTypeForVaulting | undefined {
  const editBoxOverlayIds = Object.keys(editBoxItems) as IEditBoxOverlayTypeForVaulting[];

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
      return nextId as IEditBoxOverlayTypeForVaulting;
    } else {
      continue;
    }
  }
}

function closeEditBoxOverlay() {
  editBoxOverlayId.value = null;
  emit('toggleEditBoxOverlay', false);
}

function calculateElementWidth(element: HTMLElement | null) {
  if (!element) return;
  const elementWidth = element.getBoundingClientRect().width;
  return `${elementWidth}px`;
}

defineExpose({
  closeEditBoxOverlay,
});
</script>
