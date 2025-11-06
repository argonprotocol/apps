<template>
  <div class="space-y-5 px-10 pt-5 pb-5">
    <p>
      Your {{ numeral(currency.satsToBtc(personalLock.satoshis ?? 0n)).format('0,0.[00000000]') }} of BTC has been
      successfully processed! You've been awarded the full market value of your Bitcoin, which is {{ currency.symbol
      }}{{ microgonToArgonNm(microgonValue).format('0,0.[00]') }}. These will be minted and sent to your wallet as the
      network's minting algorithm allows.
    </p>

    <button
      @click="closeOverlay"
      class="bg-argon-600 border-argon-700 mb-2 w-full cursor-pointer rounded-lg border px-6 py-2 text-lg font-bold text-white focus:outline-none">
      Close
    </button>
  </div>
</template>

<script setup lang="ts">
import * as Vue from 'vue';
import numeral, { createNumeralHelpers } from '../../lib/numeral.ts';
import { useCurrency } from '../../stores/currency.ts';
import { IBitcoinLockRecord } from '../../lib/db/BitcoinLocksTable.ts';
import { useVaults } from '../../stores/vaults.ts';

const currency = useCurrency();
const vaults = useVaults();

const { microgonToArgonNm } = createNumeralHelpers(currency);

const props = defineProps<{
  personalLock: IBitcoinLockRecord;
}>();

const emit = defineEmits<{
  (e: 'close'): void;
}>();

const microgonValue = Vue.ref(0n);

function closeOverlay() {
  emit('close');
}

Vue.onMounted(async () => {
  microgonValue.value = await vaults.getMarketRate(props.personalLock.satoshis ?? 0n).catch(() => 0n);
});
</script>
