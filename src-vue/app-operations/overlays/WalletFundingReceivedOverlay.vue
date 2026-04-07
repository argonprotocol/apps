<!-- prettier-ignore -->
<template>
  <OverlayBase :disallowClose="true" :showCloseIcon="false" :isOpen="isOpen" class="w-6/12">
    <template #title>
      <div class="grow text-2xl font-bold">
        Wallet Funds Have Been Received
      </div>
    </template>

    <div class="flex min-h-60 w-full flex-col items-center justify-center gap-x-5 px-5 pt-3 pb-5" :class="{ 'flash-overlay': flash }">
      <div v-if="walletType === WalletType.miningHold">
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
  </OverlayBase>
</template>

<script setup lang="ts">
import * as Vue from 'vue';
import { Config, getConfig } from '../../stores/config.ts';
import { getCurrency } from '../../stores/currency.ts';
import { getMyVault } from '../../stores/vaults.ts';
import { getWalletKeys, useWallets } from '../../stores/wallets.ts';
import { getTransactionTracker } from '../../stores/transactions.ts';
import OverlayBase from '../../app-shared/overlays/OverlayBase.vue';
import { MoveCapital } from '../../lib/MoveCapital.ts';
import { createNumeralHelpers } from '../../lib/numeral.ts';
import type { IWallet } from '../../lib/Wallet.ts';
import { IWalletType, WalletType } from '../../lib/Wallet.ts';
import { MiningSetupStatus, VaultingSetupStatus } from '../../interfaces/IConfig.ts';

const isOpen = Vue.computed(() => changes.value.length > 0);

const currency = getCurrency();
const config = getConfig();
const wallets = useWallets();
const walletKeys = getWalletKeys();
const myVault = getMyVault();
const transactionTracker = getTransactionTracker();
const moveCapital = new MoveCapital(walletKeys, transactionTracker, myVault);

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
const walletType = Vue.computed(() => changes.value[0]?.walletType ?? WalletType.miningHold);

const isProcessing = Vue.ref(false);

const progressPct = Vue.ref(0);
const progressLabel = Vue.ref('');
const transactionError = Vue.ref('');
const flash = Vue.ref(false);
let isAutoTransferringMiningHold = false;
let shouldRetryAutoTransfer = false;
const RECENT_TRANSFER_WINDOW_MS = 24 * 60 * 60 * 1000;

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

async function queueMiningHoldAutoTransfer(wallet: IWallet) {
  if (isAutoTransferringMiningHold) {
    shouldRetryAutoTransfer = true;
    return;
  }

  isAutoTransferringMiningHold = true;
  try {
    // If new funds arrive while the sweep tx is still pending, rerun once against the latest balance
    // after the in-flight transfer settles instead of submitting a second transfer in parallel.
    do {
      shouldRetryAutoTransfer = false;
      const sweepTxInfo = await moveCapital.moveAvailableMiningHoldToBot(wallet, walletKeys, config as Config);
      if (sweepTxInfo) {
        await sweepTxInfo.waitForPostProcessing.catch(error => {
          console.error('[WalletFundingReceivedOverlay] Mining hold sweep failed while waiting to retry', error);
        });
      }
    } while (shouldRetryAutoTransfer);
  } finally {
    isAutoTransferringMiningHold = false;
  }
}

function isRecentTransfer(blockTime: number): boolean {
  return Date.now() - blockTime <= RECENT_TRANSFER_WINDOW_MS;
}

let unsubscribe: (() => void) | null = null;
Vue.onMounted(() => {
  const unsub1 = wallets.on('transfer-in', (wallet, balanceChange) => {
    if (!isRecentTransfer(balanceChange.block.blockTime)) {
      console.log('Skipping wallet change - transfer is older than popup window', balanceChange.block);
      return;
    }

    if (
      wallet.type === WalletType.miningHold &&
      config.isServerInstalled &&
      !config.hasMiningSeats &&
      (balanceChange.microgonsAdded > 0n || balanceChange.micronotsAdded > 0n) &&
      balanceChange.transfers.some(x => x.isInbound && !x.isInternal)
    ) {
      void queueMiningHoldAutoTransfer(wallet).catch(error => {
        console.error('[WalletFundingReceivedOverlay] Failed to auto-transfer mining hold funds', error);
      });
      return;
    }

    if (wallet.type === 'vaulting' && config.vaultingSetupStatus !== VaultingSetupStatus.Finished) {
      console.log('Skipping vaulting wallet change - no created vault');
      return;
    }
    if (wallet.type === WalletType.miningHold && config.miningSetupStatus !== MiningSetupStatus.Finished) {
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

Vue.onUnmounted(() => {
  unsubscribe?.();
  unsubscribe = null;
});
</script>

<style scoped>
@reference "../../main.css";

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
