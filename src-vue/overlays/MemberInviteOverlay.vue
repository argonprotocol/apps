<!-- prettier-ignore -->
<template>
  <OverlayBase
    :isOpen="isOpen"
    @close="closeOverlay"
    @pressEsc="closeOverlay"
    class="w-7/12"
  >
    <template #title>
      <div class="grow text-2xl font-bold">Create Invite</div>
    </template>

    <div class="px-8 py-6 text-base text-slate-700">
      <p class="leading-6 text-slate-500">
        Grow your vault network by inviting new members to lock Bitcoin and Bonds in your vault. You can help them progress through certification just as you did.
      </p>

      <div v-if="isLoading" class="border-y border-slate-200 py-12 mt-6 text-center text-slate-500">
        Loading your invite settings…
      </div>

      <form v-else class="mt-6" @submit.prevent="submitInvite">
        <div>
          <label class="text-sm font-semibold text-slate-700">Invitee Name</label>
          <input
            v-model.trim="inviteName"
            type="text"
            placeholder="Who is this invite for?"
            class="inner-input-shadow focus:border-argon-500 focus:ring-argon-500/15 mt-2 w-full rounded-lg border border-slate-400/70 bg-white px-3 py-2 text-base text-slate-700 placeholder:text-slate-300 outline-none transition focus:ring-2"
          />
          <div class="mt-2 text-sm text-slate-500">
            Add a name just to help you track inside the app.
          </div>
        </div>

        <section class="mt-6 border-t border-slate-200 pt-5">
          <div class="flex items-start justify-between gap-5">
            <div>
              <div class="text-sm font-semibold text-slate-700">Attach Bitcoin Lock Fees Waivers</div>
              <p class="mt-1 text-sm leading-5 text-slate-500">
                Choose how much of this member's Bitcoin locking fees to waive.
                The waiver can be applied across eligible locks until its amount is exhausted or it expires.
                The maximum waiver is based on your current
                {{
                  numeral(inviteVaultSnapshot?.terms.bitcoinAnnualPercentRate.times(100).toNumber() ?? 0).format(
                    '0.[00]',
                  )
                }}% vault fee and available Bitcoin lock space.
                <template v-if="supportsFlexibleAssets">
                  You can
                  <a href="#" class="cursor-pointer" @click.prevent="openFlexibleAssets">manage flexible assets</a>
                  to make more space available.
                </template>
              </p>
            </div>
          </div>

          <div class="mt-4 border-y border-slate-200 py-4">
            <div class="flex items-center justify-between text-sm text-slate-600">
              <span class="font-semibold">Fees to waive</span>
              <span class="font-mono font-semibold text-slate-800">
                {{ currency.symbol }}{{ microgonToArgonNm(feeCreditMicrogons).format('0,0.[00]') }}
              </span>
            </div>
            <SliderRoot
              v-model="feeWaiverPercentage"
              :disabled="!!inviteCreationBlockedReason"
              :min="1"
              :max="100"
              :step="1"
              class="relative mt-3 flex h-5 w-full touch-none items-center select-none"
            >
              <SliderTrack class="relative h-2 grow overflow-hidden rounded-full bg-slate-200">
                <SliderRange class="bg-argon-button absolute h-full rounded-full" />
              </SliderTrack>
              <SliderThumb
                aria-label="Bitcoin lock fee waiver amount"
                class="border-argon-button focus:ring-argon-500/20 block size-5 cursor-grab rounded-full border-2 bg-white shadow focus:ring-4 focus:outline-none active:cursor-grabbing"
              />
            </SliderRoot>
            <div class="mt-2 flex items-start justify-between gap-4">
              <div class="text-sm text-slate-500">
                Supports {{ currency.symbol
                }}{{ microgonToMoneyNm(maximumBitcoinLockMicrogons).format('0,0.[00]') }} in Bitcoin Locks (~{{
                  satToBtcNm(maximumBitcoinLockSatoshis).format('0,0.[00000000]')
                }} BTC)
              </div>
              <MemberInviteFeeWaiverExpiration
                v-model="feeWaiverExpirationDays"
              />
            </div>
          </div>
        </section>

        <div class="mt-5 space-y-2">
          <div
            v-if="hasInsufficientBitcoinWaiver || hasInsufficientBondCapacity"
            class="flex items-start rounded border border-yellow-400/70 bg-yellow-100 px-3 py-2.5 text-sm text-yellow-900"
          >
            <ul class="grow list-disc space-y-1 pl-4">
              <li v-if="hasInsufficientBitcoinWaiver">
                {{ inviteName.trim() || 'This member' }} will not be able to lock enough Bitcoin for Treasury
                verification with this waiver.
              </li>
              <li v-if="hasInsufficientBondCapacity">
                {{ inviteName.trim() || 'This member' }} will not be able to buy enough bonds for Treasury verification.
                <Tooltip
                  as-child
                  side="top"
                  :content="`Your vault currently has ${currency.symbol}${microgonToArgonNm(memberBondCapacityMicrogons).format('0,0.[00]')} of available Argon Bond capacity. Treasury verification requires ${currency.symbol}${microgonToArgonNm(controller.rewardConfig.treasuryMinimumBonds).format('0,0.[00]')}. You can create more Bond space by locking more Bitcoin, or you can make your own Bonds flexible.`"
                >
                  <span class="ml-1 inline-flex cursor-help align-text-bottom">
                    <InformationCircleIcon class="size-4 text-yellow-700" />
                  </span>
                </Tooltip>
              </li>
            </ul>
          </div>

          <div
            v-if="inviteCreationBlockedReason"
            class="flex items-center rounded border border-yellow-400/70 bg-yellow-100 px-3 py-2.5 text-sm text-yellow-900"
          >
            <AlertIcon class="mr-2 size-4 shrink-0 text-yellow-700" />
            <span>
              {{ inviteCreationBlockedReason }}
              <template v-if="myVault.createdVault && !isValidOperatorName(operatorName)">
                <a href="#" class="font-semibold underline" @click.prevent="openOperationalProfile"
                  >Activate member onboarding</a
                >.
              </template>
              <template v-else-if="myVault.createdVault">
                <a href="#" class="font-semibold underline" @click.prevent="openSecuritization">Add securitization</a>
                <template v-if="supportsFlexibleAssets">
                  or
                  <a href="#" class="font-semibold underline" @click.prevent="openFlexibleAssets"
                    >manage flexible assets</a
                  >.
                </template>
              </template>
            </span>
          </div>

        </div>

        <div v-if="setupTransaction" class="mt-5">
          <div class="font-medium text-slate-700">Preparing your vault to create this invite.</div>
          <ProgressBar :progress="setupProgressPct" :hasError="!!setupProgressError" class="mt-3" />
          <div class="mt-2 text-sm text-slate-500">{{ setupProgressMessage }}</div>
        </div>

        <div v-if="errorMessage || setupProgressError" class="mt-5 text-sm text-red-700">
          {{ errorMessage || setupProgressError }}
        </div>

        <div class="mt-7 flex justify-end gap-3 border-t border-slate-200 pt-5">
          <button
            type="button"
            :disabled="isSubmitting"
            class="inner-button-shadow text-argon-600 border-argon-600/20 hover:bg-argon-600/10 cursor-pointer rounded-md border bg-white px-6 py-2 font-bold focus:outline-none disabled:cursor-default disabled:opacity-60"
            @click="closeOverlay"
          >
            Cancel
          </button>
          <button
            data-testid="SubmitMemberInvite"
            type="submit"
            :disabled="!canSubmit"
            class="inner-button-shadow bg-argon-button border-argon-button-hover hover:bg-argon-button-hover cursor-pointer rounded-md border px-6 py-2 font-bold text-white focus:outline-none disabled:cursor-default disabled:opacity-40"
          >
            {{ isSubmitting ? 'Creating…' : 'Create Invite' }}
          </button>
        </div>
      </form>
    </div>
  </OverlayBase>
</template>

<script setup lang="ts">
import * as Vue from 'vue';
import BigNumber from 'bignumber.js';

import { InformationCircleIcon } from '@heroicons/vue/24/outline';
import { SliderRange, SliderRoot, SliderThumb, SliderTrack } from 'reka-ui';
import AlertIcon from '../assets/alert.svg?component';
import {
  bigIntMax,
  bigIntMin,
  bigNumberToBigInt,
  MICROGONS_PER_ARGON,
  NetworkConfig,
  UnitOfMeasurement,
  BitcoinLock,
  Vault,
} from '@argonprotocol/apps-core';
import ProgressBar from '../components/ProgressBar.vue';
import Tooltip from '../components/Tooltip.vue';
import basicEmitter from '../emitters/basicEmitter.ts';
import numeral, { createNumeralHelpers } from '../lib/numeral.ts';
import { supportsFlexibleAssetsRuntime, type IVaultFlexibleAssetChanges } from '../lib/MyVault.ts';
import type { TransactionInfo } from '../lib/TransactionInfo.ts';
import { generateProgressLabel, isValidOperatorName } from '../lib/Utils.ts';
import { getOperationalProfileName, loadOperationalAccount } from '../lib/OperationalAccount.ts';
import { useBasics } from '../stores/basics.ts';
import { getBitcoinLocks } from '../stores/bitcoin.ts';
import { getArgonBonds } from '../stores/argonBonds.ts';
import {
  treasuryBitcoinCertificationDisplayAmount,
  useCertificationController,
} from '../stores/certificationController.ts';
import { getConfig } from '../stores/config.ts';
import { getCurrency } from '../stores/currency.ts';
import { getMainchainClient } from '../stores/mainchain.ts';
import { getServerApiClient } from '../stores/server.ts';
import { getMyVault } from '../stores/vaults.ts';
import { getWalletKeys } from '../stores/wallets.ts';
import MemberInviteFeeWaiverExpiration from './member-invite/FeeWaiverExpirationPopover.vue';
import OverlayBase from './OverlayBase.vue';

const basics = useBasics();
const argonBonds = getArgonBonds();
const bitcoinLocks = getBitcoinLocks();
const config = getConfig();
const controller = useCertificationController();
const currency = getCurrency();
const myVault = getMyVault();
const serverApiClient = getServerApiClient();
const walletKeys = getWalletKeys();
const { microgonToArgonNm, microgonToMoneyNm, satToBtcNm } = createNumeralHelpers(currency);

const isOpen = Vue.ref(false);
const isLoading = Vue.ref(false);
const isSubmitting = Vue.ref(false);
const operatorName = Vue.ref('');
const inviteName = Vue.ref('');
const feeCreditMicrogons = Vue.ref(0n);
const feeWaiverExpirationDays = Vue.ref(7);
const maxLockableSatoshis = Vue.ref(0n);
const maxLockableLiquidityMicrogons = Vue.ref(0n);
const memberBondCapacityMicrogons = Vue.ref(0n);
const memberBondTotalCapacityMicrogons = Vue.ref(0n);
const inviteVaultSnapshot = Vue.shallowRef<Vault>();
const supportsFlexibleAssets = Vue.ref(false);
const inviteCreationBlockedReason = Vue.ref('');
const errorMessage = Vue.ref('');
const setupTransaction = Vue.ref<TransactionInfo>();
const setupProgressPct = Vue.ref(0);
const setupProgressMessage = Vue.ref('');
const setupProgressError = Vue.ref('');
const flexibleAssetChanges = Vue.shallowRef<IVaultFlexibleAssetChanges>();

let unsubscribeSetupProgress: VoidFunction | undefined;
let openRequestId = 0;

const microgonsPerArgon = BigInt(MICROGONS_PER_ARGON);

const maximumFeeCreditMicrogons = Vue.computed(() => {
  const vault = inviteVaultSnapshot.value;
  if (!vault || maxLockableLiquidityMicrogons.value <= 0n) return 0n;

  const maximumFee = vault.calculateBitcoinFee(maxLockableLiquidityMicrogons.value);
  return bigIntMax(maximumFee - vault.terms.bitcoinBaseFee, 0n);
});
const feeWaiverPercentage = Vue.computed<number[]>({
  get: () => {
    const maximumFeeCredit = maximumFeeCreditMicrogons.value;
    if (maximumFeeCredit <= 0n) return [100];

    return [Number((feeCreditMicrogons.value * 100n + maximumFeeCredit / 2n) / maximumFeeCredit)];
  },
  set: value => {
    const percentage = BigInt(Math.round(value[0] ?? 100));
    feeCreditMicrogons.value = (maximumFeeCreditMicrogons.value * percentage) / 100n;
  },
});
const maximumBitcoinLockMicrogons = Vue.computed(() => {
  const vault = inviteVaultSnapshot.value;
  if (!vault || feeCreditMicrogons.value <= 0n || maxLockableLiquidityMicrogons.value <= 0n) return 0n;

  const variableFeeCredit = feeCreditMicrogons.value;
  if (vault.terms.bitcoinAnnualPercentRate.isZero()) return 0n;

  const coveredLockValue = bigNumberToBigInt(
    BigNumber(variableFeeCredit.toString())
      .dividedBy(vault.terms.bitcoinAnnualPercentRate)
      .integerValue(BigNumber.ROUND_FLOOR),
  );
  return bigIntMin(coveredLockValue, maxLockableLiquidityMicrogons.value);
});
const maximumBitcoinLockSatoshis = Vue.computed(() => {
  const requestedSatoshis = BitcoinLock.satoshisRequiredForRedemptionAmount(
    currency.priceIndex,
    maximumBitcoinLockMicrogons.value,
  );
  return maxLockableSatoshis.value > 0n ? bigIntMin(requestedSatoshis, maxLockableSatoshis.value) : requestedSatoshis;
});
const hasInsufficientBitcoinWaiver = Vue.computed(() => {
  return (
    maximumBitcoinLockMicrogons.value > 0n &&
    maximumBitcoinLockMicrogons.value < treasuryBitcoinCertificationDisplayAmount
  );
});
const hasInsufficientBondCapacity = Vue.computed(() => {
  return (
    !!myVault.createdVault &&
    controller.rewardConfig.treasuryMinimumBonds > 0n &&
    memberBondCapacityMicrogons.value < controller.rewardConfig.treasuryMinimumBonds
  );
});
const canSubmit = Vue.computed(() => {
  if (isLoading.value || isSubmitting.value || inviteCreationBlockedReason.value) return false;
  if (!inviteName.value.trim()) return false;
  if (!isValidOperatorName(operatorName.value)) return false;
  return (
    feeCreditMicrogons.value > 0n &&
    maximumBitcoinLockMicrogons.value > 0n &&
    Number.isSafeInteger(feeWaiverExpirationDays.value) &&
    feeWaiverExpirationDays.value > 0 &&
    feeWaiverExpirationDays.value <= 365
  );
});
function closeOverlay() {
  if (isSubmitting.value) return;

  openRequestId += 1;
  clearSetupProgress();
  isOpen.value = false;
  basics.overlayIsOpen = false;
}

async function openOverlay(request?: { preserveDraft?: boolean; flexibleAssetChanges?: IVaultFlexibleAssetChanges }) {
  const requestId = ++openRequestId;
  const preserveDraft = request?.preserveDraft ?? false;
  const requestedFlexibleAssetChanges = request?.flexibleAssetChanges;
  const hasRequestedFlexibleAssetChanges =
    !!requestedFlexibleAssetChanges?.bitcoinChanges.length || !!requestedFlexibleAssetChanges?.bondChanges.length;

  clearSetupProgress();
  isOpen.value = true;
  isLoading.value = true;
  basics.overlayIsOpen = true;
  errorMessage.value = '';
  inviteCreationBlockedReason.value = '';

  if (!preserveDraft) {
    operatorName.value = '';
    inviteName.value = '';
    feeCreditMicrogons.value = 0n;
    feeWaiverExpirationDays.value = 7;
    flexibleAssetChanges.value = hasRequestedFlexibleAssetChanges ? requestedFlexibleAssetChanges : undefined;
  } else if (request && 'flexibleAssetChanges' in request) {
    flexibleAssetChanges.value = hasRequestedFlexibleAssetChanges ? requestedFlexibleAssetChanges : undefined;
  }

  try {
    await loadInviteCapacity(preserveDraft);
    if (!isOpen.value || requestId !== openRequestId) return;
  } catch (error: any) {
    if (requestId !== openRequestId) return;
    errorMessage.value = error?.message ?? 'Unable to load your invite settings right now.';
  } finally {
    if (requestId === openRequestId) {
      isLoading.value = false;
    }
  }
}

async function loadInviteCapacity(preserveFeeWaiverAmount = false) {
  const vault = myVault.createdVault;
  if (!vault) {
    inviteVaultSnapshot.value = undefined;
    memberBondCapacityMicrogons.value = 0n;
    memberBondTotalCapacityMicrogons.value = 0n;
    inviteCreationBlockedReason.value = 'Create your vault before sending member invites.';
    maxLockableSatoshis.value = 0n;
    maxLockableLiquidityMicrogons.value = 0n;
    feeCreditMicrogons.value = 0n;
    return;
  }

  const client = await getMainchainClient(false);
  const currentVault = (await Vault.get(client, vault.vaultId, NetworkConfig.tickMillis)) ?? vault;
  inviteVaultSnapshot.value = currentVault;
  memberBondCapacityMicrogons.value =
    argonBonds.availableBondSpace(currentVault) + currentVault.securitizationPendingActivation;
  memberBondTotalCapacityMicrogons.value =
    currentVault.activatedSecuritization() + currentVault.securitizationPendingActivation;
  supportsFlexibleAssets.value = supportsFlexibleAssetsRuntime(client);
  operatorName.value = getOperationalProfileName(await loadOperationalAccount(walletKeys, client));

  let projectedFlexibleSecuritizationLocked: bigint | undefined;
  if (flexibleAssetChanges.value) {
    const bitcoinSecuritizationRatios = await Promise.all(
      flexibleAssetChanges.value.bitcoinChanges.map(async change => {
        return (
          (await bitcoinLocks.getLockSecuritizationRatio(client, change.lock)) ?? currentVault.securitizationRatioBN()
        );
      }),
    );
    let projectedFlexibleMicrogons = currentVault.flexibleSecuritizationLocked;
    for (const [index, change] of flexibleAssetChanges.value.bitcoinChanges.entries()) {
      const securitizationMicrogons = bigNumberToBigInt(
        bitcoinSecuritizationRatios[index].multipliedBy(change.lock.liquidityPromised),
      );
      projectedFlexibleMicrogons = change.isFlexible
        ? projectedFlexibleMicrogons + securitizationMicrogons
        : bigIntMax(projectedFlexibleMicrogons - securitizationMicrogons, 0n);
    }
    projectedFlexibleSecuritizationLocked = projectedFlexibleMicrogons;
  }

  const { availableSatoshis, availableLiquidityMicrogons } = await bitcoinLocks.getLockableBitcoinCapacity({
    vault: currentVault,
    projectedFlexibleSecuritizationLocked,
  });

  maxLockableSatoshis.value = availableSatoshis;
  maxLockableLiquidityMicrogons.value = availableLiquidityMicrogons;
  if (!preserveFeeWaiverAmount) {
    feeCreditMicrogons.value = maximumFeeCreditMicrogons.value;
  } else {
    feeCreditMicrogons.value = bigIntMin(feeCreditMicrogons.value, maximumFeeCreditMicrogons.value);
  }
  if (!isValidOperatorName(operatorName.value)) {
    inviteCreationBlockedReason.value = 'Activate member onboarding before creating an invite.';
  } else {
    inviteCreationBlockedReason.value =
      availableLiquidityMicrogons >= microgonsPerArgon
        ? ''
        : `Member invites require at least ${currency.symbol}1 of available Bitcoin lock space.`;
  }
}

async function submitInvite() {
  if (!canSubmit.value) return;

  errorMessage.value = '';
  setupProgressError.value = '';
  isSubmitting.value = true;

  try {
    await Promise.all([myVault.load(true), currency.load(true)]);
    await loadInviteCapacity(true);
    const vault = myVault.createdVault;
    if (!vault) {
      throw new Error('No vault is available to create an invite.');
    }
    if (!config.serverDetails.ipAddress) {
      throw new Error('No server is available to create an invite.');
    }

    if (feeCreditMicrogons.value <= 0n) {
      throw new Error('The Bitcoin fee waiver must be greater than zero.');
    }

    const maxSatoshis = maximumBitcoinLockSatoshis.value;
    if (maxSatoshis <= 0n) {
      throw new Error('The Bitcoin fee waiver is too small to cover a lock at the current fee.');
    }
    if (maxSatoshis > maxLockableSatoshis.value) {
      throw new Error("The Bitcoin fee waiver can't exceed the vault's available Bitcoin space.");
    }
    const estimatedGiftUsd = Number(currency.convertMicrogonTo(feeCreditMicrogons.value, UnitOfMeasurement.USD));

    const fromName = operatorName.value.trim();

    let inviteSetupTransaction: TransactionInfo | undefined;
    if (flexibleAssetChanges.value) {
      inviteSetupTransaction = await myVault.prepareMemberInvite({
        operatorName: fromName,
        ...flexibleAssetChanges.value,
      });
    } else {
      inviteSetupTransaction = await myVault.ensureVaultDelegateReady();
    }

    if (inviteSetupTransaction) {
      await waitForSetupTransaction(inviteSetupTransaction);
      flexibleAssetChanges.value = undefined;
    }

    const invite = await serverApiClient.createInvite({
      name: inviteName.value.trim(),
      fromName,
      vaultId: vault.vaultId,
      maxSatoshis,
      estimatedGiftUsd,
      feeCreditMicrogons: feeCreditMicrogons.value,
      btcPctFee: vault.terms.bitcoinAnnualPercentRate.times(100).toNumber(),
      expiresAfterTicks: feeWaiverExpirationDays.value * NetworkConfig.rewardTicksPerFrame,
    });

    controller.setOperationalInvites([
      invite,
      ...controller.operationalInvites.filter(candidate => candidate.inviteCode !== invite.inviteCode),
    ]);
    isSubmitting.value = false;
    closeOverlay();
    basicEmitter.emit('openMemberDetailsOverlay', { invite });
  } catch (error: any) {
    errorMessage.value = error?.message ?? 'Unable to send this invite right now.';
  } finally {
    isSubmitting.value = false;
  }
}

async function waitForSetupTransaction(transaction: TransactionInfo) {
  clearSetupProgress();
  setupTransaction.value = transaction;
  setupProgressMessage.value = 'Submitting to Argon…';
  unsubscribeSetupProgress = transaction.subscribeToProgress((progress, error) => {
    setupProgressPct.value = progress.progressPct;
    setupProgressMessage.value = generateProgressLabel(progress.confirmations, progress.expectedConfirmations, {
      blockType: 'Argon',
    });
    setupProgressError.value = error?.message ?? '';
  });

  try {
    await transaction.txResult.waitForInFirstBlock;
  } finally {
    clearSetupProgress();
  }
}

function clearSetupProgress() {
  unsubscribeSetupProgress?.();
  unsubscribeSetupProgress = undefined;
  setupTransaction.value = undefined;
  setupProgressPct.value = 0;
  setupProgressMessage.value = '';
  setupProgressError.value = '';
}

function openFlexibleAssets() {
  if (isSubmitting.value || !supportsFlexibleAssets.value) return;

  isOpen.value = false;
  basics.overlayIsOpen = false;
  basicEmitter.emit('openFlexibleAssetsOverlay', {
    returnTo: 'memberInvite',
    flexibleAssetChanges: flexibleAssetChanges.value,
  });
}

function openOperationalProfile() {
  if (isSubmitting.value) return;

  isOpen.value = false;
  basics.overlayIsOpen = false;
  basicEmitter.emit('openOperationalProfileOverlay', {
    onSaved: () => basicEmitter.emit('openMemberInviteOverlay', { preserveDraft: true }),
  });
}

function openSecuritization() {
  if (isSubmitting.value) return;

  isOpen.value = false;
  basics.overlayIsOpen = false;
  basicEmitter.emit('openSecuritizationOverlay', { returnToInvite: true });
}

basicEmitter.on('openMemberInviteOverlay', openOverlay);

Vue.onUnmounted(() => {
  clearSetupProgress();
  basicEmitter.off('openMemberInviteOverlay', openOverlay);
});
</script>
