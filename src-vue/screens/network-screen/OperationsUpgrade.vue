<template>
  <div class="w-full max-w-2xl rounded-2xl border border-slate-200 bg-white/90 px-8 py-8 shadow-sm">
    <div class="text-3xl font-bold text-slate-800">Unlock Operations</div>

    <p v-if="canRequestUpgrade" class="mt-4 text-base leading-7 text-slate-500">
      Treasury certification is complete. Request approval from
      <strong class="font-semibold text-slate-700">{{ upstreamName }}</strong>
      to unlock mining and vaulting.
    </p>

    <div
      v-if="formError"
      class="mt-4 flex flex-row items-center gap-x-2 rounded-lg border border-red-400/50 bg-red-100 px-3 py-1.5 text-red-600"
    >
      <AlertIcon class="h-4 w-4 shrink-0" />
      <span>{{ formError }}</span>
    </div>

    <div v-else-if="registrationProgressLabel" class="mt-4 rounded-lg border border-slate-200 bg-white px-4 py-4">
      <div class="text-sm font-semibold text-slate-800">Submitting operations registration</div>
      <ProgressBar :progress="registrationProgressPct" :hasError="!!registrationProgressError" class="mt-3" />

      <div class="mt-3 text-sm text-slate-500">
        {{ registrationProgressLabel }}
      </div>

      <div
        v-if="registrationProgressError"
        class="mt-3 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700"
      >
        {{ registrationProgressError }}
      </div>
    </div>

    <div
      v-else-if="invite?.accessProof"
      class="border-argon-300/60 bg-argon-50 text-argon-700 mt-4 rounded-lg border px-3 py-2"
    >
      Your upstream approved operations access on {{ upgradedAtLabel }}.
    </div>

    <div
      v-else-if="invite?.operationsUpgradeRequestedAt"
      class="mt-4 rounded-lg border border-amber-300/60 bg-amber-50 px-3 py-2 text-amber-900"
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
</template>

<script setup lang="ts">
import * as Vue from 'vue';
import type { IMemberInvite } from '@argonprotocol/apps-router';
import dayjs from 'dayjs';
import AlertIcon from '../../assets/alert.svg?component';
import ProgressBar from '../../components/ProgressBar.vue';
import { supportsOperationalAccessProofRuntime } from '../../lib/OperationalAccount.ts';
import { getConfig } from '../../stores/config.ts';
import { treasuryCertificationStepIds, useCertificationController } from '../../stores/certificationController.ts';
import { getMainchainClient } from '../../stores/mainchain.ts';
import { getUpstreamOperatorClient } from '../../stores/upstreamOperator.ts';
import { getWalletKeys } from '../../stores/wallets.ts';

const config = getConfig();
const controller = useCertificationController();
const upstreamOperatorClient = getUpstreamOperatorClient();
const walletKeys = getWalletKeys();

const invite = Vue.ref<IMemberInvite | null>(null);
const isLoading = Vue.ref(true);
const isSubmitting = Vue.ref(false);
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

async function loadRegistrationProgress() {
  unsubscribeProgress?.();
  unsubscribeProgress = undefined;
  registrationProgressPct.value = 0;
  registrationProgressLabel.value = '';
  registrationProgressError.value = '';

  if (!invite.value?.accessProof || !supportsAccessProofRuntime.value) {
    return;
  }

  const txInfo = await controller.ensureOperationalRegistration();
  if (!txInfo) {
    return;
  }

  registrationProgressLabel.value = 'Preparing transaction...';
  unsubscribeProgress = txInfo.subscribeToProgress((args, error) => {
    registrationProgressPct.value = args.progressPct;
    registrationProgressLabel.value = args.progressMessage;
    registrationProgressError.value = error?.message ?? '';
  });
}

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
