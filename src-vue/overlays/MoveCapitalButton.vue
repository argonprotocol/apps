<template>
  <PopoverRoot v-model:open="isOpen">
    <PopoverTrigger>
      <button
        :class="
          twMerge('border-argon-600/50 text-argon-600/80 cursor-pointer rounded border px-3 font-bold', props.class)
        ">
        Move
      </button>
    </PopoverTrigger>
    <PopoverPortal>
      <PopoverContent
        :sideOffset="-5"
        class="border-argon-600/30 z-50 rounded-md border bg-white px-6 py-4 text-sm font-medium text-gray-700 shadow-2xl">
        <div class="flex flex-col justify-between">
          <p class="mb-4">Choose how much you want to move and where you want to move it.</p>

          <div class="mt-3 flex flex-row items-start space-x-2">
            <div class="grow">
              <div>Move From</div>
              <div class="rounded-md border border-dashed border-slate-900/70 px-2 py-1 font-mono">
                {{ moveFromTitle[moveFrom] }}
              </div>
            </div>
            <div class="grow">
              <div>Amount</div>
              <InputArgon :min="0n" v-model="amountToMove" class="w-full" />
            </div>
          </div>

          <div class="mt-3">Move To</div>
          <InputMenu
            v-model="moveTo"
            :options="[
              { name: `Vaulting Account`, value: 'Vaulting' },
              { name: `Holding Account`, value: 'Holding' },
              { name: `External Address`, value: 'External' },
            ]"
            :selectFirst="true"
            class="w-full" />
          <input
            v-if="moveTo === MoveTo.External"
            type="text"
            class="mt-3 w-full rounded-md border border-slate-900/40 px-2 py-1.5 font-mono"
            placeholder="Address of Account" />
        </div>

        <div class="mt-5 flex flex-row items-center justify-end space-x-2 border-t border-slate-600/30 pt-3">
          <button @click="cancel" class="rounded border border-slate-600/60 px-5 py-1">Cancel</button>
          <button
            class="bg-argon-600 border-argon-700 hover:bg-argon-700 inner-button-shadow rounded border px-7 py-1 font-bold text-white">
            Send
          </button>
        </div>
        <PopoverArrow :width="26" :height="12" class="stroke-argon-600/30 -mt-px fill-white" />
      </PopoverContent>
    </PopoverPortal>
  </PopoverRoot>
</template>

<script lang="ts">
export enum MoveTo {
  Mining = 'Mining',
  Vaulting = 'Vaulting',
  Holding = 'Holding',
  External = 'External',
}
export enum MoveFrom {
  Holding = 'Holding',
  MiningReserveArgon = 'MiningReserveArgon',
  MiningReserveArgonot = 'MiningReserveArgonot',
  VaultingMintedArgon = 'VaultingMintedArgon',
  VaultingSecurityUnused = 'VaultingSecurityUnused',
  VaultingTreasuryUnused = 'VaultingTreasuryUnused',
}

const moveFromTitle = {
  [MoveFrom.Holding]: 'Holding Account',
  [MoveFrom.MiningReserveArgon]: 'Mining / ARGN Available',
  [MoveFrom.MiningReserveArgonot]: 'Mining / ARGNOT Available',
  [MoveFrom.VaultingMintedArgon]: 'Vaulting / ARGN Minted',
  [MoveFrom.VaultingSecurityUnused]: 'Vaulting / ARGN Security',
  [MoveFrom.VaultingTreasuryUnused]: 'Vaulting / ARGN Treasury',
};
</script>

<script setup lang="ts">
import { twMerge } from 'tailwind-merge';
import { PopoverArrow, PopoverContent, PopoverPortal, PopoverRoot, PopoverTrigger } from 'reka-ui';
import InputMenu from '../components/InputMenu.vue';
import * as Vue from 'vue';
import InputArgon from '../components/InputArgon.vue';

const props = withDefaults(
  defineProps<{
    class?: string;
    moveFrom?: MoveFrom;
    moveTo?: MoveTo;
  }>(),
  {
    moveFrom: MoveFrom.Holding,
  },
);

const isOpen = Vue.ref(false);

const amountToMove = Vue.ref(0n);

const moveFrom = Vue.ref(props.moveFrom);
const moveTo = Vue.ref(props.moveTo);

function cancel() {
  isOpen.value = false;
}
</script>
