<template>
  <DropdownMenuRoot v-model:open="isOpen">
    <DropdownMenuTrigger
      ref="menuTrigger"
      :aria-label="`${props.moveToken} actions`"
      class="focus-visible:outline-argon-600 absolute inset-0 cursor-pointer focus-visible:outline-2"
      @click.capture="setMenuPosition"
      @contextmenu.prevent="
        setMenuPosition($event);
        isOpen = true;
      "
      @keydown="pointerPosition = undefined"
    />
    <DropdownMenuPortal>
      <DropdownMenuContent
        side="bottom"
        align="center"
        :sideOffset="4"
        :collisionPadding="30"
        :reference="menuReference"
        :style="floatingZIndex"
        class="bg-argon-menu-bg flex min-w-48 flex-col rounded p-1 text-sm/6 text-gray-900 shadow-lg ring-1 ring-gray-900/20"
      >
        <DropdownMenuItem :disabled="!props.canSend" @select="emit('send')">
          Send {{ props.moveToken }}
        </DropdownMenuItem>
        <DropdownMenuSeparator class="my-1 h-px bg-slate-400/30" />
        <DropdownMenuItem @select="emit('receive')">Receive {{ props.moveToken }}</DropdownMenuItem>
        <template v-if="props.moveToken !== MoveToken.BTC">
          <DropdownMenuSeparator class="my-1 h-px bg-slate-400/30" />
          <DropdownMenuItem asChild :disabled="!uniswapUrl">
            <a :href="uniswapUrl" target="_blank" rel="noreferrer">Uniswap Market</a>
          </DropdownMenuItem>
          <DropdownMenuSeparator class="my-1 h-px bg-slate-400/30" />
          <DropdownMenuItem asChild :disabled="!etherscanUrl">
            <a :href="etherscanUrl" target="_blank" rel="noreferrer">Etherscan Details</a>
          </DropdownMenuItem>
          <p v-if="isLoadingLinks" class="px-3 py-2 text-xs text-slate-500">Loading token links...</p>
          <p v-else-if="linkError" role="status" class="max-w-64 px-3 py-2 text-xs text-slate-500">
            {{ linkError }}
          </p>
        </template>
        <DropdownMenuArrow :width="22" :height="12" class="fill-argon-menu-bg stroke-gray-300" />
      </DropdownMenuContent>
    </DropdownMenuPortal>
  </DropdownMenuRoot>
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { MoveToken, raceWithTimeout } from '@argonprotocol/apps-core';
import {
  DropdownMenuArrow,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuPortal,
  DropdownMenuRoot,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from 'reka-ui';
import { loadEthereumChainConfig, type IEthereumChainConfig } from '../../lib/EthereumClient.ts';
import { useFloatingZIndex } from '../../overlays/helpers/OverlayZIndex.ts';

const props = defineProps<{
  moveToken: MoveToken;
  canSend: boolean;
}>();
const emit = defineEmits<{
  (event: 'send'): void;
  (event: 'receive'): void;
}>();

const floatingZIndex = useFloatingZIndex(2);
const isOpen = ref(false);
const menuTrigger = ref<InstanceType<typeof DropdownMenuTrigger>>();
const pointerPosition = ref<{ x: number; y: number }>();
const menuReference = computed(() => {
  const point = pointerPosition.value;
  return {
    getBoundingClientRect: () =>
      point ? new DOMRect(point.x, point.y, 0, 0) : (menuTrigger.value?.$el.getBoundingClientRect() ?? new DOMRect()),
  };
});
const chainConfig = ref<IEthereumChainConfig>();
const isLoadingLinks = ref(false);
const linkError = ref('');
const tokenAddress = computed(() =>
  props.moveToken === MoveToken.ARGNOT ? chainConfig.value?.argonotTokenAddress : chainConfig.value?.argonTokenAddress,
);
const uniswapUrl = computed(() => {
  if (!tokenAddress.value) return;
  if (chainConfig.value?.chainId === 1) {
    return `https://app.uniswap.org/explore/tokens/ethereum/${tokenAddress.value}`;
  }
  if (chainConfig.value?.chainId === 11155111) {
    return `https://app.uniswap.org/#/swap?chain=sepolia&outputCurrency=${tokenAddress.value}`;
  }
  return undefined;
});
const etherscanUrl = computed(() => {
  if (!tokenAddress.value) return;
  if (chainConfig.value?.chainId === 1) return `https://etherscan.io/token/${tokenAddress.value}`;
  if (chainConfig.value?.chainId === 11155111) return `https://sepolia.etherscan.io/token/${tokenAddress.value}`;
  return undefined;
});

function setMenuPosition(event: MouseEvent) {
  pointerPosition.value =
    event.type === 'click' && event.detail === 0 ? undefined : { x: event.clientX, y: event.clientY };
}

async function loadTokenLinks(open: boolean) {
  if (!open || props.moveToken === MoveToken.BTC || isLoadingLinks.value) return;

  isLoadingLinks.value = true;
  linkError.value = '';
  try {
    chainConfig.value = await raceWithTimeout(loadEthereumChainConfig(), 15_000, () => {
      throw new Error('Ethereum token configuration timed out');
    });
    if (!chainConfig.value) {
      linkError.value = 'Token links unavailable. Reopen this menu to retry.';
    }
  } catch {
    linkError.value = 'Token links unavailable. Reopen this menu to retry.';
  } finally {
    isLoadingLinks.value = false;
  }
}

watch(isOpen, loadTokenLinks);
</script>

<style scoped>
@reference "../../main.css";

[data-reka-collection-item] {
  @apply hover:bg-argon-menu-hover focus:bg-argon-menu-hover cursor-pointer rounded px-3 py-1 focus:outline-none;

  &[data-disabled] {
    @apply pointer-events-none text-gray-400;
  }
}
</style>
