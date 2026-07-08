<template>
  <div class="px-5 pt-4 pb-5 text-slate-700">
    <div class="text-reg mt-4 space-y-3 leading-6 text-slate-500">
      <p>This is your home base for mining and vaulting on the Argon network. No prior crypto experience required.</p>
      <p>
        <strong class="font-bold">Mining</strong>
        helps secure the Argon network by maintaining consensus and minting new Argons when needed.
      </p>
      <p>
        <strong class="font-bold">Vaulting</strong>
        locks Bitcoin into stabilization contracts that help keep Argon's price steady.
      </p>
      <p>
        Request an operations upgrade from
        <strong class="font-bold">{{ upstreamName }}</strong>
        when you're ready to manage mining and vaulting from the same vault.
      </p>
    </div>

    <div
      v-if="formError"
      class="mt-4 flex flex-row items-center gap-x-2 rounded-lg border border-red-400/50 bg-red-100 px-3 py-1.5 text-red-600"
    >
      <AlertIcon class="h-4 w-4 shrink-0" />
      <span>{{ formError }}</span>
    </div>

    <div
      v-else-if="invite?.operationsUpgradedAt"
      class="border-argon-300/60 bg-argon-50 text-argon-700 mt-4 rounded-lg border px-3 py-2"
    >
      Your vault operator approved this upgrade on {{ upgradedAtLabel }}. Operations will unlock as soon as chain data
      refreshes.
    </div>

    <div
      v-else-if="invite?.operationsUpgradeRequestedAt"
      class="mt-4 rounded-lg border border-amber-300/60 bg-amber-50 px-3 py-2 text-amber-900"
    >
      Upgrade requested on {{ requestedAtLabel }}. Your vault operator can approve it from their side when they are
      ready.
    </div>

    <button
      v-if="!invite?.operationsUpgradeRequestedAt && !invite?.operationsUpgradedAt"
      type="button"
      :disabled="isLoading || isSubmitting"
      class="bg-argon-button border-argon-button-hover hover:bg-argon-button-hover inner-button-shadow mt-4 flex w-full cursor-pointer flex-row items-center justify-center space-x-2 rounded-md border px-12 py-2 font-bold text-white focus:outline-none disabled:cursor-default disabled:opacity-50"
      @click="requestUpgrade"
    >
      <template v-if="isSubmitting">Requesting Upgrade...</template>
      <template v-else-if="isLoading">Loading...</template>
      <template v-else>Request Operations Upgrade</template>
    </button>
  </div>
</template>

<script setup lang="ts">
import * as Vue from 'vue';
import type { IMemberInvite } from '@argonprotocol/apps-router';
import dayjs from 'dayjs';
import AlertIcon from '../assets/alert.svg?component';
import { getConfig } from '../stores/config.ts';
import { getUpstreamOperatorClient } from '../stores/upstreamOperator.ts';
import { getWalletKeys } from '../stores/wallets.ts';

const config = getConfig();
const upstreamOperatorClient = getUpstreamOperatorClient();
const walletKeys = getWalletKeys();

const invite = Vue.ref<IMemberInvite | null>(null);
const isLoading = Vue.ref(true);
const isSubmitting = Vue.ref(false);
const formError = Vue.ref('');

const upstreamName = Vue.computed(() => {
  return invite.value?.fromName || config.upstreamOperator?.name || 'your vault operator';
});
const requestedAtLabel = Vue.computed(() => {
  if (!invite.value?.operationsUpgradeRequestedAt) return '';
  return dayjs.utc(invite.value.operationsUpgradeRequestedAt).local().format('M/D/YYYY [at] h:mm a');
});
const upgradedAtLabel = Vue.computed(() => {
  if (!invite.value?.operationsUpgradedAt) return '';
  return dayjs.utc(invite.value.operationsUpgradedAt).local().format('M/D/YYYY [at] h:mm a');
});

void loadInvite();

async function requestUpgrade() {
  if (
    isLoading.value ||
    isSubmitting.value ||
    invite.value?.operationsUpgradeRequestedAt ||
    invite.value?.operationsUpgradedAt
  ) {
    return;
  }

  isSubmitting.value = true;
  formError.value = '';

  try {
    const [defaultAccountKeypair, authKeypair] = await Promise.all([
      walletKeys.getLiquidLockingKeypair(),
      walletKeys.getUpstreamOperatorAuthKeypair(),
    ]);

    const operationsUpgradeRequestedAt = await upstreamOperatorClient.requestOperationsUpgrade({
      defaultAccountKeypair,
      operationalAccountId: walletKeys.operationalAddress,
      authKeypair,
    });
    invite.value = invite.value
      ? {
          ...invite.value,
          operationsUpgradeRequestedAt,
        }
      : await upstreamOperatorClient.getMemberInvite();
  } catch (error) {
    formError.value =
      error instanceof Error && error.message
        ? error.message
        : 'Unable to request an operations upgrade right now. Please try again.';
  } finally {
    isSubmitting.value = false;
  }
}

async function loadInvite() {
  isLoading.value = true;
  formError.value = '';

  try {
    invite.value = await upstreamOperatorClient.getMemberInvite();
  } catch (error) {
    formError.value =
      error instanceof Error && error.message ? error.message : 'Unable to load your upstream member record right now.';
  } finally {
    isLoading.value = false;
  }
}
</script>
