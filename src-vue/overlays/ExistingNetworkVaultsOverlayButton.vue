<!-- prettier-ignore -->
<template>
  <Popover as="div" class="relative">
    <PopoverButton class="focus:outline-none">
      <slot>
        <span class="text-argon-600/70 cursor-pointer hover:bg-argon-50/40 hover:border-argon-600 transition-all duration-300">
          View Existing Network Vaults
        </span>
      </slot>
    </PopoverButton>
    <PopoverPanel as="div" :class="panelPositioningClasses" class="absolute w-160 h-120 z-100 text-center text-lg font-bold mt-10 bg-white rounded-lg shadow-lg border border-gray-300 ">
      <div :class="arrowPositioningClasses" class="absolute w-[30px] h-[15px] overflow-hidden">
        <div class="relative top-[5px] left-[5px] w-[20px] h-[20px] rotate-45 bg-white ring-1 ring-gray-900/20"></div>
      </div>
      <div class="text-center text-base px-6 pt-5 pb-3 h-full">
        <table class="w-full h-full">
          <thead class="font-bold">
            <tr>
              <th class="text-left pb-2">#</th>
              <th class="text-left pb-2">BTC Locking Fee</th>
              <th class="text-left pb-2">Fee Revenue</th>
              <th class="text-left pb-2">Pool Earnings</th>
              <th class="text-right pb-2">APY %</th>
            </tr>
          </thead>
          <tbody class="font-light font-mono">
            <tr v-for="(vault, index) in vaults" :key="vault.vaultId">
              <td class="text-left opacity-50">{{ index + 1 }})</td>
              <td class="text-left">{{ currency.symbol }}{{ microgonToMoneyNm(vault.bitcoinBaseFee).format('0,0.00') }} + {{numeral(vault.bitcoinAnnualPercentRate * 100).format('0,[0.0]')}}%</td>
              <td class="text-left">{{ currency.symbol }}{{ microgonToMoneyNm(vault.feeRevenue).format('0,0.00') }}</td>
              <td class="text-left">{{ currency.symbol }}{{ microgonToMoneyNm(vault.poolEarnings).format('0,0.00') }}</td>
              <td class="text-right relative">{{ numeral(vault.apy).formatIfElseCapped('< 1_000', '0,0.00', '0,0', 9_999) }}%</td>
            </tr>
          </tbody>
        </table>
      </div>
    </PopoverPanel>
  </Popover>
</template>

<script setup lang="ts">
import * as Vue from 'vue';
import dayjs from 'dayjs';
import utc from 'dayjs/plugin/utc';
import relativeTime from 'dayjs/plugin/relativeTime';
import { getCurrency } from '../stores/currency';
import { Popover, PopoverButton, PopoverPanel } from '@headlessui/vue';
import numeral, { createNumeralHelpers } from '../lib/numeral';
import { getVaults } from '../stores/vaults.ts';

dayjs.extend(utc);
dayjs.extend(relativeTime);

const props = withDefaults(
  defineProps<{
    position?: 'left' | 'top';
  }>(),
  {
    position: 'top',
  },
);

const vaultStore = getVaults();
const currency = getCurrency();

const panelPositioningClasses = Vue.computed(() => {
  if (props.position === 'left') {
    return 'top-[-80px] right-[calc(100%+10px)]';
  } else {
    // props.position === 'top'
    return 'top-[-55px] left-1/2 -translate-x-1/2 -translate-y-full';
  }
});

const arrowPositioningClasses = Vue.computed(() => {
  if (props.position === 'left') {
    return 'top-[62px] right-0 translate-x-[22.5px] -translate-y-full rotate-90';
  } else {
    // props.position === 'top'
    return 'top-full left-1/2 -translate-x-1/2 rotate-180';
  }
});

const { microgonToMoneyNm } = createNumeralHelpers(currency);

const vaults = Vue.ref<
  {
    vaultId: number;
    bitcoinBaseFee: bigint;
    bitcoinAnnualPercentRate: number;
    activatedSecuritization: bigint;
    feeRevenue: bigint;
    poolEarnings: bigint;
    apy: number;
  }[]
>([]);

Vue.onMounted(async () => {
  await vaultStore.load();
  await vaultStore.updateRevenue();

  const nextVaults = [];
  for (const vault of Object.values(vaultStore.vaultsById)) {
    const { terms } = vault;
    const apy = vaultStore.calculateVaultApy(vault.vaultId);
    nextVaults.push({
      vaultId: vault.vaultId,
      bitcoinAnnualPercentRate: terms.bitcoinAnnualPercentRate.toNumber(),
      activatedSecuritization: vault.activatedSecuritization(),
      bitcoinBaseFee: terms.bitcoinBaseFee,
      poolEarnings: vaultStore.treasuryPoolEarnings(vault.vaultId),
      feeRevenue: vaultStore.getTotalFeeRevenue(vault.vaultId),
      apy,
    });
  }
  nextVaults.sort((a, b) => Number(b.activatedSecuritization - a.activatedSecuritization));
  vaults.value = nextVaults;
});
</script>

<style scoped>
@reference "../main.css";

th,
td {
  @apply border-b border-gray-300;
}

tbody tr:last-child {
  th,
  td {
    @apply border-b-0;
  }
}
</style>
