<template>
  <div class="flex h-full grow flex-col text-black/90">
    <WalletHeader
      name="Receive Into Internal"
      :showHome="props.showBack"
      :isDragging="props.isDragging"
      @dragStart="emit('dragStart', $event)"
      @goto="emit('goto', $event)"
      @close="emit('close')"
    />

    <div class="flex grow flex-col px-6 py-4">
      <p>Your wallet address can receive Argons or Argonot tokens directly on the Argon network.</p>

      <WalletReceiveAddress
        :address="defaultArgonWallet.address"
        networkName="Argon"
        qrCodeTitle="Your Argon address:"
        data-testid="WalletViewReceive.address"
        class="my-3"
      />

      <p class="text-sm text-slate-500">
        <strong class="font-semibold">Note:</strong>
        This wallet address cannot receive transfers on the Bitcoin or Ethereum networks.
      </p>

      <p class="mt-auto border-t border-slate-300 pt-4">
        Bitcoin can be received through a Bitcoin channel.
        <button
          data-testid="WalletViewReceive.openBitcoinConnector()"
          type="button"
          class="text-argon-600 cursor-pointer hover:underline"
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
import WalletReceiveAddress from './WalletReceiveAddress.vue';
import { useWallets } from '../../stores/wallets.ts';
import { computed } from 'vue';

const wallets = useWallets();

const props = defineProps<{
  isDragging: boolean;
  showBack: boolean;
  showGuidance?: boolean;
  guidanceContext?: IWalletGuidanceContext;
}>();

const emit = defineEmits<{
  (event: 'dragStart', mouseEvent: MouseEvent): void;
  (event: 'goto', view: IWalletView): void;
  (event: 'openBitcoinConnector'): void;
  (event: 'close'): void;
}>();

const defaultArgonWallet = computed(() => wallets.defaultArgonWallet);
</script>
