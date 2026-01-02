<!-- prettier-ignore -->
<template>
  <div >
    <div class="flex grow flex-col space-y-1">
      <label class="font-bold opacity-40">Allocate to Bitcoin Security</label>
      <div class="flex w-full flex-row items-center gap-x-2">
        <div class="w-7/12">
          <InputArgon
            v-model="securitizationAmount"
            @update:modelValue="handleBitcoinSecurityChange"
            :maxDecimals="8"
            :min="0n"
            :max="maxSecuritizationAmount"
            :dragBy="1_000_000n"
            :dragByMin="1_000n"
            class="px-1 py-2" />
        </div>
        <div class="py-2 opacity-50">=</div>
        <div class="py-2 opacity-50">{{ numeral(securitizationPct).format('0,0.[00]') }}%</div>
      </div>
    </div>
    <div class="mt-5 flex grow flex-col space-y-1">
      <label class="font-bold opacity-40">Allocate to Treasury Bonds</label>
      <div class="flex w-full flex-row items-center gap-x-2">
        <div class="w-7/12">
          <InputArgon
            v-model="treasuryAmount"
            @update:modelValue="handleTreasuryBondsChange"
            :maxDecimals="0"
            :min="0n"
            :max="maxTreasuryAmount"
            :dragBy="1_000_000n"
            :dragByMin="1_000n"
            class="px-1 py-2" />
        </div>
        <div class="py-2 opacity-50">=</div>
        <div class="py-2 opacity-50">{{ numeral(treasuryPct).format('0,0.[00]') }}%</div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import * as Vue from 'vue';
import InputArgon from './InputArgon.vue';
import BigNumber from 'bignumber.js';
import { getConfig } from '../stores/config.ts';
import { useWallets } from '../stores/wallets.ts';
import { getMyVault } from '../stores/vaults.ts';
import numeral from '../lib/numeral.ts';

const config = getConfig();
const wallets = useWallets();
const myVault = getMyVault();

const props = withDefaults(
  defineProps<{
    microgonsToActivate: bigint;
  }>(),
  {},
);

Vue.watch(
  () => props.microgonsToActivate,
  async () => {
    await refreshData();
  },
  { immediate: true },
);

const securitizationAmount = Vue.ref(0n);
const securitizationPct = Vue.computed(() => {
  return BigNumber(securitizationAmount.value).div(props.microgonsToActivate).toNumber() * 100;
});

const maxSecuritizationAmount = Vue.computed(() => {
  return props.microgonsToActivate - treasuryAmount.value;
});

const treasuryAmount = Vue.ref(0n);
const treasuryPct = Vue.computed(() => {
  return BigNumber(treasuryAmount.value).div(props.microgonsToActivate).toNumber() * 100;
});

const maxTreasuryAmount = Vue.computed(() => {
  return props.microgonsToActivate - securitizationAmount.value;
});

async function refreshData() {
  await myVault.load();
  const newAllocation = await myVault.getVaultAllocations(props.microgonsToActivate, config.vaultingRules);
  securitizationAmount.value = newAllocation.proposedSecuritizationMicrogons - newAllocation.securitizationMicrogons;
  treasuryAmount.value = newAllocation.proposedTreasuryMicrogons - newAllocation.treasuryMicrogons;
}

async function handleBitcoinSecurityChange(microgons: bigint) {
  securitizationAmount.value = microgons;
}

async function handleTreasuryBondsChange(microgons: bigint) {
  treasuryAmount.value = microgons;
}

defineExpose({
  refreshData,
  getAllocation() {
    return {
      addedTreasuryMicrogons: treasuryAmount.value,
      addedSecuritizationMicrogons: securitizationAmount.value,
    };
  },
  getPercents() {
    return {
      treasury: treasuryPct.value,
      securitization: securitizationPct.value,
    };
  },
});
</script>
