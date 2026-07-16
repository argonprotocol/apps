<template>
  <div>
    <div v-if="!isLoaded" class="py-12 text-center text-slate-500">Loading active vaults...</div>

    <div v-else-if="!financials.vaultsActiveRecords.length" class="py-12 text-center text-slate-500">
      No active vaults found.
    </div>

    <div v-else class="mt-4 max-h-[28rem] overflow-y-auto">
      <div
        v-for="vault in financials.vaultsActiveRecords"
        @click="selectVault(vault)"
        :key="vault.vaultId"
        :class="[selectedVaultId === vault.vaultId ? 'border-argon-500 bg-argon-300/10' : 'border-slate-200']"
        class="hover:border-argon-500 flex cursor-pointer flex-row gap-x-3 rounded-lg border px-3 py-3"
      >
        <div class="pointer-events-none">
          <input
            type="radio"
            name="vault-selection"
            :value="vault.vaultId"
            :checked="selectedVaultId === vault.vaultId"
            class="text-argon-600 focus:ring-argon-500 h-4 w-4 cursor-pointer border-slate-300 focus:ring-2 focus:ring-offset-2"
          />
        </div>
        <div class="flex grow flex-col">
          <div class="flex flex-row items-center gap-x-2">
            <span class="font-bold text-slate-800">{{ vault.name || 'Unnamed' }} Vault</span>
            <span class="font-light">({{ abbreviateAddress(vault.operatorAccountId, 10) }})</span>
          </div>
          <div class="mt-2 flex w-full flex-row gap-x-3 pb-px text-center">
            <div
              v-if="props.unitType === 'BitcoinLock'"
              :class="[selectedVaultId === vault.vaultId ? 'bg-white/80' : 'bg-slate-100']"
              class="w-1/2 rounded px-4 py-3 text-slate-500"
            >
              BTC Space
              <br />
              {{ currency.symbol }}{{ microgonToMoneyNm(vault.availableBitcoinSpace()).format('0,0.00') }}
            </div>
            <div
              v-else
              :class="[selectedVaultId === vault.vaultId ? 'bg-white/80' : 'bg-slate-100']"
              class="w-1/2 rounded px-4 py-3 text-slate-500"
            >
              Bonds Available
              <br />
              {{ currency.symbol }}{{ microgonToMoneyNm(availableBondSpace(vault)).format('0,0.00') }}
            </div>
            <div
              :class="[selectedVaultId === vault.vaultId ? 'bg-white/80' : 'bg-slate-100']"
              class="w-1/2 rounded px-4 py-3 text-slate-500"
            >
              Locking Fee
              <br />
              {{ currency.symbol }}{{ microgonToMoneyNm(bitcoinBaseFee(vault)).format('0,0.00') }} +
              {{ numeral(bitcoinAnnualPercentRate(vault) * 100).format('0,[0.0]') }}%
            </div>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import * as Vue from 'vue';
import { getCurrency } from '../stores/currency.ts';
import numeral, { createNumeralHelpers } from '../lib/numeral.ts';
import { abbreviateAddress } from '../lib/Utils.ts';
import { Vault } from '@argonprotocol/mainchain';
import { useFinancials } from '../stores/financials.ts';
import { getArgonBonds } from '../stores/argonBonds.ts';
import { getMainchainClient } from '../stores/mainchain.ts';

const emit = defineEmits<{
  (e: 'load', vaults: Vault[]): void;
  (e: 'select', vault: Vault): void;
}>();

const props = withDefaults(
  defineProps<{
    unitType?: 'BitcoinLock' | 'ArgonBond';
  }>(),
  {
    unitType: 'BitcoinLock',
  },
);

const currency = getCurrency();
const financials = useFinancials();
const argonBonds = getArgonBonds();

const { microgonToMoneyNm } = createNumeralHelpers(currency);

const isLoaded = Vue.ref(false);
const selectedVaultId = Vue.ref<number | null>(null);
const vaultBondSubscriptions: VoidFunction[] = [];

function availableBondSpace(vault: Vault): bigint {
  const bondState = argonBonds.data.vaultsById[vault.vaultId];
  return vault.availableBondSpace(currency.priceIndex, bondState?.bondLots ?? [], true);
}

function bitcoinAnnualPercentRate(vault: Vault) {
  return vault.terms.bitcoinAnnualPercentRate.toNumber();
}

function bitcoinBaseFee(vault: Vault) {
  return vault.terms.bitcoinBaseFee;
}

async function selectVault(vault: Vault) {
  selectedVaultId.value = vault.vaultId;
  emit('select', vault);
}

function unsubscribeVaultBonds() {
  for (const unsubscribe of vaultBondSubscriptions.splice(0)) {
    unsubscribe();
  }
}

async function loadVaultBondState(vaults: Vault[]) {
  if (props.unitType !== 'ArgonBond') return;

  unsubscribeVaultBonds();

  const client = await getMainchainClient(false);
  await argonBonds.subscribeGlobal(client);
  const subscriptions = await Promise.all(
    vaults.map(vault =>
      argonBonds.subscribeVault(
        {
          vaultId: vault.vaultId,
          operatorAddress: vault.operatorAccountId,
        },
        client,
      ),
    ),
  );
  vaultBondSubscriptions.push(...subscriptions);
}

Vue.watch(
  () => financials.vaultsIsLoaded,
  async isVaultsLoaded => {
    if (isLoaded.value || !isVaultsLoaded) return;
    await loadVaultBondState(financials.vaultsActiveRecords);
    isLoaded.value = true;
    emit('load', financials.vaultsActiveRecords);
    if (financials.vaultsActiveRecords.length) {
      void selectVault(financials.vaultsActiveRecords[0]);
    }
  },
  { immediate: true },
);

Vue.onUnmounted(() => {
  unsubscribeVaultBonds();
});
</script>
