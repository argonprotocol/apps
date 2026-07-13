<template>
  <div class="flex h-full flex-col text-black/90">
    <div class="mx-1 border-t border-slate-300 px-4 py-6 text-center text-7xl font-bold">
      <FormattedMoney :value="props.wallet.availableMicrogons" />
    </div>

    <div class="relative py-2">
      <div
        class="absolute top-0 -left-2 h-full w-[calc(100%+16px)] rounded-t-lg border border-black/30 bg-white shadow-md"
      >
        <WrapBehindEdge class="absolute right-0 bottom-0 h-2 w-2 translate-y-full" />
        <WrapBehindEdge class="absolute bottom-0 left-0 h-2 w-2 translate-y-full scale-x-[-1]" />
      </div>
      <div class="relative px-4">
        <ArgonTokens
          :microgons="props.wallet.availableMicrogons"
          :micronots="props.wallet.availableMicronots"
          :moveDirection="props.transferDirection"
          :moveFrom="props.moveFrom"
          :moveTo="props.moveTo"
          :networkName="props.transferDirection ? 'Ethereum' : ''"
          :feeTokenSymbol="props.transferDirection ? 'ETH' : ''"
          @openTransferOverlay="emit('openTransferOverlay', $event)"
        />
      </div>
    </div>

    <div class="flex grow flex-col px-4">
      <ArgonBottom
        v-if="props.selection.walletType !== WalletType.ethereum"
        :mode="props.mode"
        :showGuidance="props.showGuidance"
        :guidanceContext="props.guidanceContext"
        :walletType="props.selection.walletType"
      />
      <EthereumBottom v-else :wallet="props.wallet" />
    </div>
  </div>
</template>

<script setup lang="ts">
import type { IEthereumMoveToken } from '../../interfaces/IEthereumInboundTransferTracker.ts';
import type { MoveFrom, MoveTo } from '@argonprotocol/apps-core';
import { type IWallet, WalletType } from '../../lib/Wallet.ts';
import type { IWalletGuidanceContext } from '../../emitters/basicEmitter.ts';
import FormattedMoney from '../../components/FormattedMoney.vue';
import WrapBehindEdge from '../../assets/wrap-behind-edge.svg';
import ArgonBottom from './ArgonBottom.vue';
import ArgonTokens from './ArgonTokens.vue';
import EthereumBottom from './EthereumBottom.vue';
import type { IWalletSelection } from '../walletOverlayState.ts';

const props = defineProps<{
  selection: IWalletSelection;
  wallet: IWallet;
  mode: 'chooser' | 'transfer';
  transferDirection?: 'transferToArgon' | 'transferOutOfArgon';
  moveFrom?: MoveFrom;
  moveTo?: MoveTo;
  showGuidance?: boolean;
  guidanceContext?: IWalletGuidanceContext;
}>();

const emit = defineEmits<{
  (event: 'openTransferOverlay', transfer: { moveToken: IEthereumMoveToken; availableAmount: bigint }): void;
}>();
</script>
