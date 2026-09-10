<template>
  <div>
    <div v-if="!isLoaded" class="py-12 text-center text-slate-500">Loading active vaults...</div>

    <div v-else-if="!displayVaults.length" class="py-12 text-center text-slate-500">No active vaults found.</div>

    <div v-else class="mt-4 max-h-[28rem] divide-y divide-slate-200 overflow-y-auto border-t border-slate-200">
      <div
        v-for="vault in displayVaults"
        @click="selectVault(vault)"
        :key="vault.vaultId"
        class="flex cursor-pointer items-center gap-x-3 px-2 py-3 transition-colors hover:bg-slate-50"
      >
        <div class="pointer-events-none">
          <template v-if="props.multiple">
            <input type="checkbox" :value="vault.vaultId" :checked="isSelected(vault.vaultId)" class="sr-only" />
            <Checkbox :isChecked="isSelected(vault.vaultId)" :size="4" class="mt-0.5" />
          </template>
          <input
            v-else
            type="radio"
            name="vault-selection"
            :value="vault.vaultId"
            :checked="isSelected(vault.vaultId)"
            class="text-argon-600 focus:ring-argon-500 h-4 w-4 cursor-pointer border-slate-300 focus:ring-2 focus:ring-offset-2"
          />
        </div>
        <div class="min-w-0 grow">
          <div class="truncate font-semibold text-slate-800">
            <template v-if="props.vaultNamesById?.[vault.vaultId]">
              {{ props.vaultNamesById[vault.vaultId] }}
            </template>
            <template v-else-if="vault.vaultId === myVault.vaultId">My Vault</template>
            <template v-else-if="vaultStore.operatorNamesByVaultId[vault.vaultId]">
              {{ vaultStore.operatorNamesByVaultId[vault.vaultId] }} Vault
            </template>
            <template v-else>Vault</template>
          </div>
          <div
            v-if="props.unitType === 'BitcoinLock' && !props.eligibleSatoshisByVaultId"
            class="mt-0.5 text-xs text-slate-500"
          >
            Locking fee: {{ currency.symbol }}{{ microgonToMoneyNm(vault.terms.bitcoinBaseFee).format('0,0.00') }} +
            {{ numeral(vault.terms.bitcoinAnnualPercentRate.times(100)).format('0,[0.0]') }}%
          </div>
          <div v-else-if="props.unitType === 'ArgonBond'" class="mt-0.5 text-xs text-slate-500">
            <template v-if="vault.vaultId !== myVault.vaultId">
              {{ numeral(vault.terms.treasuryProfitSharing.times(100)).format('0,[0.0]') }}% sharing ·
            </template>
            {{ numeral(vaultStore.calculateArgonBondsApr(vault.vaultId)).format('0,0.[0]') }}% avg APR
          </div>
        </div>
        <div class="shrink-0 text-right">
          <div class="text-xs text-slate-500">
            {{
              props.eligibleSatoshisByVaultId
                ? 'Eligible Bitcoin'
                : props.unitType === 'BitcoinLock'
                  ? 'BTC Space'
                  : 'Bonds Available'
            }}
          </div>
          <div class="mt-0.5 font-semibold text-slate-700">
            <template v-if="props.eligibleSatoshisByVaultId">
              {{ satToBtcNm(props.eligibleSatoshisByVaultId[vault.vaultId] ?? 0n).format('0,0.[00000000]') }} BTC
            </template>
            <template v-else-if="props.unitType === 'BitcoinLock'">
              {{ currency.symbol
              }}{{ microgonToMoneyNm(vault.availableBitcoinSpace(walletKeys.liquidLockingAddress)).format('0,0.00') }}
            </template>
            <template v-else>
              {{ numeral(Number(argonBonds.availableBondSpace(vault) / BigInt(MICROGONS_PER_ARGON))).format('0,0') }}
              Bonds
            </template>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { MICROGONS_PER_ARGON, type Vault } from '@argonprotocol/apps-core';
import * as Vue from 'vue';
import { getCurrency } from '../stores/currency.ts';
import numeral, { createNumeralHelpers } from '../lib/numeral.ts';
import Checkbox from './Checkbox.vue';

import { useFinancials } from '../stores/financials.ts';
import { getArgonBonds } from '../stores/argonBonds.ts';
import { getMainchainClient } from '../stores/mainchain.ts';
import { getWalletKeys } from '../stores/wallets.ts';
import { getMyVault, getVaults } from '../stores/vaults.ts';

const emit = defineEmits<{
  (e: 'load', vaults: Vault[]): void;
  (e: 'select', vault: Vault): void;
  (e: 'update:selectedVaultIds', vaultIds: number[]): void;
}>();

const props = withDefaults(
  defineProps<{
    unitType?: 'BitcoinLock' | 'ArgonBond';
    multiple?: boolean;
    vaultIds?: number[];
    selectedVaultIds?: number[];
    eligibleSatoshisByVaultId?: Record<number, bigint>;
    vaultNamesById?: Record<number, string>;
  }>(),
  {
    unitType: 'BitcoinLock',
    multiple: false,
    selectedVaultIds: () => [],
  },
);

const currency = getCurrency();
const financials = useFinancials();
const argonBonds = getArgonBonds();
const walletKeys = getWalletKeys();
const vaultStore = getVaults();
const myVault = getMyVault();

const { microgonToMoneyNm, satToBtcNm } = createNumeralHelpers(currency);

const isLoaded = Vue.ref(false);
const selectedVaultId = Vue.ref<number | null>(props.selectedVaultIds[0] ?? null);
const displayVaults = Vue.computed(() => {
  if (!props.vaultIds) return financials.vaultsActiveRecords;

  return props.vaultIds.flatMap(vaultId => {
    const vault =
      vaultStore.vaultsById[vaultId] ?? financials.vaultsActiveRecords.find(vault => vault.vaultId === vaultId);
    return vault ? [vault] : [];
  });
});
const vaultBondSubscriptions: VoidFunction[] = [];

async function selectVault(vault: Vault) {
  if (props.multiple) {
    const selectedVaultIds = new Set(props.selectedVaultIds);
    if (selectedVaultIds.has(vault.vaultId)) selectedVaultIds.delete(vault.vaultId);
    else selectedVaultIds.add(vault.vaultId);
    emit('update:selectedVaultIds', [...selectedVaultIds]);
    return;
  }
  selectedVaultId.value = vault.vaultId;
  emit('select', vault);
}

function isSelected(vaultId: number): boolean {
  return props.multiple ? (props.selectedVaultIds?.includes(vaultId) ?? false) : selectedVaultId.value === vaultId;
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
          accountId: walletKeys.defaultArgonAddress,
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
    if (!props.multiple && selectedVaultId.value === null && financials.vaultsActiveRecords.length) {
      void selectVault(financials.vaultsActiveRecords[0]);
    }
  },
  { immediate: true },
);

Vue.onUnmounted(() => {
  unsubscribeVaultBonds();
});
</script>
