<!-- prettier-ignore -->
<template>
  <div class="flex h-full flex-col px-4 py-4">
    <h2 class="text-xl font-bold text-slate-800/70">Mainchain Account</h2>

    <div class="mt-4 rounded-lg border border-slate-300/50 bg-white px-6 py-4 shadow-sm">
      <div class="text-sm text-slate-500">Your Address</div>
      <div class="mt-1 font-mono text-base text-slate-800 break-all select-all">
        {{ walletKeys.investmentAddress }}
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { getWalletKeys } from '../stores/wallets.ts';

const walletKeys = getWalletKeys();
</script>
