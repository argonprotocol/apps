<template>
  <ul>
    <li class="relative flex flex-row gap-x-2 border-slate-400/50 py-2">
      <ArgonIcon class="h-6 w-6" />
      <div class="grow">{{ microgonToArgonNm(props.microgons).format('0,0.[00]') }} ARGN</div>
      <div>{{ currency.symbol }}{{ microgonToMoneyNm(props.microgons).format('0,0.00') }}</div>
      <CrosschainMoveButton
        v-if="props.moveDirection"
        :moveToken="MoveToken.ARGN"
        :availableAmount="props.microgons"
        :direction="props.moveDirection"
        :networkName="props.networkName"
        :feeTokenSymbol="props.feeTokenSymbol"
        @openTransferOverlay="openTransferOverlay(MoveToken.ARGN, props.microgons)"
      />
      <MoveCapitalButton
        v-else-if="props.moveFrom !== undefined && props.moveTo !== undefined"
        :moveFrom="props.moveFrom"
        :moveTo="props.moveTo"
        :moveToken="MoveToken.ARGN"
        side="top"
        class="absolute top-1/2 left-[calc(100%+40px)] z-30 -translate-x-1/2 -translate-y-1/2 bg-white py-1 text-xs"
      />
    </li>
    <li class="relative flex flex-row gap-x-2 border-t border-slate-400/50 py-2">
      <ArgonotIcon class="h-6 w-6" />
      <div class="grow">{{ micronotToArgonotNm(props.micronots).format('0,0.[00]') }} ARGNOT</div>
      <div>{{ currency.symbol }}{{ micronotToMoneyNm(props.micronots).format('0,0.00') }}</div>
      <CrosschainMoveButton
        v-if="props.moveDirection"
        :moveToken="MoveToken.ARGNOT"
        :availableAmount="props.micronots"
        :direction="props.moveDirection"
        :networkName="props.networkName"
        :feeTokenSymbol="props.feeTokenSymbol"
        @openTransferOverlay="openTransferOverlay(MoveToken.ARGNOT, props.micronots)"
      />
      <MoveCapitalButton
        v-else-if="props.moveFrom !== undefined && props.moveTo !== undefined"
        :moveFrom="props.moveFrom"
        :moveTo="props.moveTo"
        :moveToken="MoveToken.ARGNOT"
        side="top"
        class="absolute top-1/2 left-[calc(100%+40px)] z-30 -translate-x-1/2 -translate-y-1/2 bg-white py-1 text-xs"
      />
    </li>
  </ul>
</template>
<script setup lang="ts">
import { MoveToken } from '@argonprotocol/apps-core';
import type { MoveFrom, MoveTo } from '@argonprotocol/apps-core';
import ArgonotIcon from '../../assets/resources/argonot.svg';
import ArgonIcon from '../../assets/resources/argon.svg';
import { createNumeralHelpers } from '../../lib/numeral.ts';
import { getCurrency } from '../../stores/currency.ts';
import CrosschainMoveButton from './CrosschainMoveButton.vue';
import MoveCapitalButton from '../../overlays/MoveCapitalButton.vue';

const currency = getCurrency();

const { microgonToMoneyNm, microgonToArgonNm, micronotToMoneyNm, micronotToArgonotNm } = createNumeralHelpers(currency);

const props = withDefaults(
  defineProps<{
    microgons?: bigint;
    micronots?: bigint;
    moveDirection?: 'transferToArgon' | 'transferOutOfArgon';
    moveFrom?: MoveFrom;
    moveTo?: MoveTo;
    networkName?: string;
    feeTokenSymbol?: string;
  }>(),
  {
    microgons: () => 0n,
    micronots: () => 0n,
    networkName: '',
    feeTokenSymbol: '',
  },
);

const emit = defineEmits<{
  (
    e: 'openTransferOverlay',
    value: {
      moveToken: MoveToken.ARGN | MoveToken.ARGNOT;
      availableAmount: bigint;
    },
  ): void;
}>();

function openTransferOverlay(moveToken: MoveToken.ARGN | MoveToken.ARGNOT, availableAmount: bigint) {
  if (!props.moveDirection) {
    return;
  }

  emit('openTransferOverlay', { moveToken, availableAmount });
}
</script>
