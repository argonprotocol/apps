<template>
  <div class="flex h-full grow flex-col text-black/90">
    <WalletHeader
      name="Internal App Wallet"
      :isDragging="props.isDragging"
      @dragStart="emit('dragStart', $event)"
      @close="emit('close')"
    />

    <div class="mx-1 px-4 py-6 text-center">
      <div class="text-argon-700/70 flex flex-row justify-center text-6xl font-bold">
        <span>{{ currency.symbol }}</span>
        <FormattedMoney :isLoaded="walletValueIsLoaded" :value="walletTotalValue" />
      </div>
    </div>

    <div class="relative pt-1">
      <div class="mb-2 flex flex-row gap-x-2 px-4">
        <button class="font-bold border-b-3 border-argon-600 cursor-pointer">Tokens</button>
        <button class="cursor-pointer text-argon-900/50">Transactions</button>
        <div class="grow" />
        <button @click="emit('goto', 'send')" class="text-md border border-argon-600/50 text-argon-600/70 px-2 rounded-lg cursor-pointer hover:bg-argon-100/20">Send</button>
        <button @click="emit('goto', 'receive')" class="text-md border border-argon-600/50 text-argon-600/70 px-2 rounded-lg cursor-pointer hover:bg-argon-100/20">Receive</button>
      </div>
      <div class="relative px-4">
        <ArgonTokens
          :microgonsToMint="financials.savingsTotalPending"
          :microgons="defaultArgonWallet.availableMicrogons"
          :micronots="defaultArgonWallet.availableMicronots"
          :showBitcoin="true"
        />
      </div>
    </div>

    <div class="flex grow flex-col px-4">
      <ArgonBottom
        mode="chooser"
        :showGuidance="props.showGuidance"
        :guidanceContext="props.guidanceContext"
        :walletType="WalletType.argon"
      />
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import type { IWalletGuidanceContext } from '../../emitters/basicEmitter.ts';
import { WalletType } from '../../lib/Wallet.ts';
import { getCurrency } from '../../stores/currency.ts';
import { useFinancials } from '../../stores/financials.ts';
import { useWallets } from '../../stores/wallets.ts';
import FormattedMoney from '../../components/FormattedMoney.vue';
import ArgonBottom from './ArgonBottom.vue';
import ArgonTokens from './ArgonTokens.vue';
import WalletHeader from './WalletHeader.vue';
import type { IWalletView } from '../walletOverlayState.ts';

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

const financials = useFinancials();
const currency = getCurrency();
const wallets = useWallets();
const defaultArgonWallet = computed(() => wallets.defaultArgonWallet);
const walletValueIsLoaded = computed(() => financials.savingsIsLoaded);
const walletTotalValue = computed(() => financials.savingsTotalValue);
</script>
