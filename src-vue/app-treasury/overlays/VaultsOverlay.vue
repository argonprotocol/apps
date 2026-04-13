<!-- prettier-ignore -->
<template>
  <OverlayBase :isOpen="isOpen" @close="closeOverlay" @esc="closeOverlay" class="w-7/12">
    <template #title>
      <div class="flex grow flex-row items-center justify-between gap-x-3 pr-4">
        <DialogTitle>Active Vaults</DialogTitle>
        <div class="text-sm font-normal text-slate-500">
          {{ vaultRows.length }} active
        </div>
      </div>
    </template>

    <div class="px-5 py-4">
      <p v-if="vaultRows.length > 0" class="text-sm leading-6 font-light text-slate-600">
        Browse active network vaults and compare their current locking fees, revenue, and available securitization.
      </p>

      <div v-if="loadError" class="mt-4 rounded-md border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
        {{ loadError }}
      </div>

      <div v-else-if="isLoading" class="py-12 text-center text-slate-500">
        Loading active vaults...
      </div>

      <div v-else-if="vaultRows.length === 0" class="py-12 text-center text-slate-500">
        No active vaults found.
      </div>

      <div v-else class="mt-4 max-h-[28rem] overflow-y-auto rounded-lg border border-slate-200">
        <table class="w-full text-left">
          <thead class="sticky top-0 bg-slate-50 text-xs font-semibold tracking-wide text-slate-500 uppercase">
            <tr>
              <th class="px-4 py-3">Name</th>
              <th class="px-4 py-3">Identifier</th>
              <th class="px-4 py-3">Lock Fee</th>
              <th class="px-4 py-3">Available</th>
              <th class="px-4 py-3 text-right">Action</th>
            </tr>
          </thead>
          <tbody class="divide-y divide-slate-200 text-sm text-slate-700">
            <tr v-for="vault in vaultRows" :key="vault.vaultId">
              <td class="px-4 py-3 font-medium text-slate-800">{{ vault.name || 'Name not set' }}</td>
              <td class="px-4 py-3 font-mono text-xs text-slate-500">{{ vault.operatorAccountId }}</td>
              <td class="px-4 py-3">
                {{ currency.symbol }}{{ microgonToMoneyNm(vault.bitcoinBaseFee).format('0,0.00') }}
                + {{ numeral(vault.bitcoinAnnualPercentRate * 100).format('0,[0.0]') }}%
              </td>
              <td class="px-4 py-3">{{ currency.symbol }}{{ microgonToMoneyNm(vault.availableSecuritization).format('0,0.00') }}</td>
              <td class="px-4 py-3 text-right">
                <button
                  type="button"
                  :disabled="isSaving || selectedVaultId === vault.vaultId"
                  class="rounded-md border px-3 py-1.5 text-xs font-semibold transition disabled:cursor-default disabled:opacity-60"
                  :class="
                    selectedVaultId === vault.vaultId
                      ? 'border-argon-600 bg-argon-50 text-argon-700'
                      : 'border-slate-300 text-slate-700 hover:border-slate-400 hover:bg-slate-50'
                  "
                  @click="selectVault(vault)">
                  {{
                    selectedVaultId === vault.vaultId
                      ? 'Selected'
                      : isSaving
                        ? 'Saving...'
                        : 'Select'
                  }}
                </button>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  </OverlayBase>
</template>

<script setup lang="ts">
import * as Vue from 'vue';
import OverlayBase from '../../app-shared/overlays/OverlayBase.vue';
import { DialogTitle } from 'reka-ui';
import basicEmitter from '../../emitters/basicEmitter.ts';
import { useBasics } from '../../stores/basics.ts';
import { getVaults } from '../../stores/vaults.ts';
import { getCurrency } from '../../stores/currency.ts';
import { getConfig } from '../../stores/config.ts';
import numeral, { createNumeralHelpers } from '../../lib/numeral.ts';

type VaultRow = {
  name: string;
  vaultId: number;
  operatorAccountId: string;
  bitcoinBaseFee: bigint;
  bitcoinAnnualPercentRate: number;
  availableSecuritization: bigint;
};

const basics = useBasics();
const vaultStore = getVaults();
const currency = getCurrency();
const config = getConfig();
const { microgonToMoneyNm } = createNumeralHelpers(currency);

const isOpen = Vue.ref(false);
const isLoading = Vue.ref(false);
const isSaving = Vue.ref(false);
const loadError = Vue.ref('');
const vaultRows = Vue.ref<VaultRow[]>([]);
const selectedVaultId = Vue.computed(() => config.upstreamOperator?.vaultId ?? 0);

function closeOverlay() {
  isOpen.value = false;
  basics.overlayIsOpen = false;
}

async function loadVaults() {
  isLoading.value = true;
  loadError.value = '';

  try {
    await vaultStore.load();
    await vaultStore.updateRevenue();

    vaultRows.value = Object.values(vaultStore.vaultsById)
      .filter(vault => vault.availableSecuritization() > 0n)
      .map(vault => ({
        name: vault.name ?? '',
        vaultId: vault.vaultId,
        operatorAccountId: vault.operatorAccountId,
        bitcoinAnnualPercentRate: vault.terms.bitcoinAnnualPercentRate.toNumber(),
        bitcoinBaseFee: vault.terms.bitcoinBaseFee,
        availableSecuritization: vault.availableSecuritization(),
      }))
      .sort((left, right) => {
        if (right.availableSecuritization !== left.availableSecuritization) {
          return Number(right.availableSecuritization - left.availableSecuritization);
        }

        return left.vaultId - right.vaultId;
      });
  } catch (error) {
    console.error('Failed to load active vaults', error);
    loadError.value = 'Unable to load active vaults right now. Please try again.';
    vaultRows.value = [];
  } finally {
    isLoading.value = false;
  }
}

async function selectVault(vault: VaultRow) {
  if (isSaving.value) return;

  isSaving.value = true;
  loadError.value = '';

  try {
    config.upstreamOperator = {
      name: vault.name,
      vaultId: vault.vaultId,
      inviteCode: config.upstreamOperator?.inviteCode ?? '',
    };
    await config.save();
    closeOverlay();
  } catch (error) {
    console.error('Failed to save selected vault', error);
    loadError.value = 'Unable to save your selected vault right now. Please try again.';
  } finally {
    isSaving.value = false;
  }
}

basicEmitter.on('openVaultsOverlay', async () => {
  isOpen.value = true;
  basics.overlayIsOpen = true;
  await loadVaults();
});
</script>
