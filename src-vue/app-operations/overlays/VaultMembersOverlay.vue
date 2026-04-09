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
              {{ member.name }} has {{ currency.symbol }}{{ satoshiToMoneyNm(member.maxSatoshis).format('0,0.00') }} in
              free BTC locking
            </div>
            <div class="grow text-right">
              <template v-if="bitcoinLockStatusesByOfferCode[member.offerCode]?.status === 'Failed'">
                Lock failed
              </template>
              <template v-else-if="bitcoinLockStatusesByOfferCode[member.offerCode]?.status === 'Finalized'">
                Locked
              </template>
              <template
                v-else-if="
                  bitcoinLockStatusesByOfferCode[member.offerCode]?.status === 'Submitted' ||
                  bitcoinLockStatusesByOfferCode[member.offerCode]?.status === 'InBlock'
                ">
                Started
              </template>
              <template v-else-if="member.lastClickedAt">Opened {{ dayjs(member.lastClickedAt).fromNow() }}</template>
              <template v-else>Waiting</template>
            </div>
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
import { getConfig } from '../../stores/config.ts';
import type { IBitcoinLockCouponStatus, ITreasuryUserMember } from '@argonprotocol/apps-router';
import { createNumeralHelpers } from '../../lib/numeral.ts';
import { getCurrency } from '../../stores/currency.ts';
import { ServerApiClient } from '../../lib/ServerApiClient.ts';

dayjs.extend(relativeTime);

const config = getConfig();
const currency = getCurrency();

const { satoshiToMoneyNm } = createNumeralHelpers(currency);

const isOpen = Vue.ref(false);
const errorMessage = Vue.ref<string | null>(null);
const members = Vue.ref<ITreasuryUserMember[]>([]);
const bitcoinLockStatusesByOfferCode = Vue.ref<Record<string, IBitcoinLockCouponStatus>>({});

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
  if (!ipAddress.value) {
    members.value = [];
    return;
  }

  try {
    const [loadedMembers, bitcoinLocks] = await Promise.all([
      ServerApiClient.getTreasuryAppMembers(ipAddress.value),
      ServerApiClient.getBitcoinLockCouponStatuses(ipAddress.value),
    ]);
    members.value = loadedMembers;
    bitcoinLockStatusesByOfferCode.value = Object.fromEntries(bitcoinLocks.map(lock => [lock.offerCode, lock]));
  } catch {
    members.value = [];
    bitcoinLockStatusesByOfferCode.value = {};
    errorMessage.value = 'Unable to load members right now. Please try again.';
  }
}

basicEmitter.on('openVaultMembersOverlay', () => {
  isOpen.value = true;
});

Vue.watch([isOpen, () => config.isServerInstalled], ([open, isServerInstalled], _oldValue, onCleanup) => {
  if (!open || !isServerInstalled) return;

  void loadMembers();

  const interval = setInterval(() => {
    void loadMembers();
  }, 5_000);

  onCleanup(() => clearInterval(interval));
});
</script>
