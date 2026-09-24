<template>
  <div>
    <div
      v-if="vaultStore.currentState.error || bondLoadError"
      class="mb-3 rounded border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700"
    >
      {{ vaultStore.currentState.error || bondLoadError }}
      <button
        type="button"
        :disabled="vaultStore.currentState.isLoading || isLoadingBonds"
        class="ml-3 cursor-pointer underline disabled:opacity-40"
        @click="retry"
      >
        Retry
      </button>
    </div>
    <div v-if="!isLoaded && !vaultStore.currentState.error && !bondLoadError" class="py-12 text-center text-slate-500">
      Loading active vaults...
    </div>

    <div v-else-if="isLoaded && !displayVaults.length" class="py-12 text-center text-slate-500">
      No active vaults found.
    </div>

    <div
      v-else-if="isLoaded"
      class="mt-4 max-h-[28rem] divide-y divide-slate-200 overflow-y-auto border-t border-slate-200"
    >
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
            <template v-else-if="vault.vaultId === myVault.vaultId">Your Vault</template>
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
                ? 'Locked Bitcoin'
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
        <div v-if="props.eligibleSatoshisByVaultId" class="ml-5 shrink-0 text-right">
          <div class="text-xs text-slate-500">Usable Bitcoin</div>
          <div class="mt-0.5 font-semibold text-slate-700">
            <template v-if="props.usableSatoshisByVaultId">
              {{ satToBtcNm(props.usableSatoshisByVaultId[vault.vaultId] ?? 0n).format('0,0.[00000000]') }} BTC
            </template>
            <template v-else>—</template>
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
import { getMyVault, getVaults, retryVaults } from '../stores/vaults.ts';

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
    usableSatoshisByVaultId?: Record<number, bigint>;
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

const bondsAreLoaded = Vue.ref(false);
const isLoadingBonds = Vue.ref(false);
const bondLoadError = Vue.ref('');
const bondRetry = Vue.ref(0);
const isLoaded = Vue.computed(
  () => vaultStore.currentState.isLoaded && (props.unitType !== 'ArgonBond' || bondsAreLoaded.value),
);
const selectedVaultId = Vue.ref<number | null>(props.selectedVaultIds[0] ?? null);
const displayVaults = Vue.computed(() => {
  if (!props.vaultIds) return financials.vaultsActiveRecords;

  return props.vaultIds.flatMap(vaultId => {
    const vault = vaultStore.vaultsById[vaultId];
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

async function retry() {
  if (vaultStore.currentState.error) await retryVaults();
  else bondRetry.value += 1;
}

Vue.watch(
  () => [vaultStore.currentState.isLoaded, displayVaults.value, bondRetry.value] as const,
  async ([isVaultsLoaded, vaults], _, onCleanup) => {
    if (!isVaultsLoaded) return;
    let isCurrent = true;
    onCleanup(() => {
      isCurrent = false;
    });
    bondLoadError.value = '';
    try {
      if (props.unitType === 'ArgonBond') {
        isLoadingBonds.value = true;
        const client = await getMainchainClient(false);
        await argonBonds.subscribeGlobal(client);
        const results = await Promise.allSettled(
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
        const subscriptions = results.flatMap(result => (result.status === 'fulfilled' ? [result.value] : []));
        const failure = results.find(result => result.status === 'rejected');
        if (!isCurrent || failure) {
          subscriptions.forEach(unsubscribe => unsubscribe());
          if (failure) throw failure.reason;
          return;
        }
        unsubscribeVaultBonds();
        vaultBondSubscriptions.push(...subscriptions);
        bondsAreLoaded.value = true;
      }
      if (!isCurrent) return;
      emit('load', vaults);
      if (!props.multiple && selectedVaultId.value === null && vaults.length) {
        void selectVault(vaults[0]);
      }
    } catch (error) {
      if (isCurrent) bondLoadError.value = error instanceof Error ? error.message : 'Unable to load vault bonds.';
    } finally {
      if (isCurrent) isLoadingBonds.value = false;
    }
  },
  { immediate: true },
);

Vue.onUnmounted(() => {
  unsubscribeVaultBonds();
});
</script>
