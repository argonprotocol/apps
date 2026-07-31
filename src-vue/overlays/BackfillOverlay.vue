<!-- prettier-ignore -->
<template>
  <OverlayBase
    :isOpen="isOpen"
    @close="closeOverlay"
    @pressEsc="closeOverlay"
    class="w-7/12">
    <template #title>
      <div class="grow text-2xl font-bold">Manage Flexible Assets</div>
    </template>

    <div class="space-y-5 px-6 py-5 text-slate-700">
      <p class="text-sm leading-6 text-slate-500">
        Make your Bitcoin and bonds flexible so new vault members can use the capacity they occupy instead of waiting
        for you to add more securitization. Member assets take priority when they arrive; your assets remain yours and
        can use the capacity again when it becomes available.
      </p>
      <p class="border-argon-300 border-l-2 py-0.5 pl-3 text-xs leading-5 text-slate-500">
        Flexible Bitcoin must be fully securitized before it can be ratcheted. Flexible bond returns are limited to the
        portion covered by securitization.
      </p>

      <div v-if="backfillProgressActive" class="border-y border-slate-200 py-8">
        <div class="text-center text-lg font-semibold text-slate-800">
          {{ backfillProgressTitle }}
        </div>
        <p class="mx-auto mt-3 max-w-xl text-center text-sm leading-6 text-slate-500">
          Updating {{ activeChangeCount }} flexible {{ activeChangeCount === 1 ? 'asset' : 'assets' }}.
          You can close this overlay without disrupting the transaction.
        </p>

        <div class="text-argon-700 mt-8 text-center text-4xl font-bold">
          {{ numeral(backfillProgressPct).format('0.00') }}%
        </div>

        <ProgressBar
          :progress="backfillProgressPct"
          :hasError="!!backfillError"
          :showLabel="false"
          class="mt-4 h-4"
        />

        <div class="mt-4 text-center text-sm text-slate-500">
          {{ backfillProgressLabel }}
        </div>

        <div v-if="backfillError" class="mt-5 border-l-2 border-red-300 pl-3 text-sm text-red-700">
          {{ backfillError }}
        </div>

        <div v-if="isBackfillProgressComplete || backfillError" class="mt-7 flex justify-end">
          <button
            type="button"
            class="bg-argon-button hover:bg-argon-button-hover rounded-lg px-5 py-2.5 text-sm font-semibold text-white"
            @click="resetBackfillProgress">
            Back to Assets
          </button>
        </div>
      </div>

      <div v-else-if="isLoading" class="border-y border-slate-200 py-10 text-center text-sm text-slate-500">
        Loading eligible assets…
      </div>

      <form v-else @submit.prevent="submitBackfill">
        <section>
          <div class="mb-2 text-sm font-semibold text-slate-800">Bitcoin</div>
          <div v-if="eligibleLocks.length" class="border-y border-slate-200">
            <label
              v-for="lock in eligibleLocks"
              :key="lock.utxoId"
              class="flex cursor-pointer items-center gap-4 border-b border-slate-100 px-2 py-3 last:border-0">
              <input
                v-model="bitcoinSelectionByUtxoId[lock.utxoId]"
                type="checkbox"
                class="sr-only"
              />
              <Checkbox :isChecked="bitcoinSelectionByUtxoId[lock.utxoId]" :size="4" />
              <span class="grow">
                <span class="block text-sm font-semibold text-slate-800">Bitcoin lock #{{ lock.utxoId }}</span>
                <span class="mt-0.5 block text-xs text-slate-400">Funded</span>
              </span>
              <span class="font-mono text-sm font-semibold text-slate-800">
                {{ satToBtcNm(lock.satoshis).format('0,0.[00000000]') }} BTC
              </span>
            </label>
          </div>
          <div v-else class="border-y border-dashed border-slate-300 py-5 text-center text-sm text-slate-500">
            No eligible Bitcoin locks.
          </div>
        </section>

        <section class="mt-6">
          <div class="mb-2 text-sm font-semibold text-slate-800">Treasury Bonds</div>
          <div v-if="eligibleBondLots.length" class="border-y border-slate-200">
            <label
              v-for="lot in eligibleBondLots"
              :key="lot.id"
              class="flex cursor-pointer items-center gap-4 border-b border-slate-100 px-2 py-3 last:border-0">
              <input
                v-model="bondSelectionById[lot.id]"
                type="checkbox"
                class="sr-only"
              />
              <Checkbox :isChecked="bondSelectionById[lot.id]" :size="4" />
              <span class="grow">
                <span class="block text-sm font-semibold text-slate-800">Bond lot #{{ lot.id }}</span>
                <span class="mt-0.5 block text-xs text-slate-400">
                  {{ lot.bonds.toLocaleString() }} bonds
                </span>
              </span>
              <span class="font-mono text-sm font-semibold text-slate-800">
                {{ currency.symbol }}{{ microgonToMoneyNm(lot.bondMicrogons).format('0,0.00') }}
              </span>
            </label>
          </div>
          <div v-else class="border-y border-dashed border-slate-300 py-5 text-center text-sm text-slate-500">
            No eligible Treasury Bond lots.
          </div>
        </section>

        <div class="mt-5 flex justify-end">
          <button
            type="submit"
            :disabled="!changeCount"
            class="bg-argon-button hover:bg-argon-button-hover rounded-md px-5 py-2 text-sm font-semibold text-white disabled:cursor-default disabled:opacity-40">
            Apply Changes
          </button>
        </div>
      </form>
    </div>
  </OverlayBase>
</template>

<script setup lang="ts">
import * as Vue from 'vue';
import { type BondLot } from '@argonprotocol/apps-core';
import type { BitcoinLock } from '@argonprotocol/mainchain';
import OverlayBase from './OverlayBase.vue';
import ProgressBar from '../components/ProgressBar.vue';
import Checkbox from '../components/Checkbox.vue';
import basicEmitter from '../emitters/basicEmitter.ts';
import type { IVaultBackfillMetadata } from '../lib/MyVault.ts';
import type { TransactionInfo } from '../lib/TransactionInfo.ts';
import numeral, { createNumeralHelpers } from '../lib/numeral.ts';
import { ExtrinsicType, TransactionStatus } from '../lib/db/TransactionsTable.ts';
import { getArgonBonds } from '../stores/argonBonds.ts';
import { getBitcoinLocks } from '../stores/bitcoin.ts';
import { getCurrency } from '../stores/currency.ts';
import { getMainchainClient } from '../stores/mainchain.ts';
import { getTransactionTracker } from '../stores/transactions.ts';
import { getMyVault } from '../stores/vaults.ts';
import { getWalletKeys } from '../stores/wallets.ts';

const argonBonds = getArgonBonds();
const bitcoinLocks = getBitcoinLocks();
const currency = getCurrency();
const myVault = getMyVault();
const transactionTracker = getTransactionTracker();
const walletKeys = getWalletKeys();
const { microgonToMoneyNm, satToBtcNm } = createNumeralHelpers(currency);

const isOpen = Vue.ref(false);
const isLoading = Vue.ref(false);
const eligibleLocks = Vue.ref<BitcoinLock[]>([]);
const eligibleBondLots = Vue.ref<BondLot[]>([]);
const bitcoinSelectionByUtxoId = Vue.ref<Record<number, boolean>>({});
const bondSelectionById = Vue.ref<Record<number, boolean>>({});
const activeChangeCount = Vue.ref(0);
const backfillProgressActive = Vue.ref(false);
const backfillProgressPct = Vue.ref(0);
const backfillProgressLabel = Vue.ref('');
const backfillError = Vue.ref('');

let unsubscribeBackfillProgress: VoidFunction | undefined;
let hasRefreshedFinalizedState = false;

const bitcoinChanges = Vue.computed(() => {
  return eligibleLocks.value.flatMap(lock => {
    const isBackfill = bitcoinSelectionByUtxoId.value[lock.utxoId];
    return isBackfill === lock.isBackfill ? [] : [{ lock, isBackfill }];
  });
});
const bondChanges = Vue.computed(() => {
  return eligibleBondLots.value.flatMap(lot => {
    const isBackfill = bondSelectionById.value[lot.id];
    return isBackfill === lot.isBackfill ? [] : [{ lot, isBackfill }];
  });
});
const changeCount = Vue.computed(() => bitcoinChanges.value.length + bondChanges.value.length);
const isBackfillProgressComplete = Vue.computed(() => {
  return backfillProgressPct.value >= 100 && !backfillError.value;
});
const backfillProgressTitle = Vue.computed(() => {
  if (backfillError.value) return 'Flexible asset update needs attention';
  if (isBackfillProgressComplete.value) return 'Flexible assets updated';
  return 'Updating flexible assets';
});

function closeOverlay() {
  isOpen.value = false;
}

async function openOverlay() {
  isOpen.value = true;
  await transactionTracker.load();
  const pending = transactionTracker.findLatestTxInfo<IVaultBackfillMetadata>(candidate => {
    if (candidate.tx.accountAddress !== walletKeys.vaultingAddress) return false;
    if (candidate.tx.extrinsicType !== ExtrinsicType.VaultSetBackfill) return false;

    return candidate.tx.status === TransactionStatus.Submitted || candidate.tx.status === TransactionStatus.InBlock;
  });

  if (pending) {
    trackBackfillTransaction(pending);
    return;
  }

  await loadBackfillAssets();
}

async function loadBackfillAssets() {
  const vault = myVault.createdVault;
  if (!vault) {
    eligibleLocks.value = [];
    eligibleBondLots.value = [];
    return;
  }

  isLoading.value = true;
  try {
    const client = await getMainchainClient(false);
    const [locks] = await Promise.all([
      bitcoinLocks.getEligibleBackfillLocks({
        vaultId: vault.vaultId,
        operatorAddress: vault.operatorAccountId,
        client,
      }),
      argonBonds.refreshVault(
        {
          vaultId: vault.vaultId,
          operatorAddress: vault.operatorAccountId,
          accountId: walletKeys.vaultingAddress,
        },
        client,
      ),
    ]);

    eligibleLocks.value = locks;
    eligibleBondLots.value = argonBonds
      .getVaultBonds(vault.vaultId)
      .bondLots.filter(lot => lot.isOwn && lot.programType === 'Vault' && !lot.isReleasing);
    bitcoinSelectionByUtxoId.value = Object.fromEntries(locks.map(lock => [lock.utxoId, lock.isBackfill]));
    bondSelectionById.value = Object.fromEntries(eligibleBondLots.value.map(lot => [lot.id, lot.isBackfill]));
  } finally {
    isLoading.value = false;
  }
}

async function submitBackfill() {
  if (!changeCount.value || backfillProgressActive.value) return;

  activeChangeCount.value = changeCount.value;
  backfillProgressActive.value = true;
  backfillProgressPct.value = 0;
  backfillProgressLabel.value = 'Submitting transaction…';
  backfillError.value = '';

  try {
    trackBackfillTransaction(
      await myVault.setBackfill({
        bitcoinChanges: bitcoinChanges.value,
        bondChanges: bondChanges.value,
      }),
    );
  } catch (error) {
    backfillError.value = error instanceof Error ? error.message : 'Transaction failed. Please try again.';
  }
}

function trackBackfillTransaction(info: TransactionInfo<IVaultBackfillMetadata>) {
  activeChangeCount.value = info.tx.metadataJson.bitcoinChanges.length + info.tx.metadataJson.bondChanges.length;
  backfillProgressActive.value = true;
  backfillError.value = '';
  hasRefreshedFinalizedState = false;

  unsubscribeBackfillProgress?.();
  unsubscribeBackfillProgress = info.subscribeToProgress(async (progress, error) => {
    backfillProgressPct.value = progress.progressPct;
    backfillProgressLabel.value = progress.progressMessage;

    if (error) {
      backfillError.value = error.message ?? 'Transaction failed.';
      return;
    }

    if (progress.progressPct < 100 || hasRefreshedFinalizedState) return;

    hasRefreshedFinalizedState = true;
    try {
      await myVault.load(true);
      await loadBackfillAssets();
    } catch (refreshError) {
      backfillError.value =
        refreshError instanceof Error
          ? `Flexible assets updated, but the latest vault state could not be loaded: ${refreshError.message}`
          : 'Flexible assets updated, but the latest vault state could not be loaded.';
    }
  });
}

function resetBackfillProgress() {
  unsubscribeBackfillProgress?.();
  unsubscribeBackfillProgress = undefined;
  activeChangeCount.value = 0;
  backfillProgressActive.value = false;
  backfillProgressPct.value = 0;
  backfillProgressLabel.value = '';
  backfillError.value = '';
}

basicEmitter.on('openBackfillOverlay', openOverlay);

Vue.onUnmounted(() => {
  basicEmitter.off('openBackfillOverlay', openOverlay);
  unsubscribeBackfillProgress?.();
});
</script>
