<!-- prettier-ignore -->
<template>
  <OverlayBase
    :isOpen="isOpen"
    @close="closeOverlay"
    @pressEsc="closeOverlay"
    class="w-7/12"
  >
    <template #title>
      <div class="grow text-2xl font-bold">Send an Invite</div>
    </template>

    <div class="px-8 py-6 text-slate-700">
      <p class="text-sm leading-6 text-slate-500">
        Grow your vault network by inviting new members to lock Bitcoin and Bonds in your vault. You can help them progress through certification just as you did.
      </p>

      <div v-if="isLoading" class="border-y border-slate-200 py-12 mt-6 text-center text-sm text-slate-500">
        Loading your invite settings…
      </div>

      <form v-else class="mt-6" @submit.prevent="submitInvite">
        <div v-if="requiresOperatorName">
          <label class="text-sm font-semibold text-slate-700">From Name</label>
          <input
            v-model.trim="operatorName"
            type="text"
            maxlength="18"
            placeholder="ArgonFamilyVault"
            class="inner-input-shadow focus:border-argon-500 focus:ring-argon-500/15 mt-2 w-full rounded-lg border border-slate-400/70 bg-white px-3 py-2 text-base text-slate-700 placeholder:text-slate-300 outline-none transition focus:ring-2"
          />
          <div class="mt-2 text-xs text-slate-500">
            This name identifies your vault in every invite. Start with a capital letter and use up to 18 letters or
            numbers.
          </div>
        </div>

        <div :class="requiresOperatorName ? 'mt-5' : ''">
          <label class="text-sm font-semibold text-slate-700">Invitee Name</label>
          <input
            v-model.trim="inviteName"
            type="text"
            placeholder="Who is this invite for?"
            class="inner-input-shadow focus:border-argon-500 focus:ring-argon-500/15 mt-2 w-full rounded-lg border border-slate-400/70 bg-white px-3 py-2 text-base text-slate-700 placeholder:text-slate-300 outline-none transition focus:ring-2"
          />
          <div class="mt-2 text-xs text-slate-500">
            Add a name just to help you track inside the app.
          </div>
        </div>

        <section class="mt-6 border-t border-slate-200 pt-5">
          <div class="flex items-start justify-between gap-5">
            <div>
              <div class="text-sm font-semibold text-slate-800">Gifts</div>
              <p class="mt-1 text-xs leading-5 text-slate-500">
                Choose at least one benefit for this invite. To ensure a smooth onboarding, you need to create enough space for new Bitcoin locks and bonds to be added to your vault.
                <br/><br/>
                <template v-if="supportsFlexibleAssets">
                  To add more space, you can make your own Bitcoin and bonds "flexible"
                  <a href="#" class="cursor-pointer" @click.prevent="openFlexibleAssets">here.</a>
                </template>
              </p>
            </div>
          </div>

          <div class="mt-4 border-y border-slate-200 py-4">
            <label class="flex cursor-pointer items-start gap-3">
              <input v-model="hasBitcoinFeeWaiver" type="checkbox" class="sr-only" />
              <Checkbox :isChecked="hasBitcoinFeeWaiver" :size="4" class="mt-0.5 shrink-0" />
              <span class="grow">
                <span class="block text-sm font-semibold text-slate-800">Waive the fee on their first Bitcoin lock</span>
                <span class="mt-1 block text-xs leading-5 text-slate-500">
                  Your invitee supplies the Bitcoin; your vault charges no fee.
                </span>
              </span>
              <span class="shrink-0 text-xs font-medium text-slate-500">
                {{ microgonToArgonNm(maxLockableMicrogons).format('0,0.[00]') }} ARGN available
              </span>
            </label>

            <div v-if="hasBitcoinFeeWaiver" class="mt-4 pl-7">
              <div class="mb-2 text-xs font-semibold text-slate-600">
                Maximum lock value covered by this gift
              </div>
              <InputToken
                data-testid="MemberInvite.argonAmount"
                v-model="maximumBitcoinLockMicrogons"
                :disabled="!!inviteCreationBlockedReason"
                :min="0n"
                :max="maxLockableMicrogons"
                suffix=" ARGN"
              />
              <div class="mt-2 text-xs text-slate-500">
                ≈ {{ satToBtcNm(maximumBitcoinLockSatoshis).format('0,0.[00000000]') }} BTC · Gift value {{ currency.symbol
                }}{{ microgonToMoneyNm(bitcoinFeeGiftValueMicrogons).format('0,0.00') }}
              </div>
              <div
                v-if="
                  maximumBitcoinLockMicrogons > 0n &&
                  maximumBitcoinLockMicrogons < controller.rewardConfig.treasuryMinimumBitcoin
                "
                class="mt-3 border-l-2 border-amber-400 py-0.5 pl-3 text-xs leading-5 text-amber-700"
              >
                Treasury certification requires at least
                {{ microgonToArgonNm(controller.rewardConfig.treasuryMinimumBitcoin).format('0,0.[00]') }} ARGN of
                Bitcoin. Increase this gift to cover that requirement.
              </div>
            </div>
          </div>

          <div v-if="!hasBitcoinFeeWaiver" class="mt-3 text-right text-xs font-semibold text-amber-700">
            Select at least one gift.
          </div>
        </section>

        <div
          v-if="inviteCreationBlockedReason"
          class="border-argon-300 mt-5 border-l-2 py-0.5 pl-3 text-sm text-slate-600"
        >
          {{ inviteCreationBlockedReason }}
        </div>

        <div v-if="setupTransaction" class="mt-5">
          <div class="text-sm font-medium text-slate-700">Preparing your vault to send member invites.</div>
          <ProgressBar :progress="setupProgressPct" :hasError="!!setupProgressError" class="mt-3" />
          <div class="mt-2 text-xs text-slate-500">{{ setupProgressMessage }}</div>
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
            {{ isSubmitting ? 'Sending…' : 'Send Invite' }}
          </button>
        </div>
      </form>
    </div>
  </OverlayBase>
</template>

<script setup lang="ts">
import * as Vue from 'vue';
import BigNumber from 'bignumber.js';
import { BitcoinLock } from '@argonprotocol/mainchain';
import { bigIntMax, bigIntMin, bigNumberToBigInt, NetworkConfig, UnitOfMeasurement } from '@argonprotocol/apps-core';
import Checkbox from '../components/Checkbox.vue';
import InputToken from '../components/InputToken.vue';
import ProgressBar from '../components/ProgressBar.vue';
import basicEmitter from '../emitters/basicEmitter.ts';
import { createNumeralHelpers } from '../lib/numeral.ts';
import { supportsFlexibleAssetsRuntime, type IVaultBackfillChanges } from '../lib/MyVault.ts';
import type { TransactionInfo } from '../lib/TransactionInfo.ts';
import { generateProgressLabel } from '../lib/Utils.ts';
import { useBasics } from '../stores/basics.ts';
import { getBitcoinLocks } from '../stores/bitcoin.ts';
import { useCertificationController } from '../stores/certificationController.ts';
import { getConfig } from '../stores/config.ts';
import { getCurrency } from '../stores/currency.ts';
import { getMainchainClient } from '../stores/mainchain.ts';
import { getServerApiClient } from '../stores/server.ts';
import { getMyVault } from '../stores/vaults.ts';
import { useVaultingAssetBreakdown } from '../stores/vaultingAssetBreakdown.ts';
import OverlayBase from './OverlayBase.vue';

const basics = useBasics();
const bitcoinLocks = getBitcoinLocks();
const config = getConfig();
const controller = useCertificationController();
const currency = getCurrency();
const myVault = getMyVault();
const serverApiClient = getServerApiClient();
const vaultingAssets = useVaultingAssetBreakdown();
const { microgonToArgonNm, microgonToMoneyNm, satToBtcNm } = createNumeralHelpers(currency);

const isOpen = Vue.ref(false);
const isLoading = Vue.ref(false);
const isSubmitting = Vue.ref(false);
const operatorName = Vue.ref('');
const inviteName = Vue.ref('');
const hasBitcoinFeeWaiver = Vue.ref(true);
const maximumBitcoinLockMicrogons = Vue.ref(0n);
const maxLockableSatoshis = Vue.ref(0n);
const maxLockableMicrogons = Vue.ref(0n);
const supportsFlexibleAssets = Vue.ref(false);
const inviteCreationBlockedReason = Vue.ref('');
const errorMessage = Vue.ref('');
const setupTransaction = Vue.ref<TransactionInfo>();
const setupProgressPct = Vue.ref(0);
const setupProgressMessage = Vue.ref('');
const setupProgressError = Vue.ref('');
const flexibleAssetChanges = Vue.shallowRef<IVaultBackfillChanges>();

let unsubscribeSetupProgress: VoidFunction | undefined;
let openRequestId = 0;

const requiresOperatorName = Vue.computed(() => !myVault.createdVault?.name);
const maximumBitcoinLockSatoshis = Vue.computed(() => {
  return BitcoinLock.satoshisRequiredForRedemptionAmount(currency.priceIndex, maximumBitcoinLockMicrogons.value);
});
const bitcoinFeeGiftValueMicrogons = Vue.computed(() => {
  const vault = myVault.createdVault;
  if (!vault) return 0n;

  const lockValue = BitcoinLock.calculateRedemptionAmountFromSatoshis(
    currency.priceIndex,
    maximumBitcoinLockSatoshis.value,
  );
  return vault.calculateBitcoinFee(lockValue);
});
const canSubmit = Vue.computed(() => {
  if (isLoading.value || isSubmitting.value || inviteCreationBlockedReason.value) return false;
  if (!inviteName.value.trim()) return false;
  if (requiresOperatorName.value && !operatorName.value.trim()) return false;
  if (!hasBitcoinFeeWaiver.value) return false;
  return maximumBitcoinLockMicrogons.value > 0n && maximumBitcoinLockMicrogons.value <= maxLockableMicrogons.value;
});

function closeOverlay() {
  if (isSubmitting.value) return;

  openRequestId += 1;
  clearSetupProgress();
  isOpen.value = false;
  basics.overlayIsOpen = false;
}

async function openOverlay(request?: { preserveDraft?: boolean; flexibleAssetChanges?: IVaultBackfillChanges }) {
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
    hasBitcoinFeeWaiver.value = true;
    flexibleAssetChanges.value = hasRequestedFlexibleAssetChanges ? requestedFlexibleAssetChanges : undefined;
  } else if (request && 'flexibleAssetChanges' in request) {
    flexibleAssetChanges.value = hasRequestedFlexibleAssetChanges ? requestedFlexibleAssetChanges : undefined;
  }

  try {
    await loadInviteCapacity(preserveDraft);
    if (!isOpen.value || requestId !== openRequestId) return;

    if (supportsFlexibleAssets.value && maxLockableMicrogons.value <= 0n && !flexibleAssetChanges.value) {
      isOpen.value = false;
      basics.overlayIsOpen = false;

      if (preserveDraft) {
        basicEmitter.emit('openBackfillOverlay', { returnToInvite: true });
      } else {
        basicEmitter.emit('openBackfillOverlay', { continueToInvite: true });
      }
    }
  } catch (error: any) {
    if (requestId !== openRequestId) return;
    errorMessage.value = error?.message ?? 'Unable to load your invite settings right now.';
  } finally {
    if (requestId === openRequestId) {
      isLoading.value = false;
    }
  }
}

async function loadInviteCapacity(preserveGiftAmount = false) {
  await myVault.load(true);
  const vault = myVault.createdVault;
  if (!vault) {
    inviteCreationBlockedReason.value = 'Create your vault before sending member invites.';
    maxLockableSatoshis.value = 0n;
    maxLockableMicrogons.value = 0n;
    maximumBitcoinLockMicrogons.value = 0n;
    return;
  }

  const client = await getMainchainClient(false);
  supportsFlexibleAssets.value = supportsFlexibleAssetsRuntime(client);
  operatorName.value = vault.name ?? '';

  if (!supportsFlexibleAssets.value) {
    const { availableSatoshis, availableLiquidityMicrogons } = await bitcoinLocks.getLockableBitcoinCapacity({ vault });

    maxLockableSatoshis.value = availableSatoshis;
    maxLockableMicrogons.value = availableLiquidityMicrogons;
    if (!preserveGiftAmount || maximumBitcoinLockMicrogons.value > availableLiquidityMicrogons) {
      maximumBitcoinLockMicrogons.value = availableLiquidityMicrogons;
    }
    inviteCreationBlockedReason.value =
      availableLiquidityMicrogons > 0n ? '' : 'Member invites require available Bitcoin lock space.';
    return;
  }

  let flexibleBitcoinMicrogons = vaultingAssets.flexibleBitcoinMicrogonsAvailable;
  if (flexibleAssetChanges.value) {
    const bitcoinSecuritizationRatios = await Promise.all(
      flexibleAssetChanges.value.bitcoinChanges.map(async change => {
        return (await bitcoinLocks.getLockSecuritizationRatio(client, change.lock)) ?? vault.securitizationRatioBN();
      }),
    );
    let projectedBackfillMicrogons = vault.backfillSecuritizationLocked;
    for (const [index, change] of flexibleAssetChanges.value.bitcoinChanges.entries()) {
      const securitizationMicrogons = bigNumberToBigInt(
        bitcoinSecuritizationRatios[index].multipliedBy(change.lock.liquidityPromised),
      );
      projectedBackfillMicrogons = change.isBackfill
        ? projectedBackfillMicrogons + securitizationMicrogons
        : bigIntMax(projectedBackfillMicrogons - securitizationMicrogons, 0n);
    }

    const ordinaryBitcoinMicrogons = bigIntMax(vault.securitizationLocked - projectedBackfillMicrogons, 0n);
    const supportedBackfillMicrogons = bigIntMax(vault.securitization - ordinaryBitcoinMicrogons, 0n);
    const backedBackfillMicrogons = bigIntMin(projectedBackfillMicrogons, supportedBackfillMicrogons);
    const availableBackfillSecuritization = bigIntMax(
      backedBackfillMicrogons - vault.backfillSecuritizationReserved,
      0n,
    );
    flexibleBitcoinMicrogons = bigNumberToBigInt(
      BigNumber(availableBackfillSecuritization).dividedBy(vault.securitizationRatioBN()),
    );
  }

  const flexibleBitcoinSatoshis = await bitcoinLocks.satoshisForArgonLiquidity(flexibleBitcoinMicrogons);
  if (flexibleAssetChanges.value) {
    maxLockableSatoshis.value = flexibleBitcoinSatoshis;
    maxLockableMicrogons.value = BitcoinLock.calculateRedemptionAmountFromSatoshis(
      currency.priceIndex,
      flexibleBitcoinSatoshis,
    );
    if (!preserveGiftAmount || maximumBitcoinLockMicrogons.value > maxLockableMicrogons.value) {
      maximumBitcoinLockMicrogons.value = maxLockableMicrogons.value;
    }
    inviteCreationBlockedReason.value =
      maxLockableMicrogons.value > 0n ? '' : 'Select a flexible Bitcoin lock before continuing.';
    return;
  }

  const { availableSatoshis, availableLiquidityMicrogons } = await bitcoinLocks.getLockableBitcoinCapacity({
    vault,
    maxSatoshis: flexibleBitcoinSatoshis,
  });

  maxLockableSatoshis.value = availableSatoshis;
  maxLockableMicrogons.value = availableLiquidityMicrogons;
  if (!preserveGiftAmount || maximumBitcoinLockMicrogons.value > availableLiquidityMicrogons) {
    maximumBitcoinLockMicrogons.value = availableLiquidityMicrogons;
  }
  inviteCreationBlockedReason.value =
    availableLiquidityMicrogons > 0n ? '' : 'Member invites require available flexible Bitcoin space.';
}

async function submitInvite() {
  if (!canSubmit.value) return;

  errorMessage.value = '';
  setupProgressError.value = '';
  isSubmitting.value = true;

  try {
    await myVault.load();
    const vault = myVault.createdVault;
    if (!vault) {
      throw new Error('No vault is available to create an invite.');
    }
    if (!config.serverDetails.ipAddress) {
      throw new Error('No server is available to create an invite.');
    }

    if (maximumBitcoinLockMicrogons.value <= 0n) {
      throw new Error('The Bitcoin fee waiver must be greater than zero.');
    }
    if (maximumBitcoinLockMicrogons.value > maxLockableMicrogons.value) {
      throw new Error("The Bitcoin fee waiver can't exceed the vault's available Bitcoin space.");
    }

    const maxSatoshis = await bitcoinLocks.satoshisForArgonLiquidity(maximumBitcoinLockMicrogons.value);
    const fullLockAmount = BitcoinLock.calculateRedemptionAmountFromSatoshis(currency.priceIndex, maxSatoshis);
    if (maxSatoshis > maxLockableSatoshis.value || fullLockAmount > maxLockableMicrogons.value) {
      throw new Error("The Bitcoin fee waiver can't exceed the vault's available Bitcoin space.");
    }
    const estimatedGiftUsd = Number(
      currency.convertMicrogonTo(vault.calculateBitcoinFee(fullLockAmount), UnitOfMeasurement.USD),
    );

    let fromName = vault.name?.trim() ?? '';
    const expectedVaultName = fromName || operatorName.value.trim();

    let inviteSetupTransaction: TransactionInfo | undefined;
    if (flexibleAssetChanges.value) {
      inviteSetupTransaction = await myVault.prepareMemberInvite({
        vaultName: expectedVaultName,
        ...flexibleAssetChanges.value,
      });
    } else if (fromName) {
      inviteSetupTransaction = await myVault.ensureDelegatedBitcoinSigner();
    } else {
      inviteSetupTransaction = await myVault.setupVaultInviteProfile(operatorName.value.trim());
    }

    if (inviteSetupTransaction) {
      await waitForSetupTransaction(inviteSetupTransaction);
      flexibleAssetChanges.value = undefined;
    }

    await myVault.load(true);
    const preparedVault = myVault.createdVault;
    if (preparedVault?.name?.trim() !== expectedVaultName || !preparedVault.delegateAccountId) {
      throw new Error('Your vault invite settings have not reached the chain yet. Please try again.');
    }
    fromName = preparedVault.name!;

    const invite = await serverApiClient.createInvite({
      name: inviteName.value.trim(),
      fromName,
      vaultId: vault.vaultId,
      maxSatoshis,
      estimatedGiftUsd,
      btcPctFee: vault.terms.bitcoinAnnualPercentRate.times(100).toNumber(),
      expiresAfterTicks: 10 * NetworkConfig.rewardTicksPerFrame,
    });

    controller.setOperationalInvites([
      invite,
      ...controller.operationalInvites.filter(candidate => candidate.inviteCode !== invite.inviteCode),
    ]);
    isSubmitting.value = false;
    closeOverlay();
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
  basicEmitter.emit('openBackfillOverlay', {
    returnToInvite: true,
    flexibleAssetChanges: flexibleAssetChanges.value,
  });
}

basicEmitter.on('openMemberInviteOverlay', openOverlay);

Vue.onUnmounted(() => {
  clearSetupProgress();
  basicEmitter.off('openMemberInviteOverlay', openOverlay);
});
</script>
