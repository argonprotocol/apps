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
      <p>Anyone can use the following address to send Argons and Argonots tokens directly to your wallet.</p>

      <CopyToClipboard
        :content="defaultArgonWallet.address"
        data-testid="WalletViewReceive.address"
        class="my-3 flex cursor-pointer items-center gap-2 overflow-hidden rounded-md border border-slate-400/50 px-2 py-1.5"
      >
        <span class="min-w-0 grow truncate font-mono select-all">
          {{ defaultArgonWallet.address }}
        </span>
        <CopyIcon class="h-4 w-4 shrink-0" />
        <template #copying><CheckIcon class="h-4 w-4 shrink-0 text-green-600" /></template>
      </CopyToClipboard>

      <p class="py-3">The following QR code also encodes the same wallet address:</p>
      <img :src="qrCode" class="mt-1.5 w-40 max-w-full" :alt="`QR Code Wallet Address`" />

      <p class="mt-6 border-t border-slate-300 pt-4">
        Bitcoin can be received through a Bitcoin channel.
        <button
          data-testid="WalletViewReceive.openBitcoinConnector()"
          type="button"
          class="text-argon-600 hover:underline"
          @click="emit('openBitcoinConnector')"
        >
          Open Bitcoin channels
        </button>
      </p>
    </div>
  </div>
</template>

<script setup lang="ts">
import type { IWalletGuidanceContext } from '../../emitters/basicEmitter.ts';
import WalletHeader from './WalletHeader.vue';
import type { IWalletView } from '../walletOverlayState.ts';
import QRCode from 'qrcode';
import * as Vue from 'vue';
import { CheckIcon } from '@heroicons/vue/24/outline';
import CopyIcon from '../../assets/copy.svg';
import CopyToClipboard from '../../components/CopyToClipboard.vue';
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
  (event: 'openBitcoinConnector'): void;
  (event: 'close'): void;
}>();

const qrCode = Vue.ref('');

const defaultArgonWallet = computed(() => wallets.defaultArgonWallet);

async function loadQRCode(address: string) {
  qrCode.value = await QRCode.toDataURL(address, {
    margin: 0,
    color: {
      dark: '#0f172a',
      light: '#0000',
    },
  });
}

Vue.watch(
  () => defaultArgonWallet.value.address,
  address => void loadQRCode(address),
  { immediate: true },
);
</script>
