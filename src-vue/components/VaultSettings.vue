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
    />
    <section class="my-2 flex grow flex-row">
      <div v-if="isEditingSettings" MainWrapperParent ref="securitizationParent" class="w-1/2">
        <Tooltip
          asChild
          :calculateWidth="() => calculateElementWidth(securitizationParent)"
          side="top"
          content="Argons and Argonots held as collateral for your vault. Reward commitments and Bitcoin locks can delay withdrawals."
        >
          <div
            MainWrapper
            @click="emit('openSecuritization')"
            class="flex h-full w-full flex-col items-center justify-center px-8"
          >
            <div StatHeader>Securitization</div>
            <div MainRule class="flex w-full flex-row items-center justify-center">
              <span class="flex flex-row items-center justify-center space-x-2 whitespace-nowrap">
                <span>
                  {{ microgonToArgonNm(myVault.createdVault?.securitization ?? 0n).format('0,0.[00]') }}
                  ARGN
                </span>
                <span class="font-light opacity-40">·</span>
                <span>
                  {{ micronotToArgonotNm(myVault.data.argonotCommitment.heldMicronots).format('0,0.[00]') }}
                  ARGNOT
                </span>
              </span>
              <EditIcon EditIcon />
            </div>
            <div class="text-md font-mono text-gray-500/60">Collateral for Bitcoin</div>
          </div>
        </Tooltip>
      </div>
      <div v-if="isEditingSettings" class="mx-2 w-[1px] bg-slate-300" />
      <div MainWrapperParent ref="btcLockingFeesParent" class="w-1/2">
        <Tooltip
          asChild
          :calculateWidth="() => calculateElementWidth(btcLockingFeesParent)"
          side="top"
          content="Each bitcoin transaction that locks in your vault must pay this flat fee for doing so."
        >
          <div
            MainWrapper
            @click="openEditBoxOverlay('btcLockingFees')"
            class="flex h-full w-full flex-col items-center justify-center px-8"
          >
            <div StatHeader>Bitcoin Locking Fee</div>
            <div MainRule class="flex w-full flex-row items-center justify-center">
              <span>
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

      <div v-if="includeProjections" MainWrapperParent ref="projectedUtilizationParent" class="w-1/2">
        <Tooltip
          asChild
          :calculateWidth="() => calculateElementWidth(projectedUtilizationParent)"
          side="top"
          content="You can play with scenarios of how utilized your Bitcoin and Treasury pools will be to see how it impacts your returns."
        >
          <div
            MainWrapper
            @click="openEditBoxOverlay('projectedUtilization')"
            class="flex h-full w-full flex-col items-center justify-center px-4"
          >
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
    </section>
  </div>
</template>

<script setup lang="ts">
import * as Vue from 'vue';
import EditBoxOverlay, { type IEditBoxOverlayTypeForVaulting } from '../overlays/EditBoxOverlay.vue';
import EditIcon from '../assets/edit.svg?component';
import type { IVaultingRules } from '../interfaces/IVaultingRules.ts';
import { getMyVault } from '../stores/vaults.ts';
import { getConfig } from '../stores/config';
import { getCurrency } from '../stores/currency';
import numeral, { createNumeralHelpers } from '../lib/numeral';
import Tooltip from '../components/Tooltip.vue';

const props = defineProps<{
  includeProjections?: boolean;
  isEditingSettings?: boolean;
}>();

const emit = defineEmits<{
  (e: 'toggleEditBoxOverlay', value: boolean): void;
  (e: 'openSecuritization'): void;
}>();

const config = getConfig();
const myVault = getMyVault();
const currency = getCurrency();
const { microgonToMoneyNm, microgonToArgonNm, micronotToArgonotNm } = createNumeralHelpers(currency);

const rules = Vue.computed(() => {
  return config.vaultingRules as IVaultingRules;
});

const btcLockingFeesParent = Vue.ref<HTMLElement | null>(null);
const projectedUtilizationParent = Vue.ref<HTMLElement | null>(null);
const securitizationParent = Vue.ref<HTMLElement | null>(null);

const editBoxItems: Record<
  IEditBoxOverlayTypeForVaulting,
  { isProjection: boolean; element: Vue.Ref<HTMLElement | null> }
> = {
  btcLockingFees: { isProjection: false, element: btcLockingFeesParent },
  projectedUtilization: { isProjection: true, element: projectedUtilizationParent },
};

const editBoxParent = Vue.ref<HTMLElement | null>(null);
const editBoxOverlayId = Vue.ref<IEditBoxOverlayTypeForVaulting | null>(null);
const editBoxOverlayPosition = Vue.ref<{ top?: number; left?: number; width?: number } | undefined>(undefined);
const editBoxOverlayPreviousId = Vue.ref<IEditBoxOverlayTypeForVaulting | undefined>();
const editBoxOverlayNextId = Vue.ref<IEditBoxOverlayTypeForVaulting | undefined>();

function openEditBoxOverlay(id: IEditBoxOverlayTypeForVaulting) {
  const selectedElem = editBoxItems[id].element.value;
  const selectedRect = selectedElem?.getBoundingClientRect() as DOMRect;
  const editBoxParentRect = editBoxParent.value?.getBoundingClientRect() as DOMRect;

  editBoxOverlayPosition.value = {
    top: selectedRect.top - editBoxParentRect.top,
    left: selectedRect.left - editBoxParentRect.left,
    width: selectedRect.width,
  };
  editBoxOverlayId.value = id;
  const editBoxIds = (Object.keys(editBoxItems) as IEditBoxOverlayTypeForVaulting[]).filter(
    editId => props.includeProjections || !editBoxItems[editId].isProjection,
  );
  const idIndex = editBoxIds.indexOf(id);
  editBoxOverlayPreviousId.value =
    editBoxIds.length > 1 ? editBoxIds[(idIndex + editBoxIds.length - 1) % editBoxIds.length] : undefined;
  editBoxOverlayNextId.value = editBoxIds.length > 1 ? editBoxIds[(idIndex + 1) % editBoxIds.length] : undefined;
  emit('toggleEditBoxOverlay', true);
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
  $el: editBoxParent,
});
</script>
