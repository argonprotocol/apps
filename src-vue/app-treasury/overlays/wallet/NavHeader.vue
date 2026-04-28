<template>
  <div class="flex grow flex-row items-center gap-x-2">
    <SelectRoot v-model="props.selectedWallet" @update:open="handleToggleOpen" @update:modelValue="handleSelectWallet">
      <SelectTrigger
        ref="triggerInstance"
        class="flex h-[34px] grow items-center justify-between rounded-lg border border-slate-400/60 px-2 text-2xl font-bold text-slate-800/70 outline-none hover:border-slate-400/50"
        aria-label="Customise wallets"
      >
        <SelectValue placeholder="Select a wallet..." />
        <ChevronDownIcon class="h-4 w-4 text-slate-400" />
      </SelectTrigger>

      <SelectPortal>
        <SelectContent
          class="data-[side=top]:animate-slideDownAndFade data-[side=right]:animate-slideLeftAndFade data-[side=bottom]:animate-slideUpAndFade data-[side=left]:animate-slideRightAndFade z-[2000] rounded-md border border-slate-400/60 bg-white shadow-sm will-change-[opacity,transform]"
          position="popper"
          :style="{ width: menuWidth }"
          :side-offset="-1"
        >
          <SelectScrollUpButton class="text-violet11 flex h-[25px] cursor-default items-center justify-center bg-white">
            <ChevronUpIcon class="h-4 w-4" />
          </SelectScrollUpButton>

          <SelectViewport class="p-[5px]">
            <SelectItem
              v-for="(wallet, index) in wallets"
              :key="index"
              class="relative flex h-[35px] items-center rounded-[3px] pr-[35px] pl-[5px] text-lg leading-none font-bold text-slate-800/60 select-none data-[disabled]:pointer-events-none data-[highlighted]:bg-slate-200/40 data-[highlighted]:text-slate-800/70 data-[highlighted]:outline-none"
              :value="wallet"
            >
              <SelectItemIndicator class="absolute right-0 inline-flex w-[25px] items-center justify-center">
                <CheckIcon class="h-4 w-4 text-slate-600/80" />
              </SelectItemIndicator>
              <SelectItemText>
                {{ wallet.name }}
              </SelectItemText>
            </SelectItem>
          </SelectViewport>
          <SelectScrollDownButton
            class="text-violet11 flex h-[25px] cursor-default items-center justify-center bg-white"
          >
            <ChevronDownIcon class="h-4 w-4" />
          </SelectScrollDownButton>
        </SelectContent>
      </SelectPortal>
    </SelectRoot>
    <CopyAddressMenu :walletType="selectedWallet.type" :showSingleAddress="true" :showBorder="true" />
    <ConnectMenu v-if="selectedWallet.type === WalletType.ethereum" />
    <div
      NotDraggable
      v-if="props.showPortal"
      @click="triggerSyncMode"
      class="flex h-[34px] w-[34px] flex-row items-center justify-center rounded-md border border-slate-400/60 hover:border-slate-400/50 hover:bg-slate-400/10 focus:outline-none"
    >
      <PortalIcon class="pointer-events-none h-5 w-5 text-slate-400" />
    </div>
    <DialogClose
      v-if="showClose"
      NotDraggable
      @click="close"
      class="z-10 flex h-[34px] w-[34px] cursor-pointer items-center justify-center rounded-md border border-slate-400/60 text-sm/6 font-semibold hover:border-slate-500/60 hover:bg-[#f1f3f7] focus:outline-none"
    >
      <XMarkIcon class="pointer-events-none h-5 w-5 stroke-2 text-slate-500/60" />
    </DialogClose>
  </div>
</template>

<script lang="ts">
import { WalletType } from '../../../lib/Wallet.ts';

export interface IWallet {
  type: WalletType.investment | WalletType.ethereum;
  name: string;
}
</script>

<script setup lang="ts">
import * as Vue from 'vue';
import {
  DialogClose,
  SelectContent,
  SelectItem,
  SelectItemIndicator,
  SelectItemText,
  SelectPortal,
  SelectRoot,
  SelectScrollDownButton,
  SelectScrollUpButton,
  SelectTrigger,
  SelectValue,
  SelectViewport,
} from 'reka-ui';
import ConnectMenu from './ConnectMenu.vue';
import CopyAddressMenu from '../../../app-operations/screens/components/CopyAddressMenu.vue';
import { CheckIcon, ChevronDownIcon, ChevronUpIcon, XMarkIcon } from '@heroicons/vue/24/outline';
import PortalIcon from '../../../assets/portal.svg';

const emit = defineEmits<{
  (e: 'close'): void;
  (e: 'syncMode'): void;
  (e: 'selectWallet', wallet: IWallet): void;
}>();

const props = defineProps<{
  wallets: IWallet[];
  selectedWallet: IWallet;
  showPortal?: boolean;
  showClose?: boolean;
}>();

const triggerInstance = Vue.ref<any>(null);
const menuWidth = Vue.ref('auto');

function handleToggleOpen(isOpen: boolean) {
  if (!isOpen || !triggerInstance.value) return;
  const el = triggerInstance.value.$el as HTMLElement;
  const rect = el.getBoundingClientRect();
  menuWidth.value = `${rect.width}px`;
}

function triggerSyncMode() {
  emit('syncMode');
}

function handleSelectWallet(wallet: IWallet) {
  emit('selectWallet', wallet);
}

function close() {
  emit('close');
}
</script>
