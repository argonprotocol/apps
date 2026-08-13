<!-- prettier-ignore -->
<template>
  <OverlayBase
    :isOpen="isOpen"
    :showGoBack="returnToInvite && (!flexibleAssetProgressActive || isFlexibleAssetProgressComplete || !!flexibleAssetError)"
    @close="closeOverlay"
    @pressEsc="closeOverlay"
    @goBack="goBackToInvite"
    class="w-7/12">
    <template #title>
      <div class="grow text-2xl font-bold">
        {{ continueToInvite ? 'Set Up Flexible Space' : 'Manage Flexible Assets' }}
      </div>
    </template>

    <div class="space-y-5 px-6 py-5 text-slate-700">
      <template v-if="continueToInvite">
        <p class="text-sm leading-6 text-slate-500">
          We need to make sure your new vault members will have space available to lock Bitcoin and bonds.
          "Flexible Space" allows you to mark some of your own Bitcoin locks and bonds to temporarily step aside when a new member is ready to use that capacity.
        </p>
        <p class="text-sm leading-6 text-slate-500">
          Your assets remain yours and automatically use the space again when it becomes available.
        </p>
      </template>
      <p v-else class="text-sm leading-6 text-slate-500">
        Make your Bitcoin and bonds flexible so new vault members can use the capacity they occupy instead of waiting
        for you to add more securitization. Member assets take priority when they arrive; your assets remain yours and
        can use the capacity again when it becomes available.
      </p>
      <p class="border-argon-300 border-l-2 py-0.5 pl-3 text-xs leading-5 text-slate-500">
        NOTE: Flexible Bitcoin must be fully securitized before it can be ratcheted. Flexible Bond returns are limited to the
        portion covered by securitization.
      </p>

      <div v-if="flexibleAssetProgressActive" class="border-y border-slate-200 py-8">
        <div class="text-center text-lg font-semibold text-slate-800">
          {{ flexibleAssetProgressTitle }}
        </div>
        <p class="mx-auto mt-3 max-w-xl text-center text-sm leading-6 text-slate-500">
          Updating {{ activeChangeCount }} flexible {{ activeChangeCount === 1 ? 'asset' : 'assets' }}.
          You can close this overlay without disrupting the transaction.
        </p>

        <div class="text-argon-700 mt-8 text-center text-4xl font-bold">
          {{ numeral(flexibleAssetProgressPct).format('0.00') }}%
        </div>

        <ProgressBar
          :progress="flexibleAssetProgressPct"
          :hasError="!!flexibleAssetError"
          :showLabel="false"
          class="mt-4 h-4"
        />

        <div class="mt-4 text-center text-sm text-slate-500">
          {{ flexibleAssetProgressLabel }}
        </div>

        <div v-if="flexibleAssetError" class="mt-5 border-l-2 border-red-300 pl-3 text-sm text-red-700">
          {{ flexibleAssetError }}
        </div>

        <div v-if="isFlexibleAssetProgressComplete || flexibleAssetError" class="mt-7 flex justify-end">
          <button
            type="button"
            class="bg-argon-button hover:bg-argon-button-hover rounded-lg px-5 py-2.5 text-sm font-semibold text-white"
            @click="handleFlexibleAssetProgressAction">
            {{ isFlexibleAssetProgressComplete && continueToInvite ? 'Continue to Invite' : 'Back to Assets' }}
          </button>
        </div>
      </div>

      <div v-else-if="isLoading" class="border-y border-slate-200 py-10 text-center text-sm text-slate-500">
        Loading eligible assets…
      </div>

      <form v-else @submit.prevent="submitFlexibleAssets">
        <section>
          <div class="mb-2 text-sm font-semibold text-slate-800">Bitcoin</div>
          <div v-if="eligibleLocks.length" class="border-y border-slate-200">
            <label
              v-for="(lock, index) in eligibleLocks"
              :key="lock.utxoId"
              class="flex cursor-pointer items-center gap-4 border-b border-slate-100 px-2 py-3 last:border-0">
              <input
                v-model="bitcoinSelectionByUtxoId[lock.utxoId]"
                type="checkbox"
                class="sr-only"
              />
              <Checkbox :isChecked="bitcoinSelectionByUtxoId[lock.utxoId]" :size="4" />
              <span class="grow">
                <span class="block text-sm font-semibold text-slate-800">Bitcoin lock #{{ index + 1 }}</span>
                <span class="mt-0.5 block text-xs text-slate-400">
                  {{ satToBtcNm(lock.satoshis).format('0,0.[00000000]') }} BTC
                </span>
              </span>
              <span class="font-mono text-sm font-semibold text-slate-800">
                {{ currency.symbol }}{{ microgonToMoneyNm(lock.liquidityPromised).format('0,0.00') }}
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
              v-for="(lot, index) in eligibleBondLots"
              :key="lot.id"
              class="flex cursor-pointer items-center gap-4 border-b border-slate-100 px-2 py-3 last:border-0">
              <input
                v-model="bondSelectionById[lot.id]"
                type="checkbox"
                class="sr-only"
              />
              <Checkbox :isChecked="bondSelectionById[lot.id]" :size="4" />
              <span class="grow">
                <span class="block text-sm font-semibold text-slate-800">Bond lot #{{ index + 1 }}</span>
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
            {{ continueToInvite ? 'Continue to Invite' : 'Apply Changes' }}
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
import type { IVaultFlexibleAssetChanges, IVaultFlexibleAssetMetadata } from '../lib/MyVault.ts';
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
const continueToInvite = Vue.ref(false);
const returnToInvite = Vue.ref(false);
const eligibleLocks = Vue.ref<BitcoinLock[]>([]);
const eligibleBondLots = Vue.ref<BondLot[]>([]);
const bitcoinSelectionByUtxoId = Vue.ref<Record<number, boolean>>({});
const bondSelectionById = Vue.ref<Record<number, boolean>>({});
const activeChangeCount = Vue.ref(0);
const flexibleAssetProgressActive = Vue.ref(false);
const flexibleAssetProgressPct = Vue.ref(0);
const flexibleAssetProgressLabel = Vue.ref('');
const flexibleAssetError = Vue.ref('');

let unsubscribeFlexibleAssetProgress: VoidFunction | undefined;
let hasRefreshedFinalizedState = false;

const bitcoinChanges = Vue.computed(() => {
  return eligibleLocks.value.flatMap(lock => {
    const isFlexible = bitcoinSelectionByUtxoId.value[lock.utxoId];
    return isFlexible === lock.isFlexible ? [] : [{ lock, isFlexible }];
  });
});
const bondChanges = Vue.computed(() => {
  return eligibleBondLots.value.flatMap(lot => {
    const isFlexible = bondSelectionById.value[lot.id];
    return isFlexible === lot.isFlexible ? [] : [{ lot, isFlexible }];
  });
});
const changeCount = Vue.computed(() => bitcoinChanges.value.length + bondChanges.value.length);
const isFlexibleAssetProgressComplete = Vue.computed(() => {
  return flexibleAssetProgressPct.value >= 100 && !flexibleAssetError.value;
});
const flexibleAssetProgressTitle = Vue.computed(() => {
  if (flexibleAssetError.value) return 'Flexible asset update needs attention';
  if (isFlexibleAssetProgressComplete.value) return 'Flexible assets updated';
  return 'Updating flexible assets';
});
function closeOverlay() {
  isOpen.value = false;
  continueToInvite.value = false;
  returnToInvite.value = false;
}

async function openOverlay(request?: {
  continueToInvite?: boolean;
  returnToInvite?: boolean;
  flexibleAssetChanges?: IVaultFlexibleAssetChanges;
}) {
  continueToInvite.value = request?.continueToInvite ?? false;
  returnToInvite.value = request?.returnToInvite ?? false;
  isOpen.value = true;
  await transactionTracker.load();
  const pending = transactionTracker.findLatestTxInfo<IVaultFlexibleAssetMetadata>(candidate => {
    if (candidate.tx.accountAddress !== walletKeys.vaultingAddress) return false;
    if (candidate.tx.extrinsicType !== ExtrinsicType.VaultSetFlexibleAssets) return false;

    return candidate.tx.status === TransactionStatus.Submitted || candidate.tx.status === TransactionStatus.InBlock;
  });

  if (pending) {
    trackFlexibleAssetTransaction(pending);
    return;
  }

  await loadFlexibleAssets();
  for (const change of request?.flexibleAssetChanges?.bitcoinChanges ?? []) {
    bitcoinSelectionByUtxoId.value[change.lock.utxoId] = change.isFlexible;
  }
  for (const change of request?.flexibleAssetChanges?.bondChanges ?? []) {
    bondSelectionById.value[change.lot.id] = change.isFlexible;
  }
}

function goBackToInvite() {
  if (flexibleAssetProgressActive.value) {
    resetFlexibleAssetProgress();
  }
  const flexibleAssetChanges = {
    bitcoinChanges: bitcoinChanges.value,
    bondChanges: bondChanges.value,
  };
  closeOverlay();
  basicEmitter.emit('openMemberInviteOverlay', { preserveDraft: true, flexibleAssetChanges });
}

function continueToInviteForm() {
  if (!isFlexibleAssetProgressComplete.value || !continueToInvite.value) return;

  resetFlexibleAssetProgress();
  closeOverlay();
  basicEmitter.emit('openMemberInviteOverlay');
}

function handleFlexibleAssetProgressAction() {
  if (isFlexibleAssetProgressComplete.value && continueToInvite.value) {
    continueToInviteForm();
    return;
  }

  resetFlexibleAssetProgress();
}

async function loadFlexibleAssets() {
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
      bitcoinLocks.getEligibleFlexibleLocks({
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
    bitcoinSelectionByUtxoId.value = Object.fromEntries(locks.map(lock => [lock.utxoId, lock.isFlexible]));
    bondSelectionById.value = Object.fromEntries(eligibleBondLots.value.map(lot => [lot.id, lot.isFlexible]));
  } finally {
    isLoading.value = false;
  }
}

async function submitFlexibleAssets() {
  if (!changeCount.value || flexibleAssetProgressActive.value) return;

  if (continueToInvite.value) {
    const flexibleAssetChanges = {
      bitcoinChanges: bitcoinChanges.value,
      bondChanges: bondChanges.value,
    };
    closeOverlay();
    basicEmitter.emit('openMemberInviteOverlay', { flexibleAssetChanges });
    return;
  }

  activeChangeCount.value = changeCount.value;
  flexibleAssetProgressActive.value = true;
  flexibleAssetProgressPct.value = 0;
  flexibleAssetProgressLabel.value = 'Submitting transaction…';
  flexibleAssetError.value = '';

  try {
    trackFlexibleAssetTransaction(
      await myVault.setFlexibleAssets({
        bitcoinChanges: bitcoinChanges.value,
        bondChanges: bondChanges.value,
      }),
    );
  } catch (error) {
    flexibleAssetError.value = error instanceof Error ? error.message : 'Transaction failed. Please try again.';
  }
}

function trackFlexibleAssetTransaction(info: TransactionInfo<IVaultFlexibleAssetMetadata>) {
  activeChangeCount.value = info.tx.metadataJson.bitcoinChanges.length + info.tx.metadataJson.bondChanges.length;
  flexibleAssetProgressActive.value = true;
  flexibleAssetError.value = '';
  hasRefreshedFinalizedState = false;

  unsubscribeFlexibleAssetProgress?.();
  unsubscribeFlexibleAssetProgress = info.subscribeToProgress(async (progress, error) => {
    flexibleAssetProgressPct.value = progress.progressPct;
    flexibleAssetProgressLabel.value = progress.progressMessage;

    if (error) {
      flexibleAssetError.value = error.message ?? 'Transaction failed.';
      return;
    }

    if (progress.progressPct < 100 || hasRefreshedFinalizedState) return;

    hasRefreshedFinalizedState = true;
    try {
      await myVault.load(true);
      await loadFlexibleAssets();
    } catch (refreshError) {
      flexibleAssetError.value =
        refreshError instanceof Error
          ? `Flexible assets updated, but the latest vault state could not be loaded: ${refreshError.message}`
          : 'Flexible assets updated, but the latest vault state could not be loaded.';
    }
  });
}

function resetFlexibleAssetProgress() {
  unsubscribeFlexibleAssetProgress?.();
  unsubscribeFlexibleAssetProgress = undefined;
  activeChangeCount.value = 0;
  flexibleAssetProgressActive.value = false;
  flexibleAssetProgressPct.value = 0;
  flexibleAssetProgressLabel.value = '';
  flexibleAssetError.value = '';
}

basicEmitter.on('openFlexibleAssetsOverlay', openOverlay);

Vue.onUnmounted(() => {
  basicEmitter.off('openFlexibleAssetsOverlay', openOverlay);
  unsubscribeFlexibleAssetProgress?.();
});
</script>
