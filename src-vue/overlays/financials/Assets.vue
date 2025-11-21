<template>
  <div class="Assets Panel flex h-full flex-col space-y-5 px-3 pt-1 pb-10">
    <p class="w-11/12 pb-2 font-light text-slate-800/70">
      This page shows a breakdown of all your Argon assets, including your mining, vaulting, and the holding accounts.
      Move your mouse over the various items to learn more or click the Move buttons to transfer.
    </p>
    <div class="flex grow flex-row pt-10">
      <div class="h-full">
        <header class="text-lg font-bold">Mining Assets</header>
        <MiningAssetBreakdown class="h-full" />
      </div>
      <div class="flex w-full grow flex-col">
        <header class="text-center text-lg font-bold">Holding Account</header>
        <div class="mx-auto flex h-full w-8/12 flex-col items-center justify-center">
          <BanklessTop class="w-full" />
          <BanklessMiddle class="-my-1 w-full grow" />
          <BanklessBottom class="w-full" />
        </div>
      </div>
      <div class="h-full">
        <header class="text-right text-lg font-bold">Vaulting Assets</header>
        <VaultingAssetBreakdown class="h-full" />
      </div>
    </div>
  </div>
</template>
<script setup lang="ts">
import VaultingAssetBreakdown from '../../components/VaultingAssetBreakdown.vue';
import MiningAssetBreakdown from '../../components/MiningAssetBreakdown.vue';
import BanklessTop from '../../assets/bankless-top.svg';
import BanklessMiddle from '../../assets/bankless-middle.svg';
import BanklessBottom from '../../assets/bankless-bottom.svg';
</script>

<style>
@reference "../../main.css";

.Assets.Panel {
  .hasStroke {
    @apply stroke-1;
  }
}
</style>
