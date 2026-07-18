<template>
  <div class="flex h-full flex-col px-4 pt-3 pb-5 text-left">
    <div class="mt-3 flex max-h-80 flex-col gap-2 overflow-y-auto pr-1">
      <button
        v-for="wallet in props.availableWallets"
        :key="getWalletSelectionKey(wallet)"
        :data-wallet-key="getWalletSelectionKey(wallet)"
        type="button"
        class="relative flex min-h-16 w-full cursor-pointer items-center rounded-md border border-slate-300 bg-white/80 px-3 py-2 text-left shadow-sm hover:border-slate-400 hover:bg-white"
        @click="emit('select', wallet)"
      >
        <span
          v-if="isEthereumWalletSelection(wallet) && wallet.walletRecord.id === wallets.activeEthereumWalletRecordId"
          data-testid="WalletOverlay.chooseEthereumWallet()"
          class="absolute inset-0 z-10"
        />
        <span v-else-if="isEthereumWalletSelection(wallet)" class="absolute inset-0 z-10" />
        <span
          v-else-if="wallet.walletType === WalletType.miningBot"
          data-testid="WalletOverlay.chooseMiningWallet()"
          class="absolute inset-0 z-10"
        />
        <span v-else data-testid="WalletOverlay.chooseDefaultArgonWallet()" class="absolute inset-0 z-10" />
        <EthereumLogo v-if="isEthereumWalletSelection(wallet)" class="h-8 w-8 shrink-0" />
        <ArgonLogo v-else class="h-8 w-8 shrink-0" />
        <span class="ml-3 min-w-0">
          <strong class="block truncate text-sm text-slate-800">{{ getWalletSelectionName(wallet) }}</strong>
          <span class="block truncate text-xs text-slate-500">{{ getWalletAddress(wallet) }}</span>
        </span>
        <ArrowCalloutButton
          v-if="controller.isTransferGuideActive && getWalletSelectionKey(wallet) === guidedEthereumWalletKey"
          guidance="Choose the Ethereum wallet holding the ARGN you acquired through Uniswap."
          class="absolute top-1/2 right-0 z-50 translate-x-[calc(100%+0.75rem)] -translate-y-1/2"
        />
      </button>
    </div>

    <div class="mt-auto grid gap-2 pt-4">
      <button
        v-if="props.canAddDefaultEthereum"
        data-testid="WalletOverlay.addDefaultEthereum()"
        type="button"
        class="rounded-md border border-slate-400/60 bg-white px-3 py-2 text-sm font-semibold text-slate-700 hover:border-slate-500/60 hover:bg-slate-200/60"
        @click="emit('addDefaultEthereum')"
      >
        Add Default Ethereum
      </button>
      <button
        data-testid="WalletOverlay.addExternalEthereum()"
        type="button"
        class="relative rounded-md border border-slate-400/60 bg-white px-3 py-2 text-sm font-semibold text-slate-700 hover:border-slate-500/60 hover:bg-slate-200/60"
        @click="emit('addExternalEthereum')"
      >
        Add External Ethereum
        <ArrowCalloutButton
          v-if="controller.isTransferGuideActive && !guidedEthereumWalletKey"
          guidance="Import the Ethereum wallet holding the ARGN you acquired through Uniswap."
          class="absolute top-1/2 right-0 z-50 translate-x-[calc(100%+0.75rem)] -translate-y-1/2"
        />
      </button>
    </div>
  </div>
</template>

<script setup lang="ts">
import * as Vue from 'vue';
import { abbreviateAddress } from '../../lib/Utils.ts';
import { WalletType } from '../../lib/Wallet.ts';
import { useWallets } from '../../stores/wallets.ts';
import EthereumLogo from '../../assets/wallets/networks/ethereum.svg?component';
import ArgonLogo from '../../assets/wallets/networks/argon.svg?component';
import {
  getWalletSelectionKey,
  getWalletSelectionName,
  isEthereumWalletSelection,
  type IWalletSelection,
} from '../walletOverlayState.ts';
import ArrowCalloutButton from '../../components/ArrowCalloutButton.vue';
import { useCertificationController } from '../../stores/certificationController.ts';

const props = defineProps<{
  availableWallets: IWalletSelection[];
  canAddDefaultEthereum: boolean;
}>();

const emit = defineEmits<{
  (event: 'select', wallet: IWalletSelection): void;
  (event: 'addDefaultEthereum'): void;
  (event: 'addExternalEthereum'): void;
}>();

const wallets = useWallets();
const controller = useCertificationController();
const guidedEthereumWalletKey = Vue.computed(() => {
  const ethereumWallets = props.availableWallets.filter(isEthereumWalletSelection);
  const activeWallet = ethereumWallets.find(wallet => wallet.walletRecord.id === wallets.activeEthereumWalletRecordId);
  const guidedWallet = activeWallet ?? ethereumWallets[0];

  return guidedWallet ? getWalletSelectionKey(guidedWallet) : undefined;
});

function getWalletAddress(wallet: IWalletSelection) {
  let address = wallets.defaultArgonWallet.address;
  if (wallet.walletType === WalletType.miningBot) {
    address = wallets.miningBotWallet.address;
  } else if (isEthereumWalletSelection(wallet)) {
    address = wallet.walletRecord.address;
  }

  return abbreviateAddress(address, 8);
}
</script>
