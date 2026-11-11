<template>
  <!-- prettier-ignore -->
  <section class="mx-9 flex items-center gap-2.5 rounded border-[1.5px] border-dashed border-slate-900/30 bg-white px-3.5 py-2">
    <div class="relative flex w-16 shrink-0 justify-center">
      <EthereumNetworkLogo class="w-10 text-slate-400" />
      <BellAlertIcon v-if="isAlert" class="text-argon-600 absolute top-0 right-0 size-6 rounded-full bg-white" />
      <span class="sr-only">Buying opportunity available</span>
    </div>
    <div class="min-w-0 grow pl-2">
      <div class="flex flex-wrap items-center justify-between gap-3 pt-3 pb-4">
        <div class="flex min-w-0 grow flex-wrap items-baseline gap-2">
          <header class="text-lg font-bold text-slate-800">
            <template v-if="quantityMicrogons !== undefined">
              ~{{ numeral(formatUnits(quantityMicrogons, 6)).format('0,0.[00]') }} ARGN available
            </template>
            <template v-else>ARGN Buy Opportunity</template>
          </header>
          <div class="flex items-center gap-2 font-light text-slate-500">
            <span aria-hidden="true">·</span>
            <span>Ethereum</span>
            <template v-if="observedAt">
              <span aria-hidden="true">·</span>
              <span>{{ dayjs(observedAt).format('M/D/YYYY') }}</span>
            </template>
          </div>
        </div>
        <button
          type="button"
          class="bg-argon-600 border-argon-800 hover:bg-argon-700 cursor-pointer rounded-md border px-4 py-0.5 font-semibold whitespace-nowrap text-white"
          @click="emit('purchase')"
        >
          Buy ARGN &raquo;
        </button>
      </div>
      <div class="grid grid-cols-3 gap-3 border-t border-slate-400/30 pt-4 pb-4 text-slate-500">
        <span>
          <template v-if="discountPercent !== undefined">{{ numeral(discountPercent).formatIfElse(Math.abs(discountPercent) < 10, '0,0.[0]', '0,0') }}%</template>
          Below Target
        </span>
        <span class="text-center">
          <template v-if="availableUsdc !== undefined">
            {{ numeral(formatUnits(availableUsdc, 6)).format('0,0') }} USDC available
          </template>
          <template v-else>USDC balance unavailable</template>
        </span>
        <span v-if="availableUsdc !== undefined && availableUsdc > 0n" class="col-start-3 text-right">
          <Returns v-if="opportunityApy !== undefined" :returns="{ apy: opportunityApy }" metric="APY" :hideDecimalsAt="10" />
          <template v-else>Choose an amount to estimate returns.</template>
        </span>
      </div>
    </div>
  </section>
</template>

<script setup lang="ts">
import numeral from '../../../lib/numeral.ts';
import Returns from '../../../components/Returns.vue';
import dayjs from 'dayjs';
import { formatUnits } from 'viem';
import { BellAlertIcon } from '@heroicons/vue/24/outline';
import EthereumNetworkLogo from '../../../assets/networks/ethereum.svg?component';

defineProps<{
  isAlert?: boolean;
  opportunityApy?: number;
  availableUsdc?: bigint;
  observedAt?: Date;
  quantityMicrogons?: bigint;
  discountPercent?: number;
}>();
const emit = defineEmits<{ purchase: [] }>();
</script>
