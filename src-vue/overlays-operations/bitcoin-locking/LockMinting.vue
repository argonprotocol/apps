<template>
  <div class="space-y-5 px-10 pt-5 pb-5">
    <p>
      The Argon Network has successfully processed and locked your
      {{
        numeral(currency.convertSatToBtc(fundingUtxoRecord?.satoshis ?? personalLock.satoshis ?? 0n)).format(
          '0,0.[00000000]',
        )
      }}
      in BTC.
    </p>
    <p>
      You're being awarded the full market value of your Bitcoin, which is currently
      {{ currency.symbol }}{{ microgonToArgonNm(microgonValue).format('0,0.[00]') }}. These argons will be minted and
      sent to your wallet as the network's capacity allows.
    </p>

    <BitcoinMintingSvg class="mx-auto my-10" />

    <button
      @click="closeOverlay"
      class="bg-argon-600 border-argon-700 mb-2 w-full cursor-pointer rounded-lg border px-6 py-2 text-lg font-bold text-white focus:outline-none">
      Okay
    </button>
  </div>
</template>

<script setup lang="ts">
import * as Vue from 'vue';
import numeral, { createNumeralHelpers } from '../../lib/numeral.ts';
import { getCurrency } from '../../stores/currency.ts';
import { IBitcoinLockRecord } from '../../lib/db/BitcoinLocksTable.ts';
import { getBitcoinLocks } from '../../stores/bitcoin.ts';
import BitcoinMintingSvg from '../../assets/wallets/bitcoin-minting.svg';

const currency = getCurrency();
const bitcoinLocks = getBitcoinLocks();

const { microgonToArgonNm } = createNumeralHelpers(currency);

const props = defineProps<{
  personalLock: IBitcoinLockRecord;
}>();

const emit = defineEmits<{
  (e: 'close'): void;
}>();

const microgonValue = Vue.ref(0n);
const fundingUtxoRecord = Vue.computed(() => bitcoinLocks.getAcceptedFundingRecord(props.personalLock));

function closeOverlay() {
  emit('close');
}

Vue.onMounted(async () => {
  microgonValue.value = props.personalLock.liquidityPromised;
});
</script>
