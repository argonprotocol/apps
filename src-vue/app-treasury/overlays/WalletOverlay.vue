<!-- prettier-ignore -->
<template>
  <OverlayBase :isOpen="isOpen" :overflowScroll="false" :disallowClose="isSyncMode" :hasHeaderBorder="false" @close="closeOverlay" @esc="closeOverlay"
    :class="[isSyncMode ? 'w-8/12' : 'w-5/12']"
    class="overflow-visible bg-linear-to-b from-[#cccccc] to-[#9f9f9f] border-none min-h-140"
  >
    <template #title>
      <div class="flex flex-row items-center grow gap-x-2">
        <div v-if="isSyncMode" class="w-[calc(50%+46px)] flex flex-row items-center gap-x-2">
          <NavHeader :wallets="wallets" :selectedWallet="secondWallet" :showPortal="false" :showClose="true" @selectWallet="handleSelectSecondWallet" @close="toggleIsSyncMode" />
          <div
            NotDraggable
            @click="toggleSyncDirection"
            class="flex flex-row h-[34px] w-[34px] bg-white shadow items-center justify-center rounded-md border border-slate-400/80 hover:border-slate-500/80 hover:bg-slate-50 focus:outline-none"
          >
            <PortalIcon class="pointer-events-none h-5 w-5 text-argon-600" />
          </div>
        </div>
        <NavHeader :class="[isSyncMode ? 'w-[calc(50%-46px)]' : 'w-full']" :wallets="wallets" :selectedWallet="firstWallet" :showPortal="!isSyncMode" @selectWallet="handleSelectFirstWallet" @syncMode="toggleIsSyncMode" @close="closeOverlay" />
      </div>
    </template>

    <div
      :class="[isSyncMode ? 'w-1/2' : 'w-full']"
      class="absolute top-0 left-0 h-full bg-white border border-black/40 rounded-lg z-[-1]"
    />
    <div
      v-if="isSyncMode"
      class="absolute top-0 right-0 w-1/2 h-full bg-white border border-black/40 rounded-lg z-[-1]"
    />

    <div class="flex flex-row w-full font-light text-black/90">
      <div v-if="isSyncMode" class="px-4 pt-4 w-1/2 border-t border-slate-300">
        <ArgonIntro v-if="secondWallet.type === 'investment'" />
        <EthereumIntro v-if="secondWallet.type === 'ethereum'" />
      </div>
      <div class="px-4 pt-4 border-t border-slate-300" :class="[isSyncMode ? 'w-1/2' : 'w-full']">
        <ArgonIntro v-if="firstWallet.type === 'investment'" />
        <EthereumIntro v-if="firstWallet.type === 'ethereum'" />
      </div>
    </div>

    <div class="flex flex-row w-full mt-4 relative" :class="isSyncMode ? 'py-2' : ''">
      <div v-if="isSyncMode" class="absolute top-0 -left-2 rounded-t-lg w-[calc(100%+16px)] h-full z-[-1] bg-white border border-black/30 shadow-md">
        <WrapBehindEdge class="absolute bottom-0 right-0 translate-y-full w-2 h-2" />
        <WrapBehindEdge class="absolute bottom-0 left-0 translate-y-full w-2 h-2 scale-x-[-1]" />
      </div>
      <div v-if="isSyncMode" class="px-4 w-1/2">
        <ArgonTokens
          :microgons="getWalletTokenBalances(secondWallet).availableMicrogons"
          :micronots="getWalletTokenBalances(secondWallet).availableMicronots"
          :minimizedLines="true"
          :showArrows="true"
        />
      </div>
      <div class="px-4" :class="[isSyncMode ? 'w-1/2' : 'w-full']">
        <ArgonTokens
          :microgons="getWalletTokenBalances(firstWallet).availableMicrogons"
          :micronots="getWalletTokenBalances(firstWallet).availableMicronots"
          :minimizedLines="isSyncMode"
        />
      </div>
    </div>

    <div class="flex flex-row w-full">
      <div v-if="isSyncMode" class="px-4 w-1/2">
        <ArgonBottom v-if="secondWallet.type === 'investment'" :isSyncMode="isSyncMode" direction="to" />
        <EthereumBottom v-else-if="secondWallet.type === 'ethereum'" />
      </div>
      <div class="px-4" :class="[isSyncMode ? 'w-1/2' : 'w-full']">
        <ArgonBottom v-if="firstWallet.type === 'investment'" :isSyncMode="isSyncMode" direction="from" />
        <EthereumBottom v-else-if="firstWallet.type === 'ethereum'" />
      </div>
    </div>
  </OverlayBase>
</template>

<script setup lang="ts">
import * as Vue from 'vue';
import OverlayBase from '../../app-shared/overlays/OverlayBase.vue';
import basicEmitter from '../../emitters/basicEmitter.ts';
import { useBasics } from '../../stores/basics.ts';
import ArgonBottom from './wallet/ArgonBottom.vue';
import EthereumBottom from './wallet/EthereumBottom.vue';
import NavHeader, { type IWallet as INavWallet } from './wallet/NavHeader.vue';
import ArgonTokens from './wallet/ArgonTokens.vue';
import ArgonIntro from './wallet/ArgonIntro.vue';
import PortalIcon from '../../assets/portal.svg';
import WrapBehindEdge from '../../assets/wrap-behind-edge.svg';
import EthereumIntro from './wallet/EthereumIntro.vue';
import { type IWallet, WalletType } from '../../lib/Wallet.ts';
import { useWallets } from '../../stores/wallets.ts';

const basics = useBasics();
const walletStore = useWallets();

const isOpen = Vue.ref(false);
const isSyncMode = Vue.ref(false);
const wallets = Vue.ref<INavWallet[]>([
  { type: WalletType.investment, name: 'Argon Wallet' },
  { type: WalletType.ethereum, name: 'Ethereum Wallet' },
]);
const firstWallet = Vue.ref<INavWallet>(wallets.value[0]);
const secondWallet = Vue.ref<INavWallet>(wallets.value[1]);

function closeOverlay() {
  if (isSyncMode.value) {
    const nextFirstWallet = secondWallet.value;
    secondWallet.value = firstWallet.value;
    firstWallet.value = nextFirstWallet;
    isSyncMode.value = false;
  } else {
    isOpen.value = false;
    basics.overlayIsOpen = false;
  }
}

function handleSelectFirstWallet(wallet: INavWallet) {
  if (wallet.type === secondWallet.value.type) {
    secondWallet.value = firstWallet.value;
  }
  firstWallet.value = wallet;
}

function handleSelectSecondWallet(wallet: INavWallet) {
  if (wallet.type === firstWallet.value.type) {
    firstWallet.value = secondWallet.value;
  }
  secondWallet.value = wallet;
}

function toggleIsSyncMode() {
  isSyncMode.value = !isSyncMode.value;
}

function toggleSyncDirection() {
  const nextSecondWallet = firstWallet.value;
  firstWallet.value = secondWallet.value;
  secondWallet.value = nextSecondWallet;
}

function getWalletTokenBalances(wallet: INavWallet): IWallet {
  if (wallet.type === WalletType.ethereum) {
    return walletStore.ethereumWallet;
  }
  return walletStore.investmentWallet;
}

basicEmitter.on('openWalletOverlay', async ({ walletType }) => {
  const wallet = wallets.value.find(x => x.type === walletType);
  handleSelectFirstWallet(wallet as INavWallet);

  isOpen.value = true;
  basics.overlayIsOpen = true;
});
</script>
