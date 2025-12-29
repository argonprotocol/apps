<!-- prettier-ignore -->
<template>
  <Overlay :disallowClose="true" :showCloseIcon="false" :isOpen="isOpen" class="w-6/12">
    <template #title>
      <div class="grow text-2xl font-bold">
        Wallet Funds Have Been Received
      </div>
    </template>

    <div class="flex min-h-60 w-full flex-row items-center justify-center gap-x-5 px-5 pt-3 pb-5"
         :class="{ 'flash-overlay': flash }">
      <div v-if="walletType === 'vaulting'">
        <template v-if="isProcessing == false">
          <VaultAllocation ref="vaultAllocation" :microgons-to-activate="microgonsReceived" />

          <div v-if="transactionError" class="flex flex-col px-5 pt-6 pb-3">
            <div class="flex flex-row items-center justify-center">
              <div class="flex flex-col items-center justify-center">
                <div class="text-2xl font-bold">Error</div>
                <div class="text-sm text-gray-500">{{ transactionError }}</div>
              </div>
            </div>
          </div>
          <div class="mt-10 flex flex-row items-center justify-end gap-x-3 border-t border-black/20 pt-4">
            <button
              class="cursor-pointer rounded-lg px-10 py-2 text-lg font-bold text-white"
              :class="[isProcessing ? 'bg-argon-600/60' : 'bg-argon-600 hover:bg-argon-700']"
              :disabled="isProcessing"
              @click="finalizeAllocation">
              <template v-if="isProcessing">Allocating...</template>
              <template v-else>Allocate These Funds</template>
            </button>
          </div>
        </template>

        <div v-if="isProcessing" class="flex flex-col space-y-5 px-28 pt-10 pb-20">
          <p class="font-light text-gray-700">
            Your request to allocate <strong>{{ microgonToArgonNm(microgonsReceived).format('0,0.[00]') }} argons</strong>
            has been submitted to the Argon network and is now awaiting finalization. This process usually takes four to
            five minutes to complete.
          </p>

          <p class="italic mb-2 font-light opacity-80">
            NOTE: You can close this overlay without disrupting the process.
          </p>

          <div class="mt-10">
            <div class="fade-progress text-center text-5xl font-bold">{{ numeral(progressPct).format('0.00') }}%</div>
          </div>

          <ProgressBar :progress="progressPct" :showLabel="false" class="h-4" />
          <div class="text-center font-light text-gray-500">
            {{ progressLabel }}
          </div>
          <button
            @click="closeOverlay"
            class="cursor-pointer rounded-lg bg-gray-200 px-10 py-2 text-lg font-bold text-black hover:bg-gray-300">
            {{  changes.length === 1 ? 'Close' : 'Show Next' }}
          </button>
        </div>
      </div>
      <div v-else>
        <div v-if="walletType === 'mining'">
          <strong>{{ fundsReceivedMessage }}</strong> been added to your <strong>mining</strong> wallet.
          Your mining bot will begin using these funds as soon as they're needed.
        </div>
        <div v-else>
          <strong>{{ fundsReceivedMessage }}</strong> been added to your <strong>holding</strong> wallet.
          You can choose how to distribute these funds from your wallet view.
        </div>

        <button
          @click="closeOverlay"
          class="inner-button-shadow bg-argon-600 hover:bg-argon-700 border-argon-700 mt-8 w-full cursor-pointer rounded-lg px-4 py-2 text-white focus:outline-none">
          {{  changes.length === 1 ? 'Ok' : 'Show Next' }}
        </button>
      </div>
    </div>
  </Overlay>
</template>

<script setup lang="ts">
import * as Vue from 'vue';
import { getConfig } from '../stores/config';
import { getCurrency } from '../stores/currency';
import Overlay from './Overlay.vue';
import numeral, { createNumeralHelpers } from '../lib/numeral';
import { IWalletType } from '../lib/Wallet.ts';
import ProgressBar from '../components/ProgressBar.vue';
import { getMyVault } from '../stores/vaults.ts';
import { useWallets } from '../stores/wallets.ts';
import VaultAllocation from '../components/VaultAllocation.vue';

const isOpen = Vue.computed(() => changes.value.length > 0);

const currency = getCurrency();
const config = getConfig();
const wallets = useWallets();
const myVault = getMyVault();

const { microgonToArgonNm, micronotToArgonotNm } = createNumeralHelpers(currency);

const fundsReceivedMessage = Vue.computed(() => {
  let message = '';
  if (microgonsReceived.value > 0n) {
    const amount = microgonToArgonNm(microgonsReceived.value).format('0,0.00');
    message += `${currency.symbol}${amount} argon${amount === '1.0' ? ' has' : 's have'}`;
  }
  if (micronotsReceived.value > 0n) {
    if (message.length > 0) {
      message += ' and ';
    }
    const amount = micronotToArgonotNm(micronotsReceived.value).format('0,0.00');
    message += `${currency.symbol}${amount} argonot${amount === '1.0' ? ' has' : 's have'}`;
  }
  return message;
});

const changes = Vue.ref<
  {
    walletType: IWalletType;
    microgonsAdded: bigint;
    micronotsAdded: bigint;
    blockHash: string;
  }[]
>([]);

const microgonsReceived = Vue.computed(() => changes.value[0]?.microgonsAdded ?? 0n);
const micronotsReceived = Vue.computed(() => changes.value[0]?.micronotsAdded ?? 0n);
const walletType = Vue.computed(() => changes.value[0]?.walletType ?? 'mining');

const vaultAllocation = Vue.ref<InstanceType<typeof VaultAllocation> | null>(null);

const isProcessing = Vue.ref(false);

const progressPct = Vue.ref(0);
const progressLabel = Vue.ref('');
const transactionError = Vue.ref('');
const flash = Vue.ref(false);

function closeOverlay() {
  changes.value.shift();

  progressPct.value = 0;
  transactionError.value = '';
  isProcessing.value = false;
}

Vue.watch(
  () => changes.value.length,
  (newLen, oldLen) => {
    if (newLen !== oldLen) {
      flash.value = false;
      requestAnimationFrame(() => {
        flash.value = true;
        setTimeout(() => (flash.value = false), 300); // length matches your CSS animation
      });
    }
  },
);

async function finalizeAllocation() {
  if (!myVault.createdVault || !vaultAllocation.value) return;
  const originalBaseCommitment = config.vaultingRules.baseMicrogonCommitment;
  try {
    isProcessing.value = true;
    transactionError.value = '';
    const allocation = vaultAllocation.value.getAllocation();

    const txInfo = await myVault.increaseVaultAllocations(allocation);
    config.vaultingRules.baseMicrogonCommitment +=
      allocation.addedSecuritizationMicrogons + allocation.addedTreasuryMicrogons;
    await config.saveVaultingRules();
    console.log('TX INFO', txInfo);
    txInfo.subscribeToProgress(async (args, error) => {
      progressPct.value = args.progressPct;
      progressLabel.value = args.progressMessage;
      if (error) {
        await failedVaultAllocation(error, originalBaseCommitment);
      }
    });
  } catch (err) {
    await failedVaultAllocation(err, originalBaseCommitment);
  }
}

async function failedVaultAllocation(error: unknown, originalBaseCommitment: bigint) {
  console.error('Error during vault allocation: %o', error);
  transactionError.value = 'Allocation failed, please try again';
  isProcessing.value = false;
  config.vaultingRules.baseMicrogonCommitment = originalBaseCommitment;
  await config.saveVaultingRules();
}

Vue.watch(walletType, newType => {
  console.log('Inbound funding wallet type changed to %s', newType);
  if (walletType.value === 'vaulting') {
    void vaultAllocation.value?.refreshData();
  }
});

let unsubscribe: (() => void) | null = null;
Vue.onMounted(() => {
  const unsub1 = wallets.on('transfer-in', (wallet, balanceChange) => {
    if (wallet.type === 'vaulting' && !config.isVaultReadyToCreate) {
      console.log('Skipping vaulting wallet change - no created vault');
      return;
    }
    if (wallet.type === 'mining' && !config.isMinerReadyToInstall) {
      console.log('Skipping mining wallet change - no created miner');
      return;
    }
    if (balanceChange.microgonsAdded === 0n && balanceChange.micronotsAdded === 0n) {
      console.log('Skipping wallet change - no funds added');
      return;
    }

    if (balanceChange.transfers.every(x => x.isInternal)) {
      console.log('Skipping wallet change - internal transfer(s) detected');
      return;
    }

    changes.value.push({
      walletType: wallet.type,
      microgonsAdded: balanceChange.microgonsAdded,
      micronotsAdded: balanceChange.micronotsAdded,
      blockHash: balanceChange.block.blockHash,
    });
  });
  const unsub2 = wallets.on('block-deleted', block => {
    changes.value = changes.value.filter(change => change.blockHash !== block.blockHash);
  });
  unsubscribe = () => {
    unsub1();
    unsub2();
  };
});

Vue.onMounted(async () => {
  await config.load();
  unsubscribe?.();
  unsubscribe = null;
});
</script>

<style scoped>
@reference "../main.css";

span[tag] {
  @apply ml-1 rounded-full px-2 text-xs font-bold text-white uppercase;
}
.flash-overlay {
  animation: flash-bg 0.3s ease;
}

@keyframes flash-bg {
  0% {
    background-color: rgba(255, 255, 0, 0.3);
  }
  100% {
    background-color: transparent;
  }
}
</style>
