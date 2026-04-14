<template>
  <OverlayBase :isOpen="isOpen" :overflowScroll="false" @close="closeOverlay" @esc="closeOverlay" class="w-7/12 pb-5">
    <template #title>
      <div class="grow text-2xl font-bold">Manage Sponsor Invites</div>
    </template>

    <div v-if="!config.isServerInstalled" class="my-16 text-center text-slate-700/50">
      You must wait for your
      <br />
      <a @click="openServerOverlay" class="cursor-pointer">server to finish installing</a>
      .
    </div>
    <div v-else-if="!hasProfileName" class="my-16 text-center text-slate-700/50">
      You must
      <a @click="updateProfileOverlay" class="cursor-pointer">set your profile name</a>
      before
      <br />
      creating sponsor invites.
    </div>
    <template v-else>
      <div v-if="errorMessage || infoMessage" class="mx-4 mt-4 space-y-3">
        <div v-if="errorMessage" class="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
          {{ errorMessage }}
        </div>
        <div
          v-if="infoMessage"
          class="rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-700">
          {{ infoMessage }}
        </div>
      </div>

      <div v-if="invites.length === 0" class="px-4 py-4 italic">No invites found.</div>
      <div v-else class="max-h-72 space-y-3 overflow-y-auto px-4 py-4">
        <div v-for="invite in invites" :key="invite.id" class="rounded-md border-b border-slate-300 px-3 py-3">
          <div class="flex flex-row items-start justify-between gap-x-4 text-slate-800">
            <div class="grow">
              <div>{{ invite.name }}</div>
              <div v-if="invite.lastClickedAt" class="mt-1 text-sm text-slate-500">
                Opened {{ dayjs(invite.lastClickedAt).fromNow() }}
              </div>
            </div>
            <div :class="statusClass(invite)">{{ extractStatus(invite) }}</div>
            <CopyToClipboard
              v-if="inviteEnvelopesByInviteCode[invite.inviteCode]"
              :content="`${NetworkConfig.get().websiteHost}/operational-invite/${inviteEnvelopesByInviteCode[invite.inviteCode]}`"
              class="cursor-pointer">
              <button type="button">Copy Link</button>
              <template #copied>
                <button type="button">Copied</button>
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

        <div class="mt-2 flex flex-row gap-x-2">
          <button @click="toggleAddInvite" class="text-argon-600 rounded border px-3 py-1">Cancel</button>
          <button
            @click="createInvite"
            :disabled="isCreatingInvite"
            class="border-argon-700 bg-argon-600 rounded border px-3 py-1 text-white disabled:opacity-50">
            {{ isCreatingInvite ? 'Creating...' : 'Create' }}
          </button>
        </div>
      </div>
      <div v-else @click="toggleAddInvite" class="text-argon-600 mx-4 mt-4 cursor-pointer">+ Add Invite</div>
    </template>
  </OverlayBase>
</template>

<script setup lang="ts">
import * as Vue from 'vue';
import dayjs from 'dayjs';
import relativeTime from 'dayjs/plugin/relativeTime';
import type { IOperationalUserInvite } from '@argonprotocol/apps-router';
import { InviteCodes, NetworkConfig, UserRole } from '@argonprotocol/apps-core';
import OverlayBase from '../../app-shared/overlays/OverlayBase.vue';
import CopyToClipboard from '../../components/CopyToClipboard.vue';
import basicEmitter from '../../emitters/basicEmitter.ts';
import { SERVER_ENV_VARS } from '../../lib/Env.ts';
import { getConfig } from '../../stores/config.ts';
import { getMyVault } from '../../stores/vaults.ts';
import { InviteEnvelope } from '../../lib/InviteEnvelope.ts';
import { ServerApiClient } from '../../lib/ServerApiClient.ts';

dayjs.extend(relativeTime);

const config = getConfig();
const myVault = getMyVault();

const isOpen = Vue.ref(false);
const isAddingInvite = Vue.ref(false);
const isCreatingInvite = Vue.ref(false);
const errorMessage = Vue.ref<string | null>(null);
const infoMessage = Vue.ref<string | null>(null);
const inviteName = Vue.ref('');
const invites = Vue.ref<IOperationalUserInvite[]>([]);
const inviteEnvelopesByInviteCode = Vue.ref<Record<string, string>>({});

const ipAddress = Vue.computed(() => {
  return config.serverDetails.ipAddress;
});

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
  infoMessage.value = null;
  errorMessage.value = null;
  isAddingInvite.value = !isAddingInvite.value;
  if (!isAddingInvite.value) {
    inviteName.value = '';
  }
}

function updateProfileOverlay() {
  basicEmitter.emit('openProfileOverlay');
}

function openServerOverlay() {
  basicEmitter.emit('openServerOverlay');
}

function statusClass(invite: IOperationalUserInvite): string {
  if (invite.lastClickedAt) return 'text-amber-700';
  return 'text-slate-600';
}

function extractStatus(invite: IOperationalUserInvite): string {
  if (invite.lastClickedAt) {
    return 'Invite Opened';
  }
  return 'Waiting for User';
}

async function loadInvites() {
  errorMessage.value = null;
  if (!ipAddress.value) {
    invites.value = [];
    return;
  }

  try {
    invites.value = await ServerApiClient.getOperationalInvites(ipAddress.value);
  } catch {
    invites.value = [];
    errorMessage.value = 'Unable to load invites right now. Please try again.';
  }
}

async function createInvite() {
  if (isCreatingInvite.value) return;

  const name = inviteName.value.trim();
  if (!name) {
    errorMessage.value = 'Enter a name for the invite.';
    return;
  }
  if (!ipAddress.value) {
    errorMessage.value = 'No server is available to create an invite.';
    return;
  }

  try {
    errorMessage.value = null;
    infoMessage.value = null;
    isCreatingInvite.value = true;
    await myVault.load();

    const fromName = currentVaultName.value.trim();
    if (!fromName) {
      throw new Error('Set your vault name before creating sponsor invites.');
    }

    const { inviteSecret, inviteCode } = InviteCodes.create();
    const inviteEnvelope = InviteEnvelope.encode({
      host: ipAddress.value,
      port: SERVER_ENV_VARS.ROUTER_PORT,
      role: UserRole.OperationalPartner,
      secret: inviteSecret,
    });
    const invite = await ServerApiClient.createOperationalInvite(ipAddress.value, {
      name,
      fromName,
      inviteCode,
    });

    inviteEnvelopesByInviteCode.value = {
      ...inviteEnvelopesByInviteCode.value,
      [invite.inviteCode]: inviteEnvelope,
    };

    await navigator.clipboard
      .writeText(`${NetworkConfig.get().websiteHost}/operational-invite/${inviteEnvelope}`)
      .catch(() => undefined);

    infoMessage.value = 'Invite link copied. Save it now, since the private access code is only available at creation.';

    await loadInvites();
    toggleAddInvite();
  } catch (error: any) {
    errorMessage.value = error?.message ?? 'Unable to create invite.';
  } finally {
    isCreatingInvite.value = false;
  }
}

basicEmitter.on('openOperationalInvitesOverlay', () => {
  isOpen.value = true;
});

Vue.watch([isOpen, () => config.isServerInstalled], ([open, isServerInstalled], _oldValue, onCleanup) => {
  if (!open || !isServerInstalled) return;

  void loadInvites();

  const interval = setInterval(() => {
    void loadInvites();
  }, 5_000);

  onCleanup(() => clearInterval(interval));
});
</script>
