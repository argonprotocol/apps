<template>
  <div
    :data-wallet-connector-id="connectorId"
    :class="[props.wallet ? 'bg-white' : 'bg-black']"
    class="relative z-20 size-24 rounded-full border border-black shadow-md/25"
  >
    <component
      :is="walletType === WalletType.bitcoin ? ConnectorChannel : ConnectorTransfer"
      v-model:open="isConnectorPopoverOpen"
      :connectorId="connectorId"
      :direction="props.direction"
      v-bind="
        walletType === WalletType.bitcoin
          ? { wallet: bitcoinWallet, channelUuid: props.bitcoinChannelUuid }
          : { moveToken: selectedTransferToken, walletName: ethereumWallet?.name }
      "
    >
      <button
        class="relative flex h-full w-full cursor-pointer items-center justify-center rounded-full p-2 text-black/70 focus:outline-none"
        @click="openConnector"
      >
        <div>
          <div
            :class="[
              props.wallet ? 'bg-argon-900/20 hover:bg-argon-900/10' : 'bg-argon-100/30 hover:bg-argon-100/40',
              isConnectorPopoverOpen ? 'bg-argon-900/10!' : '',
              transferPulseClass,
            ]"
            class="pointer-events-none absolute inset-0 rounded-full p-2"
          >
            <div class="h-full w-full rounded-full border border-dashed border-black" />
          </div>
        </div>
        <BitcoinNetworkLogo v-if="walletType === WalletType.bitcoin" class="relative z-10 w-10" />
        <EthereumNetworkLogo v-else-if="walletType === WalletType.ethereum" class="relative z-10 w-10" />
        <span v-else class="text relative -top-1 z-10 text-7xl font-light text-white/20">+</span>
      </button>
    </component>
    <div v-if="props.wallet" class="text-md text-argon-900/70 absolute -top-2 left-1/2 flex -translate-x-1/2 flex-row">
      <ConnectorTokensMenu
        :connectorId="connectorId"
        :disabled="!ethereumWallet"
        :microgons="ethereumWallet?.data.availableMicrogons"
        :micronots="ethereumWallet?.data.availableMicronots"
        @selectToken="openTransferPopover"
      >
        <template #default="{ isOpen }">
          <button class="cursor-pointer rounded-lg border border-black/80 bg-white focus:outline-none">
            <span
              class="hover:bg-argon-900/10 block rounded-lg px-2 inset-shadow-xs inset-shadow-white"
              :class="isOpen ? 'bg-argon-900/10' : 'bg-argon-900/20'"
            >
              {{ currency.symbol }}{{ microgonToMoneyNm(walletTotalValue).formatIfElse('< 100', '0,0.00', '0,0') }}
            </span>
          </button>
        </template>
      </ConnectorTokensMenu>
      <!--      <div class="rounded-lg border border-black/80 bg-white">-->
      <!--        <ConnectorMenu-->
      <!--          :connectorId="connectorId"-->
      <!--          :direction="props.direction"-->
      <!--          :wallet="props.wallet"-->
      <!--        >-->
      <!--          <template #default="{ isOpen }">-->
      <!--            <button-->
      <!--              class="hover:bg-argon-900/10 flex h-full cursor-pointer flex-row items-center justify-center gap-x-1 rounded-lg px-2 inset-shadow-xs inset-shadow-white focus:outline-none"-->
      <!--              :class="isOpen ? 'bg-argon-900/10' : 'bg-argon-900/20'"-->
      <!--            >-->
      <!--              <span class="bg-argon-900/70 size-[3px] rounded-full" />-->
      <!--              <span class="bg-argon-900/70 size-[3px] rounded-full" />-->
      <!--              <span class="bg-argon-900/70 size-[3px] rounded-full" />-->
      <!--            </button>-->
      <!--          </template>-->
      <!--        </ConnectorMenu>-->
      <!--      </div>-->
    </div>
    <div
      v-if="props.wallet"
      class="absolute top-full left-1/2 -translate-x-1/2 translate-y-1 text-center whitespace-nowrap text-white"
    >
      <div class="text-lg font-bold opacity-60">
        <template v-if="walletType === WalletType.bitcoin">Bitcoin</template>
        <template v-else-if="ethereumWallet">{{ ethereumWallet.name }}</template>
      </div>
      <template v-if="walletType === WalletType.bitcoin">
        <div class="text-md relative -top-0.5 font-light italic opacity-60">Create Channel</div>
      </template>
      <template v-else></template>
    </div>
  </div>
</template>

<script setup lang="ts">
import { MoveToken } from '@argonprotocol/apps-core';
import * as Vue from 'vue';
import BitcoinNetworkLogo from '../../assets/networks/bitcoin.svg';
import EthereumNetworkLogo from '../../assets/networks/ethereum.svg';
import ConnectorChannel from './ConnectorChannel.vue';
import ConnectorMenu from './ConnectorMenu.vue';
import ConnectorTokensMenu from './ConnectorTokensMenu.vue';
import ConnectorTransfer from './ConnectorTransfer.vue';
import { getCurrency } from '../../stores/currency.ts';
import { getWalletArgonValue, WalletType } from '../../lib/Wallet.ts';
import type { WalletForBitcoin } from '../../lib/WalletForBitcoin.ts';
import type { WalletForEthereum } from '../../lib/WalletForEthereum.ts';
import { createNumeralHelpers } from '../../lib/numeral.ts';
import { useFinancials } from '../../stores/financials.ts';
import type { ICrosschainTransferDirection } from './crosschainTransferView.ts';

const props = withDefaults(
  defineProps<{
    bitcoinChannelUuid?: string;
    direction: 'right' | 'left';
    wallet?: WalletForBitcoin | WalletForEthereum;
    open: boolean;
    transferDirections?: ICrosschainTransferDirection[];
  }>(),
  {},
);

const emit = defineEmits<{
  (event: 'update:open', value: boolean): void;
  (event: 'addConnector'): void;
}>();

const currency = getCurrency();
const financials = useFinancials();
const isConnectorPopoverOpen = Vue.computed({
  get: () => props.open,
  set: value => emit('update:open', value),
});
const selectedTransferToken = Vue.ref<MoveToken.ARGN | MoveToken.ARGNOT>();
const walletType = Vue.computed(() => props.wallet?.type);
const ethereumWallet = Vue.computed(() => {
  return props.wallet?.type === WalletType.ethereum ? props.wallet : undefined;
});
const bitcoinWallet = Vue.computed(() => {
  return props.wallet?.type === WalletType.bitcoin ? props.wallet : undefined;
});
const connectorId = Vue.computed(() => {
  if (walletType.value === WalletType.bitcoin) return WalletType.bitcoin;
  return ethereumWallet.value?.id?.toString();
});
const transferPulseClass = Vue.computed(() => {
  if (props.transferDirections?.length === 2) return 'connector-transfer-pulse-both';
  if (props.transferDirections?.[0] === 'inbound') return 'connector-transfer-pulse-inbound';
  if (props.transferDirections?.[0] === 'outbound') return 'connector-transfer-pulse-outbound';
  return '';
});

const { microgonToMoneyNm } = createNumeralHelpers(currency);

const walletTotalValue = Vue.computed(() => {
  if (bitcoinWallet.value) return currency.convertSatToMicrogon(financials.bitcoinWalletTotalSatoshis);
  return ethereumWallet.value ? getWalletArgonValue(ethereumWallet.value.data, currency) : 0n;
});

function openTransferPopover(moveToken: MoveToken.ARGN | MoveToken.ARGNOT) {
  selectedTransferToken.value = moveToken;
  isConnectorPopoverOpen.value = true;
}

function openConnector() {
  selectedTransferToken.value = undefined;
  if (!props.wallet) emit('addConnector');
}
</script>

<style scoped>
.connector-transfer-pulse-inbound {
  animation: connector-transfer-pulse-inbound 2.6s ease-in-out infinite;
}

.connector-transfer-pulse-outbound {
  animation: connector-transfer-pulse-outbound 2.6s ease-in-out infinite;
}

.connector-transfer-pulse-both {
  animation: connector-transfer-pulse-both 5.2s ease-in-out infinite;
}

@keyframes connector-transfer-pulse-inbound {
  0%,
  16%,
  100% {
    box-shadow: 0 0 0 0 rgb(162 76 184 / 0%);
    transform: scale(1);
  }
  8% {
    box-shadow: 0 0 0 7px rgb(162 76 184 / 20%);
    transform: scale(1.035);
  }
}

@keyframes connector-transfer-pulse-outbound {
  0%,
  68%,
  86%,
  100% {
    box-shadow: 0 0 0 0 rgb(162 76 184 / 0%);
    transform: scale(1);
  }
  77% {
    box-shadow: 0 0 0 7px rgb(162 76 184 / 20%);
    transform: scale(1.035);
  }
}

@keyframes connector-transfer-pulse-both {
  0%,
  8%,
  81%,
  91%,
  100% {
    box-shadow: 0 0 0 0 rgb(162 76 184 / 0%);
    transform: scale(1);
  }
  4%,
  86% {
    box-shadow: 0 0 0 7px rgb(162 76 184 / 20%);
    transform: scale(1.035);
  }
}
</style>
