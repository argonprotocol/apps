<!-- prettier-ignore -->
<template>
  <OverlayBase
    :isOpen="isOpen"
    @close="closeOverlay"
    @pressEsc="closeOverlay"
    :hasHeaderBorder="false"
    class="w-7/12"
  >
    <template #title>
      <div class="border-b-none relative top-2 ml-6 grow text-2xl font-bold">Upgrade to Operations</div>
    </template>

    <div class="mt-2 px-10 pb-8">
      <div class="mb-5 space-y-3 text-[17px]/7 leading-normal font-light">
        <p>
          Operations manages the network and its yield-generating assets. They mine blocks, process transactions,
          and operate stabilization vaults. It's more complicated than Treasury, but it also has more revenue
          opportunities. Here’s the network's current APR for Operations:
        </p>

        <ul class="mt-6 grid grid-cols-2 gap-3">
          <li class="border-argon-300/20 bg-argon-100/20 flex items-center justify-between rounded border px-3 py-2">
            <div class="leading-tight">
              <header class="font-bold">Mining Operations</header>
              <span class="text-base opacity-80">The network's computation</span>
            </div>
            <div class="bg-argon-100/50 rounded px-3 py-2 text-2xl leading-none font-bold">
              <template v-if="areOperationReturnsReady">
                {{ numeral(miningStats.averageAPY).formatIfElseCapped('< 100', '0.0', '0', 999) }}%
              </template>
              <template v-else>---%</template>
            </div>
          </li>
          <li class="border-argon-300/20 bg-argon-100/20 flex items-center justify-between rounded border px-3 py-2">
            <div class="leading-tight">
              <header class="font-bold">Vaulting Operations</header>
              <span class="text-base opacity-80">The currency's stabilization</span>
            </div>
            <div class="bg-argon-100/50 rounded px-3 py-2 text-2xl leading-none font-bold">
              <template v-if="areOperationReturnsReady">
                {{ numeral(vaultingStats.averageAPY).formatIfElseCapped('< 100', '0.0', '0', 999) }}%
              </template>
              <template v-else>---%</template>
            </div>
          </li>
        </ul>
      </div>

      <p v-if="canRequestUpgrade" class="mt-3 text-base leading-6 text-slate-500">
        Only existing Operators can grant upgrade approvals. Click the button below to request an upgrade from your sponsor
        (<strong class="font-semibold text-slate-700">{{ upstreamName }}</strong>).
      </p>

      <div v-if="formError" class="mt-4 flex flex-row items-center gap-x-2 text-sm text-red-600">
        <AlertIcon class="h-4 w-4 shrink-0" />
        <span>{{ formError }}</span>
      </div>

      <div
        v-else-if="invite?.operationsUpgradeRequestedAt && !canRequestUpgrade"
        class="border-argon-300 mt-5 border-l-2 pl-3 text-sm text-slate-600"
      >
        Upgrade requested on {{ requestedAtLabel }}. We're waiting for your sponsor to approve.
      </div>

      <button
        v-else-if="canRequestUpgrade"
        type="button"
        :disabled="isLoading || isSubmitting"
        class="bg-argon-button hover:bg-argon-button-hover mt-6 rounded-lg cursor-pointer px-5 py-2.5 font-semibold text-white disabled:cursor-default disabled:opacity-50"
        @click="requestUpgrade"
      >
        <template v-if="isSubmitting">Requesting Upgrade...</template>
        <template v-else-if="isLoading">Loading...</template>
        <template v-else>Request Operational Upgrade</template>
      </button>
    </div>
  </OverlayBase>
</template>

<script lang="ts">
import { ref } from 'vue';

const hasRequestedUpgradeThisSession = ref(false);
</script>

<script setup lang="ts">
import * as Vue from 'vue';
import type { IMemberInvite } from '@argonprotocol/apps-router';
import dayjs from 'dayjs';
import { getConfig } from '../stores/config.ts';
import { treasuryCertificationStepIds, useCertificationController } from '../stores/certificationController.ts';
import { getUpstreamOperatorClient } from '../stores/upstreamOperator.ts';
import { getWalletKeys } from '../stores/wallets.ts';
import { useMiningStats } from '../stores/miningStats.ts';
import { useVaultingStats } from '../stores/vaultingStats.ts';
import OverlayBase from './OverlayBase.vue';
import AlertIcon from '../assets/alert.svg';
import basicEmitter from '../emitters/basicEmitter.ts';
import numeral from '../lib/numeral.ts';
import { hasOperationsUpgradeRequest } from '../lib/UpstreamOperatorClient.ts';
import { canRequestOperationsUpgrade } from '../lib/OperationalAccount.ts';

const config = getConfig();
const controller = useCertificationController();
const upstreamOperatorClient = getUpstreamOperatorClient();
const walletKeys = getWalletKeys();
const miningStats = useMiningStats();
const vaultingStats = useVaultingStats();

const isOpen = Vue.ref(false);
const invite = Vue.ref<IMemberInvite | null>(null);
const isLoading = Vue.ref(true);
const isSubmitting = Vue.ref(false);
const formError = Vue.ref('');
const areOperationReturnsReady = Vue.ref(false);
const hasOpenedWelcome = Vue.ref(false);

let refreshInterval: ReturnType<typeof setInterval> | undefined;

const upstreamName = Vue.computed(() => {
  return invite.value?.fromName || config.upstreamOperator?.name || 'your upstream operator';
});

const isEligibleForUpgrade = Vue.computed(() => {
  return canRequestOperationsUpgrade({
    hasLoadedInitialOperationalProgress: controller.hasLoadedInitialOperationalProgress,
    hasExtensionTreasury: config.hasExtensionTreasury,
    hasCompletedTreasuryCertification:
      controller.completedTreasuryCertificationStepCount === treasuryCertificationStepIds.length,
    isUpgradedToOperations: controller.chainProgress.isUpgradedToOperations,
  });
});

const canRequestUpgrade = Vue.computed(() => {
  if (!isEligibleForUpgrade.value) {
    return false;
  }

  if (invite.value?.accessProof || invite.value?.operationsUpgradedAt) {
    return false;
  }

  if (hasRequestedUpgradeThisSession.value) {
    return false;
  }

  if (
    hasOperationsUpgradeRequest({
      ...(invite.value ?? {}),
      restorePackageRevision: config.upstreamOperator?.restorePackageRevision,
    })
  ) {
    return false;
  }

  return true;
});

const requestedAtLabel = Vue.computed(() => {
  if (!invite.value?.operationsUpgradeRequestedAt) return '';
  return dayjs.utc(invite.value.operationsUpgradeRequestedAt).local().format('M/D/YYYY [at] h:mm a');
});

async function requestUpgrade() {
  if (!canRequestUpgrade.value || isLoading.value || isSubmitting.value) {
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

    hasRequestedUpgradeThisSession.value = true;

    config.setCertificationDetails({ dismissedOperationsUpgradeOverlay: true });
    void config.save();

    if (invite.value) {
      invite.value.operationsUpgradeRequestedAt = operationsUpgradeRequestedAt;
    }
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
    openWelcomeIfApproved();
  } catch (error) {
    formError.value =
      error instanceof Error && error.message ? error.message : 'Unable to load your upstream member record right now.';
  } finally {
    isLoading.value = false;
  }
}

function openWelcomeIfApproved() {
  if (
    hasOpenedWelcome.value ||
    config.certificationDetails?.dismissedWelcomeToOperationsOverlay ||
    (!invite.value?.accessProof && !invite.value?.operationsUpgradedAt)
  ) {
    return;
  }

  hasOpenedWelcome.value = true;
  closeOverlay();
  basicEmitter.emit('openWelcomeToOperationsOverlay');
}

async function refreshOperationReturns(): Promise<void> {
  areOperationReturnsReady.value = false;

  try {
    await Promise.all([miningStats.update(), vaultingStats.update()]);
    areOperationReturnsReady.value = true;
  } catch (error) {
    console.warn('[UpgradeToOperationsOverlay] Unable to refresh operation returns', error);
  }
}

function closeOverlay() {
  isOpen.value = false;
}

function openUpgradeToOperationsOverlay() {
  isOpen.value = true;
  void refreshOperationReturns();
}

basicEmitter.on('openUpgradeToOperationsOverlay', openUpgradeToOperationsOverlay);

Vue.watch(
  () => controller.chainProgress.isUpgradedToOperations,
  isUpgradedToOperations => {
    if (isUpgradedToOperations) openWelcomeIfApproved();
  },
);

Vue.onMounted(() => {
  void loadInvite();

  refreshInterval = setInterval(() => {
    void loadInvite();
  }, 5_000);
});

Vue.onBeforeUnmount(() => {
  basicEmitter.off('openUpgradeToOperationsOverlay', openUpgradeToOperationsOverlay);
  if (refreshInterval) {
    clearInterval(refreshInterval);
  }
});
</script>
