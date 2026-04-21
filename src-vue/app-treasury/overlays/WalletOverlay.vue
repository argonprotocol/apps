<!-- prettier-ignore -->
<template>
  <OverlayBase :isOpen="isOpen" @close="closeOverlay" @esc="closeOverlay" class="w-5/12 overflow-auto">
    <template #title>
      <div class="flex flex-row grow h-[30px] w-full border border-slate-400/60 rounded-md mr-3 pl-1">
        <DialogTitle class="grow -mt-0.5">Argon Wallet</DialogTitle>
      </div>
    </template>
    <template #icons>
      <CopyAddressMenu :walletType="WalletType.investment" :showBorder="true" />
      <div NotDraggable class="w-[30px] h-[30px] flex flex-row items-center justify-center border-slate-400/60 hover:border-slate-400/50 hover:bg-slate-400/10 focus:outline-none border rounded-md">
        <PortalIcon class="w-5 h-5 text-slate-400 pointer-events-none" />
      </div>
    </template>

    <div class="px-5 py-4">
      <p>
        These are your unencumbered tokens, ready for Argon Bonds, Liquid Locking, or whatever else you want.
      </p>

      <ul class="border-b border-slate-400/50">
        <li class="flex flex-row gap-x-2 border-t border-slate-400/50 py-2">
          <ArgonIcon class="w-6 h-6" />
          <div class="grow">132 ARGN</div>
          <div>$135.00</div>
        </li>
        <li class="flex flex-row gap-x-2 border-t border-slate-400/50 py-2">
          <ArgonotIcon class="w-6 h-6" />
          <div class="grow">132 ARGNOT</div>
          <div>$135.00</div>
        </li>
      </ul>

      <p class="mt-5 text-center">
        Click the transfer icon above (<PortalIcon class="inline-block w-4" />) to open up a<br />
        portal between Argon and Ethereum.
      </p>
    </div>
  </OverlayBase>
</template>

<script setup lang="ts">
import * as Vue from 'vue';
import OverlayBase from '../../app-shared/overlays/OverlayBase.vue';
import { DialogTitle, DropdownMenuTrigger } from 'reka-ui';
import basicEmitter from '../../emitters/basicEmitter.ts';
import { useBasics } from '../../stores/basics.ts';
import CopyAddressMenu from '../../app-operations/screens/components/CopyAddressMenu.vue';
import { WalletType } from '../../lib/Wallet.ts';
import PortalIcon from '../../assets/portal.svg';
import ArgonIcon from '../../assets//resources/argon.svg';
import ArgonotIcon from '../../assets//resources/argonot.svg';

const basics = useBasics();

const isOpen = Vue.ref(false);

function closeOverlay() {
  isOpen.value = false;
  basics.overlayIsOpen = false;
}

basicEmitter.on('openWallet2Overlay', async () => {
  isOpen.value = true;
  basics.overlayIsOpen = true;
});
</script>
