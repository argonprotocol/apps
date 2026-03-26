<template>
  <div class="px-10 pt-3">
    <p class="mt-5 mb-4 text-gray-600 select-text">
      You must send exactly
      <strong>{{ numeral(currency.convertSatToBtc(props.personalLock.satoshis)).format('0,0.[00000000]') }} BTC</strong>
      (or
      {{ numeral(props.personalLock.satoshis).format('0,0') }}
      sats) to the multi-sig cosign address listed below. If the amount differs, we’ll pause and let you choose whether
      to accept the adjusted amount or return the transfer.
    </p>

    <p class="mt-5 mb-4 text-gray-600 select-text">
      You have
      <CountdownClock :time="fundingExpirationTime" v-slot="{ days, hours, minutes, seconds }">
        <template v-if="days > 0">{{ days }} day{{ days === 1 ? '' : 's' }}</template>
        <template v-else>{{ hours }}h, {{ minutes }}m, and {{ seconds }}s</template>
      </CountdownClock>
      to complete this step.
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
      <template v-if="showQrCode">
        <p class="w-full text-left">
          Many Bitcoin wallets allow you scan the following QR code to pre-fill the transfer details (
          <span @click="showQrCode = false" class="text-argon-600 cursor-pointer">hide</span>
          ).
        </p>
        <BitcoinQrCode class="mt-5 h-44 w-44 text-center" :bip21="fundingBip21" v-if="fundingBip21" />
        <CopyToClipboard data-testid="fundingBip21" :content="fundingBip21" class="relative mb-4 cursor-pointer">
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
      </template>
      <div v-else class="w-full text-left">
        Alternatively,
        <span @click="showQrCode = true" class="text-argon-600 cursor-pointer">click to scan our QR code</span>
        into your wallet.
      </div>
    </div>

    <div class="mb-4 border-t border-gray-300 pt-4 pb-1 text-gray-500">
      <div class="flex flex-row items-center">
        <Spinner class="mr-3" />
        We're monitoring Bitcoin's network and will update this screen when your transaction is received.
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import * as Vue from 'vue';
import dayjs from 'dayjs';
import utc from 'dayjs/plugin/utc';
import numeral from '../../lib/numeral';
import { abbreviateAddress } from '../../lib/Utils';
import CopyToClipboard from '../../components/CopyToClipboard.vue';
import BitcoinQrCode from '../../components/BitcoinQrCode.vue';
import CountdownClock from '../../components/CountdownClock.vue';
import CopyIcon from '../../assets/copy.svg?component';
import { IBitcoinLockRecord } from '../../lib/db/BitcoinLocksTable.ts';
import { SATS_PER_BTC } from '@argonprotocol/mainchain';
import { getCurrency } from '../../stores/currency.ts';
import { getBitcoinLocks } from '../../stores/bitcoin.ts';
import Spinner from '../../components/Spinner.vue';

dayjs.extend(utc);

const props = defineProps<{
  personalLock: IBitcoinLockRecord;
}>();

const currency = getCurrency();
const bitcoinLocks = getBitcoinLocks();

const showQrCode = Vue.ref(false);
const fundingBip21 = Vue.ref('');
const scriptPaytoAddress = Vue.ref('');
const fundingExpirationTime = Vue.ref(dayjs.utc());

Vue.onMounted(async () => {
  await bitcoinLocks.load();
  fundingExpirationTime.value = dayjs.utc(bitcoinLocks.verifyExpirationTime(props.personalLock));
  try {
    scriptPaytoAddress.value = bitcoinLocks.formatP2wshAddress(props.personalLock.lockDetails.p2wshScriptHashHex);
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
});
</script>
