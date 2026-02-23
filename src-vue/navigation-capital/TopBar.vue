<template>
  <div
    v-if="controller.isLoaded"
    class="relative mr-3 flex h-[55px] flex-row items-center justify-end space-x-2"
    :class="[wallets.isLoaded ? '' : 'opacity-20']"
    data-tauri-drag-region>
    <div class="absolute bottom-0 left-0 h-px w-full bg-gradient-to-l from-slate-300 from-[50%] to-transparent"></div>
    <div
      class="text-argon-600/70 flex h-[30px] cursor-pointer flex-row items-center rounded-md border border-slate-400/50 px-3 font-semibold hover:border-slate-400/50 hover:bg-slate-400/10 focus:outline-none">
      <div class="bg-argon-600 mr-2 h-3 w-3 rounded-full"></div>
      <div>Connected to Josh’s Vault</div>
    </div>
    <div class="pointer-events-auto">
      <CurrencyMenu ref="currencyMenuRef">USD</CurrencyMenu>
    </div>
    <div class="pointer-events-auto">
      <AccountMenu ref="accountMenuRef" />
    </div>
  </div>
</template>
<script setup lang="ts">
import CurrencyMenu from '../navigation-shared/CurrencyMenu.vue';
import AccountMenu from '../navigation-shared/AccountMenu.vue';
import { useCapitalController } from '../stores/capitalController.ts';
import { useWallets } from '../stores/wallets.ts';

const controller = useCapitalController();
const wallets = useWallets();
</script>
