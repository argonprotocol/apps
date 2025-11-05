<template>
  <Overlay :isOpen="true" @close="cancelOverlay" @esc="cancelOverlay" title="Activate Unused Argons">
    <div box class="flex flex-col px-5 pt-6 pb-3">
      <p>
        You have {{ microgonToArgonNm(sidelinedMicrogons).format('0,0.[00]') }} unused argons that are ready to
        activate. We've divided them between bitcoin security and treasury bonds based on your current config values,
        however, you can adjust below.
      </p>

      <div class="mt-5 flex flex-col gap-x-5">
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

      <div class="mt-10 flex flex-row items-center justify-end gap-x-3 border-t border-black/20 pt-4">
        <button
          class="cursor-pointer rounded-lg bg-gray-200 px-10 py-2 text-lg font-bold text-black hover:bg-gray-300"
          @click="cancelOverlay"
          :disabled="isSaving">
          Cancel
        </button>
        <button
          class="cursor-pointer rounded-lg px-10 py-2 text-lg font-bold text-white"
          :class="[isSaving ? 'bg-argon-600/60' : 'bg-argon-600 hover:bg-argon-700']"
          :disabled="isSaving"
          @click="finalizeActivation">
          <template v-if="isSaving">Finalizing...</template>
          <template v-else>Finalize Activation</template>
        </button>
      </div>
    </div>
  </Overlay>
</template>

<script setup lang="ts">
import * as Vue from 'vue';
import dayjs from 'dayjs';
import utc from 'dayjs/plugin/utc';
import InputNumber from '../components/InputNumber.vue';
import InputArgon from '../components/InputArgon.vue';
import Overlay from './Overlay.vue';
import numeral from 'numeral';
import { useMyVault, useVaults } from '../stores/vaults.ts';
import { createNumeralHelpers } from '../lib/numeral.ts';
import { useCurrency } from '../stores/currency.ts';
import { useBitcoinLocks } from '../stores/bitcoin.ts';
import { SATS_PER_BTC } from '@argonprotocol/mainchain';
import { useDebounceFn } from '@vueuse/core';
import { useConfig } from '../stores/config.ts';
import { useWallets } from '../stores/wallets.ts';
import { bigIntMax, bigNumberToBigInt } from '@argonprotocol/apps-core';
import BigNumber from 'bignumber.js';

dayjs.extend(utc);

const config = useConfig();
const currency = useCurrency();
const myVault = useMyVault();
const wallets = useWallets();

const { microgonToArgonNm } = createNumeralHelpers(currency);

const emit = defineEmits<{
  (e: 'close', shouldFinishLocking: boolean): void;
}>();

const isSaving = Vue.ref(false);

const rules = config.vaultingRules;

const sidelinedMicrogons = Vue.computed(() => {
  return bigIntMax(wallets.vaultingWallet.availableMicrogons - 1_000_000n, 0n);
});

console.log('capitalForSecuritizationPct', rules.capitalForSecuritizationPct);
console.log('capitalForTreasuryPct', rules.capitalForTreasuryPct);

const securitizationAmount = Vue.ref(
  bigNumberToBigInt(BigNumber(rules.capitalForSecuritizationPct).div(100).times(sidelinedMicrogons.value)),
);
const securitizationPct = Vue.computed(() => {
  return BigNumber(securitizationAmount.value).div(sidelinedMicrogons.value).toNumber() * 100;
});
const maxSecuritizationAmount = Vue.computed(() => {
  return wallets.vaultingWallet.availableMicrogons - securitizationAmount.value;
});

const treasuryAmount = Vue.ref(
  bigNumberToBigInt(BigNumber(rules.capitalForTreasuryPct).div(100).times(sidelinedMicrogons.value)),
);
const treasuryPct = Vue.computed(() => {
  return BigNumber(treasuryAmount.value).div(sidelinedMicrogons.value).toNumber() * 100;
});
const maxTreasuryAmount = Vue.computed(() => {
  return wallets.vaultingWallet.availableMicrogons - treasuryAmount.value;
});

const activatedSecuritization = Vue.computed(() => {
  return myVault.createdVault?.activatedSecuritization() ?? 0n;
});

const pendingSecuritization = Vue.computed(() => {
  return myVault.createdVault?.argonsPendingActivation ?? 0n;
});

const waitingSecuritization = Vue.computed(() => {
  const securitization = myVault.createdVault?.securitization ?? 0n;
  return securitization - (activatedSecuritization.value + pendingSecuritization.value);
});

async function handleBitcoinSecurityChange(microgons: bigint) {
  securitizationAmount.value = microgons;
}

async function handleTreasuryBondsChange(microgons: bigint) {
  treasuryAmount.value = microgons;
}

async function finalizeActivation() {
  // if (!vault.createdVault) return;
  // let fallbackRules = JsonExt.stringify(toRaw(config.vaultingRules));
  // try {
  //   isAllocating.value = true;
  //   const availableMicrogons = wallets.vaultingWallet.availableMicrogons;
  //   const { newlyAllocated } = await vault.increaseVaultAllocations({
  //     freeBalance: availableMicrogons,
  //     rules: config.vaultingRules,
  //     argonKeyring: config.vaultingAccount,
  //   });
  //   config.vaultingRules.baseMicrogonCommitment += newlyAllocated;
  //   await config.saveVaultingRules();
  // } catch (err) {
  //   console.error('Error during vault allocation: %o', err);
  //   allocationError.value = 'Allocation failed. Please try again.';
  //   config.vaultingRules = JsonExt.parse(fallbackRules);
  // } finally {
  //   isAllocating.value = false;
  // }
}

function cancelOverlay() {
  emit('close', false);
}

Vue.onMounted(async () => {});

Vue.onUnmounted(async () => {});
</script>
