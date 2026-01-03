<!-- prettier-ignore -->
<template>
  <Overlay :disallowClose="true" :showCloseIcon="false" :isOpen="isOpen" class="w-6/12">
    <template #title>
      <div class="grow text-2xl font-bold">
        Wallet Funds Have Been Received
      </div>
    </template>

    <div class="flex min-h-60 w-full flex-row items-center justify-center gap-x-5 px-5 pt-3 pb-5" :class="{ 'flash-overlay': flash }">
      <div v-if="walletType === WalletType.mining">
        <strong>{{ fundsReceivedMessage }}</strong> been added to your <strong>mining</strong> wallet.
        You can choose how to distribute these funds from your Mining tab.
      </div>
      <div v-else>
        <strong>{{ fundsReceivedMessage }}</strong> been added to your <strong>vaulting</strong> wallet.
        You can choose how to distribute these funds from your Vaulting tab.
      </div>

      <button
        @click="closeOverlay"
        class="inner-button-shadow bg-argon-600 hover:bg-argon-700 border-argon-700 mt-8 w-full cursor-pointer rounded-lg px-4 py-2 text-white focus:outline-none">
        {{  changes.length === 1 ? 'Ok' : 'Show Next' }}
      </button>
    </div>
  </Overlay>
</template>

<script setup lang="ts">
import * as Vue from 'vue';
import { getConfig } from '../stores/config';
import { getCurrency } from '../stores/currency';
import Overlay from './Overlay.vue';
import { createNumeralHelpers } from '../lib/numeral';
import { IWalletType, WalletType } from '../lib/Wallet.ts';
import { useWallets } from '../stores/wallets.ts';

const isOpen = Vue.computed(() => changes.value.length > 0);

const currency = getCurrency();
const config = getConfig();
const wallets = useWallets();

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
const walletType = Vue.computed(() => changes.value[0]?.walletType ?? WalletType.mining);

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

let unsubscribe: (() => void) | null = null;
Vue.onMounted(() => {
  const unsub1 = wallets.on('transfer-in', (wallet, balanceChange) => {
    if (wallet.type === 'vaulting' && !config.isVaultReadyToCreate) {
      console.log('Skipping vaulting wallet change - no created vault');
      return;
    }
    if (wallet.type === WalletType.mining && !config.isMinerReadyToInstall) {
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
