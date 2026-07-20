<template>
  <DropdownMenuRoot>
    <DropdownMenuTrigger
      v-bind="$attrs"
      :data-testid="`${props.testIdPrefix}.open()`"
      class="hover:bg-argon-600/5 flex h-[34px] min-w-0 cursor-pointer flex-row items-center rounded-md px-2 focus:outline-none"
    >
      <div class="relative mr-1 w-4.5 border-r border-slate-300 pr-1">
        <ArgonNetworkLogo v-if="selectedWallet.walletType === WalletType.defaultArgon" class="h-full" />
        <EthereumNetworkLogo v-else-if="selectedWallet.walletType === WalletType.ethereum" class="h-full" />
      </div>
      <span class="truncate">{{ getWalletName(props.selectedWallet) }}</span>
      <ChevronDownIcon class="ml-1.5 w-4 shrink-0" />
    </DropdownMenuTrigger>

    <DropdownMenuPortal>
      <DropdownMenuContent
        align="start"
        :side="props.side"
        :sideOffset="8"
        :style="floatingZIndex"
        class="bg-argon-menu-bg min-w-64 rounded p-1 text-sm/6 font-semibold text-gray-900 shadow-lg ring-1 ring-gray-900/20"
      >
        <DropdownMenuItem
          v-for="wallet in props.walletSelections"
          :key="getWalletSelectionKey(wallet)"
          :data-testid="`${props.testIdPrefix}.select(${getWalletSelectionKey(wallet)})`"
          class="focus:bg-argon-menu-hover flex cursor-pointer items-center rounded px-3 py-2 focus:outline-none"
          @select="emit('select', wallet)"
        >
          <CheckIcon
            class="mr-2 h-4 w-4 shrink-0"
            :class="getWalletSelectionKey(wallet) === selectedWalletKey ? 'visible' : 'invisible'"
          />
          <span class="min-w-0 grow">
            <strong class="block truncate text-slate-800">{{ getWalletName(wallet) }}</strong>
            <span class="block font-mono text-xs font-normal text-slate-500">
              {{ abbreviateAddress(getWalletAddress(wallet), 8) }}
            </span>
          </span>
        </DropdownMenuItem>
        <DropdownMenuArrow :width="18" :height="10" class="fill-white stroke-gray-300" />
      </DropdownMenuContent>
    </DropdownMenuPortal>
  </DropdownMenuRoot>
</template>

<script setup lang="ts">
import { CheckIcon } from '@heroicons/vue/20/solid';
import { ChevronDownIcon } from '@heroicons/vue/24/outline';
import {
  DropdownMenuArrow,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuPortal,
  DropdownMenuRoot,
  DropdownMenuTrigger,
} from 'reka-ui';
import { computed } from 'vue';
import { abbreviateAddress } from '../../lib/Utils.ts';
import { WalletType } from '../../lib/Wallet.ts';
import { useFloatingZIndex } from '../../overlays/helpers/OverlayZIndex.ts';
import { useWallets } from '../../stores/wallets.ts';
import {
  getWalletSelectionKey,
  getWalletSelectionName,
  isEthereumWalletSelection,
  type IWalletSelection,
} from '../walletOverlayState.ts';
import ArgonNetworkLogo from '../../assets/wallets/networks/argon.svg';
import EthereumNetworkLogo from '../../assets/wallets/networks/ethereum.svg';

defineOptions({ inheritAttrs: false });

const props = withDefaults(
  defineProps<{
    selectedWallet: IWalletSelection;
    walletSelections: IWalletSelection[];
    testIdPrefix: string;
    side?: 'top' | 'right' | 'bottom' | 'left';
    getName?: (wallet: IWalletSelection) => string;
  }>(),
  {
    side: 'bottom',
  },
);

const emit = defineEmits<{
  (event: 'select', wallet: IWalletSelection): void;
}>();

const wallets = useWallets();
const floatingZIndex = useFloatingZIndex();
const selectedWalletKey = computed(() => getWalletSelectionKey(props.selectedWallet));

function getWalletName(wallet: IWalletSelection) {
  return props.getName?.(wallet) ?? getWalletSelectionName(wallet);
}

function getWalletAddress(wallet: IWalletSelection) {
  if (isEthereumWalletSelection(wallet)) return wallet.walletRecord.address;
  return wallet.walletType === WalletType.miningBot
    ? wallets.miningBotWallet.address
    : wallets.defaultArgonWallet.address;
}
</script>
