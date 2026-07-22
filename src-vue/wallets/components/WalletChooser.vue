<template>
  <div class="flex h-full flex-col text-left" :class="props.compact ? 'px-5 pb-5' : 'px-4 pt-3 pb-5'">
    <div class="mt-3 flex max-h-80 flex-col gap-2 overflow-y-auto pr-1">
      <div v-for="wallet in props.availableWallets" :key="getWalletSelectionKey(wallet)" class="relative">
        <button
          :data-wallet-key="getWalletSelectionKey(wallet)"
          type="button"
          class="relative flex w-full cursor-pointer items-center px-3 py-2 text-left"
          :class="
            props.compact
              ? props.dark
                ? 'min-h-14 border-b border-black/20 bg-transparent text-black/70 hover:bg-white/10'
                : 'min-h-14 border-b border-slate-300 bg-transparent hover:bg-slate-100'
              : 'min-h-16 rounded-md border border-slate-300 bg-white/80 shadow-sm hover:border-slate-400 hover:bg-white'
          "
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
            <strong class="block truncate text-sm" :class="props.dark ? 'text-black/70' : 'text-slate-800'">
              {{ getWalletSelectionName(wallet) }}
            </strong>
            <span class="block truncate text-xs" :class="props.dark ? 'text-black/50' : 'text-slate-500'">
              {{ getWalletAddress(wallet) }}
            </span>
          </span>
        </button>
        <ArrowCalloutButton
          v-if="controller.isTransferGuideActive && getWalletSelectionKey(wallet) === guidedEthereumWalletKey"
          guidance="Choose the Ethereum wallet holding the ARGN you acquired through Uniswap."
          class="absolute top-1/2 right-0 z-50 translate-x-[calc(100%+0.75rem)] -translate-y-1/2"
        />
      </div>
    </div>

    <div
      class="mt-auto grid gap-2 pt-4"
      :class="props.compact ? (props.dark ? 'border-t border-black/20' : 'border-t border-slate-300') : ''"
    >
      <button
        v-if="props.compact"
        data-testid="WalletOverlay.addNewWallet()"
        type="button"
        class="cursor-pointer rounded-md px-3 py-2 text-left text-lg font-semibold"
        :class="props.dark ? 'text-black/70 hover:bg-white/10' : 'text-slate-700 hover:bg-slate-200/60'"
        @click="emit('addNewWallet')"
      >
        + Add Ethereum Wallet
      </button>
      <div v-if="!props.compact" class="relative">
        <button
          data-testid="WalletOverlay.addExternalEthereum()"
          type="button"
          class="w-full rounded-md border border-slate-400/60 bg-white px-3 py-2 text-sm font-semibold text-slate-700 hover:border-slate-500/60 hover:bg-slate-200/60"
          @click="emit('addExternalEthereum')"
        >
          Add External Ethereum
        </button>
        <ArrowCalloutButton
          v-if="controller.isTransferGuideActive && !guidedEthereumWalletKey"
          guidance="Import the Ethereum wallet holding the ARGN you acquired through Uniswap."
          class="absolute top-1/2 right-0 z-50 translate-x-[calc(100%+0.75rem)] -translate-y-1/2"
        />
      </div>
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
  compact?: boolean;
  dark?: boolean;
}>();

const emit = defineEmits<{
  (event: 'select', wallet: IWalletSelection): void;
  (event: 'addNewWallet'): void;
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
