<template>
  <MiningStatPopover
    :open="open"
    :pinned="pinned"
    ariaLabel="Manage bot capital"
    triggerTestId="BiddingBotOverlay.botFundsStat"
    contentTestId="BiddingBotOverlay.fundsPopover"
    arrowTestId="BiddingBotOverlay.fundsPopoverArrow"
    class="group hover:bg-argon-20 flex w-1/3 cursor-pointer flex-col items-center justify-start px-5 py-4 text-center focus:outline-none"
    @preview="emit('preview')"
    @leave="emit('leave')"
    @togglePin="emit('togglePin')"
    @dismiss="emit('dismiss')"
  >
    <span class="group-hover:text-argon-600/70 text-lg font-bold text-[#a08fb7]">Bot Capital</span>
    <div
      data-testid="BiddingBotOverlay.botFundsMetric"
      class="text-argon-700/80 relative my-1.5 w-full border-y border-dashed border-slate-500/30 font-mono font-bold"
    >
      <div class="py-2 whitespace-nowrap">
        {{
          microgonToArgonNm(
            (bot.isReady ? bot.state?.botCapital?.microgons : undefined) ??
              wallets.miningBotWallet.availableMicrogons + wallets.miningBotWallet.reservedMicrogons,
          ).format('0.[0]a')
        }}
        ARGN
        <span class="mx-1 text-slate-400">·</span>
        {{
          micronotToArgonotNm(
            (bot.isReady ? bot.state?.botCapital?.micronots : undefined) ??
              wallets.miningBotWallet.availableMicronots + wallets.miningBotWallet.reservedMicronots,
          ).format('0.[0]a')
        }}
        ARGNOT
      </div>
    </div>
    <span class="text-md text-gray-500/60">Click to change allocation</span>

    <template #content>
      <template v-if="capitalTransfer">
        <header class="px-4 pt-3 text-center font-bold">Changing Mining Capital</header>
        <div class="px-4 pt-3 pb-4 text-slate-700">
          <p class="font-mono">
            {{ microgonToArgonNm(capitalTransfer.microgons).format('0,0.[00]') }} ARGN
            <span class="mx-1 text-slate-400">·</span>
            {{ micronotToArgonotNm(capitalTransfer.micronots).format('0,0.[00]') }} ARGNOT
          </p>
          <ProgressBar :progress="capitalTransfer.progressPct" :hasError="!!capitalTransfer.error" class="mt-3 h-7" />
          <p class="mt-2 text-center text-slate-500">
            {{ capitalTransfer.error || capitalTransfer.progressLabel }}
          </p>
          <footer class="mt-3 flex justify-end border-t border-slate-300 pt-3">
            <button
              type="button"
              class="cursor-pointer rounded-md border border-slate-300 px-4 py-1 font-bold text-slate-600 hover:bg-slate-50"
              @click="emit('dismiss')"
            >
              Close
            </button>
          </footer>
        </div>
      </template>
      <template v-else>
        <header class="px-4 pt-3 text-center font-bold">Change Mining Capital</header>
        <p class="px-4 pt-2">
          Choose how much ARGN and ARGNOT to allocate to the mining bot. Funds in current bids stay allocated.
        </p>
        <div class="px-4 pt-3 pb-4 text-base text-slate-700">
          <MiningCapitalForm
            :isOpen="open"
            :error="capitalChangeError"
            @close="emit('dismiss')"
            @save="emit('updateCapital', $event)"
          />
        </div>
      </template>
    </template>
  </MiningStatPopover>
</template>

<script setup lang="ts">
import { createNumeralHelpers } from '../../lib/numeral.ts';
import { getCurrency } from '../../stores/currency.ts';
import { getBot } from '../../stores/bot.ts';
import MiningCapitalForm from './MiningCapitalForm.vue';
import MiningStatPopover from './MiningStatPopover.vue';
import ProgressBar from '../../components/ProgressBar.vue';
import type { IMiningCapitalTransferProgress } from './BiddingBotOverlay.vue';
import { useWallets } from '../../stores/wallets.ts';

defineProps<{
  open: boolean;
  pinned: boolean;
  capitalTransfer?: IMiningCapitalTransferProgress;
  capitalChangeError?: string;
}>();

const emit = defineEmits<{
  (event: 'preview'): void;
  (event: 'leave'): void;
  (event: 'togglePin'): void;
  (event: 'dismiss'): void;
  (event: 'updateCapital', value: { microgons: bigint; micronots: bigint }): void;
}>();

const { microgonToArgonNm, micronotToArgonotNm } = createNumeralHelpers(getCurrency());
const bot = getBot();
const wallets = useWallets();
</script>
