<template>
  <OverlayBase
    :isOpen="isOpen"
    :overflowScroll="true"
    @close="closeOverlay"
    @pressEsc="closeOverlay"
    class="max-h-[calc(100vh-2rem)] w-7/12 pb-5"
  >
    <template #title>
      <div class="grow text-2xl font-bold">Manage Members</div>
    </template>

    <div v-if="!config.isServerInstalled" class="my-16 text-center text-slate-700/50">
      You must wait for your
      <br />
      <a @click="openServerOverlay" class="cursor-pointer">server to finish installing</a>
      .
    </div>

    <div v-else-if="!hasLoadedVaultState" class="my-16 text-center text-slate-700/50">Loading...</div>

    <div v-else-if="!hasProfileName" class="my-16 text-center text-slate-700/50">
      You must
      <a @click="updateProfileOverlay" class="cursor-pointer">set your vault name</a>
      before
      <br />
      you can manage members.
    </div>

    <div v-else class="px-6 py-4 text-base text-gray-700">
      <div v-if="errorMessage || inviteCreationBlockedReason" class="space-y-3">
        <div v-if="errorMessage" class="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
          {{ errorMessage }}
        </div>

        <div
          v-if="inviteCreationBlockedReason"
          class="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800"
        >
          {{ inviteCreationBlockedReason }}
        </div>
      </div>

      <section class="mt-5">
        <div class="flex flex-row items-start justify-between gap-4">
          <div>
            <div class="title text-lg font-semibold text-slate-800">Invite People to Add Bitcoin to Your Vault</div>
            <p class="mt-2 text-sm leading-6 font-light text-slate-600">
              Create invite links with a free Bitcoin locking allowance for each person.
            </p>
          </div>

          <button
            v-if="!inviteCreationBlockedReason && !isAddingInvite"
            type="button"
            class="text-argon-700 rounded border border-slate-300 px-3 py-2 text-sm font-semibold hover:border-slate-400 hover:bg-slate-50"
            @click="toggleAddInvite"
          >
            Add Invite
          </button>
        </div>

        <div v-if="isAddingInvite" class="mt-5 border-t border-dashed border-slate-300 pt-4">
          <div>
            <label class="text-sm font-medium text-slate-700">Recipient Name</label>
            <input
              v-model.trim="inviteName"
              type="text"
              class="focus:border-argon-600 mt-2 w-full rounded-xl border border-slate-300 px-3 py-2.5 focus:ring-0"
            />
          </div>

          <div class="mt-4">
            <label class="text-sm font-medium text-slate-700">Max Satoshis Allowed For Free Lock</label>
            <div class="mt-2">
              <InputNumber v-model="maxSatoshisNumber" :min="1" :max="2100000000000000" suffix=" sats" />
            </div>
          </div>

          <div class="mt-4 flex flex-row gap-2">
            <button
              type="button"
              class="text-argon-700 rounded border border-slate-300 px-4 py-2 text-sm font-semibold"
              @click="toggleAddInvite"
            >
              Cancel
            </button>
            <button
              type="button"
              :disabled="isCreatingInvite || !inviteName.trim()"
              class="border-argon-700 bg-argon-600 rounded border px-4 py-2 text-sm font-semibold text-white disabled:cursor-default disabled:opacity-50"
              @click="createInvite"
            >
              {{ isCreatingInvite ? 'Creating...' : 'Create Invite' }}
            </button>
          </div>
        </div>

        <div
          v-if="invites.length === 0 && !isAddingInvite"
          class="mt-5 border-t border-dashed border-slate-300 pt-5 text-center text-sm font-light text-slate-500"
        >
          No invites yet. Create your first one to share your vault with someone.
        </div>

        <div v-else class="mt-5 max-h-72 overflow-y-auto border-t border-slate-300/70 pr-1">
          <div v-for="invite in invites" :key="invite.id" class="border-b border-slate-200 py-4 last:border-b-0">
            <div class="grid grid-cols-[minmax(0,1fr)_auto_auto_auto] items-start gap-x-4 text-slate-800">
              <div class="min-w-0">
                {{ invite.name }} has {{ currency.symbol
                }}{{ satToMoneyNm(invite.bitcoinLockCoupon?.coupon.maxSatoshis ?? 0n).format('0,0.00') }} in free BTC
                locking
              </div>

              <div class="text-right text-sm font-light break-all text-slate-500">
                <template v-if="invite.bitcoinLockCoupon?.expiresAt">
                  <CountdownClock :time="dayjs.utc(invite.bitcoinLockCoupon.expiresAt)">
                    <template #default="{ days, hours, minutes, seconds, isFinished }">
                      <template v-if="isFinished">expired</template>
                      <template v-else>expires in {{ days }}d {{ hours }}h {{ minutes }}m {{ seconds }}s</template>
                    </template>
                  </CountdownClock>
                </template>
                <template v-else>starts on first connect</template>
              </div>

              <div :class="statusClass(invite)" class="text-sm font-medium">{{ extractStatus(invite) }}</div>

              <CopyToClipboard
                v-if="inviteEnvelopesByInviteCode[invite.inviteCode]"
                :content="`${NetworkConfig.get().websiteHost}/treasury-invite/${inviteEnvelopesByInviteCode[invite.inviteCode]}`"
                class="cursor-pointer"
              >
                <button type="button" class="text-argon-700 text-sm font-semibold">Copy Link</button>
                <template #copied>
                  <button type="button" class="text-argon-700 text-sm font-semibold">Copy Link</button>
                </template>
              </CopyToClipboard>
            </div>
          </div>
        </div>
      </section>
    </div>
  </OverlayBase>
</template>

<script setup lang="ts">
import * as Vue from 'vue';
import dayjs from 'dayjs';
import type { ITreasuryUserInvite } from '@argonprotocol/apps-router';
import OverlayBase from '../../app-shared/overlays/OverlayBase.vue';
import basicEmitter from '../../emitters/basicEmitter.ts';
import InputNumber from '../../components/InputNumber.vue';
import CopyToClipboard from '../../components/CopyToClipboard.vue';
import CountdownClock from '../../components/CountdownClock.vue';
import { getMainchainClient } from '../../stores/mainchain.ts';
import { getMyVault } from '../../stores/vaults.ts';
import { getConfig } from '../../stores/config.ts';
import { InviteEnvelope } from '../../lib/InviteEnvelope.ts';
import { createNumeralHelpers } from '../../lib/numeral.ts';
import { getCurrency } from '../../stores/currency.ts';
import { InviteCodes, NetworkConfig, supportsBitcoinLockDelegateSetup, UserRole } from '@argonprotocol/apps-core';
import { UpstreamOperatorClient } from '../../lib/UpstreamOperatorClient.ts';
import { getServerApiClient } from '../../stores/server.ts';

const config = getConfig();
const myVault = getMyVault();
const currency = getCurrency();
const serverApiClient = getServerApiClient();

const { satToMoneyNm } = createNumeralHelpers(currency);

const isOpen = Vue.ref(false);
const isAddingInvite = Vue.ref(false);
const isCreatingInvite = Vue.ref(false);
const hasLoadedVaultState = Vue.ref(false);
const inviteCreationBlockedReason = Vue.ref<string | null>(null);
const errorMessage = Vue.ref<string | null>(null);
const inviteName = Vue.ref('');
const maxSatoshisNumber = Vue.ref(100_000_000);
const invites = Vue.ref<ITreasuryUserInvite[]>([]);
const inviteEnvelopesByInviteCode = Vue.ref<Record<string, string>>({});

const currentVaultName = Vue.computed(() => {
  return myVault.createdVault?.name ?? '';
});

const hasProfileName = Vue.computed(() => {
  return !!currentVaultName.value;
});

function closeOverlay() {
  isOpen.value = false;
}

function toggleAddInvite() {
  if (inviteCreationBlockedReason.value) return;

  errorMessage.value = null;
  isAddingInvite.value = !isAddingInvite.value;

  if (!isAddingInvite.value) {
    inviteName.value = '';
    maxSatoshisNumber.value = 100_000_000;
  }
}

function openServerOverlay() {
  basicEmitter.emit('openServerOverlay');
}

function updateProfileOverlay() {
  basicEmitter.emit('openProfileOverlay');
}

function statusClass(invite: ITreasuryUserInvite): string {
  const status = extractStatus(invite);
  if (status.includes('User')) return 'text-green-700';
  if (status.includes('Failed') || status.includes('Expired')) return 'text-red-700';
  return 'text-slate-600';
}

function extractStatus(invite: ITreasuryUserInvite): string {
  const bitcoinLock = invite.bitcoinLockCoupon;
  if (bitcoinLock?.status === 'Failed') {
    return 'Bitcoin Lock Failed';
  }
  if (bitcoinLock?.status === 'Finalized') {
    return 'Bitcoin Lock Started';
  }
  if (bitcoinLock?.status === 'Submitted' || bitcoinLock?.status === 'InBlock') {
    return 'User Started Bitcoin Lock';
  }
  if (invite.lastClickedAt) {
    return 'User Clicked';
  }
  if (bitcoinLock?.status === 'Expired') {
    return 'Invite Expired';
  }
  return 'Waiting for User';
}

async function loadInvites() {
  errorMessage.value = null;
  if (!config.serverDetails.ipAddress) {
    invites.value = [];
    return;
  }

  try {
    invites.value = await serverApiClient.getTreasuryAppInvites();
  } catch {
    invites.value = [];
    errorMessage.value = 'Unable to load invites right now. Please try again.';
  }
}

async function loadDelegateSetupState() {
  hasLoadedVaultState.value = false;
  inviteCreationBlockedReason.value = null;

  try {
    const client = await getMainchainClient(false);
    await myVault.load();

    if (!supportsBitcoinLockDelegateSetup(client)) {
      isAddingInvite.value = false;
      inviteCreationBlockedReason.value =
        'Member invites will unlock after the Argon network upgrade reaches your node.';
      return;
    }
  } catch (error: any) {
    errorMessage.value = error?.message ?? 'Unable to verify your Bitcoin lock delegate setup.';
  } finally {
    hasLoadedVaultState.value = true;
  }
}

async function createInvite() {
  if (isCreatingInvite.value) return;
  if (!hasProfileName.value) {
    errorMessage.value = 'Set your vault name before creating invites.';
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

  const maxSatoshis = BigInt(Math.floor(maxSatoshisNumber.value));
  if (maxSatoshis <= 0n) {
    errorMessage.value = 'Max satoshis must be greater than zero.';
    return;
  }

  try {
    errorMessage.value = null;
    isCreatingInvite.value = true;

    await myVault.load();
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
    const { inviteSecret, inviteCode } = InviteCodes.create();
    const inviteEnvelope = InviteEnvelope.encode({
      ...UpstreamOperatorClient.getInviteEndpoint(config.serverDetails),
      role: UserRole.TreasuryUser,
      secret: inviteSecret,
    });

    const invite = await serverApiClient.createTreasuryAppInvite({
      name,
      fromName: currentVaultName.value,
      inviteCode,
      vaultId,
      maxSatoshis,
      expiresAfterTicks,
    });

    inviteEnvelopesByInviteCode.value = {
      ...inviteEnvelopesByInviteCode.value,
      [invite.inviteCode]: inviteEnvelope,
    };

    await loadInvites();
    toggleAddInvite();
  } catch (error: any) {
    errorMessage.value = error?.message ?? 'Unable to create invite.';
  } finally {
    isCreatingInvite.value = false;
  }
}

basicEmitter.on('openVaultMembersOverlay', () => {
  isOpen.value = true;
});

Vue.watch([isOpen, () => config.isServerInstalled], ([open, isServerInstalled], _oldValue, onCleanup) => {
  if (!open || !isServerInstalled) return;

  void loadInvites();
  void loadDelegateSetupState();

  const interval = setInterval(() => {
    void loadInvites();
  }, 5_000);

  onCleanup(() => clearInterval(interval));
});
</script>
