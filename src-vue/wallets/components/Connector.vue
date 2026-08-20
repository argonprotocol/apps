<template>
  <div
    :data-wallet-connector-id="connectorId"
    :class="[props.network ? 'bg-white' : 'bg-black']"
    class="relative z-20 size-24 rounded-full border border-black shadow-md/25"
  >
    <component
      :is="props.network === 'bitcoin' ? ConnectorChannel : ConnectorTransfer"
      v-model:open="isConnectorPopoverOpen"
      :connectorId="connectorId"
      :direction="props.direction"
      v-bind="
        props.network === 'bitcoin'
          ? {}
          : { moveToken: selectedTransferToken, walletName: props.selection?.walletRecord.name }
      "
    >
      <button
        class="relative flex h-full w-full cursor-pointer items-center justify-center rounded-full p-2 text-black/70 focus:outline-none"
        @click="openConnector"
      >
        <div>
          <div
            :class="[
              props.network ? 'bg-argon-900/20 hover:bg-argon-900/10' : 'bg-argon-100/30 hover:bg-argon-100/40',
              isConnectorPopoverOpen ? 'bg-argon-900/10!' : '',
              transferPulseClass,
            ]"
            class="pointer-events-none absolute inset-0 rounded-full p-2"
          >
            <div class="h-full w-full rounded-full border border-dashed border-black" />
          </div>
        </div>
        <BitcoinNetworkLogo v-if="props.network === 'bitcoin'" class="relative z-10 w-10" />
        <EthereumNetworkLogo v-else-if="props.network === 'ethereum'" class="relative z-10 w-10" />
        <span v-else class="text relative -top-1 z-10 text-7xl font-light text-white/20">+</span>
      </button>
    </component>
    <div
      v-if="props.network"
      class="text-md text-argon-900/70 absolute -top-2 flex flex-row gap-x-1"
      :class="[props.direction === 'left' ? 'right-0' : 'left-0']"
    >
      <ConnectorTokensMenu
        :connectorId="connectorId"
        :disabled="!ethereumWallet"
        :microgons="ethereumWallet?.availableMicrogons"
        :micronots="ethereumWallet?.availableMicronots"
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
      <div class="rounded-lg border border-black/80 bg-white">
        <ConnectorMenu
          :connectorId="connectorId"
          :network="props.network"
          :direction="props.direction"
          :selection="props.selection"
        >
          <template #default="{ isOpen }">
            <button
              class="hover:bg-argon-900/10 flex h-full cursor-pointer flex-row items-center justify-center gap-x-1 rounded-lg px-2 inset-shadow-xs inset-shadow-white focus:outline-none"
              :class="isOpen ? 'bg-argon-900/10' : 'bg-argon-900/20'"
            >
              <span class="bg-argon-900/70 size-[3px] rounded-full" />
              <span class="bg-argon-900/70 size-[3px] rounded-full" />
              <span class="bg-argon-900/70 size-[3px] rounded-full" />
            </button>
          </template>
        </ConnectorMenu>
      </div>
    </div>
    <div
      v-if="props.network"
      class="absolute top-full left-1/2 -translate-x-1/2 translate-y-1 text-center whitespace-nowrap text-white"
    >
      <div class="text-lg font-bold opacity-60">
        <template v-if="props.network === 'bitcoin'">Bitcoin</template>
        <template v-else-if="selection">{{ selection.walletRecord.name }}</template>
      </div>
      <template v-if="props.network === 'bitcoin'">
        <div class="text-md relative -top-0.5 font-light italic opacity-60">Add Channel</div>
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
import { useWallets } from '../../stores/wallets.ts';
import { createNumeralHelpers } from '../../lib/numeral.ts';
import type { IWalletSelection } from '../walletOverlayState.ts';
import type { ICrosschainTransferDirection } from './crosschainTransferView.ts';

type IEthereumWalletSelection = Extract<IWalletSelection, { walletType: WalletType.ethereum }>;

const props = withDefaults(
  defineProps<{
    network?: 'bitcoin' | 'ethereum' | undefined;
    direction: 'right' | 'left';
    selection?: IEthereumWalletSelection;
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
const wallets = useWallets();
const isConnectorPopoverOpen = Vue.computed({
  get: () => props.open,
  set: value => emit('update:open', value),
});
const selectedTransferToken = Vue.ref<MoveToken.ARGN | MoveToken.ARGNOT>();
const connectorId = Vue.computed(() => {
  if (props.network === 'bitcoin') return 'bitcoin';
  return props.selection?.walletRecord.id.toString();
});
const transferPulseClass = Vue.computed(() => {
  if (props.transferDirections?.length === 2) return 'connector-transfer-pulse-both';
  if (props.transferDirections?.[0] === 'inbound') return 'connector-transfer-pulse-inbound';
  if (props.transferDirections?.[0] === 'outbound') return 'connector-transfer-pulse-outbound';
  return '';
});

const { microgonToMoneyNm } = createNumeralHelpers(currency);

const ethereumWallet = Vue.computed(() => {
  if (!props.selection) return;
  return wallets.getEthereumWalletRecord(props.selection.walletRecord.id);
});

const walletTotalValue = Vue.computed(() => {
  if (!ethereumWallet.value) return 0n;
  return getWalletArgonValue(ethereumWallet.value, currency);
});

function openTransferPopover(moveToken: MoveToken.ARGN | MoveToken.ARGNOT) {
  selectedTransferToken.value = moveToken;
  isConnectorPopoverOpen.value = true;
}

function openConnector() {
  selectedTransferToken.value = undefined;
  if (!props.network) emit('addConnector');
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
