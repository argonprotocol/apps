<template>
  <div class="flex flex-row items-center gap-x-2.5">
    <CopyToClipboard
      :content="props.wallet.address"
      :data-testid="props.walletAddressTestId"
      class="flex h-[34px] w-[34px] cursor-pointer items-center justify-center rounded-md border text-slate-500/60 hover:bg-[#f1f3f7]"
      :class="
        props.showBorders
          ? 'border-slate-400/60 hover:border-slate-500/60'
          : 'border-transparent hover:border-slate-500/30'
      "
    >
      <CopyIcon class="h-4" />
      <template #copying>
        <CopyIcon class="h-4" />
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
        <span
          class="flex h-[34px] w-[34px] cursor-pointer items-center justify-center rounded-md border text-slate-500/60 hover:bg-[#f1f3f7]"
          :class="
            props.showBorders
              ? 'border-slate-400/60 hover:border-slate-500/60'
              : 'border-transparent hover:border-slate-500/30'
          "
        >
          <MoreIcon class="h-4" />
        </span>
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
  showBorders?: boolean;
}>();
</script>
