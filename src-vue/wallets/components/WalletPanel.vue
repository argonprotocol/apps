<template>
  <div class="flex h-full flex-col text-black/90">
    <div class="mx-1 border-t border-slate-300 px-4 py-6 text-center">
      <div class="text-argon-700/70 text-6xl font-bold">
        {{ currency.symbol }}
        <FormattedMoney :isLoaded="walletValueIsLoaded" :value="walletTotalValue" />
      </div>
      <div class="mt-2 h-[29px] shrink-0">
        <div
          v-if="props.selection.walletType === WalletType.defaultArgon"
          class="mx-auto w-fit border-t border-slate-500/30 pt-2 text-sm opacity-50"
        >
          {{ currency.symbol
          }}{{ microgonToMoneyNm(walletTotalValue - financials.savingsTotalPending).format('0,0.00') }} is immediately
          usable
        </div>
        <div
          v-else-if="props.selection.walletType === WalletType.ethereum"
          class="mx-auto w-fit border-t border-slate-500/30 pt-2 text-sm opacity-50"
        >
          {{ currency.symbol }}{{ microgonToMoneyNm(nonNativeTokenValue).format('0,0.00') }} is in non-native tokens
        </div>
      </div>
    </div>

    <div class="relative pt-1 pb-2">
      <div class="relative px-4">
        <ArgonTokens
          :microgonsToMint="
            props.selection?.walletType === WalletType.defaultArgon ? financials.savingsTotalPending : 0n
          "
          :microgons="props.wallet.availableMicrogons"
          :micronots="props.wallet.availableMicronots"
          :moveDirection="props.transferDirection"
          :moveFrom="props.moveFrom"
          :moveTo="props.moveTo"
          :networkName="props.transferDirection ? 'Ethereum' : ''"
          :feeTokenSymbol="props.transferDirection ? 'ETH' : ''"
          :indentLeft="props.indentTokensLeft"
          :indentRight="props.indentTokensRight"
          @openTransferOverlay="emit('openTransferOverlay', $event)"
        />
      </div>
    </div>

    <div class="flex grow flex-col px-4">
      <ArgonBottom
        v-if="props.selection.walletType !== WalletType.ethereum"
        :mode="props.mode"
        :showGuidance="props.showGuidance"
        :guidanceContext="props.guidanceContext"
        :walletType="props.selection.walletType"
      />
      <EthereumBottom v-else :wallet="props.wallet" />
    </div>
  </div>
</template>

<script setup lang="ts">
import type { IEthereumMoveToken } from '../../interfaces/IEthereumInboundTransferTracker.ts';
import type { MoveFrom, MoveTo } from '@argonprotocol/apps-core';
import { getWalletTotalValue, type IWallet, WalletType } from '../../lib/Wallet.ts';
import type { IWalletGuidanceContext } from '../../emitters/basicEmitter.ts';
import FormattedMoney from '../../components/FormattedMoney.vue';
import ArgonBottom from './ArgonBottom.vue';
import ArgonTokens from './ArgonTokens.vue';
import EthereumBottom from './EthereumBottom.vue';
import type { IWalletSelection } from '../walletOverlayState.ts';
import * as Vue from 'vue';
import { useFinancials } from '../../stores/financials.ts';
import { getCurrency } from '../../stores/currency.ts';
import { createNumeralHelpers } from '../../lib/numeral.ts';

const props = defineProps<{
  selection: IWalletSelection;
  wallet: IWallet;
  mode: 'chooser' | 'transfer';
  transferDirection?: 'transferToArgon' | 'transferOutOfArgon';
  moveFrom?: MoveFrom;
  moveTo?: MoveTo;
  indentTokensLeft?: boolean;
  indentTokensRight?: boolean;
  showGuidance?: boolean;
  guidanceContext?: IWalletGuidanceContext;
}>();

const emit = defineEmits<{
  (event: 'openTransferOverlay', transfer: { moveToken: IEthereumMoveToken; availableAmount: bigint }): void;
}>();

const financials = useFinancials();
const currency = getCurrency();
const { microgonToMoneyNm } = createNumeralHelpers(currency);

const walletValueIsLoaded = Vue.computed(() => {
  if (props.selection.walletType === WalletType.defaultArgon) return financials.savingsIsLoaded;
  return true;
});
const walletTotalValue = Vue.computed(() => {
  if (props.selection.walletType === WalletType.defaultArgon) return financials.savingsTotalValue;
  return getWalletTotalValue(props.wallet, currency);
});
const nonNativeTokenValue = Vue.computed(() => {
  return props.wallet.otherTokens.reduce((total, token) => total + currency.convertOtherToMicrogon(token), 0n);
});
</script>
