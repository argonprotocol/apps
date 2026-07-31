<!-- prettier-ignore -->
<template>
  <OverlayBase :isOpen="isOpen" @close="closeOverlay" @pressEsc="closeOverlay" class="w-240">
    <template #title>
      <StepsHeader :isLoading="isLoading" :hasError="!!loadError" :icon="ArgonIcon" :items="stepItems" />
    </template>

    <div v-if="isLoading" class="flex min-h-60 flex-col items-center justify-center gap-3 text-slate-500">
      <div class="h-8 w-8 animate-spin rounded-full border-3 border-slate-200 border-t-argon-500" />
      <div>Refreshing vault availability...</div>
    </div>
    <div v-else-if="loadError" class="flex min-h-60 flex-col items-center justify-center gap-4 px-8 text-center">
      <div class="text-lg font-semibold text-slate-800">Unable to refresh bond availability</div>
      <div class="text-sm text-slate-500">{{ loadError }}</div>
      <div class="flex gap-3">
        <button class="rounded border border-slate-300 px-4 py-2 text-sm text-slate-600" @click="closeOverlay">Cancel</button>
        <button class="bg-argon-button rounded px-4 py-2 text-sm font-semibold text-white" @click="loadPurchase">
          Retry
        </button>
      </div>
    </div>
    <BondPurchaseComplete
      v-else-if="isComplete"
      :amount="completedPurchaseAmount"
      singularLabel="Argon Bond"
      pluralLabel="Argon Bonds"
      distributionSource="Vault revenue"
      @close="closeOverlay"
    />
    <div v-else-if="!vaultId" class="px-6 pt-2 pb-7">
      <SelectAVault unitType="ArgonBond" @select="handleVaultSelected" />
      <div class="flex flex-row justify-end gap-3 pt-3 px-3 mt-4 mb-3 border-t border-slate-300">
        <button
          type="button"
          class="rounded border border-slate-300 px-4 py-2 text-sm text-slate-600 hover:bg-slate-50"
          @click="closeOverlay"
        >
          Cancel
        </button>
        <button
          type="button"
          :disabled="!tmpVaultId"
          class="bg-argon-button hover:bg-argon-button-hover rounded px-5 py-2 text-sm font-semibold text-white disabled:opacity-40"
          @click="selectVault"
        >
          Select Vault
        </button>
      </div>
    </div>
    <div v-else-if="txInfo" class="px-6 py-5">
      <div class="space-y-5">
        <div class="space-y-3">
          <div class="text-sm font-medium text-slate-600">
            Buying Bonds...
          </div>
          <ProgressBar :progress="progressPct" :hasError="!!progressError" />
          <div class="text-xs text-slate-500">{{ progressMessage }}</div>
          <div
            v-if="progressError"
            class="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700"
          >
            {{ progressError }}
          </div>
        </div>

        <div v-if="progressError" class="flex flex-row justify-end gap-3 pt-1">
          <button
            type="button"
            class="rounded border border-slate-300 px-4 py-2 text-sm text-slate-600 hover:bg-slate-50"
            @click="resetProgress"
          >
            Try Again
          </button>
        </div>
      </div>
    </div>
    <div
      v-else-if="vaultAvailableCapacity <= 0n"
      class="flex min-h-105 flex-col items-center justify-center px-10 py-5 text-center"
    >
      <AlertIcon class="h-18 text-yellow-700" />
      <h1 class="mt-8 text-xl font-bold text-yellow-800">This Vault Has No Argon Bond Space</h1>
      <p class="mt-4 max-w-150 text-lg leading-relaxed font-light">
        Contact the person who invited you and let them know their vault has no more Argon Bond space.
      </p>
    </div>
    <div v-else class="px-10 py-5">
      <div class="pt-3">
        <h1 class="text-2xl font-bold">Choose Your Bond Amount</h1>
        <p class="font-light leading-relaxed mt-2">
          Argon Bonds help secure the network’s stabilization vaults. Each bond earns a share of vault revenue while
          your principal is protected by onchain rules. <a :href="`${NetworkConfig.websiteHost}/docs/assets-and-entities/argon-bonds`">Learn more</a>.
        </p>
        <div class="flex flex-col mt-6">
          <div class="flex flex-row items-center">
            <label class="mb-2 font-bold text-gray-600/60 grow">Purchase Details</label>
            <span v-if="purchaseAmount === minPurchaseAllowed" class="text-sm text-gray-600/60">
              You're At Min Amount
            </span>
            <button
              v-else
              type="button"
              class="text-sm text-argon-600 hover:text-argon-700 cursor-pointer"
              @click="purchaseAmount = minPurchaseAllowed"
            >
              Min
            </button>
            <span class="h-4 border-l border-gray-300 mx-3" />
            <span v-if="purchaseAmount === maxPurchaseAmount" class="text-sm text-gray-600/60">
              You're At Vault Capacity
            </span>
            <button
              v-else
              type="button"
              class="text-sm text-argon-600 hover:text-argon-700 cursor-pointer"
              @click="purchaseAmount = maxPurchaseAmount"
            >
              Max
            </button>
          </div>
          <InputNumber
            v-model="purchaseAmount"
            :min="minPurchaseAllowed"
            :max="maxPurchaseAmount"
            :dragBy="1"
            :dragByMin="1"
            :minDecimals="0"
            :maxDecimals="0"
            :suffix="` ${purchaseAmount === 1 ? 'Bond' : 'Bonds'}`"
            class="px-1 py-2 text-[17px]!"
          />
          <div class="mt-2 text-gray-600/70 text-md">
            Cost: {{ numeral(purchaseAmount).format('0,0') }} ARGON (~{{ currency.symbol
            }}{{ bondToMoneyNm(purchaseAmount).format('0,0.00') }}) will be pulled from your Internal App
            Wallet for this acquisition.
          </div>
          <WalletFundingCallout v-if="neededMicrogons" @open-wallet="openWallet">
            <AlertIcon class="h-4 text-yellow-700 mr-2" />
            Your wallet needs {{ availableMicrogons ? '' : 'another' }} {{ microgonToArgonNm(neededMicrogons).format('0,0.[00]') }} ARGN to purchase these
            bonds.
          </WalletFundingCallout>

          <section class="border border-slate-600/30 rounded-md mt-6">
            <div class="flex flex-row text-center py-7">
              <div class="w-1/3">
                <header class="font-bold opacity-40">TERM LENGTH</header>
                <div class="text-3xl text-argon-600 font-bold py-1">10 DAYS</div>
                <div class="font-light opacity-80">With Automatic Rollover</div>
              </div>
              <div class="min-w-px min-h-full bg-slate-600/20" />
              <div class="w-1/3">
                <header class="font-bold opacity-40">AVG BOND RETURNS</header>
                <div class="text-3xl text-argon-600 font-bold py-1">
                  {{ numeral(vaultingStats.argonBondsAPR).formatIfElseCapped('< 100', '0.0', '0', 999) }}% APR
                </div>
                <div class="font-light opacity-80">Based on Past Performance<sup>&dagger;</sup></div>
              </div>
              <div class="min-w-px min-h-full bg-slate-600/20" />
              <div class="w-1/3">
                <header class="font-bold opacity-40">PROJECTED EARNINGS</header>
                <div class="text-3xl text-argon-600 font-bold py-1">
                  +{{ currency.symbol }}{{ microgonToMoneyNm(projectedEarnings).formatIfElse('< 100', '0,0.00', '0,0') }}
                </div>
                <div class="font-light opacity-80">Modeled Over One Year<sup>&dagger;</sup></div>
              </div>
            </div>
            <div class="border-t border-slate-600/30 py-2 px-2 mx-2 font-light opacity-80">
              &dagger; Vaulting revenue changes daily, which makes future projections unpredictable.
              <a :href="`${NetworkConfig.websiteHost}/docs/assets-and-entities/argon-bonds`">Learn more</a>.
            </div>
          </section>
        </div>

        <div
          v-if="errorMessage"
          class="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700"
        >
          {{ errorMessage }}
        </div>

        <div class="flex flex-row justify-end gap-3 py-3 mt-3">
          <button
            type="button"
            class="rounded-md border border-slate-300 px-4 py-2 text-slate-600 hover:bg-slate-50 cursor-pointer"
            @click="closeOverlay"
          >
            Cancel
          </button>
          <button
            type="button"
            :disabled="isSubmitting || purchaseAmount <= 0 || neededMicrogons > 0n"
            class="bg-argon-button hover:bg-argon-button-hover rounded-md px-5 py-2 cursor-pointer font-semibold text-white disabled:opacity-40"
            @click="submit"
          >
            <template v-if="isSubmitting">Submitting...</template>
            <template v-else>Finalize Purchase &raquo;</template>
          </button>
        </div>
      </div>
    </div>
  </OverlayBase>
</template>

<script setup lang="ts">
import * as Vue from 'vue';
import BigNumber from 'bignumber.js';
import OverlayBase from './OverlayBase.vue';
import SelectAVault from '../components/SelectAVault.vue';
import { Vault } from '@argonprotocol/mainchain';
import { bigNumberToBigInt, MICROGONS_PER_ARGON, NetworkConfig, TreasuryBonds } from '@argonprotocol/apps-core';
import { getConfig } from '../stores/config.ts';
import { getMyVault } from '../stores/vaults.ts';
import { getVaults } from '../stores/vaults.ts';
import { getWalletKeys, useWallets } from '../stores/wallets.ts';
import { getArgonBonds } from '../stores/argonBonds.ts';
import basicEmitter from '../emitters/basicEmitter.ts';
import InputNumber from '../components/InputNumber.vue';
import ProgressBar from '../components/ProgressBar.vue';
import { type TransactionInfo } from '../lib/TransactionInfo.ts';
import { ExtrinsicType, TransactionStatus } from '../lib/db/TransactionsTable.ts';
import numeral, { createNumeralHelpers } from '../lib/numeral.ts';
import { generateProgressLabel } from '../lib/Utils.ts';
import { getCurrency } from '../stores/currency.ts';
import { getMainchainClient } from '../stores/mainchain.ts';
import { getTransactionTracker } from '../stores/transactions.ts';
import { getSpendableDefaultArgonMicrogons } from '../lib/WalletForArgon.ts';
import type { IBuyVaultBondMetadata } from '../lib/ArgonBonds.ts';
import StepsHeader, { IStepHeaderItem } from '../components/StepsHeader.vue';
import ArgonIcon from '../assets/wallets/tokens/argon.svg?component';
import { useVaultingStats } from '../stores/vaultingStats.ts';
import { WalletType } from '../lib/Wallet.ts';
import WalletFundingCallout from '../components/WalletFundingCallout.vue';
import AlertIcon from '../assets/alert.svg?component';
import BondPurchaseComplete from './BondPurchaseComplete.vue';
import { useFinancials } from '../stores/financials.ts';

const MICROGONS_PER_ARGON_BIGINT = BigInt(MICROGONS_PER_ARGON);

const config = getConfig();
const myVault = getMyVault();
const wallets = useWallets();
const argonBonds = getArgonBonds();
const currency = getCurrency();
const walletKeys = getWalletKeys();
const vaultingStats = useVaultingStats();
const transactionTracker = getTransactionTracker();
const vaults = getVaults();
const financials = useFinancials();

const { microgonToArgonNm, microgonToMoneyNm } = createNumeralHelpers(currency);

const isOpen = Vue.ref(false);
const isLoading = Vue.ref(false);
const loadError = Vue.ref('');
const tmpVaultId = Vue.ref<number>();
const selectedVaultId = Vue.ref<number>();
const vault = Vue.ref<Vault>();
const purchaseAmount = Vue.ref(0);
const minPurchaseAllowed = Vue.ref(0);
const isSubmitting = Vue.ref(false);
const errorMessage = Vue.ref('');
const txInfo = Vue.ref<TransactionInfo>();
const progressPct = Vue.ref(0);
const progressMessage = Vue.ref('');
const progressError = Vue.ref('');
const isComplete = Vue.ref(false);
const completedPurchaseAmount = Vue.ref(0);

let unsubVault: VoidFunction | undefined;
let unsubProgress: VoidFunction | undefined;
let purchaseSession = 0;

const vaultId = Vue.computed(() => {
  return selectedVaultId.value ?? myVault.vaultId ?? config.upstreamOperator?.vaultId;
});

const availableMicrogons = Vue.computed(() => wallets.defaultArgonWallet.availableMicrogons);

const vaultBondState = Vue.computed(() => {
  return vaultId.value ? argonBonds.data.vaultsById[vaultId.value] : undefined;
});

const vaultAvailableCapacity = Vue.computed(() => {
  return vault.value?.availableBondSpace(currency.priceIndex, vaultBondState.value?.bondLots ?? [], true) ?? 0n;
});

const spendableWalletBalance = Vue.computed(() => {
  return getSpendableDefaultArgonMicrogons(availableMicrogons.value);
});

const maxPurchaseAmount = Vue.computed(() => {
  return Number(vaultAvailableCapacity.value / MICROGONS_PER_ARGON_BIGINT);
});

const neededMicrogons = Vue.computed(() => {
  const purchaseMicrogons = BigInt(purchaseAmount.value) * MICROGONS_PER_ARGON_BIGINT;
  return purchaseMicrogons > spendableWalletBalance.value ? purchaseMicrogons - spendableWalletBalance.value : 0n;
});

const projectedEarnings = Vue.computed(() => {
  const bondsAPR = Math.min(999, vaultingStats.argonBondsAPR);
  const purchaseMicrogons = BigInt(purchaseAmount.value) * MICROGONS_PER_ARGON_BIGINT;
  return bigNumberToBigInt(BigNumber(purchaseMicrogons.toString()).multipliedBy(bondsAPR).dividedBy(100));
});

function bondToMoneyNm(bonds: number) {
  return microgonToMoneyNm(BigInt(bonds) * MICROGONS_PER_ARGON_BIGINT);
}

function openWallet() {
  basicEmitter.emit('openWalletOverlay', { walletType: WalletType.defaultArgon });
}

const stepItems: IStepHeaderItem[] = [
  {
    label: 'Select Vault',
    tooltip: 'Pick the vault you want to use for your bond purchase.',
    isActive: () => !vaultId.value && !txInfo.value && !isComplete.value,
  },
  {
    label: '',
    tooltip: "We'll pull the latest data from the network.",
    isActive: () => false,
  },
  {
    label: 'Choose Amount',
    tooltip: 'Choose how many Argon Bonds you want to purchase.',
    isActive: () => !!vaultId.value && !txInfo.value && !isComplete.value,
  },
  {
    label: '',
    tooltip: 'Your bond purchase settles directly on the blockchain.',
    isActive: () => !!txInfo.value && !isComplete.value,
  },
  {
    label: 'Collect Argons',
    tooltip: 'Collect daily ARGN distributions funded by Vault revenue.',
    isActive: () => isComplete.value,
  },
];

function resetProgress() {
  unsubProgress?.();
  unsubProgress = undefined;
  txInfo.value = undefined;
  progressPct.value = 0;
  progressMessage.value = '';
  progressError.value = '';
  isSubmitting.value = false;
}

function cancelPurchaseActivity() {
  purchaseSession += 1;
  unsubVault?.();
  unsubVault = undefined;
  unsubProgress?.();
  unsubProgress = undefined;
}

function cleanupPurchase() {
  cancelPurchaseActivity();
  resetProgress();
}

function resetPurchase() {
  vault.value = undefined;
  purchaseAmount.value = 0;
  completedPurchaseAmount.value = 0;
  isComplete.value = false;
  errorMessage.value = '';
  loadError.value = '';
  isLoading.value = false;
  isSubmitting.value = false;
}

async function loadPurchase() {
  const session = ++purchaseSession;
  const relevantVaultIds = [myVault.vaultId, config.upstreamOperator?.vaultId].filter((id): id is number => id != null);
  isLoading.value = true;
  loadError.value = '';
  try {
    await Promise.all([
      financials.refreshVaults(relevantVaultIds.length ? [...new Set(relevantVaultIds)] : undefined),
      argonBonds.refreshBondLots(),
    ]);
    if (session !== purchaseSession || !isOpen.value) return;
    if (vaultId.value !== undefined) {
      await initializePurchase(session);
    }
  } catch (error) {
    if (session !== purchaseSession || !isOpen.value) return;
    loadError.value = error instanceof Error ? error.message : 'Unable to refresh bond availability.';
  } finally {
    if (session === purchaseSession && isOpen.value) isLoading.value = false;
  }
}

function openOverlay() {
  cleanupPurchase();
  resetPurchase();
  tmpVaultId.value = undefined;
  selectedVaultId.value = undefined;
  isOpen.value = true;
  void loadPurchase();
}

function closeOverlay() {
  isOpen.value = false;
  cancelPurchaseActivity();
}

async function onSubmitted() {
  if (isComplete.value) return;

  isComplete.value = true;
  unsubProgress?.();
  unsubProgress = undefined;
  await argonBonds.refreshBondLots();
}

function trackTxInfo(info: TransactionInfo<IBuyVaultBondMetadata>) {
  unsubProgress?.();
  txInfo.value = info;
  isSubmitting.value = false;
  completedPurchaseAmount.value = Number(info.tx.metadataJson.bondPurchaseMicrogons / MICROGONS_PER_ARGON_BIGINT);
  argonBonds.saveBondPurchase(info);

  unsubProgress = info.subscribeToProgress((args, error) => {
    progressPct.value = args.progressPct;
    progressMessage.value = generateProgressLabel(args.confirmations, args.expectedConfirmations);

    if (error) {
      progressError.value = error.message ?? 'Transaction failed.';
    }

    if (args.progressPct >= 100 && !error) void onSubmitted();
  });
}

async function submit() {
  if (isSubmitting.value) return;

  errorMessage.value = '';
  isSubmitting.value = true;

  try {
    const bondPurchaseMicrogons = BigInt(purchaseAmount.value) * MICROGONS_PER_ARGON_BIGINT;
    const client = await getMainchainClient(false);
    const signer = await walletKeys.getDefaultArgonKeypair();
    let tx;
    let extrinsicType;
    let metadata;

    if (!vaultId.value) throw new Error('Select a vault before buying bonds.');
    tx = await TreasuryBonds.buildBuyBondTx({
      client,
      vaultId: vaultId.value,
      bondPurchaseMicrogons,
    });
    extrinsicType = ExtrinsicType.TreasuryBuyBonds;
    metadata = {
      vaultId: vaultId.value,
      bondPurchaseMicrogons,
    } satisfies IBuyVaultBondMetadata;

    const info = await transactionTracker.submitAndWatch({
      tx,
      txSigner: signer,
      extrinsicType,
      metadata,
    });

    trackTxInfo(info);
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : 'Transaction failed. Please try again.';
    isSubmitting.value = false;
  }
}

async function initializePurchase(session = ++purchaseSession) {
  unsubVault?.();
  unsubVault = undefined;

  if (vaultId.value) {
    const initializingVaultId = vaultId.value;
    vault.value = vaults.vaultsById[initializingVaultId];
    const unsubscribe = await vaults.subscribeToVault(initializingVaultId, updatedVault => {
      if (session === purchaseSession) vault.value = updatedVault;
    });
    if (session !== purchaseSession) {
      unsubscribe();
      return;
    }
    unsubVault = unsubscribe;
  }

  await transactionTracker.load();
  if (session !== purchaseSession) return;

  const pendingBuyTxInfo = transactionTracker.findLatestTxInfo<IBuyVaultBondMetadata>(candidate => {
    if (candidate.tx.accountAddress !== walletKeys.defaultArgonAddress) return false;
    if (candidate.tx.submissionErrorJson || candidate.tx.blockExtrinsicErrorJson) return false;

    if (candidate.tx.extrinsicType !== ExtrinsicType.TreasuryBuyBonds) return false;
    if (candidate.tx.metadataJson?.vaultId !== vaultId.value) return false;
    if ((candidate.tx.metadataJson?.bondPurchaseMicrogons ?? 0n) <= 0n) return false;

    return candidate.tx.status === TransactionStatus.Submitted || candidate.tx.status === TransactionStatus.InBlock;
  });

  if (pendingBuyTxInfo) {
    trackTxInfo(pendingBuyTxInfo);
  }

  purchaseAmount.value = maxPurchaseAmount.value;
}

function handleVaultSelected(v: Vault) {
  tmpVaultId.value = v.vaultId;
}

async function selectVault() {
  selectedVaultId.value = tmpVaultId.value;
  await initializePurchase();
}

Vue.onMounted(async () => {
  basicEmitter.on('openBondPurchaseOverlay', openOverlay);
  basicEmitter.on('closeAllOverlays', closeOverlay);

  const client = await getMainchainClient(false);
  minPurchaseAllowed.value = Number(
    client.consts.treasury.minimumArgonsPerContributor.toBigInt() / MICROGONS_PER_ARGON_BIGINT,
  );
});

Vue.onUnmounted(() => {
  basicEmitter.off('openBondPurchaseOverlay', openOverlay);
  basicEmitter.off('closeAllOverlays', closeOverlay);
  cleanupPurchase();
});
</script>
