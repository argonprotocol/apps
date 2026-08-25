<template>
  <div class="flex h-full grow flex-col text-black/90">
    <WalletHeader
      name="Receive Into Internal"
      :showHome="true"
      :isDragging="props.isDragging"
      @dragStart="emit('dragStart', $event)"
      @goto="emit('goto', $event)"
      @close="emit('close')"
    />

    <div class="px-6 py-4">
      <p class="text-md">
        Anyone can use the following address to send Argons and Argonots tokens directly to your wallet.
      </p>

      <div class="my-3 overflow-hidden rounded-md border border-slate-400/50 px-2 py-1.5 text-sm text-slate-700">
        {{ defaultArgonWallet.address }}
      </div>

      <p class="text-md py-3">The following QR code also encodes the same wallet address:</p>
      <img :src="qrCode" class="mt-1.5 w-40 max-w-full" :alt="`QR Code Wallet Address`" />
    </div>
  </div>
</template>

<script setup lang="ts">
import type { IWalletGuidanceContext } from '../../emitters/basicEmitter.ts';
import WalletHeader from './WalletHeader.vue';
import type { IWalletView } from '../walletOverlayState.ts';
import QRCode from 'qrcode';
import * as Vue from 'vue';
import { useWallets } from '../../stores/wallets.ts';
import { computed } from 'vue';

const wallets = useWallets();

const props = defineProps<{
  isDragging: boolean;
  showGuidance?: boolean;
  guidanceContext?: IWalletGuidanceContext;
}>();

const emit = defineEmits<{
  (event: 'dragStart', mouseEvent: MouseEvent): void;
  (event: 'goto', view: IWalletView): void;
  (event: 'close'): void;
}>();

const qrCode = Vue.ref('');

const defaultArgonWallet = computed(() => wallets.defaultArgonWallet);

async function loadQRCode() {
  let address = defaultArgonWallet.value.address;
  qrCode.value = await QRCode.toDataURL(address, {
    margin: 0,
    color: {
      dark: '#0f172a',
      light: '#0000',
    },
  });
}

Vue.onMounted(async () => {
  await wallets.load();
  void loadQRCode();
});
</script>
