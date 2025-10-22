<!-- prettier-ignore -->
<template>
  <DialogRoot class="absolute inset-0 z-10" :open="true">
    <DialogPortal>
      <AnimatePresence>
        <DialogOverlay asChild>
          <Motion asChild :initial="{ opacity: 0 }" :animate="{ opacity: 1 }" :exit="{ opacity: 0 }">
            <BgOverlay @close="closeOverlay" />
          </Motion>
        </DialogOverlay>

        <DialogContent asChild @escapeKeyDown="closeOverlay" :aria-describedby="undefined">
          <Motion
            :ref="draggable.setModalRef"
            @mousedown="draggable.onMouseDown($event)"
            :initial="{ opacity: 0 }"
            :animate="{ opacity: 1 }"
            :exit="{ opacity: 0 }"
            :style="{
              top: `calc(50% + ${draggable.modalPosition.y}px)`,
              left: `calc(50% + ${draggable.modalPosition.x}px)`,
              transform: 'translate(-50%, -50%)',
              cursor: draggable.isDragging ? 'grabbing' : 'default',
            }"
            class="absolute z-50 w-200 overflow-scroll rounded-lg border border-black/40 bg-white px-4 pt-2 pb-4 shadow-xl focus:outline-none"
          >
            <h2
              @mousedown="draggable.onMouseDown($event)"
              :style="{ cursor: draggable.isDragging ? 'grabbing' : 'grab' }"
              class="mb-2 flex w-full flex-row items-center space-x-4 border-b border-black/20 px-3 pt-3 pb-3 text-5xl font-bold"
            >
              <DialogTitle v-if="isWaitingToRelease" class="grow text-2xl font-bold">Unlock Your Bitcoin</DialogTitle>
              <DialogTitle v-else class="grow text-2xl font-bold">Unlocking Your {{ numeral(currency.satsToBtc(personalUtxo?.satoshis ?? 0n)).format('0,0.[00000000]') }} BTC...</DialogTitle>
              <div
                @click="closeOverlay"
                class="z-10 mr-1 flex h-[30px] w-[30px] cursor-pointer items-center justify-center rounded-md border border-slate-400/60 text-sm/6 font-semibold hover:border-slate-500/60 hover:bg-[#f1f3f7] focus:outline-none">
                <XMarkIcon class="h-5 w-5 stroke-4 text-[#B74CBA]" />
              </div>
            </h2>

            <div class="mb-6 px-3 text-red-700" v-if="errorMessage">{{ errorMessage }}</div>
            <div v-if="isWaitingToRelease" class="flex flex-col space-y-6 px-3 pt-3">
              <template v-if="canAfford">
                <div class="mb-6">
                  <p class="mb-4 text-gray-700">
                    You are releasing
                    <strong>
                      {{ numeral(currency.satsToBtc(lock.satoshis)).format('0,0.[00000000]') }} of Bitcoin
                    </strong>, which requires
                    <strong>{{ microgonToArgonNm(releasePrice).format('0,0.[000000]') }} argons to unlock</strong>.
                    These funds will be pulled directly from the available capital in your vaulting wallet.
                  </p>

                  <p>
                    In the fields below, choose where you want your bitcoin sent and the network speed you're willing to
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
                  @click="sendReleaseRequest"
                  :disabled="!canSendRequest || isSubmittingReleaseRequest"
                  class="w-full rounded-lg py-3 font-medium transition-all"
                  :class="
                    canSendRequest && !isSubmittingReleaseRequest
                      ? 'bg-red-500 text-white hover:bg-red-600'
                      : 'cursor-not-allowed bg-gray-200 text-gray-400'
                  ">
                  <span v-if="isSubmittingReleaseRequest">Releasing...</span>
                  <span v-else>Initiate Release</span>
                </button>
                <ProgressBar
                  v-if="isSubmittingReleaseRequest"
                  :progress="releaseProgress"
                  :has-error="errorMessage != ''"
                  class="mr-2 inline-block h-4 w-24" />
              </template>
              <template v-else>
                <div class="mb-6 text-red-700">
                  You must add ₳{{ microgonToArgonNm(neededMicrogons).format('0,0.[000000]') }} to your wallet to
                  release this Bitcoin.
                </div>
                <button @click="$emit('close')" class="w-full rounded-lg bg-gray-200 py-3 hover:bg-gray-300">
                  Close
                </button>
              </template>
            </div>
            <div v-else class="flex flex-col space-y-5 px-3.5 py-3">
              <p class="text-gray-700">
                Argon and Bitcoin networks are currently in the process of unlocking your
                {{ numeral(currency.satsToBtc(personalUtxo?.satoshis ?? 0n)).format('0,0.[00000000]') }} in BTC. This
                requires a series of four steps...
              </p>

              <div class="flex flex-row items-center justify-start w-full border-t border-gray-200 pt-5">
                <div v-if="stepByStatus[props.lock.status] === 1" spinner class="h-6 min-h-6 w-6 min-w-6 mr-3" />
                <Checkbox v-else :isChecked="stepByStatus[props.lock.status] > 1" class="mr-3" />
                <template v-if="stepByStatus[props.lock.status] === 1">Requesting</template>
                <template v-else>Requested</template>
                Release from Argon Network
              </div>

              <div class="flex flex-row items-center justify-start w-full border-t border-gray-200 pt-5">
                <div v-if="stepByStatus[props.lock.status] === 2" spinner class="h-6 min-h-6 w-6 min-w-6 mr-3" />
                <Checkbox v-else :isChecked="stepByStatus[props.lock.status] > 2" class="mr-3" />
                <template v-if="stepByStatus[props.lock.status] < 2">Await Approval from</template>
                <template v-else-if="stepByStatus[props.lock.status] === 2">Awaiting Approval from</template>
                <template v-else>Approved by</template>
                Argon Vault
              </div>

              <div class="flex flex-row items-center justify-start w-full border-t border-gray-200 pt-5">
                <div v-if="stepByStatus[props.lock.status] === 3" spinner class="h-6 min-h-6 w-6 min-w-6 mr-3" />
                <Checkbox v-else :isChecked="stepByStatus[props.lock.status] > 3" class="mr-3" />
                <template v-if="stepByStatus[props.lock.status] < 3">Submit</template>
                <template v-else-if="stepByStatus[props.lock.status] === 3">Submitting</template>
                <template v-else>Submitted</template>
                Transfer to Bitcoin Network.
              </div>

              <div class="flex flex-row items-center justify-start w-full border-y border-gray-200 py-5">
                <div v-if="stepByStatus[props.lock.status] === 4" spinner class="h-6 min-h-6 w-6 min-w-6 mr-3" />
                <Checkbox v-else :isChecked="stepByStatus[props.lock.status] > 4" class="mr-3" />
                <template v-if="stepByStatus[props.lock.status] < 4">Await</template>
                <template v-else-if="stepByStatus[props.lock.status] === 4">Waiting for</template>
                <template v-else>Completed</template>
                Bitcoin Finalization
              </div>

              <p class="text-gray-400 mb-2 font-bold">NOTE: You can close this overlay without it disrupting the process.</p>
            </div>
          </Motion>
        </DialogContent>
      </AnimatePresence>
    </DialogPortal>
  </DialogRoot>
</template>

<script setup lang="ts">
import * as Vue from 'vue';
import { BitcoinLockStatus, IBitcoinLockRecord } from '../lib/db/BitcoinLocksTable.ts';
import { useBitcoinLocks } from '../stores/bitcoin.ts';
import { useMyVault, useVaults } from '../stores/vaults.ts';
import { useConfig } from '../stores/config.ts';
import BitcoinLocksStore from '../lib/BitcoinLocksStore.ts';
import { createNumeralHelpers } from '../lib/numeral.ts';
import { useCurrency } from '../stores/currency.ts';
import numeral from 'numeral';
import { useWallets } from '../stores/wallets.ts';
import ProgressBar from '../components/ProgressBar.vue';
import Draggable from './helpers/Draggable';
import BgOverlay from '../components/BgOverlay.vue';
import { DialogContent, DialogOverlay, DialogPortal, DialogRoot, DialogTitle } from 'reka-ui';
import InputMenu from '../components/InputMenu.vue';
import { AnimatePresence, Motion } from 'motion-v';
import { XMarkIcon } from '@heroicons/vue/24/outline';
import Checkbox from '../components/Checkbox.vue';

const vaults = useVaults();
const myVault = useMyVault();
const bitcoinLocks = useBitcoinLocks();
const config = useConfig();
const currency = useCurrency();
const wallets = useWallets();
const { microgonToArgonNm } = createNumeralHelpers(currency);

const draggable = Vue.reactive(new Draggable());

const props = defineProps<{
  lock: IBitcoinLockRecord;
}>();

const emit = defineEmits<{
  close: [];
}>();

const stepByStatus: Record<any, number> = {
  [BitcoinLockStatus.ReleaseSubmittingToArgon]: 1,
  [BitcoinLockStatus.ReleaseWaitingForVault]: 2,
  [BitcoinLockStatus.ReleasedByVault]: 3,
  [BitcoinLockStatus.ReleaseProcessingOnBitcoin]: 4,
  [BitcoinLockStatus.ReleaseComplete]: 5,
};

const personalUtxo = Vue.computed(() => {
  const utxoId = myVault.metadata?.personalUtxoId;
  return utxoId ? bitcoinLocks.data.locksById[utxoId] : null;
});

const feeRatesByKey = Vue.ref<Record<string, { key: string; label: string; time: string; value: bigint }>>({
  fast: { key: 'fast', label: 'Fast', time: '~10 min', value: 10n },
  medium: { key: 'medium', label: 'Medium', time: '~30 min', value: 5n },
  slow: { key: 'slow', label: 'Slow', time: '~60 min', value: 3n },
});

const selectedFeeRate = Vue.ref('medium');
const destinationAddress = Vue.ref('');
const isSubmittingReleaseRequest = Vue.ref(false);
const requestReleaseError = Vue.ref('');

const errorMessage = Vue.computed(() => {
  return myVault.data.finalizeMyBitcoinError?.error ?? requestReleaseError.value;
});

const releasePrice = Vue.ref(0n);
const releaseProgress = Vue.ref(0);

const isWaitingToRelease = Vue.computed(() => {
  return [BitcoinLockStatus.LockedAndMinting, BitcoinLockStatus.LockedAndMinted].includes(props.lock.status);
});

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
  return destinationAddress.value.trim().length > 0 && !isSubmittingReleaseRequest.value;
});

const feeRates = Vue.computed(() => {
  return Object.values(feeRatesByKey.value).map(rate => ({
    name: `${rate.label} = ${rate.time}`,
    value: rate.key,
    sats: rate.value,
  }));
});

function closeOverlay() {
  console.log('Closing overlay');
  emit('close');
}

async function sendReleaseRequest() {
  if (!canSendRequest.value) return;

  releaseProgress.value = 0;
  try {
    isSubmittingReleaseRequest.value = true;
    requestReleaseError.value = '';
    const toScriptPubkey = destinationAddress.value.trim();
    const feeRate = Object.values(feeRatesByKey.value).find(rate => rate.key === selectedFeeRate.value);
    const networkFee = await bitcoinLocks.calculateBitcoinNetworkFee(props.lock, feeRate?.value ?? 5n, toScriptPubkey);

    let done = false;
    await bitcoinLocks.requestRelease({
      lock: props.lock,
      bitcoinNetworkFee: networkFee,
      toScriptPubkey,
      argonKeyring: config.vaultingAccount,
      txProgressCallback(progress: number) {
        // this callback will keep reporting until finalized, so we should stop updating once done
        if (done) return;
        releaseProgress.value = progress;
      },
    });
    done = true;
    // don't wait for this
    void myVault.finalizeMyBitcoinUnlock({
      argonKeyring: config.vaultingAccount,
      lock: props.lock,
      bitcoinXprivSeed: config.bitcoinXprivSeed,
      bitcoinLocks,
    });
  } catch (error) {
    console.error('Failed to send release request:', error);
    requestReleaseError.value = `Failed to send release request. ${error}`;
  } finally {
    isSubmittingReleaseRequest.value = false;
  }
  releaseProgress.value = 100;
}

async function updateFeeRates() {
  const isLocked = [BitcoinLockStatus.LockedAndMinting, BitcoinLockStatus.LockedAndMinted].includes(props.lock.status);
  if (!isLocked) return;

  releasePrice.value = await vaults.getRedemptionRate(props.lock);
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

<style scoped>
@reference "../main.css";

[spinner] {
  @apply relative -left-0.5 hidden h-8 min-h-8 w-8 min-w-8 border;
}

[spinner] {
  border-radius: 50%;
  display: block;
  border: 10px solid;
  border-color: rgba(166, 0, 212, 0.15) rgba(166, 0, 212, 0.25) rgba(166, 0, 212, 0.35) rgba(166, 0, 212, 0.5);
  animation: rotation 1s linear infinite;
}

@keyframes rotation {
  0% {
    transform: rotate(0deg);
  }
  100% {
    transform: rotate(360deg);
  }
}
</style>
