<template>
  <OverlayBase
    :isOpen="!!walletRecord"
    :disallowClose="isDisconnecting"
    class="w-xl"
    @close="closeOverlay"
    @pressEsc="closeOverlay"
  >
    <template #title>
      <div class="grow text-2xl font-bold">Disconnect{{ walletRecord ? '' : 'ing'}} {{ walletRecord?.name }}?</div>
    </template>

    <div v-if="walletRecord" class="px-6 py-5 text-gray-700">
      <p v-if="walletRecord.role === 'defaultEthereum'" class="mt-1">
        The app will refresh this wallet and verify that all tracked token balances are zero. A wallet containing any
        tokens cannot be disconnected.
      </p>
      <p v-else class="mt-1">
        This removes the wallet and its locally stored credentials from this app. It does not move or delete any
        on-chain funds, so make sure you can recover the wallet before continuing.
      </p>

      <div v-if="errorMessage" class="mt-4 rounded border border-red-400/50 bg-red-50 px-4 py-3 text-red-700">
        {{ errorMessage }}
      </div>

      <div class="mt-6 flex flex-row justify-end gap-3 border-t border-slate-300 pt-4">
        <button
          type="button"
          :disabled="isDisconnecting"
          class="border-argon-button text-argon-button hover:border-argon-button-hover hover:text-argon-button-hover rounded border bg-white px-5 py-2 disabled:opacity-50"
          @click="closeOverlay"
        >
          Cancel
        </button>
        <button
          type="button"
          :disabled="isDisconnecting"
          class="bg-argon-button border-argon-button-hover hover:bg-argon-button-hover rounded border px-5 py-2 font-bold text-white disabled:cursor-default disabled:opacity-50"
          @click="disconnectWallet"
        >
          {{ isDisconnecting ? 'Disconnecting...' : 'Yes, Disconnect' }}
        </button>
      </div>
    </div>
  </OverlayBase>
</template>

<script setup lang="ts">
import * as Vue from 'vue';
import basicEmitter from '../emitters/basicEmitter.ts';
import type { IWalletRecord } from '../lib/db/WalletsTable.ts';
import { useWallets } from '../stores/wallets.ts';
import OverlayBase from './OverlayBase.vue';

const wallets = useWallets();
const walletRecord = Vue.ref<IWalletRecord>();
const isDisconnecting = Vue.ref(false);
const errorMessage = Vue.ref('');

function openOverlay(record: IWalletRecord) {
  walletRecord.value = record;
  errorMessage.value = '';
  isDisconnecting.value = false;
}

function closeOverlay() {
  if (isDisconnecting.value) return;
  walletRecord.value = undefined;
  errorMessage.value = '';
}

async function disconnectWallet() {
  const record = walletRecord.value;
  if (!record || isDisconnecting.value) return;

  isDisconnecting.value = true;
  errorMessage.value = '';
  try {
    await wallets.disconnectEthereumWalletRecord(record.id);
    walletRecord.value = undefined;
    basicEmitter.emit('ethereumWalletDisconnected', { walletRecordId: record.id });
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : 'Unable to disconnect the wallet.';
  } finally {
    isDisconnecting.value = false;
  }
}

basicEmitter.on('openWalletDisconnectOverlay', openOverlay);
Vue.onBeforeUnmount(() => {
  basicEmitter.off('openWalletDisconnectOverlay', openOverlay);
});
</script>
