<template>
  <div class="flex h-full flex-col">
    <div class="flex items-start justify-between gap-4">
      <div>
        <div class="text-xl font-bold text-slate-800">Member Invites</div>
        <p class="mt-1 text-sm leading-5 text-slate-500">
          Invite people into your vault, track their certification progress, and approve operations access when they are
          ready.
        </p>
      </div>
    </div>

    <div class="flex min-h-0 grow flex-col">
      <div v-if="errorMessage || showRuntimeUpgradeNotice" class="mt-3 space-y-2">
        <div v-if="errorMessage" class="text-sm text-red-600">
          {{ errorMessage }}
        </div>

        <div v-if="showRuntimeUpgradeNotice" class="border-argon-300 border-l-2 pl-3 text-sm text-slate-600">
          Operations approval will unlock here after the next mainchain runtime upgrade is active.
        </div>
      </div>

      <div class="mt-4 min-h-0 grow overflow-auto">
        <table class="w-full min-w-[760px] text-left">
          <thead
            class="sticky top-0 z-10 border-b border-slate-200 bg-white text-xs font-semibold tracking-wide text-slate-400 uppercase"
          >
            <tr>
              <th class="px-5 py-3">Invitee</th>
              <th class="px-5 py-3">Status</th>
              <th class="px-5 py-3">Certification</th>
              <th class="px-5 py-3">Details</th>
              <th class="px-5 py-3 text-right">Actions</th>
            </tr>
          </thead>

          <tbody>
            <tr
              v-for="invite in controller.operationalInvites"
              :key="invite.id"
              class="border-b border-slate-100 bg-white align-middle last:border-0"
            >
              <td class="px-5 py-4">
                <div class="max-w-72 truncate text-sm font-semibold text-slate-800">{{ invite.name }}</div>
                <div class="mt-0.5 text-xs text-slate-400">
                  Sent {{ dayjs.utc(invite.createdAt).local().fromNow() }}
                </div>
              </td>

              <td class="px-5 py-4">
                <span
                  v-if="
                    inviteStatus(invite).label === 'Upgrade requested' ||
                    inviteStatus(invite).label === 'Access granted' ||
                    inviteStatus(invite).label === 'Operationally certified'
                  "
                  class="bg-argon-50 text-argon-600 inline-flex rounded-full px-2.5 py-1 text-xs font-semibold whitespace-nowrap"
                >
                  {{ inviteStatus(invite).label }}
                </span>
                <span
                  v-else
                  class="inline-flex rounded-full bg-slate-100 px-2.5 py-1 text-xs font-semibold whitespace-nowrap text-slate-500"
                >
                  {{ inviteStatus(invite).label }}
                </span>
              </td>

              <td class="px-5 py-4 font-mono text-sm font-semibold whitespace-nowrap text-slate-700">
                <template v-if="inviteCurrentStep(invite)">
                  {{ inviteCurrentStep(invite) }} of {{ totalCertificationRequirementCount }}
                </template>
                <template v-else>-</template>
              </td>

              <td class="px-5 py-4 whitespace-nowrap">
                <div v-if="invite.vaultContribution" class="text-sm whitespace-nowrap text-slate-600">
                  <span class="font-mono">
                    <template v-if="(invite.vaultContribution.bitcoinAmount ?? 0n) > 0n">
                      ₳{{ microgonToArgonNm(invite.vaultContribution.bitcoinAmount).format('0,0.[00]') }}
                    </template>
                    <template v-else>
                      ₳{{ microgonToArgonNm(invite.vaultContribution.pendingBitcoinAmount ?? 0n).format('0,0.[00]') }}
                    </template>
                  </span>
                  <span class="ml-1 text-xs text-slate-400">Bitcoin</span>
                  <span
                    v-if="
                      (invite.vaultContribution.bitcoinAmount ?? 0n) > 0n &&
                      (invite.vaultContribution.pendingBitcoinAmount ?? 0n) > 0n
                    "
                    class="ml-1 text-xs text-slate-400"
                  >
                    (₳{{ microgonToArgonNm(invite.vaultContribution.pendingBitcoinAmount ?? 0n).format('0,0.[00]') }}
                    awaiting funding)
                  </span>
                  <span
                    v-else-if="(invite.vaultContribution.pendingBitcoinAmount ?? 0n) > 0n"
                    class="ml-1 text-xs text-slate-400"
                  >
                    (awaiting funding)
                  </span>
                  <span class="mx-2 text-slate-300">·</span>
                  <span class="font-mono">
                    ₳{{ microgonToArgonNm(invite.vaultContribution?.bondAmount ?? 0n).format('0,0.[00]') }}
                  </span>
                  <span class="ml-1 text-xs text-slate-400">Bonds</span>
                </div>
              </td>

              <td class="px-5 py-4">
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
                    v-if="canRegenerateInvite(invite)"
                    type="button"
                    :disabled="regeneratingInviteCode === invite.inviteCode"
                    class="rounded border border-slate-300 bg-white px-3 py-1.5 text-sm font-semibold whitespace-nowrap text-slate-700 disabled:cursor-default disabled:opacity-50"
                    @click="regenerateInvite(invite)"
                  >
                    {{ regeneratingInviteCode === invite.inviteCode ? 'Regenerating…' : 'Regenerate' }}
                  </button>

                  <CopyToClipboard
                    v-if="
                      !canRegenerateInvite(invite) &&
                      (invite.vaultContribution?.bitcoinAmount ?? 0n) === 0n &&
                      (invite.vaultContribution?.bondAmount ?? 0n) === 0n
                    "
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
import dayjs from 'dayjs';
import relativeTime from 'dayjs/plugin/relativeTime';
import utc from 'dayjs/plugin/utc';
import {
  countCompletedOperationalCertificationRequirements,
  countCompletedTreasuryCertificationRequirements,
  createOperationalAccessProof,
  hasCompletedTreasuryCertificationRequirements,
  InviteEnvelope,
  NetworkConfig,
  operationalCertificationRequirementCount,
  treasuryCertificationRequirementCount,
} from '@argonprotocol/apps-core';
import CopyToClipboard from '../../../components/CopyToClipboard.vue';
import { createNumeralHelpers } from '../../../lib/numeral.ts';
import { supportsOperationalAccessProofRuntime } from '../../../lib/OperationalAccount.ts';
import { UpstreamOperatorClient } from '../../../lib/UpstreamOperatorClient.ts';
import { getMainchainClient } from '../../../stores/mainchain.ts';
import { getBitcoinLocks } from '../../../stores/bitcoin.ts';
import { getConfig } from '../../../stores/config.ts';
import { getCurrency } from '../../../stores/currency.ts';
import { useCertificationController } from '../../../stores/certificationController.ts';
import { getServerApiClient } from '../../../stores/server.ts';
import { getMyVault } from '../../../stores/vaults.ts';
import { getWalletKeys } from '../../../stores/wallets.ts';

dayjs.extend(relativeTime);
dayjs.extend(utc);

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

const errorMessage = Vue.ref<string | null>(null);
const approvingInviteCode = Vue.ref<string | null>(null);
const regeneratingInviteCode = Vue.ref<string | null>(null);
const supportsAccessProofRuntime = Vue.ref(false);

let loadInvitesPromise: Promise<void> | undefined;

const showRuntimeUpgradeNotice = Vue.computed(() => {
  return (
    !supportsAccessProofRuntime.value &&
    controller.operationalInvites.some(invite => !!invite.operationsUpgradeRequestedAt)
  );
});

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
    } catch (error) {
      errorMessage.value =
        error instanceof Error
          ? `Unable to refresh member invites: ${error.message}`
          : 'Unable to refresh member invites right now. Please try again.';
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

async function regenerateInvite(invite: IMemberInvite) {
  if (!canRegenerateInvite(invite) || regeneratingInviteCode.value) {
    return;
  }
  if (!myVault.createdVault?.name) {
    errorMessage.value = 'Set your Operator name before creating invites.';
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
    const vault = myVault.createdVault;
    if (!vault) {
      throw new Error('No vault is available to create an invite.');
    }

    const { availableSatoshis } = await bitcoinLocks.getLockableBitcoinCapacity({ vault });
    if (coupon.maxSatoshis > availableSatoshis) {
      errorMessage.value = 'This vault no longer has enough Bitcoin lock capacity to regenerate that invite.';
      return;
    }

    if (!config.serverDetails.ipAddress) {
      throw new Error('No server is available to create an invite.');
    }

    const delegateSetupTx = await myVault.ensureDelegatedBitcoinSigner();
    await delegateSetupTx?.txResult.waitForInFirstBlock;

    await serverApiClient.regenerateInvite(invite.inviteCode, {
      vaultId: vault.vaultId,
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
  return `${NetworkConfig.websiteHost}/invite/${InviteEnvelope.encode({
    ...UpstreamOperatorClient.getInviteEndpoint(config.serverDetails),
    inviteCode: invite.inviteCode,
  })}`;
}

async function loadRuntimeSupport() {
  try {
    const client = await getMainchainClient(false);
    supportsAccessProofRuntime.value = supportsOperationalAccessProofRuntime(client);
  } catch (error: any) {
    errorMessage.value = error?.message ?? 'Unable to verify operations approval support.';
  }
}

Vue.watch(
  [() => config.isServerInstalled, () => config.serverDetails.ipAddress],
  ([isServerInstalled, ipAddress], _previous, onCleanup) => {
    if (!isServerInstalled || !ipAddress) return;

    if (!controller.hasLoadedOperationalInvites) {
      void loadInvites();
    }
    void loadRuntimeSupport();

    const interval = setInterval(() => {
      if (document.visibilityState !== 'visible') return;
      void loadInvites();
    }, 5_000);

    onCleanup(() => clearInterval(interval));
  },
  { immediate: true },
);
</script>
