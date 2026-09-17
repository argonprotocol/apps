<template>
  <form class="space-y-4" @submit.prevent="sendBitcoin">
    <div class="rounded-md bg-slate-50 px-4 py-3">
      <div class="text-sm text-slate-500">Amount to send</div>
      <div class="mt-0.5 text-xl font-bold text-slate-800">
        {{ satToBtcNm(props.personalLock.fundedSatoshis).format('0,0.[00000000]') }} BTC
      </div>
    </div>

    <div>
      <label class="mb-1.5 block font-semibold text-slate-700">Destination Bitcoin address</label>
      <input
        v-model="destinationAddress"
        data-testid="BitcoinSend.destinationAddress"
        type="text"
        placeholder="bc1q..."
        :class="destinationAddressError ? 'border-red-400 text-red-900' : 'border-slate-700/40'"
        class="focus:ring-argon-500 w-full rounded-md border px-3 py-2.5 focus:border-transparent focus:ring-2"
      />
      <p class="mt-1.5 text-xs" :class="destinationAddressError ? 'font-semibold text-red-700' : 'text-slate-500'">
        {{ destinationAddressError || `Use a ${bitcoinNetworkName} address you control.` }}
      </p>
    </div>

    <BitcoinFeeRateInput v-model="feeRatePerSatVb" dataTestid="BitcoinSend.feeRate" />

    <p v-if="isCheckingArgonFee" class="text-sm text-slate-500">Checking the Internal App Wallet transaction fee...</p>
    <p v-else-if="argonFeeQuote && !argonFeeQuote.canAfford" class="text-sm text-red-700">
      Add {{ argonSymbol }}{{ microgonToArgonNm(argonFeeShortfall).format('0,0.[000000]') }} to the Internal App Wallet
      to cover the Argon transaction fee.
    </p>
    <p v-else-if="argonFeeQuote" class="text-sm text-slate-500">
      Argon transaction fee: approximately
      {{ argonSymbol }}{{ microgonToArgonNm(argonFeeQuote.txFee).format('0,0.[000000]') }}.
    </p>
    <p v-else-if="argonFeeQuoteError" class="text-sm text-red-700">{{ argonFeeQuoteError }}</p>

    <p v-if="formError" data-testid="BitcoinSend.error" class="text-sm font-semibold text-red-700">
      {{ formError }}
    </p>

    <button
      data-testid="BitcoinSend.submit()"
      :disabled="!canSubmit"
      class="bg-argon-600 hover:bg-argon-700 w-full cursor-pointer rounded-md px-5 py-2 font-semibold text-white disabled:cursor-not-allowed disabled:opacity-50"
    >
      {{ isSubmitting ? 'Sending Bitcoin...' : 'Send Bitcoin' }}
    </button>
  </form>
</template>

<script setup lang="ts">
import * as Vue from 'vue';
import { bigIntMax, UnitOfMeasurement } from '@argonprotocol/apps-core';

import BitcoinFeeRateInput from '../../overlays/bitcoin-locking/components/BitcoinFeeRateInput.vue';
import { getBitcoinNetworkName, validateBitcoinAddressForNetwork } from '../../lib/BitcoinAddressValidation.ts';
import { createNumeralHelpers } from '../../lib/numeral.ts';
import type { IBitcoinLockRecord } from '../../interfaces/IBitcoinLockRecord.ts';
import { getBitcoinLocks, getBitcoinTransactionOperations } from '../../stores/bitcoin.ts';
import { getCurrency } from '../../stores/currency.ts';
import { getWalletKeys, useWallets } from '../../stores/wallets.ts';

const props = defineProps<{
  personalLock: IBitcoinLockRecord;
  externalError?: string;
}>();

const emit = defineEmits<{
  done: [];
}>();

const bitcoinLocks = getBitcoinLocks();
const { bitcoinLockRelease } = getBitcoinTransactionOperations();
const currency = getCurrency();
const wallets = useWallets();
const { microgonToArgonNm, satToBtcNm } = createNumeralHelpers(currency);
const argonSymbol = currency.recordsByKey[UnitOfMeasurement.ARGN].symbol;

const destinationAddress = Vue.ref('');
const feeRatePerSatVb = Vue.ref(5n);
const isSubmitting = Vue.ref(false);
const requestError = Vue.ref('');
const argonFeeQuote = Vue.ref<{ canAfford: boolean; availableBalance: bigint; txFee: bigint; bitcoinFee: bigint }>();
const argonFeeQuoteError = Vue.ref('');
const isCheckingArgonFee = Vue.ref(false);

const trimmedDestinationAddress = Vue.computed(() => destinationAddress.value.trim());
const currentLockAddress = Vue.computed(() => {
  try {
    const scriptHash = props.personalLock.scriptDetails?.p2wshScriptHashHex;
    return scriptHash ? bitcoinLocks.formatP2wshAddress(scriptHash) : '';
  } catch {
    return '';
  }
});
const destinationAddressError = Vue.computed(() =>
  validateBitcoinAddressForNetwork(trimmedDestinationAddress.value, bitcoinLocks.bitcoinNetwork, {
    disallowAddress: currentLockAddress.value,
  }),
);
const bitcoinNetworkName = Vue.computed(() => getBitcoinNetworkName(bitcoinLocks.bitcoinNetwork));
const formError = Vue.computed(() => props.externalError || requestError.value);
const argonFeeShortfall = Vue.computed(() => {
  if (!argonFeeQuote.value) return 0n;
  return bigIntMax(argonFeeQuote.value.txFee - argonFeeQuote.value.availableBalance, 0n);
});
const canSubmit = Vue.computed(
  () =>
    !!props.personalLock.lockId &&
    trimmedDestinationAddress.value.length > 0 &&
    !destinationAddressError.value &&
    argonFeeQuote.value?.canAfford === true &&
    !isSubmitting.value,
);

Vue.watch(
  [trimmedDestinationAddress, feeRatePerSatVb, () => wallets.defaultArgonWallet.availableMicrogons],
  async (_values, _oldValues, onCleanup) => {
    argonFeeQuoteError.value = '';
    requestError.value = '';
    if (!trimmedDestinationAddress.value || destinationAddressError.value) {
      argonFeeQuote.value = undefined;
      isCheckingArgonFee.value = false;
      return;
    }

    let cancelled = false;
    onCleanup(() => (cancelled = true));
    isCheckingArgonFee.value = true;
    await refreshArgonFeeQuote(() => cancelled);
  },
  { immediate: true },
);

async function sendBitcoin(): Promise<void> {
  const quote = argonFeeQuote.value;
  const lockId = props.personalLock.lockId;
  if (!canSubmit.value || !quote || lockId == null) return;

  isSubmitting.value = true;
  requestError.value = '';
  try {
    await bitcoinLockRelease.submit({
      lockId: lockId,
      bitcoinNetworkFee: quote.bitcoinFee,
      destinationSatoshis: props.personalLock.fundedSatoshis - quote.bitcoinFee,
      toScriptPubkey: trimmedDestinationAddress.value,
      txSigner: await getWalletKeys().getLiquidLockingKeypair(),
    });
    emit('done');
  } catch (error) {
    requestError.value = error instanceof Error ? error.message : String(error);
  } finally {
    isSubmitting.value = false;
  }
}

async function refreshArgonFeeQuote(isCancelled: () => boolean): Promise<void> {
  const lockId = props.personalLock.lockId;
  if (lockId == null) return;

  try {
    const bitcoinFee = await bitcoinLocks.calculateBitcoinNetworkFee(
      props.personalLock,
      feeRatePerSatVb.value,
      trimmedDestinationAddress.value,
    );
    const prepared = await bitcoinLockRelease.prepare({
      lockId: lockId,
      bitcoinNetworkFee: bitcoinFee,
      destinationSatoshis: props.personalLock.fundedSatoshis - bitcoinFee,
      toScriptPubkey: trimmedDestinationAddress.value,
      txSigner: await getWalletKeys().getLiquidLockingKeypair(),
    });
    if (isCancelled()) return;
    argonFeeQuote.value = {
      canAfford: prepared.canAfford,
      availableBalance: prepared.availableBalance,
      txFee: prepared.txFeePlusTip,
      bitcoinFee,
    };
  } catch {
    if (isCancelled()) return;
    argonFeeQuote.value = undefined;
    argonFeeQuoteError.value = 'Unable to check the Argon transaction fee. Please try again.';
  } finally {
    if (!isCancelled()) isCheckingArgonFee.value = false;
  }
}
</script>
