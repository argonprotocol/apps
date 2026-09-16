<template>
  <ul>
    <li
      class="via-argon-100/20 relative flex flex-row gap-x-2 border-t border-slate-400/50 from-transparent to-transparent py-2 hover:bg-linear-to-r"
      :class="[props.indentLeft ? 'pl-10' : '', props.indentRight ? 'pr-10' : '']"
    >
      <ArgonIcon class="h-6 w-6" />
      <div class="grow">{{ microgonToArgonNm(props.microgons).format('0,0.[00]') }} ARGN</div>
      <div>{{ currency.symbol }}{{ microgonToMoneyNm(props.microgons).format('0,0.00') }}</div>
      <CrosschainMoveButton
        v-if="props.moveDirection"
        :moveToken="MoveToken.ARGN"
        :availableAmount="moveMicrogons"
        :direction="props.moveDirection"
        :networkName="props.networkName"
        :feeTokenSymbol="props.feeTokenSymbol"
        :placement="props.movePlacement"
        @openTransferOverlay="openTransferOverlay(MoveToken.ARGN, moveMicrogons)"
      />
    </li>
    <li
      class="via-argon-100/20 relative flex flex-row gap-x-2 border-y border-slate-400/50 from-transparent to-transparent py-2 hover:bg-linear-to-r"
      :class="[props.indentLeft ? 'pl-10' : '', props.indentRight ? 'pr-10' : '']"
    >
      <ArgonotIcon class="h-6 w-6" />
      <div class="grow">{{ micronotToArgonotNm(props.micronots).format('0,0.[00]') }} ARGNOT</div>
      <div>{{ currency.symbol }}{{ micronotToMoneyNm(props.micronots).format('0,0.00') }}</div>
      <CrosschainMoveButton
        v-if="props.moveDirection"
        :moveToken="MoveToken.ARGNOT"
        :availableAmount="moveMicronots"
        :direction="props.moveDirection"
        :networkName="props.networkName"
        :feeTokenSymbol="props.feeTokenSymbol"
        :placement="props.movePlacement"
        @openTransferOverlay="openTransferOverlay(MoveToken.ARGNOT, moveMicronots)"
      />
    </li>
    <li
      v-if="props.showBitcoin"
      class="via-argon-100/20 relative flex flex-row gap-x-2 border-b border-slate-400/50 from-transparent to-transparent py-2 hover:bg-linear-to-r"
      :class="[props.indentLeft ? 'pl-10' : '', props.indentRight ? 'pr-10' : '']"
    >
      <BitcoinIcon class="h-6 w-6" />
      <div class="flex grow items-center gap-1">
        <span>{{ satToBtcNm(props.satoshis).format('0,0.[00000000]') }} BTC</span>
        <slot name="bitcoinAction" />
      </div>
      <div>{{ currency.symbol }}{{ satToMoneyNm(props.satoshis).format('0,0.00') }}</div>
    </li>
    <slot name="bitcoinDetails" />
    <li v-if="props.microgonsToMint" class="relative flex flex-row gap-x-2 border-b border-slate-400/50 py-2">
      <ArgonIcon class="h-6 w-6" />
      <div class="grow">{{ microgonToArgonNm(props.microgonsToMint).format('0,0.[00]') }} ARGN waiting to mint</div>
      <div>{{ currency.symbol }}{{ microgonToMoneyNm(props.microgonsToMint).format('0,0.00') }}</div>
    </li>
  </ul>
</template>
<script setup lang="ts">
import { computed } from 'vue';
import { MoveToken } from '@argonprotocol/apps-core';
import ArgonotIcon from '../../assets/resources/argonot.svg';
import ArgonIcon from '../../assets/resources/argon.svg';
import BitcoinIcon from '../../assets/wallets/tokens/bitcoin.svg';
import { createNumeralHelpers } from '../../lib/numeral.ts';
import { getCurrency } from '../../stores/currency.ts';
import CrosschainMoveButton from './CrosschainMoveButton.vue';

const currency = getCurrency();

const { microgonToMoneyNm, microgonToArgonNm, micronotToMoneyNm, micronotToArgonotNm, satToBtcNm, satToMoneyNm } =
  createNumeralHelpers(currency);

const props = withDefaults(
  defineProps<{
    microgonsToMint?: bigint;
    microgons?: bigint;
    micronots?: bigint;
    satoshis?: bigint;
    moveMicrogons?: bigint;
    moveMicronots?: bigint;
    movePlacement?: 'left' | 'right';
    indentLeft?: boolean;
    indentRight?: boolean;
    moveDirection?: 'transferToArgon' | 'transferOutOfArgon';
    networkName?: string;
    feeTokenSymbol?: string;
    showBitcoin?: boolean;
  }>(),
  {
    microgonsToMint: () => 0n,
    microgons: () => 0n,
    micronots: () => 0n,
    satoshis: () => 0n,
    networkName: '',
    feeTokenSymbol: '',
    movePlacement: 'right',
  },
);

const moveMicrogons = computed(() => props.moveMicrogons ?? props.microgons);
const moveMicronots = computed(() => props.moveMicronots ?? props.micronots);

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
