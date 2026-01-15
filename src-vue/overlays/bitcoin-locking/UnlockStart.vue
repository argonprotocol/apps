<!-- prettier-ignore -->
<template>
  <div class="flex flex-col px-6 pt-3 pb-7">
    <div v-if="errorMessage" class="mb-6 px-3 text-red-700">{{ errorMessage }}</div>
    <div class="flex flex-col space-y-6 px-3 pt-3">
      <template v-if="canAfford">
        <div class="mb-6">
          <p class="mb-4 text-gray-700">
            You are releasing
            <strong>{{ numeral(currency.convertSatToBtc(personalLock.satoshis)).format('0,0.[00000000]') }} of Bitcoin</strong>,
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
            placeholder="bc1q..."
            class="focus:ring-argon-500 w-full rounded-md border border-slate-700/50 px-3 py-3 focus:border-transparent focus:ring-2" />
        </div>

        <!-- Fee Selection -->
        <div class="mb-10">
          <label class="mb-2 block font-medium text-gray-700">
            Desired Bitcoin Network Speed
            <span class="font-light">(how much you're willing to pay)</span>
          </label>
          <InputMenu v-model="selectedFeeRate" :options="feeRates" class="h-auto py-3 pl-3" />
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
import { BitcoinLockStatus, IBitcoinLockRecord } from '../../lib/db/BitcoinLocksTable.ts';
import { getBitcoinLocks } from '../../stores/bitcoin.ts';
import { getMyVault, getVaults } from '../../stores/vaults.ts';
import BitcoinLocksStore from '../../lib/BitcoinLocksStore.ts';
import numeral, { createNumeralHelpers } from '../../lib/numeral.ts';
import { getCurrency } from '../../stores/currency.ts';
import { useWallets } from '../../stores/wallets.ts';
import InputMenu from '../../components/InputMenu.vue';

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

const feeRatesByKey = Vue.ref<Record<string, { key: string; label: string; time: string; value: bigint }>>({
  fast: { key: 'fast', label: 'Fast', time: '~10 min', value: 10n },
  medium: { key: 'medium', label: 'Medium', time: '~30 min', value: 5n },
  slow: { key: 'slow', label: 'Slow', time: '~60 min', value: 3n },
});

const isSubmitting = Vue.ref(false);

const selectedFeeRate = Vue.ref('medium');
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
  return wallets.vaultingWallet.availableMicrogons - amountNeeded;
});

const canSendRequest = Vue.computed(() => {
  return destinationAddress.value.trim().length > 0 && !isSubmitting.value;
});

const feeRates = Vue.computed(() => {
  return Object.values(feeRatesByKey.value).map(rate => ({
    name: `${rate.label} = ${rate.time}`,
    value: rate.key,
    sats: rate.value,
  }));
});

function closeOverlay() {
  emit('close');
}

async function submitRelease() {
  if (!canSendRequest.value) return;

  try {
    isSubmitting.value = true;
    requestReleaseError.value = '';
    const toScriptPubkey = destinationAddress.value.trim();
    const feeRate = Object.values(feeRatesByKey.value).find(rate => rate.key === selectedFeeRate.value);
    const networkFee = await bitcoinLocks.calculateBitcoinNetworkFee(
      props.personalLock,
      feeRate?.value ?? 5n,
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
  const isLocked = [BitcoinLockStatus.LockedAndIsMinting, BitcoinLockStatus.LockedAndMinted].includes(
    props.personalLock.status,
  );
  if (!isLocked) return;

  releasePrice.value = await vaults.getRedemptionRate(props.personalLock);
  const latestFeeRates = await BitcoinLocksStore.getFeeRates();
  feeRatesByKey.value = Object.entries(latestFeeRates).reduce(
    (acc, [key, rate]) => {
      acc[key] = {
        key,
        label: key.charAt(0).toUpperCase() + key.slice(1),
        time: `~${rate.estimatedMinutes} min`,
        value: rate.feeRate,
      };
      return acc;
    },
    {} as Record<string, { key: string; label: string; time: string; value: bigint }>,
  );
}

Vue.onMounted(async () => {
  await myVault.load();
  await bitcoinLocks.load();
  void updateFeeRates();
});
</script>
