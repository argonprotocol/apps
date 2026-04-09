<template>
  <OverlayBase :isOpen="isOpen" :overflowScroll="false" @close="closeOverlay" @esc="closeOverlay" class="w-7/12 pb-5">
    <template #title>
      <div class="grow text-2xl font-bold">Manage Member Invites</div>
    </template>

    <div v-if="!config.isServerInstalled" class="my-16 text-center text-slate-700/50">
      You must wait for your
      <br />
      <a @click="openServerOverlay" class="cursor-pointer">server to finish installing</a>
      .
    </div>
    <div v-else-if="!config.hasProfileName" class="my-16 text-center text-slate-700/50">
      You must
      <a @click="updateProfileOverlay" class="cursor-pointer">set your profile name</a>
      before
      <br />
      creating invites.
    </div>
    <template v-else>
      <div v-if="errorMessage || inviteCreationBlockedReason || needsInitialDelegateSetup" class="mx-4 mt-4 space-y-3">
        <div v-if="errorMessage" class="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
          {{ errorMessage }}
        </div>

        <div
          v-if="inviteCreationBlockedReason"
          class="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800">
          {{ inviteCreationBlockedReason }}
        </div>

        <div
          v-if="needsInitialDelegateSetup"
          class="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800">
          Your first member invite will set up and fund your Bitcoin lock delegate. That extra setup step needs an Argon
          transaction from your vault account, so creating the invite may take a moment.
        </div>
      </div>

      <div v-if="invites.length === 0" class="px-4 py-4 italic">No invites found.</div>
      <div v-else class="max-h-72 space-y-3 overflow-y-auto px-4 py-4">
        <div v-for="invite in invites" :key="invite.id" class="rounded-md border-b border-slate-300 px-3 py-3">
          <div class="flex flex-row items-start justify-between gap-x-4 text-slate-800">
            <div>
              {{ invite.name }} has {{ currency.symbol }}{{ satoshiToMoneyNm(invite.maxSatoshis).format('0,0.00') }} in
              free BTC locking
            </div>
            <div class="break-all">
              <template v-if="invite.expiresAt">
                <CountdownClock :time="dayjs.utc(invite.expiresAt)">
                  <template #default="{ days, hours, minutes, seconds, isFinished }">
                    <template v-if="isFinished">expired</template>
                    <template v-else>expires in {{ days }}d {{ hours }}h {{ minutes }}m {{ seconds }}s</template>
                  </template>
                </CountdownClock>
              </template>
              <template v-else>starts on first connect</template>
            </div>
            <div :class="statusClass(invite)">{{ extractStatus(invite) }}</div>
            <CopyToClipboard
              :content="`${NetworkConfig.get().websiteHost}/treasury-invite/${invite.inviteCode}`"
              class="cursor-pointer">
              <button type="button">Copy Link</button>
              <template #copied>
                <button type="button">Copy Link</button>
              </template>
            </CopyToClipboard>
          </div>
        </div>
      </div>

      <div v-if="isAddingInvite" class="mx-4 mt-4">
        <div>
          <label>Recipient Name</label>
          <input
            v-model.trim="inviteName"
            type="text"
            class="focus:border-argon-600 mt-2 w-full rounded-md border border-slate-300 focus:ring-0" />
        </div>

        <div class="mt-3">
          <label>Max Satoshis Allowed For Free Lock</label>
          <InputNumber v-model="maxSatoshisNumber" :min="1" :max="2100000000000000" suffix=" sats" />
        </div>

        <div class="mt-2 flex flex-row gap-x-2">
          <button @click="toggleAddInvite" class="text-argon-600 rounded border px-3 py-1">Cancel</button>
          <button
            @click="createInvite"
            :disabled="isCreatingInvite"
            class="border-argon-700 bg-argon-600 rounded border px-3 py-1 text-white disabled:opacity-50">
            {{ isCreatingInvite ? (isRunningInitialDelegateSetup ? 'Setting Up...' : 'Creating...') : 'Create' }}
          </button>
        </div>
      </div>
      <div v-else-if="inviteCreationBlockedReason" class="mx-4 mt-4 text-sm text-slate-600">
        Invite creation will unlock after the runtime upgrade adds Bitcoin lock delegate support.
      </div>
      <div v-else @click="toggleAddInvite" class="text-argon-600 mx-4 mt-4 cursor-pointer">+ Add Invite</div>
    </template>
  </OverlayBase>
</template>

<script setup lang="ts">
import * as Vue from 'vue';
import OverlayBase from '../../app-shared/overlays/OverlayBase.vue';
import basicEmitter from '../../emitters/basicEmitter.ts';
import InputNumber from '../../components/InputNumber.vue';
import CopyToClipboard from '../../components/CopyToClipboard.vue';
import { getMainchainClient, getMiningFrames } from '../../stores/mainchain.ts';
import { getMyVault } from '../../stores/vaults.ts';
import { getWalletKeys } from '../../stores/wallets.ts';
import {
  BitcoinLockCoupons,
  type IBitcoinLockCouponStatus,
  type ITreasuryUserInviteSummary,
} from '@argonprotocol/apps-router';
import { getConfig } from '../../stores/config.ts';
import { SERVER_ENV_VARS } from '../../lib/Env.ts';
import { VaultInvites } from '../../lib/VaultInvites.ts';
import dayjs from 'dayjs';
import CountdownClock from '../../components/CountdownClock.vue';
import { createNumeralHelpers } from '../../lib/numeral.ts';
import { getCurrency } from '../../stores/currency.ts';
import { NetworkConfig, supportsBitcoinLockDelegateSetup } from '@argonprotocol/apps-core';
import { nanoid } from 'nanoid';
import { ServerApiClient } from '../../lib/ServerApiClient.ts';

const config = getConfig();
const myVault = getMyVault();
const walletKeys = getWalletKeys();
const miningFrames = getMiningFrames();
const currency = getCurrency();

const { satoshiToMoneyNm } = createNumeralHelpers(currency);

const isOpen = Vue.ref(false);
const isAddingInvite = Vue.ref(false);
const isCreatingInvite = Vue.ref(false);
const isRunningInitialDelegateSetup = Vue.ref(false);
const needsInitialDelegateSetup = Vue.ref(false);
const inviteCreationBlockedReason = Vue.ref<string | null>(null);
const errorMessage = Vue.ref<string | null>(null);
const inviteName = Vue.ref('');
const maxSatoshisNumber = Vue.ref(100_000_000);
const invites = Vue.ref<ITreasuryUserInviteSummary[]>([]);
const bitcoinLockStatusesByOfferCode = Vue.ref<Record<string, IBitcoinLockCouponStatus>>({});

const ipAddress = Vue.computed(() => {
  return config.serverDetails.ipAddress;
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

function statusClass(invite: ITreasuryUserInviteSummary): string {
  const status = extractStatus(invite);
  if (status.includes('User')) return 'text-green-700';
  if (status.includes('Failed') || status.includes('Expired')) return 'text-red-700';
  return 'text-slate-600';
}

function extractStatus(invite: ITreasuryUserInviteSummary): string {
  const bitcoinLock = bitcoinLockStatusesByOfferCode.value[invite.offerCode];
  if (bitcoinLock?.status === 'Failed') {
    return 'Bitcoin Lock Failed';
  } else if (bitcoinLock?.status === 'Finalized') {
    return 'Bitcoin Lock Started';
  } else if (bitcoinLock?.status === 'Submitted' || bitcoinLock?.status === 'InBlock') {
    return 'User Started Bitcoin Lock';
  } else if (invite.lastClickedAt) {
    return 'User Clicked';
  } else if (invite.expiresAt && invite.expiresAt < new Date()) {
    return 'Invite Expired';
  } else {
    return 'Waiting for User';
  }
}

function updateProfileOverlay() {
  basicEmitter.emit('openProfileOverlay');
}

function openServerOverlay() {
  basicEmitter.emit('openServerOverlay');
}

async function loadInvites() {
  errorMessage.value = null;
  if (!ipAddress.value) {
    invites.value = [];
    bitcoinLockStatusesByOfferCode.value = {};
    return;
  }

  try {
    const [loadedInvites, bitcoinLocks] = await Promise.all([
      ServerApiClient.getTreasuryAppInvites(ipAddress.value),
      ServerApiClient.getBitcoinLockCouponStatuses(ipAddress.value),
    ]);
    invites.value = loadedInvites;
    bitcoinLockStatusesByOfferCode.value = Object.fromEntries(bitcoinLocks.map(lock => [lock.offerCode, lock]));
  } catch {
    invites.value = [];
    bitcoinLockStatusesByOfferCode.value = {};
    errorMessage.value = 'Unable to load invites right now. Please try again.';
  }
}

async function loadDelegateSetupState() {
  needsInitialDelegateSetup.value = false;
  inviteCreationBlockedReason.value = null;

  try {
    const client = await getMainchainClient(false);
    if (!supportsBitcoinLockDelegateSetup(client)) {
      isAddingInvite.value = false;
      inviteCreationBlockedReason.value = 'This feature will be activated after the Argon network is upgraded.';
      return;
    }

    await myVault.load();
    const delegateAddress = await walletKeys.getVaultDelegateKeypair().then(x => x.address);
    needsInitialDelegateSetup.value = myVault.createdVault?.bitcoinLockDelegateAccount !== delegateAddress;
  } catch (error: any) {
    errorMessage.value = error?.message ?? 'Unable to verify your Bitcoin lock delegate setup.';
  }
}

async function createInvite() {
  if (isCreatingInvite.value) return;
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
    if (!ipAddress.value) {
      throw new Error('No server is available to create an invite.');
    }

    const client = await getMainchainClient(false);

    isRunningInitialDelegateSetup.value = needsInitialDelegateSetup.value;
    const delegateSetupTx = await myVault.ensureDelegatedBitcoinSigner();
    await delegateSetupTx?.txResult.waitForInFirstBlock;
    needsInitialDelegateSetup.value = false;
    const signer = await walletKeys.getVaultingKeypair();

    const expirationFrame = myVault.data.currentFrameId + 1;
    const expirationFrameEndTick = miningFrames.getTickEnd(expirationFrame);
    if (!expirationFrameEndTick) {
      throw new Error(`Unable to calculate expiration tick for frame ${expirationFrame}.`);
    }

    const currentTick = Number((await client.query.ticks.currentTick()).toBigInt());
    const expiresAfterTicks = expirationFrameEndTick - currentTick;
    if (expiresAfterTicks <= 0) {
      throw new Error('Unable to calculate an invite expiration window.');
    }

    const inviteAccessCode = nanoid(10);
    const offerCode = nanoid(10);
    const offerToken = BitcoinLockCoupons.createToken(
      {
        vaultId,
        maxSatoshis,
        expiresAfterTicks,
        code: offerCode,
      },
      signer,
    );
    const inviteCode = VaultInvites.encodeInviteCode(ipAddress.value, SERVER_ENV_VARS.ROUTER_PORT, inviteAccessCode);
    await ServerApiClient.createTreasuryAppInvite(ipAddress.value, {
      name,
      inviteCode,
      offerCode,
      offerToken,
      maxSatoshis,
      expiresAfterTicks,
    });

    await loadInvites();
    toggleAddInvite();
  } catch (error: any) {
    errorMessage.value = error?.message ?? 'Unable to create invite.';
  } finally {
    isRunningInitialDelegateSetup.value = false;
    isCreatingInvite.value = false;
  }
}

basicEmitter.on('openVaultInvitesOverlay', () => {
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
