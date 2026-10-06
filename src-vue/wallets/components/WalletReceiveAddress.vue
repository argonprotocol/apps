<template>
  <div class="flex items-center rounded-md border border-slate-300 bg-slate-50 pr-1 text-sm">
    <CopyToClipboard
      :content="props.address"
      :title="`Copy ${props.networkName} address`"
      class="flex min-w-0 grow cursor-pointer items-center gap-2 rounded-md py-2 pl-3 hover:bg-slate-100"
    >
      <span :data-testid="props.addressTestId" class="min-w-0 grow truncate font-mono select-all">
        {{ props.address }}
      </span>
      <span class="flex h-[34px] w-[34px] shrink-0 items-center justify-center">
        <CopyIcon class="pointer-events-none h-5 w-5 stroke-2 text-slate-500/60" />
      </span>
      <template #copying>
        <div class="flex h-full w-full items-center gap-2 rounded-md bg-[#f1f3f7] px-3 py-2">
          <span class="min-w-0 grow truncate font-mono">{{ props.address }}</span>
          <span class="flex h-[34px] w-[34px] shrink-0 items-center justify-center">
            <CheckIcon class="h-5 w-5 stroke-2 text-green-700" />
          </span>
        </div>
      </template>
    </CopyToClipboard>
    <HoverCardRoot v-model:open="isQrCodeOpen" :openDelay="150" :closeDelay="150">
      <HoverCardTrigger asChild>
        <button
          type="button"
          :aria-label="`Show ${props.networkName} address QR code`"
          :aria-expanded="isQrCodeOpen"
          :disabled="!qrCode"
          class="hover:text-argon-600 flex h-[34px] w-[34px] shrink-0 cursor-pointer items-center justify-center rounded-md text-slate-500/60 hover:bg-slate-100 disabled:opacity-40"
          @click="isQrCodeOpen = true"
        >
          <QrCodeIcon class="h-6 w-6 stroke-2" />
        </button>
      </HoverCardTrigger>
      <HoverCardPortal>
        <HoverCardContent
          data-testid="WalletReceiveAddress.qrCode"
          side="bottom"
          align="end"
          :sideOffset="0"
          :collisionPadding="30"
          :style="floatingZIndex"
          class="w-60 rounded-md border border-slate-300 bg-white p-3 text-center text-sm text-slate-700 shadow-xl"
        >
          <p class="mb-3 font-semibold">{{ props.qrCodeTitle ?? `${props.networkName} network receive address:` }}</p>
          <img v-if="qrCode" :src="qrCode" class="w-full" :alt="`${props.networkName} receive address QR code`" />
          <HoverCardArrow :width="16" :height="8" class="-mt-px fill-white stroke-slate-300" />
        </HoverCardContent>
      </HoverCardPortal>
    </HoverCardRoot>
  </div>
</template>

<script setup lang="ts">
import * as Vue from 'vue';
import QRCode from 'qrcode';
import { CheckIcon, QrCodeIcon } from '@heroicons/vue/24/outline';
import { HoverCardArrow, HoverCardContent, HoverCardPortal, HoverCardRoot, HoverCardTrigger } from 'reka-ui';
import CopyIcon from '../../assets/copy.svg';
import CopyToClipboard from '../../components/CopyToClipboard.vue';
import { useFloatingZIndex } from '../../overlays/helpers/OverlayZIndex.ts';

const props = defineProps<{
  address: string;
  networkName: string;
  qrCodeTitle?: string;
  addressTestId?: string;
}>();

const floatingZIndex = useFloatingZIndex();
const qrCode = Vue.ref('');
const isQrCodeOpen = Vue.ref(false);

Vue.watch(
  () => props.address,
  async (address, _, onCleanup) => {
    let cancelled = false;
    onCleanup(() => (cancelled = true));
    isQrCodeOpen.value = false;
    qrCode.value = '';
    if (!address) return;
    const svg = await QRCode.toString(address, {
      type: 'svg',
      margin: 0,
      color: { dark: '#0f172a', light: '#ffffff' },
    });
    if (!cancelled) qrCode.value = `data:image/svg+xml,${encodeURIComponent(svg)}`;
  },
  { immediate: true },
);
</script>
