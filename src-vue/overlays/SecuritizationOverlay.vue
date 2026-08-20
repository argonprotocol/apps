<!-- prettier-ignore -->
<template>
  <OverlayBase
    :isOpen="isOpen"
    :showGoBack="returnToInvite && !isProcessing"
    @close="closeOverlay"
    @pressEsc="closeOverlay"
    @goBack="goBackToInvite"
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
            :disabled="isProcessing"
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
          :disabled="isProcessing"
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
              :disabled="isProcessing || wallets.defaultArgonWallet.totalMicronots <= 0n"
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
            :disabled="isProcessing"
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
          v-if="!isProcessing && (walletShortfall > 0n || argonotWalletShortfall > 0n)"
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

        <div v-if="isProcessing" class="mt-8 rounded-md border border-slate-200 px-6 py-7">
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
          Cancel
        </button>
        <button
          type="button"
          class="bg-argon-button hover:bg-argon-button-hover rounded-md px-8 py-2.5 font-semibold text-white disabled:cursor-default disabled:opacity-40"
          :disabled="
            isProcessing ||
            !hasSecuritizationChange ||
            walletShortfall > 0n ||
            argonotWalletShortfall > 0n ||
            argonotEncumbranceShortfall > 0n
          "
          @click="updateSecuritization"
        >
          {{ isSubmitting ? 'Submitting…' : 'Update Securitization' }}
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
import { WalletType } from '../lib/Wallet.ts';
import { createNumeralHelpers } from '../lib/numeral.ts';
import { getCurrency } from '../stores/currency.ts';
import { getMainchainClient } from '../stores/mainchain.ts';
import { getMyVault } from '../stores/vaults.ts';
import { useWallets } from '../stores/wallets.ts';
import { useVaultingAssetBreakdown } from '../stores/vaultingAssetBreakdown.ts';
import OverlayBase from './OverlayBase.vue';

const currency = getCurrency();
const wallets = useWallets();
const myVault = getMyVault();
const vaultingAssets = useVaultingAssetBreakdown();
const { microgonToArgonNm, micronotToArgonotNm } = createNumeralHelpers(currency);

const isOpen = Vue.ref(false);
const returnToInvite = Vue.ref(false);
const securitizationMicrogons = Vue.ref(0n);
const committedMicronots = Vue.ref(0n);
const totalArgonIssuanceMicrogons = Vue.ref(0n);
const totalArgonotIssuanceMicronots = Vue.ref(0n);
const txFee = Vue.ref(0n);
const isSubmitting = Vue.ref(false);
const progressPct = Vue.ref(0);
const progressLabel = Vue.ref('');
const transactionError = Vue.ref('');
const circulationError = Vue.ref('');

const pendingTransaction = Vue.computed(() => myVault.data.pendingAllocateTxInfo);
const isProcessing = Vue.computed(() => isSubmitting.value || !!pendingTransaction.value);

const finalArgonotTarget = Vue.computed(() => {
  return TreasuryBonds.getVaultArgonotSecuritizationTarget({
    activatedSecuritizationMicrogons: securitizationMicrogons.value,
    totalArgonIssuanceMicrogons: totalArgonIssuanceMicrogons.value,
    totalArgonotIssuanceMicronots: totalArgonotIssuanceMicronots.value,
  });
});

const securitizationChangeMicrogons = Vue.computed(() => {
  if (pendingTransaction.value) {
    const metadata = pendingTransaction.value.tx.metadataJson;
    return (
      metadata.securitizationChangeMicrogons ??
      (metadata.securitizationMicrogons ?? vaultingAssets.securityMicrogons) - vaultingAssets.securityMicrogons
    );
  }
  return securitizationMicrogons.value - vaultingAssets.securityMicrogons;
});
const argonotChangeMicronots = Vue.computed(() => {
  if (pendingTransaction.value) {
    const metadata = pendingTransaction.value.tx.metadataJson;
    return (
      metadata.argonotChangeMicronots ??
      (metadata.committedMicronots ?? vaultingAssets.securityMicronots) - vaultingAssets.securityMicronots
    );
  }
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

function openOverlay(request?: { returnToInvite?: boolean }) {
  const pendingMetadata = pendingTransaction.value?.tx.metadataJson;
  returnToInvite.value = request?.returnToInvite ?? false;
  isOpen.value = true;
  securitizationMicrogons.value = pendingMetadata?.securitizationMicrogons ?? vaultingAssets.securityMicrogons;
  committedMicronots.value = pendingMetadata?.committedMicronots ?? vaultingAssets.securityMicronots;
  txFee.value = 0n;
  transactionError.value = '';
  circulationError.value = '';

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

function goBackToInvite() {
  if (isProcessing.value) return;

  closeOverlay();
  basicEmitter.emit('openMemberInviteOverlay', { preserveDraft: true });
}

function openWallet() {
  closeOverlay();
  basicEmitter.emit('openWalletOverlay', { connectorType: WalletType.defaultArgon });
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
  if (isProcessing.value) return;

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

  isSubmitting.value = true;
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

    await myVault.setVaultSecuritization(change);
  } catch (error) {
    transactionError.value = error instanceof Error ? error.message : 'Unable to update securitization.';
  } finally {
    isSubmitting.value = false;
  }
}

Vue.watch(
  pendingTransaction,
  (txInfo, _, onCleanup) => {
    if (!txInfo) {
      progressPct.value = 0;
      progressLabel.value = '';
      return;
    }

    transactionError.value = '';
    if (isOpen.value) {
      securitizationMicrogons.value =
        txInfo.tx.metadataJson.securitizationMicrogons ?? vaultingAssets.securityMicrogons;
      committedMicronots.value = txInfo.tx.metadataJson.committedMicronots ?? vaultingAssets.securityMicronots;
      txFee.value = 0n;
    }
    const status = txInfo.getStatus();
    progressPct.value = status.progressPct;
    progressLabel.value = status.isFinalized ? 'Finalizing securitization details…' : 'Waiting for transaction status…';

    const unsubscribe = txInfo.subscribeToProgress((progress, error) => {
      progressPct.value = progress.progressPct;
      progressLabel.value = progress.progressMessage;
      if (error) {
        transactionError.value = error.message;
      }
    });
    onCleanup(unsubscribe);
  },
  { immediate: true },
);

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
  basicEmitter.off('openSecuritizationOverlay', openOverlay);
});
</script>
