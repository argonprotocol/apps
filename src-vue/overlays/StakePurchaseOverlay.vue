<!-- prettier-ignore -->
<template>
  <OverlayBase :isOpen="isOpen" @close="closeOverlay" @pressEsc="closeOverlay" class="w-240">
    <template #title>
      <StepsHeader :isLoading="isLoading" :hasError="!!loadError" :icon="ArgonotIcon" :items="stepItems" />
    </template>

    <div v-if="isLoading" class="flex min-h-60 flex-col items-center justify-center gap-3 text-slate-500">
      <div class="h-8 w-8 animate-spin rounded-full border-3 border-slate-200 border-t-argon-500" />
      <div>Refreshing stake availability...</div>
    </div>
    <div v-else-if="loadError" class="flex min-h-60 flex-col items-center justify-center gap-4 px-8 text-center">
      <div class="text-lg font-semibold text-slate-800">Unable to refresh stake availability</div>
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
      singularLabel="Argonot Stake"
      pluralLabel="Argonot Stakes"
      distributionSource="Mining Auction revenue"
      @close="closeOverlay"
    />
    <div v-else-if="!minerId" class="px-6 pt-2 pb-7">
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
          Select Miner
        </button>
      </div>
    </div>
    <div v-else-if="txInfo" class="px-6 py-5">
      <div class="space-y-5">
        <div class="space-y-3">
          <div class="text-sm font-medium text-slate-600">
            Buying Stakes...
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

    <div v-else class="px-10 py-5">
      <div class="pt-3">
        <h1 class="text-2xl font-bold">Choose Your Stake Amount</h1>
        <p class="font-light leading-relaxed mt-2">
          Argonot Stakes pay you a share of each day’s Mining Auction profits, with onchain mechanics that keep your
          principal protected.
          <a :href="`${NetworkConfig.websiteHost}/docs/assets-and-entities/argonot-stakes`" target="_blank">Learn more</a>.
        </p>
        <div class="flex flex-col mt-6">
          <div class="flex flex-row items-center">
            <label class="mb-2 font-bold text-gray-600/60 grow">Purchase Details</label>
            <span v-if="purchaseBonds === minPurchaseAllowed" class="text-sm text-gray-600/60">
              You're At Min Amount
            </span>
            <button
              v-else
              type="button"
              class="text-sm text-argon-600 hover:text-argon-700 cursor-pointer"
              @click="purchaseBonds = minPurchaseAllowed"
            >
              Min
            </button>
            <span class="h-4 border-l border-gray-300 mx-3" />
            <span v-if="purchaseBonds === maxPurchaseBonds" class="text-sm text-gray-600/60">
              You're At Max Amount
            </span>
            <button
              v-else
              type="button"
              class="text-sm text-argon-600 hover:text-argon-700 cursor-pointer"
              @click="purchaseBonds = maxPurchaseBonds"
            >
              Max
            </button>
          </div>
          <InputNumber
            v-model="purchaseBonds"
            :min="minPurchaseAllowed"
            :max="maxPurchaseBonds"
            :dragBy="1"
            :dragByMin="1"
            :minDecimals="0"
            :maxDecimals="0"
            :suffix="` ${purchaseBonds === 1 ? 'Stake' : 'Stakes'}`"
            class="px-1 py-2 text-[17px]!"
          />
          <div class="mt-2 text-gray-600/70 text-md">
            Cost: {{ numeral(purchaseBonds).format('0,0') }} ARGNOT (~{{ currency.symbol
            }}{{ micronotToMoneyNm(purchaseAmount).format('0,0.00') }}) will be pulled from your Internal App
            Wallet for this acquisition.
          </div>
          <WalletFundingCallout v-if="neededMicronots" @open-wallet="openWallet">
            <AlertIcon class="h-4 text-yellow-700 mr-2" />
            Your wallet needs {{ availableMicronots ? '' : 'another' }} {{ micronotToArgonotNm(neededMicronots).format('0,0.[00]') }} ARGNOT to purchase
            these stakes.
          </WalletFundingCallout>

          <section class="border border-slate-600/30 rounded-md mt-6">
            <div class="flex flex-row text-center py-7">
              <div class="w-1/3">
                <header class="font-bold opacity-40">COST OF PURCHASE</header>
                <div class="text-3xl text-argon-600 font-bold py-1">
                  {{ currency.symbol }}{{ micronotToMoneyNm(purchaseAmount).format('0,0.00') }}
                </div>
                <div class="font-light opacity-80">
                  To Acquire {{ numeral(purchaseBonds).format('0,0') }}
                  {{ purchaseBonds === 1 ? 'Stake' : 'Stakes' }}
                </div>
              </div>
              <div class="min-w-px min-h-full bg-slate-600/20" />
              <div class="w-1/3">
                <header class="font-bold opacity-40">AVG STAKE RETURNS</header>
                <div class="text-3xl text-argon-600 font-bold py-1">
                  {{ numeral(vaultingStats.argonotStakingAPR).formatIfElseCapped('< 100', '0.0', '0', 999) }}% APR
                </div>
                <div class="font-light opacity-80">Based on Past Performance<sup>&dagger;</sup></div>
              </div>
              <div class="min-w-px min-h-full bg-slate-600/20" />
              <div class="w-1/3">
                <header class="font-bold opacity-40">PROJECTED EARNINGS</header>
                <div class="text-3xl text-argon-600 font-bold py-1">
                  +{{ currency.symbol
                  }}{{ micronotToMoneyNm(projectedEarnings).formatIfElse('< 100', '0,0.00', '0,0') }}
                </div>
                <div class="font-light opacity-80">Modeled Over One Year<sup>&dagger;</sup></div>
              </div>
            </div>
            <div class="border-t border-slate-600/30 py-2 px-2 mx-2 font-light opacity-80">
              &dagger; Mining Auction revenue changes daily, which makes future projections unpredictable.
              <a :href="`${NetworkConfig.websiteHost}/docs/assets-and-entities/argonot-stakes`" target="_blank">Learn more</a>.
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
            :disabled="
              isSubmitting ||
              purchaseBonds < minPurchaseAllowed ||
              purchaseBonds > maxPurchaseBonds ||
              neededMicronots > 0n
            "
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
import OverlayBase from './OverlayBase.vue';
import { Vault } from '@argonprotocol/mainchain';
import { bigNumberToBigInt, MICRONOTS_PER_ARGONOT, NetworkConfig, TreasuryBonds } from '@argonprotocol/apps-core';
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
import type { IBuyArgonotBondMetadata } from '../lib/ArgonBonds.ts';
import ArgonotIcon from '../assets/wallets/tokens/argonot.svg?component';
import StepsHeader, { type IStepHeaderItem } from '../components/StepsHeader.vue';
import BigNumber from 'bignumber.js';
import { useVaultingStats } from '../stores/vaultingStats.ts';
import { WalletType } from '../lib/Wallet.ts';
import WalletFundingCallout from '../components/WalletFundingCallout.vue';
import AlertIcon from '../assets/alert.svg?component';
import BondPurchaseComplete from './BondPurchaseComplete.vue';

const wallets = useWallets();
const argonBonds = getArgonBonds();
const currency = getCurrency();
const walletKeys = getWalletKeys();
const vaultingStats = useVaultingStats();
const transactionTracker = getTransactionTracker();

const { micronotToArgonotNm, micronotToMoneyNm } = createNumeralHelpers(currency);

const isOpen = Vue.ref(false);
const isLoading = Vue.ref(false);
const loadError = Vue.ref('');
const tmpVaultId = Vue.ref<number>();
const selectedVaultId = Vue.ref<number>();
const vault = Vue.ref<Vault>();
const argonotBondCapacity = Vue.ref(0n);
const argonotBondPurchaseLimit = Vue.ref(0n);
const purchaseAmount = Vue.ref<bigint>(0n);
const minPurchaseAllowed = Vue.ref(1);
const isSubmitting = Vue.ref(false);
const errorMessage = Vue.ref('');
const txInfo = Vue.ref<TransactionInfo>();
const progressPct = Vue.ref(0);
const progressMessage = Vue.ref('');
const progressError = Vue.ref('');
const isComplete = Vue.ref(false);
const completedPurchaseAmount = Vue.ref(0);
const minerId = Vue.ref('TODO');

let unsubVault: VoidFunction | undefined;
let unsubProgress: VoidFunction | undefined;
let purchaseSession = 0;

const availableMicronots = Vue.computed(() => wallets.defaultArgonWallet.availableMicronots);

const unitsPerBond = Vue.computed(() => BigInt(MICRONOTS_PER_ARGONOT));

const purchaseBonds = Vue.computed({
  get: () => Number(purchaseAmount.value / unitsPerBond.value),
  set: value => {
    purchaseAmount.value = BigInt(value) * unitsPerBond.value;
  },
});

const vaultAvailableCapacity = Vue.computed(() => {
  return argonotBondCapacity.value;
});

const purchaseCapacity = Vue.computed(() => {
  return availableMicronots.value < vaultAvailableCapacity.value
    ? availableMicronots.value
    : vaultAvailableCapacity.value;
});

const maxPurchaseBonds = Vue.computed(() => {
  return Number(
    (vaultAvailableCapacity.value < argonotBondPurchaseLimit.value
      ? vaultAvailableCapacity.value
      : argonotBondPurchaseLimit.value) / unitsPerBond.value,
  );
});

const neededMicronots = Vue.computed(() => {
  return purchaseAmount.value > availableMicronots.value ? purchaseAmount.value - availableMicronots.value : 0n;
});

const projectedEarnings = Vue.computed(() => {
  const stakesAPR = Math.min(999, vaultingStats.argonotStakingAPR);
  const earningsBn = BigNumber(purchaseAmount.value.toString()).multipliedBy(stakesAPR).dividedBy(100);
  return bigNumberToBigInt(earningsBn);
});

function openWallet() {
  basicEmitter.emit('openWalletOverlay', { walletType: WalletType.defaultArgon });
}

function selectVault() {
  minerId.value = 'TODO';
}

const stepItems: IStepHeaderItem[] = [
  {
    label: 'Select Miner',
    tooltip: 'Choose the miner you want to purchase your Argonot Stakes through.',
    isActive: () => !minerId.value && !txInfo.value && !isComplete.value,
  },
  {
    label: '',
    tooltip: "We'll pull data from the network",
    isActive: () => false,
  },
  {
    label: 'Choose Amount',
    tooltip: 'Choose how many Argonot Stakes you want to purchase.',
    isActive: () => !!minerId.value && !txInfo.value && !isComplete.value,
  },
  {
    label: '',
    tooltip: 'Your purchase will be finalized directly on the blockchain.',
    isActive: () => !!txInfo.value && !isComplete.value,
  },
  {
    label: 'Collect Argons',
    tooltip: 'Collect daily ARGN distributions funded by Mining Auction revenue.',
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
  argonotBondCapacity.value = 0n;
  argonotBondPurchaseLimit.value = 0n;
  purchaseAmount.value = 0n;
  minPurchaseAllowed.value = 1;
  completedPurchaseAmount.value = 0;
  isComplete.value = false;
  errorMessage.value = '';
  loadError.value = '';
  isLoading.value = false;
  isSubmitting.value = false;
}

async function loadPurchase() {
  const session = ++purchaseSession;
  isLoading.value = true;
  loadError.value = '';
  try {
    await initializePurchase(session);
  } catch (error) {
    if (session !== purchaseSession || !isOpen.value) return;
    loadError.value = error instanceof Error ? error.message : 'Unable to refresh stake availability.';
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

function trackTxInfo(info: TransactionInfo<IBuyArgonotBondMetadata>) {
  unsubProgress?.();
  txInfo.value = info;
  isSubmitting.value = false;
  completedPurchaseAmount.value = Number(info.tx.metadataJson.bondPurchaseMicronots / unitsPerBond.value);
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
    const client = await getMainchainClient(false);
    const signer = await walletKeys.getDefaultArgonKeypair();
    let tx;
    let extrinsicType;
    let metadata;

    tx = client.tx.treasury.buyArgonotBonds(purchaseBonds.value);
    extrinsicType = ExtrinsicType.TreasuryBuyArgonotBonds;
    metadata = { bondPurchaseMicronots: purchaseAmount.value } satisfies IBuyArgonotBondMetadata;

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

  const client = await getMainchainClient(false);
  const [totalIssuance, totalActiveBonds, activeLots] = await Promise.all([
    client.query.ownership.totalIssuance(),
    client.query.treasury.totalActiveArgonotBonds(),
    client.query.treasury.argonotBondLots(),
  ]);
  if (session !== purchaseSession) return;

  const maxActiveLots = client.consts.treasury.maxActiveArgonotBondLots.toNumber();
  const smallestActiveLotBonds = activeLots[0]?.bonds.toNumber();
  const isReplacingActiveLot = activeLots.length >= maxActiveLots;

  minPurchaseAllowed.value = TreasuryBonds.getArgonotBondMinimumPurchase({
    configuredMinimumMicrounits: client.consts.treasury.minimumArgonsPerContributor.toBigInt(),
    activeLotCount: activeLots.length,
    maxActiveLots,
    smallestActiveLotBonds,
  });

  argonotBondCapacity.value = TreasuryBonds.getArgonotBondPurchaseCapacity({
    totalIssuanceMicronots: totalIssuance.toBigInt(),
    maxBondedPercent: client.consts.treasury.maxArgonotBondedPercentOfCirculation.toNumber(),
    totalActiveBonds: totalActiveBonds.toNumber(),
    replacedBonds: isReplacingActiveLot ? smallestActiveLotBonds : undefined,
  });
  argonotBondPurchaseLimit.value = TreasuryBonds.getArgonotBondPurchaseLimit({
    totalIssuanceMicronots: totalIssuance.toBigInt(),
    maxBondedPercent: client.consts.treasury.maxArgonotBondedPercentOfCirculation.toNumber(),
  });

  await transactionTracker.load();
  if (session !== purchaseSession) return;

  const pendingBuyTxInfo = transactionTracker.findLatestTxInfo<IBuyArgonotBondMetadata>(candidate => {
    if (candidate.tx.accountAddress !== walletKeys.defaultArgonAddress) return false;
    if (candidate.tx.submissionErrorJson || candidate.tx.blockExtrinsicErrorJson) return false;

    if (candidate.tx.extrinsicType !== ExtrinsicType.TreasuryBuyArgonotBonds) return false;
    if ((candidate.tx.metadataJson?.bondPurchaseMicronots ?? 0n) <= 0n) return false;

    return candidate.tx.status === TransactionStatus.Submitted || candidate.tx.status === TransactionStatus.InBlock;
  });

  if (pendingBuyTxInfo) {
    trackTxInfo(pendingBuyTxInfo);
  }

  const initialPurchaseBonds = Math.min(maxPurchaseBonds.value, Math.max(minPurchaseAllowed.value, 200));
  purchaseAmount.value = BigInt(initialPurchaseBonds) * unitsPerBond.value;
}

Vue.onMounted(async () => {
  basicEmitter.on('openStakePurchaseOverlay', openOverlay);
  basicEmitter.on('closeAllOverlays', closeOverlay);
});

Vue.onUnmounted(() => {
  basicEmitter.off('openStakePurchaseOverlay', openOverlay);
  basicEmitter.off('closeAllOverlays', closeOverlay);
  cleanupPurchase();
});
</script>
