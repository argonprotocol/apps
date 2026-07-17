<template>
  <div class="flex h-full flex-col">
    <div class="flex items-start justify-between gap-4 border-b border-slate-200 pb-3">
      <div>
        <div class="text-xl font-bold text-slate-800">Member Invites</div>
        <p class="mt-1 text-sm leading-5 text-slate-500">
          Invite people into your vault, track their certification progress, and approve operations access when they are
          ready.
        </p>
      </div>

      <button
        v-if="
          config.isServerInstalled &&
          hasLoadedVaultState &&
          hasProfileName &&
          !inviteCreationBlockedReason &&
          !isAddingInvite
        "
        type="button"
        class="bg-argon-button hover:bg-argon-button-hover shrink-0 rounded-lg px-3 py-2 text-sm font-semibold text-white"
        @click="toggleAddInvite"
      >
        Add Invite
      </button>
    </div>

    <div v-if="!config.isServerInstalled" class="my-auto text-center text-sm leading-6 text-slate-500">
      Finish installing your server before managing member invites.
    </div>

    <div v-else-if="!hasLoadedVaultState" class="my-auto text-center text-sm text-slate-500">
      Loading member invites…
    </div>

    <div v-else-if="!hasProfileName" class="my-auto text-center">
      <div class="text-sm leading-6 text-slate-500">Set your profile name before sending member invites.</div>

      <button
        type="button"
        class="border-argon-600/20 text-argon-600 inner-button-shadow hover:bg-argon-600/10 mt-4 cursor-pointer rounded-md border bg-white px-5 py-2 font-bold focus:outline-none"
        @click="basicEmitter.emit('openProfileOverlay')"
      >
        Set Profile Name
      </button>
    </div>

    <div v-else class="flex min-h-0 grow flex-col">
      <div v-if="errorMessage || inviteCreationBlockedReason || showRuntimeUpgradeNotice" class="mt-3 space-y-2">
        <div v-if="errorMessage" class="text-sm text-red-600">
          {{ errorMessage }}
        </div>

        <div v-if="inviteCreationBlockedReason" class="border-argon-300 border-l-2 pl-3 text-sm text-slate-600">
          {{ inviteCreationBlockedReason }}
        </div>

        <div v-if="showRuntimeUpgradeNotice" class="border-argon-300 border-l-2 pl-3 text-sm text-slate-600">
          Operations approval will unlock here after the next mainchain runtime upgrade is active.
        </div>
      </div>

      <div v-if="isAddingInvite" class="mt-3 border-b border-slate-200 pb-4">
        <div>
          <label class="text-sm font-medium text-slate-700">Invite name</label>
          <input
            v-model.trim="inviteName"
            type="text"
            class="focus:border-argon-600 mt-2 w-full rounded border border-slate-300 px-3 py-2 focus:ring-0"
          />
        </div>

        <div class="mt-4">
          <label class="text-sm font-medium text-slate-700">Free Bitcoin lock allowance</label>
          <div class="mt-2">
            <InputNumber v-model="maxSatoshisNumber" :min="1" :max="maxSatoshisInputMax" suffix=" sats" />
          </div>
        </div>

        <div class="mt-4 flex gap-2">
          <button
            type="button"
            class="rounded border border-slate-300 px-4 py-2 text-sm font-semibold text-slate-600"
            @click="toggleAddInvite"
          >
            Cancel
          </button>
          <button
            type="button"
            :disabled="isCreatingInvite || !inviteName.trim()"
            class="bg-argon-button hover:bg-argon-button-hover rounded px-4 py-2 text-sm font-semibold text-white disabled:cursor-default disabled:opacity-50"
            @click="createInvite"
          >
            {{ isCreatingInvite ? 'Creating…' : 'Create Invite' }}
          </button>
        </div>
      </div>

      <div
        v-if="!isAddingInvite && !controller.operationalInvites.length"
        class="my-auto px-4 py-8 text-center text-sm text-slate-500"
      >
        No invites yet. Create one to share your vault with a new member.
      </div>

      <div v-else class="mt-3 min-h-0 grow overflow-auto border-y border-slate-200">
        <table class="w-full min-w-[760px] table-auto bg-white">
          <thead class="border-b border-slate-200 bg-slate-50/70 text-left text-xs font-semibold text-slate-500">
            <tr>
              <th class="px-3 py-2.5">Invitee</th>
              <th class="px-3 py-2.5">Status</th>
              <th class="px-3 py-2.5">Step</th>
              <th class="px-3 py-2.5">Contributed</th>
              <th class="px-3 py-2.5 text-right">Actions</th>
            </tr>
          </thead>

          <tbody class="divide-y divide-slate-200">
            <tr v-for="invite in controller.operationalInvites" :key="invite.id" class="bg-white align-middle">
              <td class="px-3 py-2.5">
                <div class="max-w-72 truncate text-sm font-semibold text-slate-800">{{ invite.name }}</div>
              </td>

              <td class="px-3 py-2.5">
                <span
                  v-if="
                    inviteStatus(invite).label === 'Upgrade requested' ||
                    inviteStatus(invite).label === 'Access granted' ||
                    inviteStatus(invite).label === 'Operationally certified'
                  "
                  class="text-argon-600 text-xs font-semibold whitespace-nowrap"
                >
                  {{ inviteStatus(invite).label }}
                </span>
                <span v-else class="text-xs font-semibold whitespace-nowrap text-slate-500">
                  {{ inviteStatus(invite).label }}
                </span>
              </td>

              <td class="px-3 py-2.5 text-sm font-medium whitespace-nowrap text-slate-700">
                <template v-if="inviteCurrentStep(invite)">
                  {{ inviteCurrentStep(invite) }} of {{ totalCertificationRequirementCount }}
                </template>
                <template v-else>-</template>
              </td>

              <td class="px-3 py-2.5 text-sm whitespace-nowrap text-slate-700">
                <div v-if="hasInviteContributionAmounts(invite)" class="flex flex-wrap gap-x-3 gap-y-1">
                  <span>
                    ₳{{ microgonToArgonNm(invite.vaultContribution?.bondAmount ?? 0n).format('0,0.[00]') }} bonds
                  </span>
                  <span>
                    ₳{{ microgonToArgonNm(invite.vaultContribution?.bitcoinAmount ?? 0n).format('0,0.[00]') }} bitcoin
                  </span>
                </div>
                <template v-else>-</template>
              </td>

              <td class="px-3 py-2.5">
                <div class="flex justify-end gap-2">
                  <button
                    v-if="canApproveOperationsAccess(invite)"
                    type="button"
                    :disabled="approvingInviteCode === invite.inviteCode"
                    class="bg-argon-button hover:bg-argon-button-hover rounded px-3 py-1.5 text-sm font-semibold whitespace-nowrap text-white disabled:cursor-default disabled:opacity-50"
                    @click="approveOperationsAccess(invite)"
                  >
                    {{ approvingInviteCode === invite.inviteCode ? 'Approving…' : 'Approve' }}
                  </button>

                  <button
                    v-if="canReassignOperationsUpgradeCode(invite)"
                    type="button"
                    :disabled="reassigningInviteCode === invite.inviteCode"
                    class="rounded border border-slate-300 bg-white px-3 py-1.5 text-sm font-semibold whitespace-nowrap text-slate-700 disabled:cursor-default disabled:opacity-50"
                    @click="reassignOperationsUpgradeCode(invite)"
                  >
                    {{ reassigningInviteCode === invite.inviteCode ? 'Reassigning…' : 'Reassign Code' }}
                  </button>

                  <button
                    v-if="canRegenerateInvite(invite)"
                    type="button"
                    :disabled="regeneratingInviteCode === invite.inviteCode"
                    class="rounded border border-slate-300 bg-white px-3 py-1.5 text-sm font-semibold whitespace-nowrap text-slate-700 disabled:cursor-default disabled:opacity-50"
                    @click="regenerateInvite(invite)"
                  >
                    {{ regeneratingInviteCode === invite.inviteCode ? 'Regenerating…' : 'Regenerate' }}
                  </button>

                  <CopyToClipboard
                    v-if="!canRegenerateInvite(invite)"
                    :content="getMemberInviteUrl(invite)"
                    class="shrink-0"
                  >
                    <button
                      type="button"
                      class="rounded border border-slate-300 bg-white px-3 py-1.5 text-sm font-semibold whitespace-nowrap text-slate-700"
                    >
                      Copy Link
                    </button>
                    <template #copying>
                      <button
                        type="button"
                        class="rounded border border-slate-300 bg-white px-3 py-1.5 text-sm font-semibold whitespace-nowrap text-slate-700"
                      >
                        Copied
                      </button>
                    </template>
                  </CopyToClipboard>
                </div>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import * as Vue from 'vue';
import type { IMemberInvite } from '@argonprotocol/apps-router';
import {
  countCompletedOperationalCertificationRequirements,
  countCompletedTreasuryCertificationRequirements,
  createOperationalAccessProof,
  hasCompletedTreasuryCertificationRequirements,
  NetworkConfig,
  operationalCertificationRequirementCount,
  treasuryCertificationRequirementCount,
  UnitOfMeasurement,
} from '@argonprotocol/apps-core';
import { BitcoinLock } from '@argonprotocol/mainchain';
import CopyToClipboard from '../../components/CopyToClipboard.vue';
import InputNumber from '../../components/InputNumber.vue';
import basicEmitter from '../../emitters/basicEmitter.ts';
import { InviteEnvelope } from '../../lib/InviteEnvelope.ts';
import { createNumeralHelpers } from '../../lib/numeral.ts';
import { supportsOperationalAccessProofRuntime } from '../../lib/OperationalAccount.ts';
import { UpstreamOperatorClient } from '../../lib/UpstreamOperatorClient.ts';
import { getMainchainClient } from '../../stores/mainchain.ts';
import { getBitcoinLocks } from '../../stores/bitcoin.ts';
import { getConfig } from '../../stores/config.ts';
import { getCurrency } from '../../stores/currency.ts';
import { useCertificationController } from '../../stores/certificationController.ts';
import { getServerApiClient } from '../../stores/server.ts';
import { getMyVault } from '../../stores/vaults.ts';
import { getWalletKeys } from '../../stores/wallets.ts';

const config = getConfig();
const controller = useCertificationController();
const myVault = getMyVault();
const currency = getCurrency();
const serverApiClient = getServerApiClient();
const bitcoinLocks = getBitcoinLocks();
const walletKeys = getWalletKeys();

const totalCertificationRequirementCount =
  treasuryCertificationRequirementCount + operationalCertificationRequirementCount;
const { microgonToArgonNm } = createNumeralHelpers(currency);

const isAddingInvite = Vue.ref(false);
const isCreatingInvite = Vue.ref(false);
const hasLoadedVaultState = Vue.ref(false);
const inviteCreationBlockedReason = Vue.ref<string | null>(null);
const errorMessage = Vue.ref<string | null>(null);
const inviteName = Vue.ref('');
const maxSatoshisNumber = Vue.ref(100_000_000);
const maxLockableSatoshis = Vue.ref(100_000_000n);
const approvingInviteCode = Vue.ref<string | null>(null);
const reassigningInviteCode = Vue.ref<string | null>(null);
const regeneratingInviteCode = Vue.ref<string | null>(null);
const supportsAccessProofRuntime = Vue.ref(false);

let loadInvitesPromise: Promise<void> | undefined;

const maxLockableSatoshisNumber = Vue.computed(() => {
  return Number(maxLockableSatoshis.value);
});

const maxSatoshisInputMax = Vue.computed(() => {
  return Math.max(1, maxLockableSatoshisNumber.value);
});

const currentVaultName = Vue.computed(() => {
  return myVault.createdVault?.name ?? '';
});

const hasProfileName = Vue.computed(() => {
  return !!currentVaultName.value;
});

const showRuntimeUpgradeNotice = Vue.computed(() => {
  return (
    !supportsAccessProofRuntime.value &&
    controller.operationalInvites.some(invite => !!invite.operationsUpgradeRequestedAt)
  );
});

function toggleAddInvite() {
  if (inviteCreationBlockedReason.value) return;

  errorMessage.value = null;
  isAddingInvite.value = !isAddingInvite.value;

  if (!isAddingInvite.value) {
    inviteName.value = '';
    maxSatoshisNumber.value = Math.min(100_000_000, maxLockableSatoshisNumber.value);
  }
}

function inviteStatus(invite: IMemberInvite) {
  return (
    controller.operationalInviteStatusesByCode[invite.inviteCode] ?? {
      label: 'Not opened',
      showRewardNote: false,
    }
  );
}

function inviteCurrentStep(invite: IMemberInvite) {
  if (!invite.certificationProgress) return;

  const completedTreasurySteps = countCompletedTreasuryCertificationRequirements(invite.certificationProgress);
  const completedOperationalSteps = countCompletedOperationalCertificationRequirements(invite.certificationProgress);
  const completedStepCount = completedTreasurySteps + completedOperationalSteps;
  if (completedStepCount >= totalCertificationRequirementCount) {
    return totalCertificationRequirementCount;
  }

  return completedStepCount + 1;
}

function hasInviteContributionAmounts(invite: IMemberInvite) {
  const treasuryBitcoinAmount = invite.vaultContribution?.bitcoinAmount;
  const treasuryBondAmount = invite.vaultContribution?.bondAmount;

  return treasuryBitcoinAmount !== undefined && treasuryBondAmount !== undefined;
}

function canApproveOperationsAccess(invite: IMemberInvite): boolean {
  const outstandingAccessProofCount = controller.operationalInvites.filter(member => {
    return member.accessProof && !member.certificationProgress?.hasOperationalAccount;
  }).length;

  return (
    supportsAccessProofRuntime.value &&
    controller.chainProgress.availableAccessCodes > outstandingAccessProofCount &&
    !!invite.operationsUpgradeRequestedAt &&
    !invite.accessProof &&
    !!invite.operationalAccountId &&
    !!invite.certificationProgress &&
    hasCompletedTreasuryCertificationRequirements(invite.certificationProgress)
  );
}

function canReassignOperationsUpgradeCode(invite: IMemberInvite): boolean {
  return !!invite.accessProof && !invite.certificationProgress?.hasOperationalAccount;
}

function canRegenerateInvite(invite: IMemberInvite): boolean {
  return inviteStatus(invite).label === 'Expired' && !!invite.bitcoinLockCoupon && !invite.defaultAccountId;
}

function loadInvites(): Promise<void> {
  if (loadInvitesPromise) {
    return loadInvitesPromise;
  }

  errorMessage.value = null;
  loadInvitesPromise = (async () => {
    try {
      await controller.loadOperationalInvites();
    } catch {
      controller.setOperationalInvites([]);
      errorMessage.value = 'Unable to load member invites right now. Please try again.';
    }
  })().finally(() => {
    loadInvitesPromise = undefined;
  });

  return loadInvitesPromise;
}

async function refreshInvites(): Promise<void> {
  await loadInvitesPromise;
  await loadInvites();
}

async function approveOperationsAccess(invite: IMemberInvite) {
  if (!canApproveOperationsAccess(invite) || approvingInviteCode.value) {
    return;
  }

  approvingInviteCode.value = invite.inviteCode;
  errorMessage.value = null;

  try {
    const operationalKeypair = await walletKeys.getOperationalKeypair();
    const accessProof = createOperationalAccessProof(operationalKeypair, invite.operationalAccountId!);

    await serverApiClient.markOperationsUpgraded(invite.inviteCode, {
      signature: accessProof.signature,
    });

    await refreshInvites();
  } catch (error: any) {
    errorMessage.value = error?.message ?? 'Unable to approve operations access right now.';
  } finally {
    approvingInviteCode.value = null;
  }
}

async function reassignOperationsUpgradeCode(invite: IMemberInvite) {
  if (!canReassignOperationsUpgradeCode(invite) || reassigningInviteCode.value) {
    return;
  }

  reassigningInviteCode.value = invite.inviteCode;
  errorMessage.value = null;

  try {
    await serverApiClient.reassignOperationsUpgradeCode(invite.inviteCode);
    await refreshInvites();
  } catch (error: any) {
    errorMessage.value = error?.message ?? 'Unable to reassign this operations upgrade code right now.';
  } finally {
    reassigningInviteCode.value = null;
  }
}

async function regenerateInvite(invite: IMemberInvite) {
  if (!canRegenerateInvite(invite) || regeneratingInviteCode.value || isCreatingInvite.value) {
    return;
  }
  if (!hasProfileName.value) {
    errorMessage.value = 'Set your Operator name before creating invites.';
    return;
  }
  if (inviteCreationBlockedReason.value) {
    errorMessage.value = inviteCreationBlockedReason.value;
    return;
  }

  const coupon = invite.bitcoinLockCoupon?.coupon;
  if (!coupon) {
    errorMessage.value = 'Unable to regenerate this invite right now.';
    return;
  }

  try {
    errorMessage.value = null;
    regeneratingInviteCode.value = invite.inviteCode;

    await myVault.load();
    await updateMaxLockableSatoshis();

    if (coupon.maxSatoshis > maxLockableSatoshis.value) {
      errorMessage.value = 'This vault no longer has enough Bitcoin lock capacity to regenerate that invite.';
      return;
    }

    const vaultId = myVault.createdVault?.vaultId;
    if (!vaultId) {
      throw new Error('No vault is available to create an invite.');
    }
    if (!config.serverDetails.ipAddress) {
      throw new Error('No server is available to create an invite.');
    }

    const delegateSetupTx = await myVault.ensureDelegatedBitcoinSigner();
    await delegateSetupTx?.txResult.waitForInFirstBlock;

    await serverApiClient.regenerateInvite(invite.inviteCode, {
      vaultId,
      maxSatoshis: coupon.maxSatoshis,
      estimatedGiftUsd: coupon.estimatedGiftUsd,
      btcPctFee: coupon.btcPctFee,
      expiresAfterTicks: coupon.expiresAfterTicks,
    });

    await refreshInvites();
  } catch (error: any) {
    errorMessage.value = error?.message ?? 'Unable to regenerate invite.';
  } finally {
    regeneratingInviteCode.value = null;
  }
}

function getMemberInviteUrl(invite: IMemberInvite): string {
  return `${NetworkConfig.get().websiteHost}/invite/${InviteEnvelope.encode({
    ...UpstreamOperatorClient.getInviteEndpoint(config.serverDetails),
    inviteCode: invite.inviteCode,
  })}`;
}

async function loadDelegateSetupState() {
  hasLoadedVaultState.value = false;
  inviteCreationBlockedReason.value = null;

  try {
    const client = await getMainchainClient(false);
    supportsAccessProofRuntime.value = supportsOperationalAccessProofRuntime(client);

    await myVault.load();
    await updateMaxLockableSatoshis();
  } catch (error: any) {
    errorMessage.value = error?.message ?? 'Unable to verify your vault invite settings.';
  } finally {
    hasLoadedVaultState.value = true;
  }
}

async function updateMaxLockableSatoshis() {
  const vault = myVault.createdVault;
  if (!vault) {
    maxLockableSatoshis.value = 0n;
    inviteCreationBlockedReason.value = 'Member invites require a vault with available Bitcoin lock capacity.';
    return;
  }

  const { availableSatoshis } = await bitcoinLocks.getLockableBitcoinCapacity({ vault });
  maxLockableSatoshis.value = availableSatoshis;
  maxSatoshisNumber.value = Math.min(maxSatoshisNumber.value, maxSatoshisInputMax.value);
  inviteCreationBlockedReason.value =
    availableSatoshis > 0n ? null : 'Member invites are unavailable because this vault has no Bitcoin lock capacity.';
}

async function createInvite() {
  if (isCreatingInvite.value) return;
  if (!hasProfileName.value) {
    errorMessage.value = 'Set your Operator name before creating invites.';
    return;
  }
  if (inviteCreationBlockedReason.value) {
    errorMessage.value = inviteCreationBlockedReason.value;
    return;
  }

  const name = inviteName.value.trim();
  if (!name) {
    errorMessage.value = 'Enter a name for the invite.';
    return;
  }

  try {
    errorMessage.value = null;
    isCreatingInvite.value = true;

    await myVault.load();
    await updateMaxLockableSatoshis();

    const maxSatoshis = BigInt(Math.floor(maxSatoshisNumber.value));
    if (maxSatoshis <= 0n) {
      errorMessage.value = 'Max satoshis must be greater than zero.';
      return;
    }
    if (maxSatoshis > maxLockableSatoshis.value) {
      errorMessage.value = "Max satoshis can't exceed the vault's available Bitcoin space.";
      return;
    }

    const vaultId = myVault.createdVault?.vaultId;
    if (!vaultId) {
      throw new Error('No vault is available to create an invite.');
    }
    if (!config.serverDetails.ipAddress) {
      throw new Error('No server is available to create an invite.');
    }

    const delegateSetupTx = await myVault.ensureDelegatedBitcoinSigner();
    await delegateSetupTx?.txResult.waitForInFirstBlock;

    const expiresAfterTicks = 10 * NetworkConfig.rewardTicksPerFrame;
    const vault = myVault.createdVault;
    if (!vault) {
      throw new Error('No vault is available to create an invite.');
    }
    const fullLockAmount = BitcoinLock.calculateRedemptionAmountFromSatoshis(currency.priceIndex, maxSatoshis);
    const estimatedGiftUsd = Number(
      currency.convertMicrogonTo(vault.calculateBitcoinFee(fullLockAmount), UnitOfMeasurement.USD),
    );
    const btcPctFee = vault.terms.bitcoinAnnualPercentRate.times(100).toNumber();

    await serverApiClient.createInvite({
      name,
      fromName: currentVaultName.value,
      vaultId,
      maxSatoshis,
      estimatedGiftUsd,
      btcPctFee,
      expiresAfterTicks,
    });

    await refreshInvites();
    toggleAddInvite();
  } catch (error: any) {
    errorMessage.value = error?.message ?? 'Unable to create invite.';
  } finally {
    isCreatingInvite.value = false;
  }
}

Vue.watch(
  [() => config.isServerInstalled, () => config.serverDetails.ipAddress],
  ([isServerInstalled, ipAddress], _previous, onCleanup) => {
    if (!isServerInstalled || !ipAddress) return;

    void loadInvites();
    void loadDelegateSetupState();

    const interval = setInterval(() => {
      if (document.visibilityState !== 'visible') return;
      void loadInvites();
    }, 5_000);

    onCleanup(() => clearInterval(interval));
  },
  { immediate: true },
);

Vue.watch(
  () => myVault.createdVault?.vaultId,
  () => {
    if (!config.isServerInstalled) return;
    void loadDelegateSetupState();
  },
);
</script>
