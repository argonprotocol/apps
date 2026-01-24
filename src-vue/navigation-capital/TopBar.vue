<template>
  <div
    v-if="controller.isLoaded"
    class="pointer-events-none relative mr-3 flex flex-row items-center justify-end space-x-2 pt-3"
    :class="[wallets.isLoaded ? '' : 'opacity-20']">
    <div>Connected to Josh’s Vault</div>
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
import { useController } from '../stores/controller.ts';
import { useWallets } from '../stores/wallets.ts';

const controller = useController();
const wallets = useWallets();
</script>
