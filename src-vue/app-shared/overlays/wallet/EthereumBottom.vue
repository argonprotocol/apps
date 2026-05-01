<template>
  <div class="mt-5 flex flex-col gap-4">
    <div
      v-if="hasBaseAlert || baseWallet.fetchErrorMsg"
      class="text-md flex flex-row items-start gap-x-3 rounded-lg border border-amber-300 bg-amber-50 p-2 leading-6"
    >
      <AlertIcon class="relative top-1 w-10 text-amber-600" />
      <p v-if="baseWallet.fetchErrorMsg" class="text-red-600">
        {{ baseWallet.fetchErrorMsg }}
      </p>
      <p v-else class="text-amber-900">
        Note: This wallet has tokens on the Base Network, but Base is not supported by the Argon app.
      </p>
    </div>

    <p class="font-light">The following is a list of your non-argon tokens.</p>

    <div class="py-1">
      <p v-if="ethereumWallet.fetchErrorMsg" class="mt-3 text-sm leading-6 text-red-600">
        {{ ethereumWallet.fetchErrorMsg }}
      </p>

      <OtherTokens :tokens="ethereumWallet.otherTokens" />
    </div>
  </div>
</template>

<script setup lang="ts">
import * as Vue from 'vue';
import OtherTokens from './OtherTokens.vue';
import AlertIcon from '../../../assets/alert.svg';
import { useWallets } from '../../../stores/wallets.ts';

const wallets = useWallets();

const ethereumWallet = wallets.ethereumWallet;
const baseWallet = wallets.baseWallet;

const hasBaseAlert = Vue.computed(() => {
  const tokensWithValue = baseWallet.otherTokens.filter(x => x.value > 0n);
  return tokensWithValue.length > 0;
});
</script>
