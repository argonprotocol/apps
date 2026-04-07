<template>
  <OverlayBase :isOpen="isOpen" :overflowScroll="false" @close="closeOverlay" @esc="closeOverlay" class="w-7/12">
    <template #title>
      <div class="grow text-2xl font-bold">Manage Members</div>
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
      you can manage members.
    </div>
    <template v-else>
      <div v-if="errorMessage" class="px-4 py-3 text-sm text-red-700">
        {{ errorMessage }}
      </div>
      <div v-if="members.length === 0" class="px-4 py-4 italic">No members found.</div>
      <div v-else class="max-h-72 space-y-3 overflow-y-auto px-4 py-4">
        <div v-for="member in members" :key="member.id" class="rounded-md border-b border-slate-300 px-3 py-3">
          <div class="flex flex-row items-start justify-between gap-x-4 text-slate-800">
            <div>
              {{ member.name }} has {{ currency.symbol
              }}{{ satoshiToMoneyNm(member.couponMaxSatoshis).format('0,0.00') }} in free BTC locking
            </div>
            <div class="grow text-right">Last seen {{ dayjs(member.appLastSeenAt).fromNow() }}</div>
          </div>
        </div>
      </div>
    </template>
  </OverlayBase>
</template>

<script setup lang="ts">
import * as Vue from 'vue';
import dayjs from 'dayjs';
import relativeTime from 'dayjs/plugin/relativeTime';
import OverlayBase from '../../app-shared/overlays/OverlayBase.vue';
import basicEmitter from '../../emitters/basicEmitter.ts';
import { getTransactionTracker } from '../../stores/transactions.ts';
import { getMyVault } from '../../stores/vaults.ts';
import { getConfig } from '../../stores/config.ts';
import { SERVER_ENV_VARS } from '../../lib/Env.ts';
import { JsonExt } from '@argonprotocol/apps-core';
import type { ITreasuryMember } from '@argonprotocol/apps-router';
import { createNumeralHelpers } from '../../lib/numeral.ts';
import { getCurrency } from '../../stores/currency.ts';

dayjs.extend(relativeTime);

const config = getConfig();
const myVault = getMyVault();
const transactionTracker = getTransactionTracker();
const currency = getCurrency();

const { satoshiToMoneyNm } = createNumeralHelpers(currency);

const isOpen = Vue.ref(false);
const errorMessage = Vue.ref<string | null>(null);
const members = Vue.ref<ITreasuryMember[]>([]);

const ipAddress = Vue.computed(() => {
  return config.serverDetails.ipAddress;
});

function closeOverlay() {
  isOpen.value = false;
}

function updateProfileOverlay() {
  basicEmitter.emit('openProfileOverlay');
}

function openServerOverlay() {
  basicEmitter.emit('openServerOverlay');
}

async function loadMembers() {
  errorMessage.value = null;
  await transactionTracker.load();
  await myVault.load();
  const vaultId = myVault.createdVault?.vaultId;
  if (!vaultId) {
    members.value = [];
    return;
  }

  try {
    const response = await fetch(`http://${ipAddress.value}:${SERVER_ENV_VARS.ROUTER_PORT}/treasury-users/members`);
    if (!response.ok) {
      members.value = [];
      errorMessage.value = 'Unable to load members right now. Please try again.';
      return;
    }

    const rawBody = await response.text();
    members.value = JsonExt.parse<ITreasuryMember[]>(rawBody);
  } catch {
    members.value = [];
    errorMessage.value = 'Unable to load members right now. Please try again.';
  }
}

basicEmitter.on('openVaultMembersOverlay', () => {
  isOpen.value = true;
  void loadMembers();
});
</script>
