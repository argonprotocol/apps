<template>
  <div class="flex h-full flex-col rounded-2xl border border-slate-200 bg-white/90 px-5 py-5">
    <div class="flex items-start justify-between gap-4 border-b border-slate-200 pb-4">
      <div>
        <div class="text-xl font-bold text-slate-800">Member Invites</div>
        <p class="mt-1 text-sm leading-6 text-slate-500">
          Invite people into your vault, track their treasury progress, and approve operations access when they are
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

    <div v-else-if="!hasProfileName" class="my-auto text-center text-sm leading-6 text-slate-500">
      Set your Operator name before creating member invites.
    </div>

    <div v-else class="flex min-h-0 grow flex-col">
      <div v-if="errorMessage || inviteCreationBlockedReason || showRuntimeUpgradeNotice" class="mt-4 space-y-3">
        <div v-if="errorMessage" class="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
          {{ errorMessage }}
        </div>

        <div
          v-if="inviteCreationBlockedReason"
          class="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800"
        >
          {{ inviteCreationBlockedReason }}
        </div>

        <div
          v-if="showRuntimeUpgradeNotice"
          class="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800"
        >
          Operations approval will unlock here after the next mainchain runtime upgrade is active.
        </div>
      </div>

      <div v-if="isAddingInvite" class="mt-4 rounded-2xl border border-dashed border-slate-300 px-4 py-4">
        <div>
          <label class="text-sm font-medium text-slate-700">Invite name</label>
          <input
            v-model.trim="inviteName"
            type="text"
            class="focus:border-argon-600 mt-2 w-full rounded-xl border border-slate-300 px-3 py-2.5 focus:ring-0"
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
        class="my-auto rounded-2xl border border-dashed border-slate-300 px-4 py-8 text-center text-sm text-slate-500"
      >
        No invites yet. Create one to share your vault with a new member.
      </div>

      <div v-else class="mt-4 min-h-0 grow overflow-y-auto pr-1">
        <div
          v-for="invite in controller.operationalInvites"
          :key="invite.id"
          class="mb-3 rounded-2xl border border-slate-200 bg-slate-50/70 px-4 py-4 last:mb-0"
        >
          <div class="flex items-start justify-between gap-4">
            <div class="min-w-0">
              <div class="flex items-center gap-3">
                <div class="truncate text-base font-semibold text-slate-800">{{ invite.name }}</div>
                <div class="rounded-full px-2.5 py-1 text-xs font-semibold" :class="inviteStatusClass(invite)">
                  {{ inviteStatusLabel(invite) }}
                </div>
              </div>

              <div class="mt-1 text-sm text-slate-500">
                {{ inviteSummary(invite) }}
              </div>
            </div>

            <div class="flex shrink-0 items-center gap-2">
              <button
                v-if="canApproveOperationsAccess(invite)"
                type="button"
                :disabled="approvingInviteCode === invite.inviteCode"
                class="bg-argon-button hover:bg-argon-button-hover rounded-lg px-3 py-2 text-sm font-semibold text-white disabled:cursor-default disabled:opacity-50"
                @click="approveOperationsAccess(invite)"
              >
                {{ approvingInviteCode === invite.inviteCode ? 'Approving…' : 'Approve' }}
              </button>

              <CopyToClipboard v-else :content="getMemberInviteUrl(invite)" class="shrink-0">
                <button
                  type="button"
                  class="rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm font-semibold text-slate-700"
                >
                  Copy Link
                </button>
                <template #copying>
                  <button
                    type="button"
                    class="rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm font-semibold text-slate-700"
                  >
                    Copied
                  </button>
                </template>
              </CopyToClipboard>
            </div>
          </div>

          <div v-if="showTreasuryProgress(invite)" class="mt-4">
            <div class="mb-1.5 flex items-center justify-between gap-3 text-xs font-medium text-slate-500">
              <span>Treasury certification</span>
              <span>{{ inviteProgressLabel(invite) }}</span>
            </div>
            <ProgressBar :progress="inviteProgressPct(invite)" :showLabel="false" class="h-2" />
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import * as Vue from 'vue';
import dayjs from 'dayjs';
import type { IMemberInvite } from '@argonprotocol/apps-router';
import {
  countCompletedTreasuryCertificationRequirements,
  createOperationalAccessProof,
  hasCompletedTreasuryCertificationRequirements,
  NetworkConfig,
  treasuryCertificationRequirementCount,
  UnitOfMeasurement,
} from '@argonprotocol/apps-core';
import { BitcoinLock } from '@argonprotocol/mainchain';
import CopyToClipboard from '../../components/CopyToClipboard.vue';
import InputNumber from '../../components/InputNumber.vue';
import ProgressBar from '../../components/ProgressBar.vue';
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

const { satToMoneyNm } = createNumeralHelpers(currency);

const isAddingInvite = Vue.ref(false);
const isCreatingInvite = Vue.ref(false);
const hasLoadedVaultState = Vue.ref(false);
const inviteCreationBlockedReason = Vue.ref<string | null>(null);
const errorMessage = Vue.ref<string | null>(null);
const inviteName = Vue.ref('');
const maxSatoshisNumber = Vue.ref(100_000_000);
const maxLockableSatoshis = Vue.ref(100_000_000n);
const approvingInviteCode = Vue.ref<string | null>(null);
const supportsAccessProofRuntime = Vue.ref(false);

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

function inviteStatusLabel(invite: IMemberInvite) {
  return inviteStatus(invite).label;
}

function inviteStatusClass(invite: IMemberInvite) {
  const label = inviteStatusLabel(invite);
  if (label === 'Opened' || label === 'Upgrade requested') return 'border border-amber-200 bg-amber-50 text-amber-700';
  if (label === 'Registered') return 'border border-sky-200 bg-sky-50 text-sky-700';
  if (label === 'Access granted') return 'border border-argon-200 bg-argon-50 text-argon-700';
  if (label === 'Operationally certified') return 'border border-emerald-200 bg-emerald-50 text-emerald-700';
  if (label === 'Expired') return 'border border-slate-200 bg-slate-100 text-slate-500';
  return 'border border-slate-200 bg-slate-100 text-slate-600';
}

function showTreasuryProgress(invite: IMemberInvite) {
  return (
    !!invite.defaultAccountId &&
    !!invite.certificationProgress &&
    !invite.certificationProgress.isOperationallyCertified
  );
}

function inviteProgressLabel(invite: IMemberInvite) {
  if (!invite.certificationProgress) return `0/${treasuryCertificationRequirementCount}`;
  const completed = countCompletedTreasuryCertificationRequirements(invite.certificationProgress);
  return `${completed}/${treasuryCertificationRequirementCount}`;
}

function inviteProgressPct(invite: IMemberInvite) {
  if (!invite.certificationProgress) return 0;
  const completed = countCompletedTreasuryCertificationRequirements(invite.certificationProgress);
  return (completed / treasuryCertificationRequirementCount) * 100;
}

function inviteSummary(invite: IMemberInvite) {
  const status = inviteStatusLabel(invite);
  if (status === 'Upgrade requested') {
    return 'Waiting for you to approve operations access.';
  }
  if (status === 'Access granted') {
    return 'Operations access has been approved.';
  }
  if (status === 'Operationally certified') {
    return 'This member completed operations certification.';
  }
  if (invite.bitcoinLockCoupon?.expiresAt) {
    return `${satToMoneyNm(invite.bitcoinLockCoupon.coupon.maxSatoshis ?? 0n).format('0,0.00')} in free BTC locking · expires ${dayjs.utc(invite.bitcoinLockCoupon.expiresAt).local().format('M/D/YYYY')}`;
  }
  return `${satToMoneyNm(invite.bitcoinLockCoupon?.coupon.maxSatoshis ?? 0n).format('0,0.00')} in free BTC locking`;
}

function canApproveOperationsAccess(invite: IMemberInvite): boolean {
  return (
    supportsAccessProofRuntime.value &&
    !!invite.operationsUpgradeRequestedAt &&
    !invite.accessProof &&
    !!invite.operationalAccountId &&
    !!invite.certificationProgress &&
    hasCompletedTreasuryCertificationRequirements(invite.certificationProgress)
  );
}

async function loadInvites() {
  errorMessage.value = null;

  try {
    await controller.loadOperationalInvites();
  } catch {
    controller.setOperationalInvites([]);
    errorMessage.value = 'Unable to load member invites right now. Please try again.';
  }
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

    await loadInvites();
  } catch (error: any) {
    errorMessage.value = error?.message ?? 'Unable to approve operations access right now.';
  } finally {
    approvingInviteCode.value = null;
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

    await loadInvites();
    toggleAddInvite();
  } catch (error: any) {
    errorMessage.value = error?.message ?? 'Unable to create invite.';
  } finally {
    isCreatingInvite.value = false;
  }
}

Vue.onMounted(() => {
  if (!config.isServerInstalled) return;

  void loadInvites();
  void loadDelegateSetupState();
});

Vue.watch(
  [() => config.isServerInstalled, () => config.serverDetails.ipAddress],
  ([isServerInstalled, ipAddress], _previous, onCleanup) => {
    if (!isServerInstalled || !ipAddress) return;

    void loadInvites();
    void loadDelegateSetupState();

    const interval = setInterval(() => {
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
