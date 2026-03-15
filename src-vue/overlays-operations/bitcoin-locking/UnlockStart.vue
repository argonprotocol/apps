<!-- prettier-ignore -->
<template>
  <div class="flex flex-col px-6 pt-3 pb-7">
    <div v-if="errorMessage" class="mb-6 px-3 text-red-700">{{ errorMessage }}</div>
    <div class="flex flex-col space-y-6 px-3 pt-3">
      <template v-if="canAfford">
        <div class="mb-6">
          <p class="mb-4 text-gray-700">
            You are releasing
            <strong>{{ numeral(currency.convertSatToBtc(fundingUtxoRecord?.satoshis ?? personalLock.satoshis)).format('0,0.[00000000]') }} of Bitcoin</strong>,
            which requires
            <strong>{{ microgonToArgonNm(releasePrice).format('0,0.[000000]') }} argons to unlock</strong>.
            These funds will be pulled directly from available capital in your vaulting wallet.
          </p>

          <p>
            use the fields below to choose where you want your bitcoin sent and the network speed you're willing to
            pay.
          </p>
        </div>

        <!-- Destination Address -->
        <div class="mb-6">
          <label class="mb-2 block font-medium text-gray-700">
            Destination Bitcoin Address
            <span class="font-light">(where you want to receive it)</span>
          </label>
          <input
            v-model="destinationAddress"
            type="text"
            data-testid="UnlockStart.destinationAddress"
            placeholder="bc1q..."
            :class="destinationAddressError ? 'border-red-400 text-red-900 placeholder:text-red-300' : 'border-slate-700/50'"
            class="focus:ring-argon-500 w-full rounded-md border px-3 py-3 focus:border-transparent focus:ring-2" />
          <p
            class="mt-2 text-xs"
            :class="destinationAddressError ? 'font-semibold text-red-700' : 'text-slate-500'">
            {{ destinationAddressError || destinationAddressHelper }}
          </p>
        </div>

        <!-- Fee Selection -->
        <div class="mb-10">
          <BitcoinFeeRateInput v-model="selectedFeeRatePerSatVb" dataTestid="UnlockStart.feeRate" />
        </div>

        <button
          :class="[!canSendRequest || isSubmitting ? 'bg-argon-600/60 pointer-events-none' : 'bg-argon-600 hover:bg-argon-700']"
          :disabled="!canSendRequest || isSubmitting"
          @click="submitRelease"
          class="cursor-pointer rounded-lg px-10 py-2 text-lg font-bold text-white"
        >
          <span v-if="isSubmitting">Releasing...</span>
          <span v-else>Initiate Release</span>
        </button>
      </template>
      <template v-else>
        <div class="mb-6 text-red-700">
          You must add ₳{{ microgonToArgonNm(neededMicrogons).format('0,0.[000000]') }} to your wallet to
          release this Bitcoin.
        </div>
        <button @click="closeOverlay" class="w-full rounded-lg bg-gray-200 py-3 hover:bg-gray-300">
          Close
        </button>
      </template>
    </div>
  </div>
</template>

<script setup lang="ts">
import * as Vue from 'vue';
import { getBitcoinNetworkName, validateBitcoinAddressForNetwork } from '../../lib/BitcoinAddressValidation.ts';
import { IBitcoinLockRecord } from '../../lib/db/BitcoinLocksTable.ts';
import { getBitcoinLocks } from '../../stores/bitcoin.ts';
import { getMyVault, getVaults } from '../../stores/vaults.ts';
import numeral, { createNumeralHelpers } from '../../lib/numeral.ts';
import { getCurrency } from '../../stores/currency.ts';
import { useWallets } from '../../stores/wallets.ts';
import BitcoinFeeRateInput from './components/BitcoinFeeRateInput.vue';

const vaults = getVaults();
const myVault = getMyVault();
const bitcoinLocks = getBitcoinLocks();
const currency = getCurrency();
const wallets = useWallets();
const { microgonToArgonNm } = createNumeralHelpers(currency);

const props = defineProps<{
  personalLock: IBitcoinLockRecord;
}>();

const emit = defineEmits<{
  close: [];
}>();

const isSubmitting = Vue.ref(false);

const selectedFeeRatePerSatVb = Vue.ref(5n);
const destinationAddress = Vue.ref('');
const requestReleaseError = Vue.ref('');

const errorMessage = Vue.computed(() => {
  return myVault.data.finalizeMyBitcoinError?.error ?? requestReleaseError.value;
});

const releasePrice = Vue.ref(0n);

const canAfford = Vue.computed(() => {
  return neededMicrogons.value <= 0n;
});

const neededMicrogons = Vue.computed(() => {
  const amountNeeded = releasePrice.value + 25_000n; // 25,000 txfee buffer
  if (wallets.vaultingWallet.availableMicrogons >= amountNeeded) {
    return 0n;
  }
  return amountNeeded - wallets.vaultingWallet.availableMicrogons;
});

const trimmedDestinationAddress = Vue.computed(() => destinationAddress.value.trim());
const currentLockAddress = Vue.computed(() => {
  try {
    return bitcoinLocks.formatP2wshAddress(props.personalLock.lockDetails.p2wshScriptHashHex);
  } catch {
    return '';
  }
});
const destinationAddressError = Vue.computed(() => {
  return validateBitcoinAddressForNetwork(trimmedDestinationAddress.value, bitcoinLocks.bitcoinNetwork, {
    disallowAddress: currentLockAddress.value,
  });
});
const isDestinationAddressValid = Vue.computed(() => {
  return trimmedDestinationAddress.value.length > 0 && !destinationAddressError.value;
});
const destinationAddressHelper = Vue.computed(() => {
  const networkName = getBitcoinNetworkName(bitcoinLocks.bitcoinNetwork);
  if (isDestinationAddressValid.value) {
    return `Released funds will be sent exactly to this address on ${networkName}. Make sure you control it.`;
  }
  return `Use a ${networkName} address you control. Released funds will be sent exactly to this address.`;
});
const canSendRequest = Vue.computed(() => {
  return isDestinationAddressValid.value && !isSubmitting.value;
});
const fundingUtxoRecord = Vue.computed(() => bitcoinLocks.getAcceptedFundingRecord(props.personalLock));

function closeOverlay() {
  emit('close');
}

async function submitRelease() {
  if (!canSendRequest.value) return;

  try {
    requestReleaseError.value = '';
    const toScriptPubkey = trimmedDestinationAddress.value;
    if (!toScriptPubkey) {
      requestReleaseError.value = 'Enter a Bitcoin address for the released funds.';
      return;
    }
    if (destinationAddressError.value) {
      requestReleaseError.value = destinationAddressError.value;
      return;
    }
    isSubmitting.value = true;
    const networkFee = await bitcoinLocks.calculateBitcoinNetworkFee(
      props.personalLock,
      selectedFeeRatePerSatVb.value,
      toScriptPubkey,
    );

    await bitcoinLocks.requestBitcoinRelease({
      utxoId: props.personalLock.utxoId!,
      bitcoinNetworkFee: networkFee,
      toScriptPubkey,
    });
  } catch (error) {
    console.error('Failed to send release request:', error);
    requestReleaseError.value = `Failed to send release request. ${error}`;
    isSubmitting.value = false;
  }
}

async function updateFeeRates() {
  const isLocked = bitcoinLocks.isLockedStatus(props.personalLock);
  if (!isLocked) return;

  releasePrice.value = await vaults.getRedemptionRate(props.personalLock);
}

Vue.onMounted(async () => {
  await myVault.load();
  await bitcoinLocks.load();
  void updateFeeRates();
});
</script>
