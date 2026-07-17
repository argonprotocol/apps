<!-- prettier-ignore -->
<template>
  <OverlayBase
    :isOpen="isOpen"
    @close="closeOverlay"
    @pressEsc="closeOverlay"
    class="w-7/12"
  >
    <template #title>
      <div class="grow text-2xl font-bold">Upgrade to Operations</div>
    </template>

    <div class="px-10 pb-8">
      <p v-if="canRequestUpgrade" class="mt-3 text-base leading-6 text-slate-500">
        Treasury certification is complete. Request approval from
        <strong class="font-semibold text-slate-700">{{ upstreamName }}</strong>
        to unlock mining and vaulting.
      </p>

      <div v-if="formError" class="mt-4 flex flex-row items-center gap-x-2 text-sm text-red-600">
        <AlertIcon class="h-4 w-4 shrink-0" />
        <span>{{ formError }}</span>
      </div>

      <div v-else-if="registrationProgressLabel" class="mt-5 border-t border-slate-200 pt-4">
        <div class="text-sm font-semibold text-slate-800">Completing operations upgrade</div>
        <ProgressBar :progress="registrationProgressPct" :hasError="!!registrationProgressError" class="mt-3" />

        <div class="mt-3 text-sm text-slate-500">
          {{ registrationProgressLabel }}
        </div>

        <div v-if="registrationProgressError" class="mt-3 text-sm text-red-600">
          <div>{{ registrationProgressError }}</div>

          <button
            type="button"
            :disabled="isRegistering"
            class="border-argon-600 text-argon-600 mt-2 rounded border px-3 py-1.5 text-sm font-semibold disabled:cursor-default disabled:opacity-50"
            @click="loadRegistrationProgress"
          >
            {{ isRegistering ? 'Completing...' : 'Try Again' }}
          </button>
        </div>
      </div>

      <div v-else-if="invite?.accessProof" class="border-argon-300 mt-5 border-l-2 pl-3 text-sm text-slate-600">
        Your upstream approved operations access on {{ upgradedAtLabel }}.
      </div>

      <div
        v-else-if="invite?.operationsUpgradeRequestedAt"
        class="border-argon-300 mt-5 border-l-2 pl-3 text-sm text-slate-600"
      >
        Upgrade requested on {{ requestedAtLabel }}. We’re waiting for your upstream to approve.
      </div>

      <button
        v-else-if="canRequestUpgrade"
        type="button"
        :disabled="isLoading || isSubmitting"
        class="bg-argon-button hover:bg-argon-button-hover mt-6 rounded-lg px-5 py-2.5 text-sm font-semibold text-white disabled:cursor-default disabled:opacity-50"
        @click="requestUpgrade"
      >
        <template v-if="isSubmitting">Requesting Upgrade...</template>
        <template v-else-if="isLoading">Loading...</template>
        <template v-else>Request Operations Upgrade</template>
      </button>
    </div>
  </OverlayBase>
</template>

<script setup lang="ts">
import * as Vue from 'vue';
import type { IMemberInvite } from '@argonprotocol/apps-router';
import dayjs from 'dayjs';
import {
  ensureOperationalAccountRegistered,
  supportsOperationalAccessProofRuntime,
} from '../lib/OperationalAccount.ts';
import { getConfig } from '../stores/config.ts';
import { treasuryCertificationStepIds, useCertificationController } from '../stores/certificationController.ts';
import { getMainchainClient } from '../stores/mainchain.ts';
import { getTransactionTracker } from '../stores/transactions.ts';
import { getUpstreamOperatorClient } from '../stores/upstreamOperator.ts';
import { getWalletKeys, useWallets } from '../stores/wallets.ts';
import OverlayBase from './OverlayBase.vue';
import AlertIcon from '../assets/alert.svg';
import ProgressBar from '../components/ProgressBar.vue';
import basicEmitter from '../emitters/basicEmitter.ts';

const config = getConfig();
const controller = useCertificationController();
const upstreamOperatorClient = getUpstreamOperatorClient();
const transactionTracker = getTransactionTracker();
const walletKeys = getWalletKeys();
const wallets = useWallets();

const isOpen = Vue.ref(false);
const invite = Vue.ref<IMemberInvite | null>(null);
const isLoading = Vue.ref(true);
const isSubmitting = Vue.ref(false);
const isRegistering = Vue.ref(false);
const formError = Vue.ref('');
const supportsAccessProofRuntime = Vue.ref(false);
const registrationProgressPct = Vue.ref(0);
const registrationProgressLabel = Vue.ref('');
const registrationProgressError = Vue.ref('');

let refreshInterval: ReturnType<typeof setInterval> | undefined;
let unsubscribeProgress: (() => void) | undefined;

const upstreamName = Vue.computed(() => {
  return invite.value?.fromName || config.upstreamOperator?.name || 'your upstream operator';
});

const isEligibleForUpgrade = Vue.computed(() => {
  return (
    config.hasExtensionTreasury &&
    !controller.chainProgress.isUpgradedToOperations &&
    controller.completedTreasuryCertificationStepCount === treasuryCertificationStepIds.length
  );
});

const canRequestUpgrade = Vue.computed(() => {
  if (!isEligibleForUpgrade.value) {
    return false;
  }

  if (invite.value?.operationsUpgradeRequestedAt || invite.value?.accessProof || invite.value?.operationsUpgradedAt) {
    return false;
  }

  return true;
});

const requestedAtLabel = Vue.computed(() => {
  if (!invite.value?.operationsUpgradeRequestedAt) return '';
  return dayjs.utc(invite.value.operationsUpgradeRequestedAt).local().format('M/D/YYYY [at] h:mm a');
});

const upgradedAtLabel = Vue.computed(() => {
  if (!invite.value?.operationsUpgradedAt) return '';
  return dayjs.utc(invite.value.operationsUpgradedAt).local().format('M/D/YYYY [at] h:mm a');
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

    config.setCertificationDetails({ dismissedOperationsUpgradeOverlay: true });
    void config.save();

    if (invite.value) {
      invite.value = {
        ...invite.value,
        operationsUpgradeRequestedAt,
      };
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
    const client = await getMainchainClient(false);
    supportsAccessProofRuntime.value = supportsOperationalAccessProofRuntime(client);
    invite.value = await upstreamOperatorClient.getMemberInvite();
    await loadRegistrationProgress();
  } catch (error) {
    formError.value =
      error instanceof Error && error.message ? error.message : 'Unable to load your upstream member record right now.';
  } finally {
    isLoading.value = false;
  }
}

function closeOverlay() {
  isOpen.value = false;
}

async function loadRegistrationProgress() {
  if (!invite.value?.accessProof || !supportsAccessProofRuntime.value || isRegistering.value) {
    return;
  }

  unsubscribeProgress?.();
  unsubscribeProgress = undefined;
  registrationProgressPct.value = 0;
  registrationProgressLabel.value = 'Preparing transaction...';
  registrationProgressError.value = '';
  isRegistering.value = true;

  try {
    const txInfo = await ensureOperationalAccountRegistered({
      transactionTracker,
      walletKeys,
      accessProof: invite.value.accessProof,
      availableMicrogons: wallets.defaultArgonWallet.availableMicrogons,
    });
    if (!txInfo) {
      registrationProgressLabel.value = '';
      return;
    }

    unsubscribeProgress = txInfo.subscribeToProgress((args, error) => {
      registrationProgressPct.value = args.progressPct;
      registrationProgressLabel.value = args.progressMessage;
      registrationProgressError.value = error?.message ?? '';

      if (error || args.progressPct >= 100) {
        isRegistering.value = false;
      }
    });
  } catch (error) {
    registrationProgressLabel.value = 'Upgrade needs attention';
    registrationProgressError.value =
      error instanceof Error && error.message ? error.message : 'Unable to complete the operations upgrade right now.';
  } finally {
    if (!unsubscribeProgress) {
      isRegistering.value = false;
    }
  }
}

basicEmitter.on('openUpgradeToOperationsOverlay', () => {
  isOpen.value = true;
});

Vue.watch(
  () => controller.chainProgress.isUpgradedToOperations,
  isUpgradedToOperations => {
    if (!isUpgradedToOperations) {
      return;
    }

    unsubscribeProgress?.();
    unsubscribeProgress = undefined;
  },
);

Vue.onMounted(() => {
  void loadInvite();

  refreshInterval = setInterval(() => {
    void loadInvite();
  }, 5_000);
});

Vue.onBeforeUnmount(() => {
  if (refreshInterval) {
    clearInterval(refreshInterval);
  }

  unsubscribeProgress?.();
});
</script>
