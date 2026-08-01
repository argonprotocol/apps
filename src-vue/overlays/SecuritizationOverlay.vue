<!-- prettier-ignore -->
<template>
  <OverlayBase
    :isOpen="isOpen"
    @close="closeOverlay"
    @pressEsc="closeOverlay"
    class="w-[920px]"
  >
    <template #title>
      <div class="grow text-2xl font-bold">Securitization</div>
    </template>

    <div class="px-10 py-7 text-slate-700">
      <p class="mt-2 text-base leading-7 text-slate-600">
        Use this form to change the securitization amounts in your vault.
        <a
          :href="`${NetworkConfig.websiteHost}/docs/assets-and-entities/vaulting-operations`"
          target="_blank"
          class="text-argon-600 hover:text-argon-700"
        >
          Learn more.
        </a>
      </p>
      <ul class="mt-3 list-disc space-y-1 pl-5 text-base leading-7 text-slate-600">
        <li>
          ARGNs determine the amount of Bitcoin that can be locked into your vault. More Bitcoin means more bonds,
          which are entitled to a portion of the daily mining auction pool.
        </li>
        <li>
          ARGNOTs maximize the share of mining auction returns your vault is eligible to receive.<sup>*</sup>
        </li>
      </ul>

      <div class="mt-7">
        <div class="mb-2 flex items-center justify-between">
          <label class="text-sm font-semibold text-slate-700">ARGN securitization</label>
          <button
            type="button"
            class="text-argon-600 hover:text-argon-700 cursor-pointer text-sm font-semibold disabled:cursor-not-allowed disabled:text-slate-300"
            :disabled="isProcessing || hasCompleted"
            @click="useWalletMaximum"
          >
            Wallet Max
          </button>
        </div>

        <InputToken
          v-model="securitizationMicrogons"
          :min="0n"
          suffix=" ARGN"
          class="w-full"
          :disabled="isProcessing || hasCompleted"
          @change="updateFee"
        />

        <div v-if="hasArgonChange" class="mt-2 text-right text-sm text-slate-500">
          {{ formatAdjustment(securitizationChangeMicrogons, formatArgons, 'ARGN') }}
        </div>

        <div class="mt-7">
          <div class="mb-2 flex items-center justify-between">
            <label class="text-sm font-semibold text-slate-700">ARGNOT securitization</label>
            <button
              type="button"
              class="text-argon-600 hover:text-argon-700 cursor-pointer text-sm font-semibold disabled:cursor-not-allowed disabled:text-slate-300"
              :disabled="isProcessing || hasCompleted || wallets.defaultArgonWallet.totalMicronots <= 0n"
              @click="useArgonotWalletMaximum"
            >
              Wallet Max
            </button>
          </div>

          <InputToken
            v-model="committedMicronots"
            :min="0n"
            suffix=" ARGNOT"
            class="w-full"
            :disabled="isProcessing || hasCompleted"
            @change="updateFee"
          />

          <div
            v-if="!circulationError || hasArgonotChange"
            class="mt-2 flex items-center justify-between gap-4 text-sm text-slate-500"
          >
            <span v-if="!circulationError" class="whitespace-nowrap">
              To maximize returns: {{ formatArgonots(finalArgonotTarget) }} ARGNOT
            </span>
            <span v-if="hasArgonotChange" class="ml-auto whitespace-nowrap">
              {{ formatAdjustment(argonotChangeMicronots, formatArgonots, 'ARGNOT') }}
            </span>
          </div>

          <div
            v-if="argonotEncumbranceShortfall > 0n"
            class="mt-4 flex items-center gap-3 rounded-md border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-800"
          >
            <ExclamationCircleIcon class="size-5 shrink-0" />
            {{ formatArgonots(vaultingAssets.securityMicronotsActivated) }} ARGNOT is backing your registered minting
            authority and cannot be released.
          </div>
        </div>

        <div
          v-if="walletShortfall > 0n || argonotWalletShortfall > 0n"
          class="mt-4 flex items-center gap-3 rounded-md border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-800"
        >
          <ExclamationCircleIcon class="size-5 shrink-0" />
          <div v-if="walletShortfall > 0n" class="grow">
            Your wallet needs another
            {{ microgonToArgonNm(walletShortfall).format('0,0.[000000]') }} ARGN to add this amount.
          </div>
          <div v-if="argonotWalletShortfall > 0n" class="grow">
            Your wallet needs another {{ formatArgonots(argonotWalletShortfall) }} ARGNOT for this commitment.
          </div>
          <button type="button" class="rounded bg-amber-700 px-4 py-1.5 font-semibold text-white hover:bg-amber-800" @click="openWallet">
            Open Wallet
          </button>
        </div>

        <div v-if="isProcessing || hasCompleted" class="mt-8 rounded-md border border-slate-200 px-6 py-7">
          <ProgressBar :progress="progressPct" :hasError="!!transactionError" />
          <div class="mt-3 text-center text-sm text-slate-500">{{ progressLabel }}</div>
        </div>
      </div>

      <div v-if="circulationError || transactionError" class="mt-4 border-l-2 border-red-300 pl-3 text-sm text-red-700">
        {{ circulationError || transactionError }}
      </div>

      <div class="mt-8 flex items-center justify-end gap-3 border-t border-slate-200 pt-6">
        <div class="mr-auto text-xs text-slate-400">
          * ARGNOT return eligibility is not yet deployed to the network.
        </div>
        <button
          type="button"
          class="rounded-md border border-slate-300 px-6 py-2.5 font-semibold text-slate-600 hover:bg-slate-50"
          @click="closeOverlay"
        >
          {{ hasCompleted ? 'Close' : 'Cancel' }}
        </button>
        <button
          v-if="!hasCompleted"
          type="button"
          class="bg-argon-button hover:bg-argon-button-hover rounded-md px-8 py-2.5 font-semibold text-white disabled:cursor-default disabled:opacity-40"
          :disabled="
            isProcessing ||
            !hasSecuritizationChange ||
            walletShortfall > 0n ||
            argonotWalletShortfall > 0n ||
            argonotEncumbranceShortfall > 0n ||
            !!transactionError
          "
          @click="updateSecuritization"
        >
          Update Securitization
        </button>
      </div>
    </div>
  </OverlayBase>
</template>

<script setup lang="ts">
import * as Vue from 'vue';
import { ExclamationCircleIcon } from '@heroicons/vue/20/solid';
import { bigIntMax, NetworkConfig, TreasuryBonds } from '@argonprotocol/apps-core';
import basicEmitter from '../emitters/basicEmitter.ts';
import InputToken from '../components/InputToken.vue';
import ProgressBar from '../components/ProgressBar.vue';
import type { IVaultIncreaseAllocationMetadata } from '../lib/MyVault.ts';
import type { TransactionInfo } from '../lib/TransactionInfo.ts';
import { WalletType } from '../lib/Wallet.ts';
import { ExtrinsicType, TransactionStatus } from '../lib/db/TransactionsTable.ts';
import { createNumeralHelpers } from '../lib/numeral.ts';
import { getArgonBonds } from '../stores/argonBonds.ts';
import { getCurrency } from '../stores/currency.ts';
import { getMainchainClient } from '../stores/mainchain.ts';
import { getTransactionTracker } from '../stores/transactions.ts';
import { getMyVault } from '../stores/vaults.ts';
import { useWallets } from '../stores/wallets.ts';
import { useVaultingAssetBreakdown } from '../stores/vaultingAssetBreakdown.ts';
import OverlayBase from './OverlayBase.vue';

const currency = getCurrency();
const wallets = useWallets();
const myVault = getMyVault();
const argonBonds = getArgonBonds();
const transactionTracker = getTransactionTracker();
const vaultingAssets = useVaultingAssetBreakdown();
const { microgonToArgonNm, micronotToArgonotNm } = createNumeralHelpers(currency);

const isOpen = Vue.ref(false);
const securitizationMicrogons = Vue.ref(0n);
const committedMicronots = Vue.ref(0n);
const totalArgonIssuanceMicrogons = Vue.ref(0n);
const totalArgonotIssuanceMicronots = Vue.ref(0n);
const txFee = Vue.ref(0n);
const isProcessing = Vue.ref(false);
const hasCompleted = Vue.ref(false);
const progressPct = Vue.ref(0);
const progressLabel = Vue.ref('');
const transactionError = Vue.ref('');
const circulationError = Vue.ref('');
let unsubscribeProgress: VoidFunction | undefined;

const finalArgonotTarget = Vue.computed(() => {
  return TreasuryBonds.getVaultArgonotSecuritizationTarget({
    activatedSecuritizationMicrogons: securitizationMicrogons.value,
    totalArgonIssuanceMicrogons: totalArgonIssuanceMicrogons.value,
    totalArgonotIssuanceMicronots: totalArgonotIssuanceMicronots.value,
  });
});

const securitizationChangeMicrogons = Vue.computed(() => {
  return securitizationMicrogons.value - vaultingAssets.securityMicrogons;
});
const argonotChangeMicronots = Vue.computed(() => {
  return committedMicronots.value - vaultingAssets.securityMicronots;
});

const hasArgonChange = Vue.computed(() => securitizationChangeMicrogons.value !== 0n);
const hasArgonotChange = Vue.computed(() => argonotChangeMicronots.value !== 0n);
const hasSecuritizationChange = Vue.computed(() => hasArgonChange.value || hasArgonotChange.value);

const walletShortfall = Vue.computed(() => {
  const argonsToAdd = bigIntMax(securitizationChangeMicrogons.value, 0n);
  return bigIntMax(argonsToAdd + txFee.value - wallets.defaultArgonSpendableMicrogons, 0n);
});

const argonotWalletShortfall = Vue.computed(() => {
  return bigIntMax(committedMicronots.value - wallets.defaultArgonWallet.totalMicronots, 0n);
});

const argonotEncumbranceShortfall = Vue.computed(() => {
  if (myVault.mintingAuthorities.data.authorities.length === 0) return 0n;
  return bigIntMax(vaultingAssets.securityMicronotsActivated - committedMicronots.value, 0n);
});

function closeOverlay() {
  isOpen.value = false;
}

function openOverlay() {
  isOpen.value = true;
  if (!isProcessing.value) {
    securitizationMicrogons.value = vaultingAssets.securityMicrogons;
    committedMicronots.value = vaultingAssets.securityMicronots;
    txFee.value = 0n;
    hasCompleted.value = false;
    progressPct.value = 0;
    progressLabel.value = '';
    transactionError.value = '';
    circulationError.value = '';
    void recoverPendingTransaction();

    void Promise.all([currency.fetchMicrogonsInCirculation(), currency.fetchMicronotsInCirculation()])
      .then(([argonIssuance, argonotIssuance]) => {
        totalArgonIssuanceMicrogons.value = argonIssuance;
        totalArgonotIssuanceMicronots.value = argonotIssuance;
      })
      .catch(error => {
        circulationError.value =
          error instanceof Error
            ? `Unable to load current token circulation: ${error.message}`
            : 'Unable to load current token circulation.';
      });
  }
}

function openWallet() {
  closeOverlay();
  basicEmitter.emit('openWalletOverlay', { walletType: WalletType.defaultArgon });
}

async function useWalletMaximum() {
  securitizationMicrogons.value = vaultingAssets.securityMicrogons + wallets.defaultArgonSpendableMicrogons;
  await updateFee();
  securitizationMicrogons.value =
    vaultingAssets.securityMicrogons + bigIntMax(wallets.defaultArgonSpendableMicrogons - txFee.value, 0n);

  await updateFee();
  securitizationMicrogons.value =
    vaultingAssets.securityMicrogons + bigIntMax(wallets.defaultArgonSpendableMicrogons - txFee.value, 0n);
}

async function useArgonotWalletMaximum() {
  committedMicronots.value = wallets.defaultArgonWallet.totalMicronots;
  await updateFee();
}

async function updateFee() {
  transactionError.value = '';
  if (!hasSecuritizationChange.value || argonotEncumbranceShortfall.value > 0n) {
    txFee.value = 0n;
    return;
  }

  try {
    const client = await getMainchainClient(false);
    const change: Parameters<typeof myVault.buildSecuritizationTx>[0] = {};
    if (hasArgonChange.value) {
      change.securitizationMicrogons = securitizationMicrogons.value;
    }
    if (hasArgonotChange.value) {
      change.committedMicronots = committedMicronots.value;
    }

    const tx = await myVault.buildSecuritizationTx(change, client);
    const fee = await tx.paymentInfo(wallets.defaultArgonWallet.address);
    txFee.value = fee.partialFee.toBigInt();
  } catch (error) {
    txFee.value = 0n;
    transactionError.value = error instanceof Error ? error.message : 'Unable to calculate the transaction fee.';
  }
}

async function updateSecuritization() {
  if (isProcessing.value || !hasSecuritizationChange.value) return;

  await updateFee();
  if (
    walletShortfall.value > 0n ||
    argonotWalletShortfall.value > 0n ||
    argonotEncumbranceShortfall.value > 0n ||
    transactionError.value
  ) {
    return;
  }

  isProcessing.value = true;
  progressPct.value = 0;
  progressLabel.value = 'Preparing transaction…';

  try {
    const change: Parameters<typeof myVault.setVaultSecuritization>[0] = {};
    if (hasArgonChange.value) {
      change.securitizationMicrogons = securitizationMicrogons.value;
    }
    if (hasArgonotChange.value) {
      change.committedMicronots = committedMicronots.value;
    }

    const info = await myVault.setVaultSecuritization(change);
    trackTransaction(info);
  } catch (error) {
    transactionError.value = error instanceof Error ? error.message : 'Unable to update securitization.';
    isProcessing.value = false;
  }
}

function trackTransaction(info: TransactionInfo) {
  isProcessing.value = true;
  hasCompleted.value = false;
  transactionError.value = '';
  unsubscribeProgress?.();
  unsubscribeProgress = info.subscribeToProgress(async (progress, error) => {
    progressPct.value = progress.progressPct;
    progressLabel.value = progress.progressMessage;

    if (error) {
      transactionError.value = error.message ?? 'Unable to update securitization.';
      isProcessing.value = false;
      return;
    }
    if (progress.progressPct < 100 || hasCompleted.value) return;

    try {
      const vault = myVault.createdVault;
      await Promise.all([
        myVault.load(true),
        vault
          ? argonBonds.refreshVault({
              vaultId: vault.vaultId,
              operatorAddress: vault.operatorAccountId,
              accountId: myVault.walletKeys.vaultingAddress,
            })
          : Promise.resolve(),
      ]);
      hasCompleted.value = true;
      progressLabel.value = 'Securitization updated.';
    } catch (refreshError) {
      transactionError.value =
        refreshError instanceof Error
          ? `Securitization was updated, but the latest vault state could not be loaded: ${refreshError.message}`
          : 'Securitization was updated, but the latest vault state could not be loaded.';
    } finally {
      isProcessing.value = false;
    }
  });
}

async function recoverPendingTransaction() {
  await transactionTracker.load();
  const vaultId = myVault.vaultId;
  if (vaultId == null) return;

  const pending = transactionTracker.findLatestTxInfo<IVaultIncreaseAllocationMetadata>(candidate => {
    if (candidate.tx.extrinsicType !== ExtrinsicType.VaultIncreaseAllocation) return false;
    if (candidate.tx.metadataJson.vaultId !== vaultId) return false;
    return candidate.tx.status === TransactionStatus.Submitted || candidate.tx.status === TransactionStatus.InBlock;
  });
  if (!pending) return;

  securitizationMicrogons.value = pending.tx.metadataJson.securitizationMicrogons ?? vaultingAssets.securityMicrogons;
  committedMicronots.value = pending.tx.metadataJson.committedMicronots ?? vaultingAssets.securityMicronots;
  trackTransaction(pending);
}

function formatArgons(microgons: bigint) {
  return microgonToArgonNm(microgons).format('0,0.[00]');
}

function formatArgonots(micronots: bigint) {
  return micronotToArgonotNm(micronots).format('0,0.[00]');
}

function formatAdjustment(amount: bigint, formatter: (value: bigint) => string, symbol: 'ARGN' | 'ARGNOT') {
  const direction = amount > 0n ? 'Adding' : 'Removing';
  const absoluteAmount = amount > 0n ? amount : -amount;
  return `${direction} ${formatter(absoluteAmount)} ${symbol}`;
}

basicEmitter.on('openSecuritizationOverlay', openOverlay);

Vue.onBeforeUnmount(() => {
  unsubscribeProgress?.();
  basicEmitter.off('openSecuritizationOverlay', openOverlay);
});
</script>
