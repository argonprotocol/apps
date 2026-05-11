<template>
  <ul :class="minimizedLines ? '' : 'border-b border-slate-400/50'">
    <li
      :class="[minimizedLines ? '' : 'border-t', showArrows ? 'pr-14' : '']"
      class="relative flex flex-row gap-x-2 border-slate-400/50 py-2"
    >
      <ArgonIcon class="h-6 w-6" />
      <div class="grow">{{ microgonToArgonNm(props.microgons).format('0,0.[00]') }} ARGN</div>
      <div>{{ currency.symbol }}{{ microgonToMoneyNm(props.microgons).format('0,0.00') }}</div>
      <EthereumMoveButton
        v-if="showArrows"
        :moveToken="MoveToken.ARGN"
        :availableAmount="props.microgons"
        :targetWalletType="props.targetWalletType"
        :open="openMoveToken === MoveToken.ARGN"
        @update:open="value => onMovePopoverOpenChange(MoveToken.ARGN, value)"
      />
    </li>
    <li :class="[showArrows ? 'pr-14' : '']" class="relative flex flex-row gap-x-2 border-t border-slate-400/50 py-2">
      <ArgonotIcon class="h-6 w-6" />
      <div class="grow">{{ micronotToArgonotNm(props.micronots).format('0,0.[00]') }} ARGNOT</div>
      <div>{{ currency.symbol }}{{ micronotToMoneyNm(props.micronots).format('0,0.00') }}</div>
      <EthereumMoveButton
        v-if="showArrows"
        :moveToken="MoveToken.ARGNOT"
        :availableAmount="props.micronots"
        :targetWalletType="props.targetWalletType"
        :open="openMoveToken === MoveToken.ARGNOT"
        @update:open="value => onMovePopoverOpenChange(MoveToken.ARGNOT, value)"
      />
    </li>
  </ul>
</template>
<script setup lang="ts">
import * as Vue from 'vue';
import { MoveToken } from '@argonprotocol/apps-core';
import ArgonotIcon from '../../../assets/resources/argonot.svg';
import ArgonIcon from '../../../assets/resources/argon.svg';
import { WalletType } from '../../../lib/Wallet.ts';
import { createNumeralHelpers } from '../../../lib/numeral.ts';
import { getCurrency } from '../../../stores/currency.ts';
import EthereumMoveButton from './EthereumMoveButton.vue';

const currency = getCurrency();
const openMoveToken = Vue.ref<MoveToken.ARGN | MoveToken.ARGNOT>();

const { microgonToMoneyNm, microgonToArgonNm, micronotToMoneyNm, micronotToArgonotNm } = createNumeralHelpers(currency);

const props = withDefaults(
  defineProps<{
    microgons?: bigint;
    micronots?: bigint;
    minimizedLines?: boolean;
    showArrows?: boolean;
    targetWalletType?: WalletType.investment | WalletType.miningHold | WalletType.vaulting;
  }>(),
  {
    microgons: () => 0n,
    micronots: () => 0n,
    showArrows: false,
  },
);

function onMovePopoverOpenChange(moveToken: MoveToken.ARGN | MoveToken.ARGNOT, isOpen: boolean) {
  if (isOpen) {
    openMoveToken.value = moveToken;
    return;
  }

  if (openMoveToken.value === moveToken) {
    openMoveToken.value = undefined;
  }
}
</script>
