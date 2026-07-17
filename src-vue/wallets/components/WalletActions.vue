<template>
  <div class="flex flex-row items-center gap-x-3.5">
    <CopyToClipboard :content="props.wallet.address" :data-testid="props.walletAddressTestId" class="cursor-pointer">
      <CopyIcon class="h-4 opacity-80" />
      <template #copying>
        <CopyIcon class="h-4 opacity-100" />
      </template>
    </CopyToClipboard>
    <ExtraMenu
      :selection="props.selection"
      :wallet="props.wallet"
      :walletIsOpen="props.walletIsOpen"
      :canExportPrivateKey="props.canExportPrivateKey"
      :testIdPrefix="props.walletAddressTestId"
    >
      <template #trigger>
        <MoreIcon class="h-4 opacity-80" />
      </template>
    </ExtraMenu>
  </div>
</template>

<script setup lang="ts">
import CopyIcon from '../../assets/copy.svg';
import MoreIcon from '../../assets/more.svg';
import CopyToClipboard from '../../components/CopyToClipboard.vue';
import type { IWallet } from '../../lib/Wallet.ts';
import type { IWalletSelection } from '../walletOverlayState.ts';
import ExtraMenu from './ExtraMenu.vue';

const props = defineProps<{
  selection: IWalletSelection;
  wallet: IWallet;
  walletAddressTestId: string;
  walletIsOpen?: boolean;
  canExportPrivateKey?: boolean;
}>();
</script>
