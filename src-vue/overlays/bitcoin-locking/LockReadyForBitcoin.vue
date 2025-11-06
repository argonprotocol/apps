<template>
  <div class="px-10 pt-3">
    <p class="mt-5 mb-4 text-gray-600 select-text">
      You must send exactly
      <strong>
        {{ numeral(currency.satsToBtc(props.personalLock.lockDetails.satoshis)).format('0,0.[00000000]') }} BTC
      </strong>
      (or
      {{ numeral(props.personalLock.lockDetails.satoshis).format('0,0') }}
      sats) to the cosign address listed below. Make sure you send the exact amount. Failure to do so could result in a
      rejected transaction and possibly the loss of your bitcoin.
    </p>

    <div class="mb-4 rounded-lg border border-gray-300 p-4 font-mono">
      <CopyToClipboard :content="scriptPaytoAddress" class="relative cursor-pointer">
        <span class="opacity-80">
          {{ scriptPaytoAddress }}
          <CopyIcon class="absolute top-1/2 right-0 h-4 w-4 -translate-y-1/2" />
        </span>
        <template #copied>
          <div class="pointer-events-none absolute top-0 left-0 h-full w-full">
            {{ scriptPaytoAddress }}
            <CopyIcon class="absolute top-1/2 right-0 h-4 w-4 -translate-y-1/2" />
          </div>
        </template>
      </CopyToClipboard>
    </div>

    <div class="mb-4 flex flex-col items-center pt-1 text-gray-500">
      <p class="w-full text-left">
        Alternatively, many Bitcoin wallets allow you scan the following QR code to pre-fill the transfer details.
      </p>
      <BitcoinQrCode class="mt-5 h-44 w-44 text-center" :bip21="fundingBip21" v-if="fundingBip21" />
      <CopyToClipboard :content="fundingBip21" class="relative mb-4 cursor-pointer">
        <span class="opacity-80">
          {{ abbreviateAddress(fundingBip21, 10) }}
          <CopyIcon class="ml-1 inline-block h-4 w-4" />
        </span>
        <template #copied>
          <div class="pointer-events-none absolute top-0 left-0 h-full w-full">
            {{ abbreviateAddress(fundingBip21, 10) }}
            <CopyIcon class="ml-1 inline-block h-4 w-4" />
          </div>
        </template>
      </CopyToClipboard>
    </div>

    <div class="mb-4 flex flex-row items-center border-t border-gray-300 pt-4 pb-1 text-gray-500">
      <Spinner class="mr-3" />
      We're monitoring Bitcoin's network and will update this screen when your transaction is received.
    </div>
  </div>
</template>

<script setup lang="ts">
import * as Vue from 'vue';
import { abbreviateAddress } from '../../lib/Utils';
import CopyToClipboard from '../../components/CopyToClipboard.vue';
import BitcoinQrCode from '../../components/BitcoinQrCode.vue';
import CopyIcon from '../../assets/copy.svg?component';
import { BitcoinLockStatus, IBitcoinLockRecord } from '../../lib/db/BitcoinLocksTable.ts';
import { SATS_PER_BTC } from '@argonprotocol/mainchain';
import numeral from '../../lib/numeral.ts';
import { useCurrency } from '../../stores/currency.ts';
import { useBitcoinLocks } from '../../stores/bitcoin.ts';
import Spinner from '../../components/Spinner.vue';

const props = defineProps<{
  personalLock: IBitcoinLockRecord;
}>();

const currency = useCurrency();
const bitcoinLocks = useBitcoinLocks();

const fundingBip21 = Vue.ref('');
const scriptPaytoAddress = Vue.ref('');

let shouldRunBitcoinCheck = true;

function runBitcoinCheck() {
  if (!shouldRunBitcoinCheck) return;
  if (props.personalLock.status !== BitcoinLockStatus.LockReadyForBitcoin) return;
  console.log('Running Bitcoin Check');
  bitcoinLocks.updateLockIsProcessingOnBitcoin(props.personalLock);
  setTimeout(runBitcoinCheck, 1e3);
}

Vue.onMounted(async () => {
  await bitcoinLocks.load();
  try {
    scriptPaytoAddress.value = bitcoinLocks.formatP2swhAddress(props.personalLock.lockDetails.p2wshScriptHashHex);
  } catch (error) {
    console.error('Error formatting P2WSH address:', error);
    throw new Error('Failed to format P2WSH address');
  }
  const btcAmount = numeral(Number(props.personalLock.satoshis) / Number(SATS_PER_BTC)).format('0,0.[00000000]');
  const label = encodeURIComponent(`Argon Vault #${props.personalLock.vaultId} (utxo id=${props.personalLock.utxoId})`);
  const message = encodeURIComponent(
    `Personal BTC Funding for Vault #${props.personalLock.vaultId}, Utxo Id #${props.personalLock.utxoId}`,
  );
  fundingBip21.value = `bitcoin:${scriptPaytoAddress.value}?amount=${btcAmount}&label=${label}&message=${message}`;

  runBitcoinCheck();
});

Vue.onUnmounted(() => {
  shouldRunBitcoinCheck = false;
});
</script>
