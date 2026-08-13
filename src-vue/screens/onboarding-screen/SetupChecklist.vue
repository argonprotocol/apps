<!-- prettier-ignore -->
<template>
  <div DashBox class="relative flex h-full w-full flex-col">
    <button
      type="button"
      class="absolute top-3 left-5 z-10 flex cursor-pointer items-center gap-x-2 pb-3 pr-10 text-slate-400/50 hover:text-slate-600"
      @click="goBack"
    >
      <ArrowLeftIcon class="size-4" />
      Back to Beginning
      <span class="absolute bottom-0 left-0 h-px w-[200%] bg-gradient-to-r from-slate-400/30 from-0% via-slate-400/30 via-50% to-transparent to-100%" />
    </button>

    <div class="relative max-h-220 grow px-[15%] pt-2 pb-12">
      <div class="flex h-full grow flex-col" :class="{ 'pointer-events-none opacity-30': !isLoaded }">
        <h1 class="text-argon-text-primary mt-24 text-left text-4xl font-bold whitespace-nowrap">
          Set Up Member Onboarding
        </h1>

        <p class="text-argon-text-primary mt-6 mb-8 leading-7">
          Complete these steps before inviting members. Your Operator name identifies you in every invite, and your
          server handles the guided onboarding process.
        </p>

        <div class="h-px w-full bg-[#CCCEDA]" />

        <section class="flex grow cursor-pointer flex-row items-center py-5" @click="openServerConnectPanel">
          <div class="flex flex-row">
            <Checkbox :isChecked="config.isServerAdded" />
            <div class="px-4 text-slate-600">
              <h2 class="text-argon-600 relative inline-block text-2xl font-bold">Connect a Cloud Machine</h2>
              <p v-if="config.isServerInstalled">Your cloud machine is connected and ready for member onboarding.</p>
              <p v-else-if="config.isServerAdded">Your cloud machine is being prepared. Open it to check installation progress.</p>
              <p v-else>Connect the cloud machine that will host your operation and guide invited members through setup.</p>
            </div>
          </div>
        </section>

        <div class="h-px w-full bg-[#CCCEDA]" />

        <section class="flex grow cursor-pointer flex-row items-center py-5" @click="openOperatorProfile">
          <div class="flex flex-row">
            <Checkbox :isChecked="isValidOperatorName(operatorName)" />
            <div class="px-4 text-slate-600">
              <h2 class="text-argon-600 relative inline-block text-2xl font-bold">Set an Operator Name</h2>
              <p>
                <span v-if="isValidOperatorName(operatorName)" class="font-semibold opacity-100">{{ operatorName }}.</span>
                This name identifies you in onboarding invites to friends and family.
              </p>
            </div>
          </div>
        </section>

        <div class="h-px w-full bg-[#CCCEDA]" />

        <section class="flex grow flex-row items-center py-5">
          <div class="flex flex-row">
            <Checkbox :isChecked="hasRequiredOperation" />
            <div class="px-4 text-slate-600">
              <h2 class="text-argon-600 relative inline-block text-2xl font-bold">
                Create a Vault<template v-if="!usesOperationalProfile">*</template> or Win Mining Seats
              </h2>
              <p v-if="hasRequiredOperation">Your operation is ready to begin onboarding members.</p>
              <p v-else>
                Establish an operation by
                <button type="button" class="text-argon-600 cursor-pointer font-semibold hover:underline" @click="openVaulting">
                  creating a vault
                </button>
                or
                <button type="button" class="text-argon-600 cursor-pointer font-semibold hover:underline" @click="openMining">
                  winning mining seats
                </button>.
              </p>
              <p v-if="!usesOperationalProfile" class="text-xs">* currently required.</p>
            </div>
          </div>
        </section>

        <div class="h-px w-full bg-[#CCCEDA]" />

        <div v-if="errorMessage" class="mt-4 text-sm text-red-700">{{ errorMessage }}</div>

        <button
          type="button"
          :disabled="!canContinue"
          class="bg-argon-button border-argon-button-hover hover:bg-argon-button-hover mt-10 w-full cursor-pointer rounded-md border px-4 py-4 text-2xl font-bold text-white hover:inner-button-shadow disabled:pointer-events-none disabled:opacity-30"
          @click="activateOnboarding"
        >
          Activate Member Onboarding
        </button>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import * as Vue from 'vue';
import { getVaultByOperator } from '@argonprotocol/apps-core';
import { ArrowLeftIcon } from '@heroicons/vue/24/outline';
import Checkbox from '../../components/Checkbox.vue';
import basicEmitter from '../../emitters/basicEmitter.ts';
import { MiningSetupStatus, OnboardingSetupStatus, TopTab, VaultingSetupStatus } from '../../interfaces/IConfig.ts';
import {
  getOperationalProfileName,
  isValidOperatorName,
  loadOperationalAccount,
  usesOperationalProfileNameRuntime,
} from '../../lib/OperationalAccount.ts';
import { OperationalStepId, useCertificationController } from '../../stores/certificationController.ts';
import { getConfig } from '../../stores/config.ts';
import { getMainchainClient } from '../../stores/mainchain.ts';
import { getMyVault } from '../../stores/vaults.ts';
import { getWalletKeys } from '../../stores/wallets.ts';

const emit = defineEmits<{
  activate: [operatorName: string];
}>();

const config = getConfig();
const controller = useCertificationController();
const myVault = getMyVault();
const walletKeys = getWalletKeys();

const operatorName = Vue.ref('');
const usesOperationalProfile = Vue.ref(false);
const isLoaded = Vue.ref(false);
const errorMessage = Vue.ref('');

const hasVaultOrMiningSeats = Vue.computed(() => {
  return !!myVault.createdVault || controller.isCertificationStepComplete(OperationalStepId.FirstMiningSeat);
});

const hasRequiredOperation = Vue.computed(() => {
  return usesOperationalProfile.value ? hasVaultOrMiningSeats.value : !!myVault.createdVault;
});

const canContinue = Vue.computed(() => {
  return config.isServerInstalled && isValidOperatorName(operatorName.value) && hasRequiredOperation.value;
});

function activateOnboarding() {
  if (!canContinue.value) return;
  emit('activate', operatorName.value.trim());
}

function openServerConnectPanel() {
  basicEmitter.emit(config.isServerAdded ? 'openServerOverlay' : 'openServerConnectPanel');
}

function openOperatorProfile() {
  basicEmitter.emit('openOperationalProfileOverlay', {
    draftName: operatorName.value,
    onSelect: name => {
      operatorName.value = name;
    },
  });
}

function openVaulting() {
  if (config.vaultingSetupStatus === VaultingSetupStatus.None) {
    config.vaultingSetupStatus = VaultingSetupStatus.Checklist;
  }
  controller.setTab(TopTab.Vaulting);
}

function openMining() {
  if (config.miningSetupStatus === MiningSetupStatus.None) {
    config.miningSetupStatus = MiningSetupStatus.Checklist;
  }
  controller.setTab(TopTab.Mining);
}

function goBack() {
  config.onboardingSetupStatus = OnboardingSetupStatus.None;
  void config.save();
}

Vue.onMounted(async () => {
  try {
    const client = await getMainchainClient(false);
    usesOperationalProfile.value = usesOperationalProfileNameRuntime(client);

    await myVault.load();
    if (usesOperationalProfile.value) {
      operatorName.value = getOperationalProfileName(await loadOperationalAccount(walletKeys, client));
    } else {
      operatorName.value = myVault.createdVault?.name ?? '';
      if (!operatorName.value) {
        const ownedVault = await getVaultByOperator({
          client,
          operatorAddress: walletKeys.vaultingAddress,
        });
        operatorName.value = ownedVault?.name ?? '';
      }
    }
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : 'Unable to load your operation right now.';
  } finally {
    isLoaded.value = true;
  }
});
</script>

<style scoped>
@reference "../../main.css";

section:hover {
  background: linear-gradient(to right, transparent 0%, #f7edf8 10%, #f7edf8 90%, transparent 100%);
}

section p {
  @apply mt-1 ml-0.5 opacity-60;
}
</style>
