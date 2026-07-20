<template>
  <section
    class="flex h-auto w-90 shrink-0 flex-col overflow-visible border border-black/40 shadow-2xl transition-colors duration-150"
    :class="[
      props.direction === 'in' ? 'rounded-l-lg' : 'rounded-r-lg',
      props.wallet || props.addWalletStep ? 'bg-white' : 'bg-gray-300/80 text-black/60',
    ]"
    :data-testid="`WalletOverlay.transfer${capitalizedDirection}Panel`"
  >
    <header
      class="mx-1 flex h-14 shrink-0 items-center gap-x-2.5 border-b px-3"
      :class="props.wallet || props.addWalletStep ? 'border-slate-300' : 'border-black/25'"
    >
      <div class="min-w-0 grow" :class="props.direction === 'in' ? 'order-3 text-right' : 'order-1 text-left'">
        <div
          class="truncate text-xl font-bold"
          :class="props.wallet || props.addWalletStep ? 'text-slate-800/70' : 'text-black/60'"
        >
          {{ headerTitle }}
        </div>
      </div>
      <CopyToClipboard
        v-if="props.wallet"
        :content="props.wallet.address"
        :data-testid="`WalletOverlay.transfer${capitalizedDirection}WalletAddress`"
        class="order-2 flex h-[34px] w-[34px] shrink-0 cursor-pointer items-center justify-center rounded-md border border-slate-400/60 text-slate-500/60 hover:border-slate-500/60 hover:bg-[#f1f3f7]"
        title="Copy wallet address"
      >
        <CopyIcon class="h-4" />
        <template #copying><CopyIcon class="h-4" /></template>
      </CopyToClipboard>
      <button
        :data-testid="`WalletOverlay.transfer${capitalizedDirection}Minimize()`"
        type="button"
        :title="
          props.wallet ? 'Close wallet' : props.addWalletStep ? 'Cancel adding wallet' : 'Minimize transfer panel'
        "
        class="hover:bg-argon-300/10 relative z-10 flex h-[34px] w-[34px] shrink-0 cursor-pointer items-center justify-center rounded-md border border-slate-400/60 text-sm/6 font-semibold hover:border-slate-500/60 focus:outline-none"
        :class="props.direction === 'in' ? 'order-1' : 'order-3'"
        @click="props.wallet ? emit('closeWallet') : props.addWalletStep ? emit('cancelAddWallet') : emit('minimize')"
      >
        <XMarkIcon class="pointer-events-none h-5 w-5 stroke-2 text-slate-400/80" />
      </button>
    </header>

    <template v-if="props.wallet">
      <div class="flex h-[120px] shrink-0 flex-col items-center justify-center">
        <div class="text-argon-700/70 text-5xl font-bold">
          {{ currency.symbol }}
          <FormattedMoney :isLoaded="walletValueIsLoaded" :value="walletTotalValue" />
        </div>
        <div v-if="walletValueIsLoaded" class="mt-2 h-[29px] shrink-0 text-sm opacity-50">
          <div
            v-if="props.walletSelection?.walletType === WalletType.defaultArgon"
            class="border-t border-slate-500/30 pt-2"
          >
            {{ currency.symbol
            }}{{ microgonToMoneyNm(walletTotalValue - financials.savingsTotalPending).format('0,0.00') }} is immediately
            usable
          </div>
          <div
            v-if="props.walletSelection?.walletType === WalletType.miningBot"
            class="border-t border-slate-500/30 pt-2"
          >
            {{ currency.symbol }}{{ microgonToMoneyNm(walletTotalValue).format('0,0.00') }} is immediately usable
          </div>
          <div
            v-else-if="props.walletSelection?.walletType === WalletType.ethereum"
            class="border-t border-slate-500/30 pt-2"
          >
            {{ currency.symbol }}{{ microgonToMoneyNm(nonNativeTokenValue).format('0,0.00') }} is in non-native tokens
          </div>
        </div>
      </div>
      <div :class="props.direction === 'in' ? 'pr-1 pl-5' : 'pr-5 pl-1'">
        <ArgonTokens
          :microgonsToMint="
            props.walletSelection?.walletType === WalletType.defaultArgon ? financials.savingsTotalPending : 0n
          "
          :microgons="props.wallet.availableMicrogons"
          :micronots="props.wallet.availableMicronots"
          :moveMicrogons="props.moveWallet?.availableMicrogons"
          :moveMicronots="props.moveWallet?.availableMicronots"
          :movePlacement="props.isSource ? 'right' : 'left'"
          :indentLeft="!props.isSource"
          :indentRight="props.isSource"
          :moveDirection="props.transferDirection"
          :moveFrom="props.moveFrom"
          :moveTo="props.moveTo"
          networkName="Ethereum"
          feeTokenSymbol="ETH"
          @openTransferOverlay="emit('openTransferOverlay', $event)"
        />
      </div>
      <EthereumBottom
        v-if="props.walletSelection?.walletType === WalletType.ethereum"
        :wallet="props.wallet"
        class="px-5"
      />
    </template>
    <EthereumWalletSetup
      v-else-if="props.addWalletStep"
      :initialStep="props.addWalletStep"
      class="min-h-0 grow"
      @complete="emit('completeAddWallet', $event)"
    />
    <WalletChooser
      v-else
      :availableWallets="props.availableWallets"
      :canAddDefaultEthereum="props.canAddDefaultEthereum"
      :compact="true"
      :dark="true"
      class="min-h-0 grow"
      @select="emit('select', $event)"
      @addNewWallet="emit('addNewWallet')"
      @addDefaultEthereum="emit('addDefaultEthereum')"
      @addExternalEthereum="emit('addExternalEthereum')"
    />
  </section>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import { XMarkIcon } from '@heroicons/vue/24/outline';
import type { MoveFrom, MoveTo } from '@argonprotocol/apps-core';
import type { IEthereumMoveToken } from '../../interfaces/IEthereumInboundTransferTracker.ts';
import type { IWalletRecord } from '../../lib/db/WalletsTable.ts';
import { getWalletTotalValue, WalletType, type IWallet } from '../../lib/Wallet.ts';
import CopyIcon from '../../assets/copy.svg';
import CopyToClipboard from '../../components/CopyToClipboard.vue';
import FormattedMoney from '../../components/FormattedMoney.vue';
import { getCurrency } from '../../stores/currency.ts';
import { useFinancials } from '../../stores/financials.ts';
import { createNumeralHelpers } from '../../lib/numeral.ts';
import type { IWalletSelection, IWalletSetupStep, IWalletTransferDirection } from '../walletOverlayState.ts';
import ArgonTokens from './ArgonTokens.vue';
import WalletChooser from './WalletChooser.vue';
import EthereumBottom from './EthereumBottom.vue';
import EthereumWalletSetup from '../EthereumWalletImportOverlay.vue';

const props = defineProps<{
  direction: IWalletTransferDirection;
  walletSelection?: IWalletSelection;
  addWalletStep?: IWalletSetupStep;
  wallet?: IWallet;
  moveWallet?: IWallet;
  availableWallets: IWalletSelection[];
  canAddDefaultEthereum: boolean;
  isSource: boolean;
  transferDirection?: 'transferToArgon' | 'transferOutOfArgon';
  moveFrom?: MoveFrom;
  moveTo?: MoveTo;
}>();

const emit = defineEmits<{
  (event: 'select', wallet: IWalletSelection): void;
  (event: 'minimize'): void;
  (event: 'closeWallet'): void;
  (event: 'cancelAddWallet'): void;
  (event: 'completeAddWallet', walletRecord: IWalletRecord): void;
  (event: 'addNewWallet'): void;
  (event: 'addDefaultEthereum'): void;
  (event: 'addExternalEthereum'): void;
  (event: 'openTransferOverlay', transfer: { moveToken: IEthereumMoveToken; availableAmount: bigint }): void;
}>();

const capitalizedDirection = computed(() => (props.direction === 'in' ? 'In' : 'Out'));
const financials = useFinancials();
const currency = getCurrency();
const { microgonToMoneyNm } = createNumeralHelpers(currency);
const walletValueIsLoaded = computed(() =>
  props.walletSelection?.walletType === WalletType.defaultArgon ? financials.savingsIsLoaded : true,
);
const walletTotalValue = computed(() => {
  if (!props.wallet) return 0n;
  return props.walletSelection?.walletType === WalletType.defaultArgon
    ? financials.savingsTotalValue
    : getWalletTotalValue(props.wallet, currency);
});
const nonNativeTokenValue = computed(
  () => props.wallet?.otherTokens.reduce((total, token) => total + currency.convertOtherToMicrogon(token), 0n) ?? 0n,
);
const headerTitle = computed(() =>
  props.addWalletStep
    ? 'Add Wallet'
    : props.walletSelection
      ? getName(props.walletSelection)
      : `TRANSFER ${props.direction.toUpperCase()}`,
);

function getName(selection: IWalletSelection) {
  if (selection.walletType === 'ethereum') return selection.walletRecord.name;
  return selection.walletType === 'miningBot' ? 'Mining Wallet' : 'Argon Wallet';
}
</script>
