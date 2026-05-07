<!-- prettier-ignore -->
<template>
  <OverlayBase :isOpen="isOpen" :overflowScroll="false" :disallowClose="isSyncMode" :hasHeaderBorder="false" @close="closeOverlay" @pressEsc="handlePressEsc" @clickClose="handleClickClose" @clickBackdrop="handleClickBackdrop"
    :class="[isSyncMode ? 'w-8/12' : 'w-5/12']"
    class="flex flex-col overflow-visible bg-linear-to-b from-[#cccccc] to-[#9f9f9f] border-none min-h-140"
  >
    <template #title>
      <div class="flex flex-row items-center grow gap-x-2">
        <div v-if="isSyncMode" class="w-[calc(50%+46px)] flex flex-row items-center gap-x-2">
          <NavHeader :key="secondWalletKey" :options="secondWalletOptions" :selectedOption="secondWalletOption" :showPortal="false" :showClose="true" @selectOption="handleSelectSecondWallet" @close="toggleIsSyncMode" />
          <div
            NotDraggable
            @click="toggleSyncDirection"
            class="flex flex-row h-[34px] w-[34px] bg-white shadow items-center justify-center rounded-md border border-slate-400/80 hover:border-slate-500/80 hover:bg-slate-50 focus:outline-none"
          >
            <PortalIcon class="pointer-events-none h-5 w-5 text-argon-600" />
          </div>
        </div>
        <NavHeader :key="firstWalletKey" :class="[isSyncMode ? 'w-[calc(50%-46px)]' : 'w-full']" :options="firstWalletOptions" :selectedOption="firstWalletOption" :showPortal="!isSyncMode" @selectOption="handleSelectFirstWallet" @syncMode="toggleIsSyncMode" @close="closeOverlay" />
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
        <ArgonIntro v-if="isArgonWalletType(secondWalletOption.type)" :walletType="secondWalletOption.type" />
        <EthereumIntro v-if="secondWalletOption.type === 'ethereum'" />
      </div>
      <div class="px-4 pt-4 border-t border-slate-300" :class="[isSyncMode ? 'w-1/2' : 'w-full']">
        <ArgonIntro v-if="isArgonWalletType(firstWalletOption.type)" :walletType="firstWalletOption.type" />
        <EthereumIntro v-if="firstWalletOption.type === 'ethereum'" />
      </div>
    </div>

    <div class="flex flex-row w-full mt-4 relative" :class="isSyncMode ? 'py-2' : ''">
      <div v-if="isSyncMode" class="absolute top-0 -left-2 rounded-t-lg w-[calc(100%+16px)] h-full z-[-1] bg-white border border-black/30 shadow-md">
        <WrapBehindEdge class="absolute bottom-0 right-0 translate-y-full w-2 h-2" />
        <WrapBehindEdge class="absolute bottom-0 left-0 translate-y-full w-2 h-2 scale-x-[-1]" />
      </div>
      <div v-if="isSyncMode" class="px-4 w-1/2">
        <ArgonTokens
          :microgons="getWallet(secondWalletOption).availableMicrogons"
          :micronots="getWallet(secondWalletOption).availableMicronots"
          :minimizedLines="true"
          :showArrows="true"
        />
      </div>
      <div class="px-4" :class="[isSyncMode ? 'w-1/2' : 'w-full']">
        <ArgonTokens
          :microgons="getWallet(firstWalletOption).availableMicrogons"
          :micronots="getWallet(firstWalletOption).availableMicronots"
          :minimizedLines="isSyncMode"
        />
      </div>
    </div>

    <div class="flex flex-row w-full grow">
      <div v-if="isSyncMode" class="flex flex-col px-4 w-1/2">
        <ArgonBottom
          v-if="isArgonWalletType(secondWalletOption.type)"
          :isSyncMode="isSyncMode"
          :showGuidance="showGuidance"
          :walletType="secondWalletOption.type"
          direction="to"
        />
        <EthereumBottom v-else-if="secondWalletOption.type === 'ethereum'" />
      </div>
      <div :class="[isSyncMode ? 'w-1/2' : 'w-full']" class="flex flex-col px-4" >
        <ArgonBottom
          v-if="isArgonWalletType(firstWalletOption.type)"
          :isSyncMode="isSyncMode"
          :showGuidance="showGuidance"
          :walletType="firstWalletOption.type"
          direction="from"
        />
        <EthereumBottom v-else-if="firstWalletOption.type === 'ethereum'" />
      </div>
    </div>
  </OverlayBase>
</template>

<script setup lang="ts">
import * as Vue from 'vue';
import OverlayBase from './OverlayBase.vue';
import basicEmitter from '../../emitters/basicEmitter.ts';
import { useBasics } from '../../stores/basics.ts';
import ArgonBottom from './wallet/ArgonBottom.vue';
import EthereumBottom from './wallet/EthereumBottom.vue';
import NavHeader, { type IWalletOption } from './wallet/NavHeader.vue';
import ArgonTokens from './wallet/ArgonTokens.vue';
import ArgonIntro from './wallet/ArgonIntro.vue';
import PortalIcon from '../../assets/portal.svg';
import WrapBehindEdge from '../../assets/wrap-behind-edge.svg';
import EthereumIntro from './wallet/EthereumIntro.vue';
import { type IWallet, WalletType } from '../../lib/Wallet.ts';
import { useWallets } from '../../stores/wallets.ts';
import { IS_OPERATIONS_APP } from '../../lib/Env.ts';

const basics = useBasics();
const walletStore = useWallets();

const isOpen = Vue.ref(false);
const isSyncMode = Vue.ref(false);
const walletOptions = Vue.ref<IWalletOption[]>([
  ...(IS_OPERATIONS_APP
    ? [
        { type: WalletType.miningHold as const, name: 'Argon Mining Wallet', isArgonNetwork: true },
        { type: WalletType.vaulting as const, name: 'Argon Vaulting Wallet', isArgonNetwork: true },
      ]
    : [{ type: WalletType.investment as const, name: 'Argon Wallet', isArgonNetwork: true }]),
  { type: WalletType.ethereum as const, name: 'Ethereum Wallet', isArgonNetwork: false },
]);
const showGuidance = Vue.ref(false);
const firstWalletOption = Vue.ref<IWalletOption>(walletOptions.value[0]);
const secondWalletOption = Vue.ref<IWalletOption>(walletOptions.value[walletOptions.value.length - 1]);
const firstWalletOptions = Vue.computed(() => getWalletOptionsForSide(secondWalletOption.value));
const secondWalletOptions = Vue.computed(() => getWalletOptionsForSide(firstWalletOption.value));
const firstWalletKey = Vue.computed(() => getWalletHeaderKey(firstWalletOption.value, firstWalletOptions.value));
const secondWalletKey = Vue.computed(() => getWalletHeaderKey(secondWalletOption.value, secondWalletOptions.value));

function isArgonWalletType(walletType: WalletType) {
  return [WalletType.vaulting, WalletType.miningHold, WalletType.investment].includes(walletType);
}

function getWalletOptionsForSide(oppositeOption: IWalletOption) {
  if (!isSyncMode.value) return walletOptions.value;

  return walletOptions.value.filter(wallet => wallet.isArgonNetwork !== oppositeOption.isArgonNetwork);
}

function getWalletHeaderKey(selectedOption: IWalletOption, options: IWalletOption[]) {
  return `${selectedOption.type}:${options.map(wallet => wallet.type).join(',')}`;
}

function ensureSyncWalletPair() {
  if (firstWalletOption.value.isArgonNetwork !== secondWalletOption.value.isArgonNetwork) return;

  const matchingNetworkOption = walletOptions.value.find(
    wallet => wallet.isArgonNetwork !== firstWalletOption.value.isArgonNetwork,
  );
  if (matchingNetworkOption) {
    secondWalletOption.value = matchingNetworkOption;
  }
}

function closeOverlay() {
  isSyncMode.value = false;
  isOpen.value = false;
  basics.overlayIsOpen = false;
}

function handleClickClose() {
  if (!isSyncMode.value) return;
  closeOverlay();
}

function handleClickBackdrop() {
  if (!isSyncMode.value) return;
  closeOverlay();
}

function handlePressEsc() {
  if (!isSyncMode.value) return;
  isSyncMode.value = false;
}

function handleSelectFirstWallet(option: IWalletOption) {
  if (option.type === secondWalletOption.value.type) {
    secondWalletOption.value = firstWalletOption.value;
  }
  firstWalletOption.value = option;
}

function handleSelectSecondWallet(option: IWalletOption) {
  if (option.type === firstWalletOption.value.type) {
    firstWalletOption.value = secondWalletOption.value;
  }
  secondWalletOption.value = option;
}

function toggleIsSyncMode() {
  isSyncMode.value = !isSyncMode.value;
  if (isSyncMode.value) {
    ensureSyncWalletPair();
  }
}

function toggleSyncDirection() {
  const nextSecondWallet = firstWalletOption.value;
  firstWalletOption.value = secondWalletOption.value;
  secondWalletOption.value = nextSecondWallet;
}

function getWallet(option: IWalletOption): IWallet {
  if (option.type === WalletType.ethereum) {
    return walletStore.ethereumWallet;
  } else if (option.type === WalletType.vaulting) {
    return walletStore.vaultingWallet;
  } else if (option.type === WalletType.miningHold) {
    return walletStore.miningHoldWallet;
  } else if (option.type === WalletType.investment) {
    return walletStore.investmentWallet;
  } else {
    throw new Error(`Wallet not support: ${option.type}`);
  }
}

basicEmitter.on('openWalletOverlay', async payload => {
  const walletOption = walletOptions.value.find(x => x.type === payload.walletType);
  handleSelectFirstWallet(walletOption as IWalletOption);

  showGuidance.value = payload.showGuidance || false;
  isOpen.value = true;
  basics.overlayIsOpen = true;
});
</script>
