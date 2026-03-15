<template>
  <div class="space-y-5 px-10 pt-5 pb-5">
    <p v-if="isMismatchAccepted">
      Funding difference accepted. Argon has locked your adjusted
      {{
        numeral(currency.convertSatToBtc(fundingUtxoRecord?.satoshis ?? personalLock.satoshis ?? 0n)).format(
          '0,0.[00000000]',
        )
      }}
      BTC amount.
    </p>
    <p v-else>
      Argon has processed and locked your
      {{
        numeral(currency.convertSatToBtc(fundingUtxoRecord?.satoshis ?? personalLock.satoshis ?? 0n)).format(
          '0,0.[00000000]',
        )
      }}
      BTC.
    </p>
    <p v-if="isMismatchAccepted">
      You’ll receive the market value of the accepted Bitcoin amount, currently
      {{ currency.symbol }}{{ microgonToArgonNm(microgonValue).format('0,0.[00]') }}. These argons will be minted and
      sent to your wallet as network capacity allows.
    </p>
    <p v-else>
      You’ll receive the full market value of your Bitcoin, currently
      {{ currency.symbol }}{{ microgonToArgonNm(microgonValue).format('0,0.[00]') }}. These argons will be minted and
      sent to your wallet as network capacity allows.
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
import { TransactionStatus } from '../../lib/db/TransactionsTable.ts';

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
const isMismatchAccepted = Vue.computed(() => {
  const utxoId = props.personalLock.utxoId;
  if (!utxoId) return false;
  const txInfo = bitcoinLocks.getLatestMismatchAcceptTxInfo(utxoId);
  return txInfo?.tx.status === TransactionStatus.Finalized;
});

function closeOverlay() {
  emit('close');
}

Vue.onMounted(async () => {
  microgonValue.value = props.personalLock.liquidityPromised;
});
</script>
