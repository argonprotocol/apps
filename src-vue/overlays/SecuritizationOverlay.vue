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

      <WalletFundingCallout
        v-if="bitcoinSecuritizationShortfall > 0n"
        :show-action="false"
        :show-arrow="false"
      >
        <AlertIcon class="mr-2 h-4 shrink-0 text-yellow-700" />
        Bitcoin market value exceeds your current securitization by
        {{ microgonToArgonNm(bitcoinSecuritizationShortfall).format('0,0.[00]') }} ARGN. Increase it to cover your
        locked Bitcoin.
      </WalletFundingCallout>

      <div class="mt-7">
        <div class="mb-2 flex items-center justify-between">
          <label class="text-sm font-semibold text-slate-700">ARGN securitization</label>
          <div class="flex items-center text-sm font-semibold">
            <span v-if="securitizationMicrogons === maximumSecuritizationMicrogons" class="text-gray-600/60">
              Wallet Max
            </span>
            <button
              v-else
              type="button"
              class="text-argon-600 hover:text-argon-700 cursor-pointer disabled:cursor-not-allowed disabled:text-slate-300"
              :disabled="isProcessing"
              @click="useWalletMaximum"
            >
              Wallet Max
            </button>
          </div>
        </div>

        <div class="relative">
          <InputToken
            v-model="securitizationMicrogons"
            :min="0n"
            :max="maximumSecuritizationMicrogons"
            suffix=" ARGN"
            :hideArrows="true"
            :class="hasArgonInputAdjustment ? 'w-full pr-24' : 'w-full'"
            :disabled="isProcessing"
            @change="updateFee"
          />
          <div
            v-if="hasArgonInputAdjustment"
            class="pointer-events-none absolute inset-y-0 right-3 z-10 flex items-center gap-1 font-mono text-sm text-slate-500"
          >
            <span>
              {{ argonInputAdjustmentMicrogons > 0n ? '+' : '-' }}{{ microgonToArgonNm(argonInputAdjustmentMicrogons > 0n ? argonInputAdjustmentMicrogons : -argonInputAdjustmentMicrogons).format('0,0.[00]') }}
              ARGN
            </span>
            <Tooltip v-if="delayedReleaseMessage" as-child :content="delayedReleaseMessage">
              <span class="pointer-events-auto inline-flex cursor-help text-slate-400 hover:text-slate-600">
                <InformationCircleIcon class="size-3.5" />
              </span>
            </Tooltip>
          </div>
        </div>

        <SliderRoot
          v-model="securitizationSlider"
          class="relative mt-1 flex h-5 w-full touch-none items-center select-none"
          :min="0"
          :max="100"
          :step="0.01"
          :disabled="isProcessing"
        >
          <SliderTrack class="relative h-2 grow rounded-full bg-gray-500/30">
            <SliderRange class="bg-argon-600/50 absolute h-full rounded-full" />
            <span
              v-if="delayedReleaseMicrogons > 0n"
              class="pointer-events-none absolute h-full bg-argon-200"
              :style="{
                left: `${securitizationSlider[0]}%`,
                width: `${activeSecuritizationPercentage - securitizationSlider[0]}%`,
              }"
            />
            <span
              v-if="activeSecuritizationMicrogons > 0n && activeSecuritizationPercentage < 99"
              class="pointer-events-none absolute top-1/2 h-5 -translate-x-1/2 -translate-y-1/2 border-l border-slate-500"
              :style="{ left: `${activeSecuritizationPercentage}%` }"
            />
          </SliderTrack>
          <!-- prettier-ignore -->
          <SliderThumb aria-label="ARGN securitization" class="relative z-10 block h-5 w-5 rounded-full border border-gray-400 bg-white shadow-sm focus:outline-none" />
        </SliderRoot>

        <div class="relative mt-1 h-5 text-sm text-slate-500">
          <div class="flex justify-between">
            <span>0 min</span>
            <span>{{ microgonToArgonNm(maximumSecuritizationMicrogons).format('0,0.[00]') }} max</span>
          </div>
          <Tooltip v-if="lockedReleaseMessage" as-child :content="lockedReleaseTooltip">
            <span
              class="absolute bottom-0 inline-flex -translate-x-1/2 items-center gap-1 whitespace-nowrap"
              :style="{ left: `${activeSecuritizationPercentage}%` }"
            >
              <ClockIcon class="size-4" />
              {{ lockedReleaseMessage }}
            </span>
          </Tooltip>
        </div>

        <div class="mt-7">
          <div class="mb-2 flex items-center justify-between">
            <label class="text-sm font-semibold text-slate-700">ARGNOT securitization</label>
            <div class="flex items-center text-sm font-semibold">
              <Tooltip as-child>
                <span class="inline-flex items-center gap-1">
                  <span v-if="argonotReturnsExceedsWalletMaximum" class="text-gray-600/60">
                    Max Returns (above your max)
                  </span>
                  <span v-else-if="committedMicronots === finalArgonotTarget" class="text-gray-600/60">Max Returns</span>
                  <button
                    v-else
                    type="button"
                    class="text-argon-600 hover:text-argon-700 cursor-pointer disabled:cursor-not-allowed disabled:text-slate-300"
                    :disabled="isProcessing"
                    @click="committedMicronots = finalArgonotTarget"
                  >
                    Max Returns
                  </button>
                  <InformationCircleIcon class="size-3.5 cursor-help text-slate-400 hover:text-slate-600" />
                </span>
                <template #content>
                  <template v-if="argonotReturnsExceedsWalletMaximum">
                    {{ formatArgonots(finalArgonotTarget) }} ARGNOT maximizes your vault's eligible share of mining
                    auction returns, but exceeds your wallet maximum.
                  </template>
                  <template v-else>
                    {{ formatArgonots(finalArgonotTarget) }} ARGNOT maximizes your vault's eligible share of mining
                    auction returns.
                  </template>
                </template>
              </Tooltip>
              <span class="mx-2 text-gray-300">|</span>
              <span v-if="committedMicronots === maximumArgonotSecuritizationMicronots" class="text-gray-600/60">
                Wallet Max
              </span>
              <button
                v-else
                type="button"
                class="text-argon-600 hover:text-argon-700 cursor-pointer disabled:cursor-not-allowed disabled:text-slate-300"
                :disabled="isProcessing"
                @click="useArgonotWalletMaximum"
              >
                Wallet Max
              </button>
            </div>
          </div>

          <div class="relative">
            <InputToken
              v-model="committedMicronots"
              :min="minimumArgonotSecuritizationMicronots"
              :max="maximumArgonotSecuritizationMicronots"
              suffix=" ARGNOT"
              :hideArrows="true"
              :class="hasArgonotChange ? 'w-full pr-28' : 'w-full'"
              :disabled="isProcessing"
              @change="updateFee"
            />
            <div
              v-if="hasArgonotChange"
              class="pointer-events-none absolute inset-y-0 right-3 z-10 flex items-center font-mono text-sm text-slate-500"
            >
              {{ argonotChangeMicronots > 0n ? '+' : '-' }}{{ formatArgonots(argonotChangeMicronots > 0n ? argonotChangeMicronots : -argonotChangeMicronots) }} ARGNOT
            </div>
          </div>

          <SliderRoot
            v-model="argonotSlider"
            class="relative mt-1 flex h-5 w-full touch-none items-center select-none"
            :min="0"
            :max="100"
            :step="0.01"
            :disabled="isProcessing"
          >
            <SliderTrack class="relative h-2 grow rounded-full bg-gray-500/30">
              <SliderRange class="bg-argon-600/50 absolute h-full rounded-full" />
            </SliderTrack>
            <!-- prettier-ignore -->
            <SliderThumb aria-label="ARGNOT securitization" class="block h-5 w-5 rounded-full border border-gray-400 bg-white shadow-sm focus:outline-none" />
          </SliderRoot>

          <div class="relative mt-1 h-5 text-sm text-slate-500">
            <div class="flex justify-between">
              <Tooltip
                v-if="minimumArgonotSecuritizationMicronots > 0n"
                as-child
                content="This amount is backing your registered minting authority and cannot be released."
              >
                <span class="inline-flex items-center gap-1">
                  {{ formatArgonots(minimumArgonotSecuritizationMicronots) }} locked
                  <InformationCircleIcon class="size-3.5 cursor-help text-slate-400 hover:text-slate-600" />
                </span>
              </Tooltip>
              <span v-else>0 min</span>
              <span>{{ formatArgonots(maximumArgonotSecuritizationMicronots) }} max</span>
            </div>
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
import BigNumber from 'bignumber.js';
import { ExclamationCircleIcon } from '@heroicons/vue/20/solid';
import { ClockIcon, InformationCircleIcon } from '@heroicons/vue/24/outline';
import {
  bigIntMax,
  bigIntMin,
  bigNumberToBigInt,
  MICROGONS_PER_ARGON,
  MICRONOTS_PER_ARGONOT,
  NetworkConfig,
  TreasuryBonds,
} from '@argonprotocol/apps-core';
import { SliderRange, SliderRoot, SliderThumb, SliderTrack } from 'reka-ui';
import AlertIcon from '../assets/alert.svg?component';
import basicEmitter from '../emitters/basicEmitter.ts';
import InputToken from '../components/InputToken.vue';
import ProgressBar from '../components/ProgressBar.vue';
import Tooltip from '../components/Tooltip.vue';
import WalletFundingCallout from '../components/WalletFundingCallout.vue';
import { BITCOIN_BLOCK_MILLIS } from '../lib/Env.ts';
import { existentialDepositMicronots } from '../lib/WalletForArgon.ts';
import { WalletType } from '../lib/Wallet.ts';
import type { IVaultIncreaseAllocationMetadata } from '../lib/MyVault.ts';
import type { TransactionInfo } from '../lib/TransactionInfo.ts';
import { ExtrinsicType, TransactionStatus } from '../lib/db/TransactionsTable.ts';
import { createNumeralHelpers } from '../lib/numeral.ts';
import { getBitcoinLocks } from '../stores/bitcoin.ts';
import { getCurrency } from '../stores/currency.ts';
import { getMainchainClient } from '../stores/mainchain.ts';
import { getMyVault } from '../stores/vaults.ts';
import { useWallets } from '../stores/wallets.ts';
import { useVaultingAssetBreakdown } from '../stores/vaultingAssetBreakdown.ts';
import OverlayBase from './OverlayBase.vue';

const currency = getCurrency();
const wallets = useWallets();
const myVault = getMyVault();
const bitcoinLocks = getBitcoinLocks();
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
const currentSecuritizationTarget = Vue.computed(() => {
  return myVault.createdVault?.securitizationTarget ?? vaultingAssets.securityMicrogons;
});
const bitcoinSecuritizationShortfall = Vue.computed(() => {
  const vaultId = myVault.createdVault?.vaultId;
  if (!vaultId) return 0n;

  let bitcoinMarketValue = 0n;
  for (const lock of bitcoinLocks.getAllLocks({ includeHistoryRecoveryPending: true })) {
    if (lock.vaultId !== vaultId || bitcoinLocks.isInactiveForVaultDisplay(lock)) continue;

    bitcoinMarketValue += currency.convertSatToMicrogon(lock.fundedSatoshis);
  }
  for (const lock of Object.values(myVault.data.externalLocks)) {
    bitcoinMarketValue += currency.convertSatToMicrogon(lock.satoshis);
  }

  return bigIntMax(bitcoinMarketValue - vaultingAssets.securityMicrogons, 0n);
});
const activeSecuritizationMicrogons = Vue.computed(() => {
  return myVault.createdVault?.securitizationLocked ?? vaultingAssets.securityMicrogonsActivated;
});
const maximumSecuritizationMicrogons = Vue.computed(() => {
  return bigIntMax(
    vaultingAssets.securityMicrogons + wallets.defaultArgonSpendableMicrogons,
    activeSecuritizationMicrogons.value,
  );
});
const minimumArgonotSecuritizationMicronots = Vue.computed(() => {
  return myVault.mintingAuthorities.data.authorities.length > 0 ? vaultingAssets.securityMicronotsActivated : 0n;
});
const maximumArgonotSecuritizationMicronots = Vue.computed(() => {
  return (
    vaultingAssets.securityMicronots +
    bigIntMax(wallets.defaultArgonWallet.availableMicronots - existentialDepositMicronots, 0n)
  );
});
const activeSecuritizationPercentage = Vue.computed(() => {
  if (maximumSecuritizationMicrogons.value === 0n) return 0;
  return BigNumber(activeSecuritizationMicrogons.value.toString())
    .dividedBy(maximumSecuritizationMicrogons.value.toString())
    .multipliedBy(100)
    .toNumber();
});
const delayedReleaseMicrogons = Vue.computed(() => {
  return bigIntMax(activeSecuritizationMicrogons.value - securitizationMicrogons.value, 0n);
});
const scheduledSecuritizationReleases = Vue.computed(() => {
  const releaseSchedule = myVault.createdVault?.securitizationReleaseSchedule;
  return releaseSchedule ? [...releaseSchedule.entries()].sort(([a], [b]) => a - b) : [];
});
const scheduledReleaseMicrogons = Vue.computed(() => {
  return scheduledSecuritizationReleases.value.reduce((total, [height, amount]) => {
    return height > bitcoinLocks.data.oracleBitcoinBlockHeight ? total + amount : total;
  }, 0n);
});
const scheduledReleaseDate = Vue.computed(() => {
  const [height] =
    [...scheduledSecuritizationReleases.value]
      .reverse()
      .find(([height]) => height > bitcoinLocks.data.oracleBitcoinBlockHeight) ?? [];

  return height === undefined
    ? undefined
    : new Date(Date.now() + (height - bitcoinLocks.data.oracleBitcoinBlockHeight) * BITCOIN_BLOCK_MILLIS);
});
const delayedReleaseHeight = Vue.computed(() => {
  let scheduledReleaseMicrogons = 0n;

  for (const [height, amount] of scheduledSecuritizationReleases.value) {
    if (height <= bitcoinLocks.data.oracleBitcoinBlockHeight) continue;

    scheduledReleaseMicrogons += amount;
    if (scheduledReleaseMicrogons >= delayedReleaseMicrogons.value) return height;
  }
});
const bitcoinLockedReleaseDate = Vue.computed(() => {
  let latestReleaseTime = 0;
  const vaultId = myVault.vaultId;
  if (vaultId === undefined) return;

  for (const lock of bitcoinLocks.getAllLocks()) {
    if (lock.vaultId !== vaultId || !bitcoinLocks.isLockFunded(lock)) continue;

    try {
      latestReleaseTime = Math.max(latestReleaseTime, bitcoinLocks.getSecuritizationHoldExpirationTime(lock));
    } catch {
      // A lock without its funding terms cannot set a release date.
    }
  }
  for (const lock of Object.values(myVault.data.externalLocks)) {
    if (lock.isPending || lock.isReleasing) continue;

    try {
      latestReleaseTime = Math.max(
        latestReleaseTime,
        bitcoinLocks.getSecuritizationHoldExpirationTime(lock.lockDetails),
      );
    } catch {
      // A lock without its funding terms cannot set a release date.
    }
  }

  return latestReleaseTime ? new Date(latestReleaseTime) : undefined;
});
const delayedReleaseDate = Vue.computed(() => {
  if (delayedReleaseMicrogons.value === 0n) return;

  return delayedReleaseHeight.value === undefined
    ? bitcoinLockedReleaseDate.value
    : new Date(
        Date.now() + (delayedReleaseHeight.value - bitcoinLocks.data.oracleBitcoinBlockHeight) * BITCOIN_BLOCK_MILLIS,
      );
});
const delayedReleaseMessage = Vue.computed(() => {
  if (!delayedReleaseDate.value) return;

  return `${microgonToArgonNm(delayedReleaseMicrogons.value).format('0,0.[00]')} ARGN locked until ${delayedReleaseDate.value.toLocaleDateString(
    undefined,
    {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
    },
  )}.`;
});
const lockedSecuritizationRelease = Vue.computed(() => {
  const date = scheduledReleaseDate.value ?? bitcoinLockedReleaseDate.value;
  if (!date) return;

  return {
    microgons:
      scheduledReleaseMicrogons.value > 0n ? scheduledReleaseMicrogons.value : activeSecuritizationMicrogons.value,
    date,
  };
});
const lockedReleaseMessage = Vue.computed(() => {
  const release = lockedSecuritizationRelease.value;
  if (!release) return;

  return `${microgonToArgonNm(release.microgons).format('0,0.[00]')} ARGN locked until ${release.date.toLocaleDateString(
    undefined,
    {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
    },
  )}.`;
});
const lockedReleaseTooltip = Vue.computed(() => {
  const release = lockedSecuritizationRelease.value;
  if (!release) return;

  return `${microgonToArgonNm(release.microgons).format('0,0.[00]')} ARGN will return to your wallet in stages as Bitcoin releases. The final release is on ${release.date.toLocaleDateString(
    undefined,
    {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
    },
  )}.`;
});

const finalArgonotTarget = Vue.computed(() => {
  return TreasuryBonds.getVaultArgonotSecuritizationTarget({
    activatedSecuritizationMicrogons: securitizationMicrogons.value,
    totalArgonIssuanceMicrogons: totalArgonIssuanceMicrogons.value,
    totalArgonotIssuanceMicronots: totalArgonotIssuanceMicronots.value,
  });
});
const argonotReturnsExceedsWalletMaximum = Vue.computed(() => {
  return finalArgonotTarget.value > maximumArgonotSecuritizationMicronots.value;
});
const securitizationChangeMicrogons = Vue.computed(() => {
  if (pendingTransaction.value) {
    const metadata = pendingTransaction.value.tx.metadataJson;
    return (
      metadata.securitizationChangeMicrogons ??
      (metadata.securitizationMicrogons ?? vaultingAssets.securityMicrogons) - vaultingAssets.securityMicrogons
    );
  }
  return securitizationMicrogons.value - currentSecuritizationTarget.value;
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
const argonInputAdjustmentMicrogons = Vue.computed(() => {
  return delayedReleaseMicrogons.value > 0n ? -delayedReleaseMicrogons.value : securitizationChangeMicrogons.value;
});
const hasArgonInputAdjustment = Vue.computed(() => argonInputAdjustmentMicrogons.value !== 0n);

const walletShortfall = Vue.computed(() => {
  const argonsToAdd = bigIntMax(securitizationMicrogons.value - vaultingAssets.securityMicrogons, 0n);
  return bigIntMax(argonsToAdd + txFee.value - wallets.defaultArgonSpendableMicrogons, 0n);
});

const securitizationSlider = createSecuritizationSlider(
  securitizationMicrogons,
  () => 0n,
  maximumSecuritizationMicrogons,
  BigInt(MICROGONS_PER_ARGON),
);
const argonotSlider = createSecuritizationSlider(
  committedMicronots,
  () => minimumArgonotSecuritizationMicronots.value,
  maximumArgonotSecuritizationMicronots,
  BigInt(MICRONOTS_PER_ARGONOT),
);

const argonotWalletShortfall = Vue.computed(() => {
  return bigIntMax(committedMicronots.value - maximumArgonotSecuritizationMicronots.value, 0n);
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
  securitizationMicrogons.value = pendingMetadata?.securitizationMicrogons ?? currentSecuritizationTarget.value;
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
  basicEmitter.emit('openWalletOverlay', { wallet: wallets.argonWallets.defaultArgonWallet });
}

async function useWalletMaximum() {
  securitizationMicrogons.value = maximumSecuritizationMicrogons.value;
  await updateFee();
  securitizationMicrogons.value =
    vaultingAssets.securityMicrogons + bigIntMax(wallets.defaultArgonSpendableMicrogons - txFee.value, 0n);

  await updateFee();
  securitizationMicrogons.value =
    vaultingAssets.securityMicrogons + bigIntMax(wallets.defaultArgonSpendableMicrogons - txFee.value, 0n);
}

async function useArgonotWalletMaximum() {
  committedMicronots.value = maximumArgonotSecuritizationMicronots.value;
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

function createSecuritizationSlider(
  value: Vue.Ref<bigint>,
  minimum: () => bigint,
  maximum: Vue.ComputedRef<bigint>,
  unitsPerToken: bigint,
): Vue.WritableComputedRef<number[]> {
  return Vue.computed<number[]>({
    get: () => {
      const range = maximum.value - minimum();
      if (range === 0n) return [0];
      return [
        BigNumber((value.value - minimum()).toString())
          .dividedBy(range.toString())
          .multipliedBy(100)
          .toNumber(),
      ];
    },
    set: ([percentage]) => {
      const range = maximum.value - minimum();
      if ((percentage ?? 0) <= 0) {
        value.value = minimum();
        return;
      }
      if ((percentage ?? 0) >= 100) {
        value.value = maximum.value;
        return;
      }

      const unsnappedValue =
        minimum() +
        bigNumberToBigInt(
          BigNumber(range.toString())
            .multipliedBy(percentage ?? 0)
            .dividedBy(100),
        );
      const step = unsnappedValue < unitsPerToken * 10n ? unitsPerToken : unitsPerToken * 10n;
      let snappedValue = ((unsnappedValue + step / 2n) / step) * step;
      if (unsnappedValue > value.value && snappedValue <= value.value) {
        snappedValue = ((value.value + step) / step) * step;
      } else if (unsnappedValue < value.value && snappedValue >= value.value) {
        snappedValue = ((value.value - 1n) / step) * step;
      }
      value.value = bigIntMin(bigIntMax(snappedValue, minimum()), maximum.value);
    },
  });
}

function formatArgonots(micronots: bigint) {
  return micronotToArgonotNm(micronots).format('0,0.[00]');
}

basicEmitter.on('openSecuritizationOverlay', openOverlay);

Vue.onBeforeUnmount(() => {
  basicEmitter.off('openSecuritizationOverlay', openOverlay);
});
</script>
