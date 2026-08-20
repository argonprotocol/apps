<template>
  <div class="flex h-full grow flex-col text-black/90">
    <WalletHeader :isDragging="props.isDragging" @dragStart="emit('dragStart', $event)" @close="emit('close')" />

    <div class="mx-1 px-4 py-6 text-center">
      <div class="text-argon-700/70 flex flex-row justify-center text-6xl font-bold">
        <span>{{ currency.symbol }}</span>
        <FormattedMoney :isLoaded="walletValueIsLoaded" :value="walletTotalValue" />
      </div>
    </div>

    <div class="relative pt-1">
      <div class="mb-2 flex flex-row gap-x-3 px-4">
        <button class="font-bold">Tokens</button>
        <button>Transactions</button>
        <div class="grow" />
        <button>Send</button>
        <button>Receive</button>
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
        :walletType="WalletType.defaultArgon"
      />
    </div>
  </div>
</template>

<script setup lang="ts">
import { CheckIcon, XMarkIcon } from '@heroicons/vue/24/outline';
import { computed } from 'vue';
import type { IWalletGuidanceContext } from '../../emitters/basicEmitter.ts';
import { WalletType } from '../../lib/Wallet.ts';
import { getCurrency } from '../../stores/currency.ts';
import { useFinancials } from '../../stores/financials.ts';
import { useWallets } from '../../stores/wallets.ts';
import type { IWalletSelection } from '../walletOverlayState.ts';
import CopyToClipboard from '../../components/CopyToClipboard.vue';
import FormattedMoney from '../../components/FormattedMoney.vue';
import ArgonBottom from './ArgonBottom.vue';
import ArgonTokens from './ArgonTokens.vue';
import WalletMenu from './WalletMenu.vue';
import CopyIcon from '../../assets/copy.svg';
import WalletHeader from './WalletHeader.vue';

const props = defineProps<{
  isDragging: boolean;
  showGuidance?: boolean;
  guidanceContext?: IWalletGuidanceContext;
}>();

const emit = defineEmits<{
  (event: 'dragStart', mouseEvent: MouseEvent): void;
  (event: 'close'): void;
}>();

const financials = useFinancials();
const currency = getCurrency();
const wallets = useWallets();
const defaultArgonWallet = computed(() => wallets.defaultArgonWallet);
const defaultArgonSelection = { walletType: WalletType.defaultArgon } satisfies IWalletSelection;
const walletValueIsLoaded = computed(() => financials.savingsIsLoaded);
const walletTotalValue = computed(() => financials.savingsTotalValue);
</script>
