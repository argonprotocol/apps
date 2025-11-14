<template>
  <div class="flex flex-col space-y-5 px-10 py-6">
    <p class="text-gray-700">
      Your {{ numeral(currency.satsToBtc(props.personalLock?.satoshis ?? 0n)).format('0,0.[00000000]') }} in BTC has
      been officially unlocked from both the Argon and Bitcoin blockchains. It's now sitting under your control at the
      address listed below:
    </p>

    <div class="mt-5 mb-12 flex flex-row items-center">
      <BitcoinUnlockedSvg />
      <div class="ml-5 grow rounded border border-slate-200 py-2 pr-10 pl-2 font-mono italic">
        {{ personalLock.releaseToDestinationAddress }}
      </div>
    </div>

    <button
      @click="closeOverlay"
      class="bg-argon-600 border-argon-700 mb-2 w-full cursor-pointer rounded-lg border px-6 py-2 text-lg font-bold text-white focus:outline-none">
      Close
    </button>
  </div>
</template>

<script setup lang="ts">
import numeral from '../../lib/numeral';
import { IBitcoinLockRecord } from '../../lib/db/BitcoinLocksTable.ts';
import BitcoinUnlockedSvg from '../../assets/wallets/bitcoin-unlocked.svg';
import { useCurrency } from '../../stores/currency.ts';

const currency = useCurrency();

const props = defineProps<{
  personalLock: IBitcoinLockRecord;
}>();

const emit = defineEmits<{
  (e: 'close'): void;
}>();

function closeOverlay() {
  emit('close');
}
</script>
