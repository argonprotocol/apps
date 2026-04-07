<template>
  <div
    v-if="controller.isLoaded"
    class="relative mr-3 flex h-[55px] flex-row items-center justify-end space-x-2"
    :class="[wallets.isLoaded ? '' : 'opacity-20']"
    data-tauri-drag-region>
    <div class="absolute bottom-0 left-0 h-px w-full bg-gradient-to-l from-slate-300 from-[50%] to-transparent"></div>
    <div
      v-if="config.upstreamOperator"
      class="text-argon-600/70 flex h-[30px] cursor-pointer flex-row items-center rounded-md border border-slate-400/50 px-3 font-semibold hover:border-slate-400/50 hover:bg-slate-400/10 focus:outline-none">
      <div class="bg-argon-600 mr-2 h-3 w-3 rounded-full"></div>
      <div>Connected to {{ toPossessive(config.upstreamOperator.name) }} Vault</div>
    </div>
    <!--    <div class="pointer-events-auto">-->
    <!--      <CurrencyMenu ref="currencyMenuRef">USD</CurrencyMenu>-->
    <!--    </div>-->
    <div class="pointer-events-auto">
      <AccountMenu ref="accountMenuRef" />
    </div>
  </div>
</template>
<script setup lang="ts">
import CurrencyMenu from '../../app-shared/navigation/CurrencyMenu.vue';
import AccountMenu from './AccountMenu.vue';
import { useTreasuryController } from '../../stores/treasuryController.ts';
import { useWallets } from '../../stores/wallets.ts';
import { getConfig } from '../../stores/config.ts';

const config = getConfig();
const wallets = useWallets();
const controller = useTreasuryController();

function toPossessive(name: string): string {
  const trimmed = name.trim();
  if (!trimmed) return '';

  return trimmed.endsWith('s') ? `${trimmed}'` : `${trimmed}'s`;
}
</script>
