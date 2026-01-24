<!-- prettier-ignore -->
<template>
  <TooltipProvider :disableHoverableContent="true" class="flex h-full flex-col">
    <div class="flex h-full grow flex-row justify-stretch gap-y-2 px-2.5 py-2.5">
      <section class="flex flex-col w-1/3 items-center !py-1 px-1 text-slate-900/90">
        <ul>
          <li>My holdings</li>
          <li>My bitcoins</li>
          <li>etc</li>
        </ul>
      </section>
    </div>
  </TooltipProvider>
</template>

<script setup lang="ts">
import * as Vue from 'vue';
import { getCurrency } from '../stores/currency.ts';
import { createNumeralHelpers } from '../lib/numeral.ts';
import { getVaults } from '../stores/vaults.ts';
import { TooltipProvider } from 'reka-ui';
import { getWalletBalances } from '../stores/wallets.ts';
import { getConfig } from '../stores/config.ts';

const vaults = getVaults();
const currency = getCurrency();
const config = getConfig();
const walletBalances = getWalletBalances();

const { microgonToArgonNm, microgonToMoneyNm, micronotToArgonotNm } = createNumeralHelpers(currency);

const microgonsPerArgonot = Vue.ref(0n);
const microgonsPerBitcoin = Vue.ref(0n);

Vue.onMounted(async () => {
  await config.isLoadedPromise;
  await currency.isLoadedPromise;
  await vaults.load();

  microgonsPerArgonot.value = currency.microgonsPer.ARGNOT;
  microgonsPerBitcoin.value = currency.microgonsPer.BTC;
});

Vue.onUnmounted(() => {});
</script>

<style>
@reference "../main.css";

svg[Bank] {
  .hasStroke {
    @apply stroke-slate-800/50 stroke-1;
  }
}
</style>

<style scoped>
@reference "../main.css";

[box] {
  @apply rounded border-[1px] border-slate-400/30 bg-white py-2 shadow;
}

[StatWrapper] {
  @apply flex flex-col justify-center gap-y-1;
  [Stat] {
    @apply text-argon-600 font-mono text-2xl font-extrabold;
  }
  header {
    @apply text-3xl;
  }
  label {
    @apply -mt-1 text-sm font-medium text-slate-700/50;
  }
}

[ArgonPrice] {
  @apply text-argon-600 text-4xl font-extrabold whitespace-nowrap lg:text-[2.5rem] xl:text-5xl;
  span {
    @apply font-light opacity-30;
  }
}
</style>
