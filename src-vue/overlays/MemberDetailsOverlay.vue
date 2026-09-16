<template>
  <OverlayBase :isOpen="isOpen" class="w-7/12" @close="closeOverlay" @pressEsc="closeOverlay">
    <template #title>
      <div class="grow text-2xl font-bold">Member Details</div>
    </template>

    <div v-if="invite" class="px-8 py-6 text-base text-slate-700">
      <div class="flex items-center gap-2 border-b border-slate-200 pb-1">
        <div class="shrink-0 text-lg font-semibold text-slate-800">{{ invite.name }}</div>
        <CopyableArgonAddress
          v-if="invite.defaultAccountId"
          :address="invite.defaultAccountId"
          class="text-sm text-slate-500"
        />
      </div>

      <div class="mt-3 flex flex-wrap items-center gap-x-2 text-sm text-slate-500">
        <template v-if="invite.defaultAccountId">
          <span v-if="isMemberBalanceLoading" class="text-slate-400">Loading balances…</span>
          <template v-else-if="memberAvailableMicrogons != null && memberAvailableMicronots != null">
            <span class="font-mono">{{ formatArgonTokenAmount(memberAvailableMicrogons) }} ARGN</span>
            <span>·</span>
            <span class="font-mono">
              {{
                micronotToArgonotNm(memberAvailableMicronots).format(
                  memberAvailableMicronots % BigInt(MICRONOTS_PER_ARGONOT) === 0n ? '0,0' : '0,0.00',
                )
              }}
              ARGNOT
            </span>
          </template>
          <span v-else class="text-slate-400">Balances unavailable</span>
          <span>·</span>
        </template>
        <template v-if="invite.operationsUpgradedAt">
          Operations access granted {{ formatMemberDate(invite.operationsUpgradedAt) }}
        </template>
        <template v-else-if="invite.operationsUpgradeRequestedAt">
          Requested Operations {{ formatMemberDate(invite.operationsUpgradeRequestedAt) }}
        </template>
        <template v-else-if="invite.defaultAccountId">
          Registered {{ formatMemberDate(invite.firstClickedAt ?? invite.createdAt) }}
        </template>
        <template v-else-if="invite.lastClickedAt">Opened {{ formatMemberDate(invite.lastClickedAt) }}</template>
        <template v-else>Not opened</template>
      </div>
      <CopyCommandBlock v-if="!invite.defaultAccountId" :content="inviteUrl" :rows="1" class="mt-3" />
      <div
        v-if="showOperationsUpgradeAction"
        class="mt-3 flex items-center justify-between gap-4 border-t border-slate-200 pt-3"
      >
        <span class="text-sm text-slate-500">
          {{ availableOperationsUpgradeCodeCount }} upgrade
          {{ availableOperationsUpgradeCodeCount === 1 ? 'code' : 'codes' }} available
        </span>
        <button
          type="button"
          :disabled="isActionInProgress || !canUpgradeMemberToOperations"
          class="bg-argon-button hover:bg-argon-button-hover shrink-0 cursor-pointer rounded-md px-3 py-1.5 text-sm font-semibold text-white disabled:cursor-default disabled:opacity-50"
          @click="upgradeMemberToOperations"
        >
          {{ isActionInProgress ? 'Upgrading…' : 'Upgrade to Operations' }}
        </button>
      </div>

      <div v-if="invite.bitcoinLockCoupon?.originalFeeCreditMicrogons != null" class="mt-8">
        <div class="border-b border-slate-200 pb-1 font-semibold text-slate-800">Bitcoin Fee Waiver</div>
        <div class="mt-3 text-sm text-slate-500">
          <div class="flex items-center">
            <span class="font-mono text-slate-700">
              ₳{{ formatFeeWaiverAmount(invite.bitcoinLockCoupon.originalFeeCreditMicrogons) }}
            </span>
            <span class="ml-1">fee waiver</span>
            <template v-if="invite.bitcoinLockCoupon.status === 'Used'">
              <span class="mr-1 ml-2">· Used</span>
              <span v-if="bitcoinFeeWaiverAppliedAt">{{ formatMemberDate(bitcoinFeeWaiverAppliedAt) }}</span>
            </template>
            <template v-else>
              <span
                v-if="
                  (invite.bitcoinLockCoupon.usedFeeCreditMicrogons ?? 0n) === 0n &&
                  (invite.bitcoinLockCoupon.pendingFeeCreditMicrogons ?? 0n) === 0n
                "
                class="ml-2"
              >
                · Unused
              </span>
              <span v-if="(invite.bitcoinLockCoupon.usedFeeCreditMicrogons ?? 0n) > 0n" class="ml-2">
                · ₳{{ formatFeeWaiverAmount(invite.bitcoinLockCoupon.usedFeeCreditMicrogons ?? 0n) }} used
              </span>
              <span v-if="(invite.bitcoinLockCoupon.pendingFeeCreditMicrogons ?? 0n) > 0n" class="ml-2">
                · ₳{{ formatFeeWaiverAmount(invite.bitcoinLockCoupon.pendingFeeCreditMicrogons ?? 0n) }} pending
              </span>
            </template>
            <template
              v-if="
                invite.bitcoinLockCoupon.status !== 'Used' && isBitcoinFeeWaiverExpired && expirationDaysAgo != null
              "
            >
              <span class="mr-1 ml-2">· expired</span>
              <FeeWaiverExpirationPopover
                v-if="canUpdateBitcoinFeeWaiverExpiration"
                v-model="expirationDays"
                mode="extension"
                side="right"
                :currentDays="expirationDaysAgo"
                :isExpired="true"
                :disabled="isActionInProgress"
                @save="updateBitcoinFeeWaiverExpiration"
              />
              <span v-else>
                <template v-if="expirationDaysAgo === 0">now</template>
                <template v-else>
                  {{ expirationDaysAgo }}
                  {{ expirationDaysAgo === 1 ? 'day' : 'days' }} ago
                </template>
              </span>
            </template>
            <template v-else-if="invite.bitcoinLockCoupon.status !== 'Used' && expirationDaysRemaining != null">
              <span class="mr-1 ml-2">· expires in</span>
              <FeeWaiverExpirationPopover
                v-if="canUpdateBitcoinFeeWaiverExpiration"
                v-model="expirationDays"
                mode="extension"
                side="right"
                :currentDays="expirationDaysRemaining"
                :disabled="isActionInProgress"
                @save="updateBitcoinFeeWaiverExpiration"
              />
              <span v-else>
                {{ expirationDaysRemaining }}
                {{ expirationDaysRemaining === 1 ? 'day' : 'days' }}
              </span>
            </template>
            <span v-else-if="invite.bitcoinLockCoupon.status !== 'Used' && availabilityDays != null" class="ml-2">
              · expires {{ availabilityDays }} {{ availabilityDays === 1 ? 'day' : 'days' }} after accept
            </span>
          </div>
        </div>
      </div>

      <div v-if="certificationProgress" class="mt-8">
        <div class="flex items-center justify-between gap-4 border-b border-slate-200 pb-1">
          <div class="font-semibold text-slate-800">Certification</div>
          <div class="font-mono text-sm font-semibold text-slate-700">
            {{ certificationCompletedCount }} of {{ certificationRequirementCount }} complete
          </div>
        </div>

        <div class="mt-3 text-xs font-semibold tracking-wide text-slate-400 uppercase">Treasury</div>
        <div class="mt-2 space-y-2 text-sm text-slate-600">
          <div class="flex items-center gap-3">
            <span class="grow">Lock Bitcoin</span>
            <span
              v-if="
                (certificationProgress.treasuryBitcoinAmount ?? 0n) > 0n || (memberPendingBitcoinMicrogons ?? 0n) > 0n
              "
              class="min-w-32 text-right font-light whitespace-nowrap text-slate-500"
            >
              <template v-if="(certificationProgress.treasuryBitcoinAmount ?? 0n) > 0n">
                {{ currency.symbol
                }}{{ microgonToMoneyNm(certificationProgress.treasuryBitcoinAmount ?? 0n).format('0,0.00') }}
              </template>
              <template v-else-if="(memberPendingBitcoinMicrogons ?? 0n) > 0n">
                {{ currency.symbol }}{{ microgonToMoneyNm(memberPendingBitcoinMicrogons ?? 0n).format('0,0.00') }}
              </template>
              <span v-if="(memberPendingBitcoinMicrogons ?? 0n) > 0n" class="ml-1">
                <template v-if="(certificationProgress.treasuryBitcoinAmount ?? 0n) > 0n">
                  · {{ currency.symbol
                  }}{{ microgonToMoneyNm(memberPendingBitcoinMicrogons ?? 0n).format('0,0.00') }} awaiting funding
                </template>
                <template v-else>· awaiting funding</template>
              </span>
            </span>
            <span
              class="rounded-full px-2.5 py-1 text-xs font-semibold"
              :class="
                certificationProgress.hasTreasuryBitcoin ? 'bg-argon-50 text-argon-600' : 'bg-slate-100 text-slate-500'
              "
            >
              {{ certificationProgress.hasTreasuryBitcoin ? 'Complete' : 'Incomplete' }}
            </span>
          </div>
          <div class="flex items-center gap-3">
            <span class="grow">Acquire Argon Bonds</span>
            <span
              v-if="(certificationProgress.treasuryBondAmount ?? 0n) > 0n"
              class="w-32 text-right font-light text-slate-500"
            >
              {{ currency.symbol
              }}{{ microgonToMoneyNm(certificationProgress.treasuryBondAmount ?? 0n).format('0,0.00') }}
            </span>
            <span
              class="rounded-full px-2.5 py-1 text-xs font-semibold"
              :class="
                certificationProgress.hasTreasuryBonds ? 'bg-argon-50 text-argon-600' : 'bg-slate-100 text-slate-500'
              "
            >
              {{ certificationProgress.hasTreasuryBonds ? 'Complete' : 'Incomplete' }}
            </span>
          </div>
          <div class="flex items-center gap-3">
            <span class="grow">Transfer Argons from Uniswap</span>
            <span v-if="(memberUniswapTransferMicrogons ?? 0n) > 0n" class="w-32 text-right font-light text-slate-500">
              {{ currency.symbol }}{{ microgonToMoneyNm(memberUniswapTransferMicrogons ?? 0n).format('0,0.00') }}
            </span>
            <span
              class="rounded-full px-2.5 py-1 text-xs font-semibold"
              :class="
                certificationProgress.hasTreasuryUniswapTransfer
                  ? 'bg-argon-50 text-argon-600'
                  : 'bg-slate-100 text-slate-500'
              "
            >
              {{ certificationProgress.hasTreasuryUniswapTransfer ? 'Complete' : 'Incomplete' }}
            </span>
          </div>
        </div>

        <template v-if="showOperationsCertification">
          <div class="mt-4 text-xs font-semibold tracking-wide text-slate-400 uppercase">Operations</div>
          <div class="mt-2 space-y-2 text-sm text-slate-600">
            <div class="flex items-center gap-3">
              <span class="grow">Create a Vault</span>
              <span
                v-if="(memberOperationalVaultMicrogons ?? 0n) > 0n"
                class="w-32 text-right font-light text-slate-500"
              >
                {{ currency.symbol }}{{ microgonToMoneyNm(memberOperationalVaultMicrogons ?? 0n).format('0,0.00') }}
              </span>
              <span
                class="rounded-full px-2.5 py-1 text-xs font-semibold"
                :class="
                  certificationProgress.hasOperationalVault
                    ? 'bg-argon-50 text-argon-600'
                    : 'bg-slate-100 text-slate-500'
                "
              >
                {{ certificationProgress.hasOperationalVault ? 'Complete' : 'Incomplete' }}
              </span>
            </div>
            <div class="flex items-center gap-3">
              <span class="grow">Win Mining Seats</span>
              <span
                v-if="(memberOperationalMiningSeatCount ?? 0) > 0"
                class="w-32 text-right font-light text-slate-500"
              >
                {{ memberOperationalMiningSeatCount }}
                {{ memberOperationalMiningSeatCount === 1 ? 'seat' : 'seats' }}
              </span>
              <span
                class="rounded-full px-2.5 py-1 text-xs font-semibold"
                :class="
                  certificationProgress.hasOperationalMiningSeats
                    ? 'bg-argon-50 text-argon-600'
                    : 'bg-slate-100 text-slate-500'
                "
              >
                {{ certificationProgress.hasOperationalMiningSeats ? 'Complete' : 'Incomplete' }}
              </span>
            </div>
            <div class="flex items-center gap-3">
              <span class="grow">Transfer Argons from Uniswap</span>
              <span
                v-if="(memberUniswapTransferMicrogons ?? 0n) > 0n"
                class="w-32 text-right font-light text-slate-500"
              >
                {{ currency.symbol }}{{ microgonToMoneyNm(memberUniswapTransferMicrogons ?? 0n).format('0,0.00') }}
              </span>
              <span
                class="rounded-full px-2.5 py-1 text-xs font-semibold"
                :class="
                  certificationProgress.hasOperationalUniswapTransfer
                    ? 'bg-argon-50 text-argon-600'
                    : 'bg-slate-100 text-slate-500'
                "
              >
                {{ certificationProgress.hasOperationalUniswapTransfer ? 'Complete' : 'Incomplete' }}
              </span>
            </div>
          </div>
        </template>
      </div>

      <div v-if="errorMessage" class="mt-5 text-sm text-red-700">{{ errorMessage }}</div>

      <div class="mt-7 flex justify-end border-t border-slate-200 pt-5">
        <button
          type="button"
          :disabled="isActionInProgress"
          class="cursor-pointer rounded-md border border-slate-300 px-7 py-2 font-semibold text-slate-600 hover:bg-slate-50 disabled:cursor-default disabled:opacity-50"
          @click="closeOverlay"
        >
          Done
        </button>
      </div>
    </div>
  </OverlayBase>
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
  MICROGONS_PER_ARGON,
  MICRONOTS_PER_ARGONOT,
  MiningFrames,
  NetworkConfig,
  operationalCertificationRequirementCount,
  treasuryCertificationRequirementCount,
} from '@argonprotocol/apps-core';
import CopyCommandBlock from '../components/CopyCommandBlock.vue';
import CopyableArgonAddress from '../components/CopyableArgonAddress.vue';
import basicEmitter from '../emitters/basicEmitter.ts';
import { createNumeralHelpers } from '../lib/numeral.ts';
import { UpstreamOperatorClient } from '../lib/UpstreamOperatorClient.ts';
import { readArgonWalletBalanceValues } from '../lib/WalletsForArgon.ts';
import { useBasics } from '../stores/basics.ts';
import { useCertificationController } from '../stores/certificationController.ts';
import { getConfig } from '../stores/config.ts';
import { getCurrency } from '../stores/currency.ts';
import { getMainchainClient } from '../stores/mainchain.ts';
import { getServerApiClient } from '../stores/server.ts';
import { getWalletKeys } from '../stores/wallets.ts';
import OverlayBase from './OverlayBase.vue';
import FeeWaiverExpirationPopover from './member-invite/FeeWaiverExpirationPopover.vue';

dayjs.extend(relativeTime);
dayjs.extend(utc);

const basics = useBasics();
const config = getConfig();
const controller = useCertificationController();
const serverApiClient = getServerApiClient();
const walletKeys = getWalletKeys();
const currency = getCurrency();
const { microgonToArgonNm, microgonToMoneyNm, micronotToArgonotNm } = createNumeralHelpers(currency);

const isOpen = Vue.ref(false);
const invite = Vue.shallowRef<IMemberInvite>();
const isActionInProgress = Vue.ref(false);
const errorMessage = Vue.ref('');
const expirationDays = Vue.ref(7);
const memberAvailableMicrogons = Vue.ref<bigint>();
const memberAvailableMicronots = Vue.ref<bigint>();
const memberUniswapTransferMicrogons = Vue.ref<bigint>();
const memberOperationalVaultMicrogons = Vue.ref<bigint>();
const memberOperationalMiningSeatCount = Vue.ref<number>();
const isMemberBalanceLoading = Vue.ref(false);
const memberBalanceRequestVersion = Vue.ref(0);

const inviteUrl = Vue.computed(() => {
  if (!invite.value) return '';

  return `${NetworkConfig.websiteHost}/invite/${InviteEnvelope.encode({
    ...UpstreamOperatorClient.getInviteEndpoint(config.serverDetails),
    inviteCode: invite.value.inviteCode,
  })}`;
});
const certificationProgress = Vue.computed(() => {
  return invite.value?.certificationProgress;
});
const memberPendingBitcoinMicrogons = Vue.computed(() => {
  return invite.value?.vaultContribution?.pendingBitcoinAmount ?? 0n;
});
const showOperationsCertification = Vue.computed(() => {
  return !!certificationProgress.value?.hasOperationalAccount;
});
const certificationRequirementCount = Vue.computed(() => {
  return (
    treasuryCertificationRequirementCount +
    (showOperationsCertification.value ? operationalCertificationRequirementCount : 0)
  );
});
const certificationCompletedCount = Vue.computed(() => {
  const progress = certificationProgress.value;
  if (!progress) return 0;

  return (
    countCompletedTreasuryCertificationRequirements(progress) +
    (showOperationsCertification.value ? countCompletedOperationalCertificationRequirements(progress) : 0)
  );
});
const canUpdateBitcoinFeeWaiverExpiration = Vue.computed(() => {
  const coupon = invite.value?.bitcoinLockCoupon;
  return (
    !controller.operationalInviteLoadError &&
    !!coupon &&
    (coupon.status === 'Open' || coupon.status === 'Expired') &&
    (coupon.remainingFeeCreditMicrogons ?? 0n) > 0n
  );
});
const bitcoinFeeWaiverAppliedAt = Vue.computed(() => {
  const coupon = invite.value?.bitcoinLockCoupon;
  if (coupon?.status !== 'Used') return;
  return coupon.coupon.usedAt ?? coupon.uses?.filter(use => use.status === 'Finalized').at(-1)?.updatedAt;
});
const isBitcoinFeeWaiverExpired = Vue.computed(() => {
  const coupon = invite.value?.bitcoinLockCoupon;
  if (!coupon) return false;

  return (
    coupon.status === 'Expired' ||
    (coupon.coupon.expirationTick != null &&
      MiningFrames.calculateCurrentTickFromSystemTime() >= coupon.coupon.expirationTick)
  );
});
const availabilityDays = Vue.computed(() => {
  const coupon = invite.value?.bitcoinLockCoupon?.coupon;
  if (!coupon || coupon.expirationTick != null) return;

  return Math.ceil(coupon.expiresAfterTicks / NetworkConfig.rewardTicksPerFrame);
});
const expirationDaysRemaining = Vue.computed(() => {
  const expirationTick = invite.value?.bitcoinLockCoupon?.coupon.expirationTick;
  if (expirationTick == null || isBitcoinFeeWaiverExpired.value) return;

  const currentTick = MiningFrames.calculateCurrentTickFromSystemTime();
  return Math.max(Math.ceil((expirationTick - currentTick) / NetworkConfig.rewardTicksPerFrame), 0);
});
const expirationDaysAgo = Vue.computed(() => {
  const expirationTick = invite.value?.bitcoinLockCoupon?.coupon.expirationTick;
  if (expirationTick == null || !isBitcoinFeeWaiverExpired.value) return;

  const currentTick = MiningFrames.calculateCurrentTickFromSystemTime();
  return Math.max(Math.floor((currentTick - expirationTick) / NetworkConfig.rewardTicksPerFrame), 0);
});
const showOperationsUpgradeAction = Vue.computed(() => {
  const member = invite.value;
  return !!member?.operationsUpgradeRequestedAt && !member.accessProof && !member.operationsUpgradedAt;
});
const availableOperationsUpgradeCodeCount = Vue.computed(() => {
  const outstandingAccessProofCount = controller.operationalInvites.filter(candidate => {
    return candidate.accessProof && !candidate.certificationProgress?.hasOperationalAccount;
  }).length;

  return Math.max(controller.chainProgress.availableAccessCodes - outstandingAccessProofCount, 0);
});
const canUpgradeMemberToOperations = Vue.computed(() => {
  if (controller.operationalInviteLoadError) return false;

  const member = invite.value;
  if (!member) return false;

  return (
    showOperationsUpgradeAction.value &&
    availableOperationsUpgradeCodeCount.value > 0 &&
    !!member.operationalAccountId &&
    !!certificationProgress.value &&
    hasCompletedTreasuryCertificationRequirements(certificationProgress.value)
  );
});

function openOverlay(request: { invite: IMemberInvite }) {
  invite.value = request.invite;
  errorMessage.value = '';
  isOpen.value = true;
  basics.overlayIsOpen = true;
  memberBalanceRequestVersion.value += 1;
}

function closeOverlay() {
  if (isActionInProgress.value) return;

  memberBalanceRequestVersion.value += 1;
  invite.value = undefined;
  isOpen.value = false;
  basics.overlayIsOpen = false;
}

async function updateBitcoinFeeWaiverExpiration(days: number) {
  const member = invite.value;
  const coupon = member?.bitcoinLockCoupon?.coupon;
  if (!member || !coupon || !canUpdateBitcoinFeeWaiverExpiration.value || isActionInProgress.value) return;

  isActionInProgress.value = true;
  errorMessage.value = '';
  try {
    const bitcoinLockCoupon = await serverApiClient.updateBitcoinLockCouponExpiration(
      coupon.offerCode,
      days * NetworkConfig.rewardTicksPerFrame,
    );
    updateInvite({ ...member, bitcoinLockCoupon });
  } catch (error: any) {
    errorMessage.value = error?.message ?? 'Unable to update the Bitcoin fee waiver expiration right now.';
  } finally {
    isActionInProgress.value = false;
  }
}

async function upgradeMemberToOperations() {
  const member = invite.value;
  if (!member || !canUpgradeMemberToOperations.value || isActionInProgress.value) return;

  isActionInProgress.value = true;
  errorMessage.value = '';
  try {
    const operationalKeypair = await walletKeys.getOperationalKeypair();
    const accessProof = createOperationalAccessProof(operationalKeypair, member.operationalAccountId!);
    updateInvite(await serverApiClient.markOperationsUpgraded(member.inviteCode, { signature: accessProof.signature }));
  } catch (error: any) {
    errorMessage.value = error?.message ?? 'Unable to approve operations access right now.';
  } finally {
    isActionInProgress.value = false;
  }
}

function updateInvite(member: IMemberInvite) {
  const updatedMember = {
    ...member,
    certificationProgress: member.certificationProgress ?? invite.value?.certificationProgress,
    vaultContribution: member.vaultContribution ?? invite.value?.vaultContribution,
  };

  invite.value = updatedMember;
  controller.setOperationalInvites(
    controller.operationalInvites.map(candidate =>
      candidate.inviteCode === updatedMember.inviteCode ? updatedMember : candidate,
    ),
  );
}

Vue.watch(
  () => controller.operationalInvites.find(candidate => candidate.inviteCode === invite.value?.inviteCode),
  refreshedInvite => {
    if (!refreshedInvite) return;

    invite.value = {
      ...refreshedInvite,
      certificationProgress: refreshedInvite.certificationProgress ?? invite.value?.certificationProgress,
      vaultContribution: refreshedInvite.vaultContribution ?? invite.value?.vaultContribution,
    };
  },
);

Vue.watch(
  [
    memberBalanceRequestVersion,
    () => invite.value?.defaultAccountId,
    () => invite.value?.operationalAccountId ?? undefined,
  ],
  async ([, accountId, operationalAccountId], previous, onCleanup) => {
    let isCurrentRequest = true;
    onCleanup(() => {
      isCurrentRequest = false;
    });

    const isNewMember = accountId !== previous[1];
    if (isNewMember) {
      memberAvailableMicrogons.value = undefined;
      memberAvailableMicronots.value = undefined;
      memberUniswapTransferMicrogons.value = undefined;
      memberOperationalVaultMicrogons.value = undefined;
      memberOperationalMiningSeatCount.value = undefined;
      isMemberBalanceLoading.value = !!accountId;
    }
    if (!accountId) return;

    try {
      const client = await getMainchainClient(false);
      const operationalAccountPromise = operationalAccountId
        ? client.query.operationalAccounts.operationalAccounts(operationalAccountId)
        : undefined;
      const transferTotalsPromise = client.query.crosschainTransfer.transferTotalsByAccount(accountId);
      const [balanceResult, operationalResult] = await Promise.allSettled([
        readArgonWalletBalanceValues(client, [accountId]),
        Promise.all([transferTotalsPromise, operationalAccountPromise]),
      ]);
      if (!isCurrentRequest) return;

      if (balanceResult.status === 'fulfilled') {
        const [balance] = balanceResult.value;
        memberAvailableMicrogons.value = balance.availableMicrogons;
        memberAvailableMicronots.value = balance.availableMicronots;
      } else {
        console.warn('[Member Details] Unable to load member balances.', balanceResult.reason);
      }

      if (operationalResult.status === 'rejected') {
        console.warn('[Member Details] Unable to load operational details.', operationalResult.reason);
        return;
      }

      const [transferTotals, operationalAccountRaw] = operationalResult.value;

      if (operationalAccountRaw) {
        const account = operationalAccountRaw;
        memberUniswapTransferMicrogons.value = account.uniswapArgonTransfersInAmount;
        memberOperationalVaultMicrogons.value = account.vaultBitcoinAccrual + account.vaultBitcoinAppliedTotal;
        memberOperationalMiningSeatCount.value = account.miningSeatAccrual + account.miningSeatAppliedTotal;
      } else {
        memberUniswapTransferMicrogons.value = transferTotals.microgonsIn;
      }
    } catch (error) {
      console.warn('[Member Details] Unable to load member details.', error);
    } finally {
      if (isCurrentRequest) isMemberBalanceLoading.value = false;
    }
  },
  { immediate: true },
);

basicEmitter.on('openMemberDetailsOverlay', openOverlay);

Vue.onUnmounted(() => {
  memberBalanceRequestVersion.value += 1;
  basicEmitter.off('openMemberDetailsOverlay', openOverlay);
});

function formatArgonTokenAmount(amount: bigint) {
  const format = amount % BigInt(MICROGONS_PER_ARGON) === 0n ? '0,0' : '0,0.00';
  return microgonToArgonNm(amount).format(format);
}

function formatFeeWaiverAmount(amount: bigint) {
  return microgonToArgonNm(amount).format('0,0');
}

function formatMemberDate(date: Date) {
  return dayjs.utc(date).local().fromNow();
}
</script>
