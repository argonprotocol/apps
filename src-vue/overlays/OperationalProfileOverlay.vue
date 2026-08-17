<!-- prettier-ignore -->
<template>
  <OverlayBase
    :isOpen="isOpen"
    :showGoBack="currentScreen === 'name' && openedFromSettings"
    @close="closeOverlay"
    @pressEsc="closeOverlay"
    @goBack="currentScreen = 'settings'"
    class="w-6/12"
  >
    <template #title>
      <div class="text-2xl font-bold inline-block relative">
        {{ currentScreen === 'settings' ? 'Onboarding Settings' : 'Your Operational Profile' }}
      </div>
    </template>

    <div v-if="currentScreen === 'settings'" class="px-6 py-5 text-base text-slate-700">
      <button
        type="button"
        class="hover:text-argon-600 hover:to-argon-menu-hover/70 flex w-full cursor-pointer items-center justify-between rounded-md py-4 text-left hover:bg-gradient-to-r hover:from-transparent"
        @click="openOperationsName"
      >
        <span class="flex items-center">
          <OnboardingIcon class="mr-2 size-5 opacity-70" />
          Operations Name
        </span>
        <span class="text-sm text-slate-500">{{ controller.operatorName || 'Not set' }}</span>
      </button>

      <template v-if="supportsFlexibleAssets">
        <div class="my-4 border-t border-dashed border-slate-300" />
        <button
          type="button"
          class="hover:text-argon-600 hover:to-argon-menu-hover/70 flex w-full cursor-pointer items-center justify-between rounded-md py-4 text-left hover:bg-gradient-to-r hover:from-transparent"
          @click="
            closeOverlay();
            basicEmitter.emit('openFlexibleAssetsOverlay', { returnTo: 'onboardingSettings' });
          "
        >
          <span class="flex items-center">
            <ArrowsUpDownIcon class="mr-2 size-5 opacity-70" />
            Flexible Assets
          </span>
          <span class="text-sm text-slate-500">Manage</span>
        </button>
      </template>
    </div>

    <div v-else class="flex flex-col w-full pt-3 pb-5 px-5 gap-x-5">
      <div v-if="!isLoaded">
        Loading...
      </div>

      <div v-else-if="requiresVault && !hasVault" class="text-center my-16 text-slate-700/50">
        You need to create a vault before setting up your profile.
      </div>

      <div v-else class="pt-2">
        <div v-if="errorMessage" class="mb-4 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
          {{ errorMessage }}
        </div>

        <p class="text-base font-light leading-6 text-slate-900">
          This name identifies you in onboarding invites to friends and family.
        </p>

        <div class="mt-4">
          <label class="text-sm font-medium text-slate-700">Operator Name</label>
          <input
            :value="operatorName"
            @input="handleOperatorNameInput"
            type="text"
            maxlength="18"
            placeholder="ArgonFamily"
            class="inner-input-shadow mt-2 w-full rounded-lg border border-slate-400/70 bg-white px-2.5 py-1.5 text-lg font-normal text-slate-700 placeholder:text-slate-300 outline-none transition focus:border-argon-500 focus:ring-2 focus:ring-argon-500/15"
          />
          <div class="mt-2 text-xs text-slate-500">
            Start with a capital letter and use up to 18 letters or numbers (no spaces or "Vault").
          </div>
          <div v-if="operatorNameInputNotice" class="mt-1 text-xs text-red-600">
            {{ operatorNameInputNotice }}
          </div>
        </div>

        <div v-if="setupTxInfo" class="mt-5">
          <div class="text-sm font-medium text-slate-700">Submitting your Operator profile on Argon.</div>
          <div class="mt-3">
            <ProgressBar :progress="setupProgressPct" :hasError="!!setupProgressError" />
          </div>
          <div class="mt-2 text-xs text-slate-500">
            {{ setupProgressMessage }}
          </div>
          <div v-if="setupProgressError" class="mt-3 text-sm text-red-700">
            {{ setupProgressError }}
          </div>
        </div>

        <div class="mt-5 flex justify-end gap-3">
          <button
            @click="closeOverlay"
            class="cursor-pointer rounded-md border border-argon-600/20 bg-white px-6 py-2 font-bold text-argon-600 inner-button-shadow hover:bg-argon-600/10 focus:outline-none"
          >
            Cancel
          </button>
          <button
            @click="saveProfile"
            :disabled="isSaving"
            class="cursor-pointer rounded-md border border-argon-button-hover bg-argon-button px-6 py-2 font-bold text-white inner-button-shadow hover:bg-argon-button-hover focus:outline-none disabled:cursor-default disabled:opacity-60"
          >
            {{ isSaving ? 'Saving...' : 'Save' }}
          </button>
        </div>
      </div>
    </div>
  </OverlayBase>
</template>

<script setup lang="ts">
import * as Vue from 'vue';
import { ArrowsUpDownIcon } from '@heroicons/vue/24/outline';
import OnboardingIcon from '../assets/onboarding.svg?component';
import OverlayBase from './OverlayBase.vue';
import basicEmitter, { type IOperationalProfileRequest } from '../emitters/basicEmitter.ts';
import ProgressBar from '../components/ProgressBar.vue';
import {
  getOperationalProfileName,
  isValidOperatorName,
  loadOperationalAccount,
  setOperationalProfileName,
  usesOperationalProfileNameRuntime,
} from '../lib/OperationalAccount.ts';
import { useBasics } from '../stores/basics.ts';
import { useCertificationController } from '../stores/certificationController.ts';
import { getMainchainClient } from '../stores/mainchain.ts';
import { getTransactionTracker } from '../stores/transactions.ts';
import { getMyVault } from '../stores/vaults.ts';
import { getWalletKeys } from '../stores/wallets.ts';
import type { TransactionInfo } from '../lib/TransactionInfo.ts';
import {
  generateProgressLabel,
  getOperatorNameInputNotice,
  normalizeOperatorNameInput,
  OPERATOR_NAME_REQUIREMENTS,
} from '../lib/Utils.ts';
import { MyVault, supportsFlexibleAssetsRuntime } from '../lib/MyVault.ts';

const basics = useBasics();
const controller = useCertificationController();
const myVault = getMyVault();
const transactionTracker = getTransactionTracker();
const walletKeys = getWalletKeys();

const isOpen = Vue.ref(false);
const isLoaded = Vue.ref(false);
const isSaving = Vue.ref(false);
const errorMessage = Vue.ref('');
const operatorName = Vue.ref('');
const operatorNameInputNotice = Vue.ref('');
const requiresVault = Vue.ref(true);
const setupTxInfo = Vue.ref<TransactionInfo | null>(null);
const setupProgressPct = Vue.ref(0);
const setupProgressMessage = Vue.ref('');
const setupProgressError = Vue.ref<string | null>(null);
const currentScreen = Vue.ref<'settings' | 'name'>('name');
const openedFromSettings = Vue.ref(false);
const supportsFlexibleAssets = Vue.ref(false);

let unsubSetupProgress: (() => void) | undefined;
let selectDraftName: ((operatorName: string) => void) | undefined;
let openRequestId = 0;

const hasVault = Vue.computed(() => {
  return !!myVault.createdVault?.vaultId;
});

async function load(request?: IOperationalProfileRequest) {
  const profileRequest = request && 'draftName' in request ? request : undefined;
  errorMessage.value = '';
  operatorNameInputNotice.value = '';
  clearSetupProgress();
  selectDraftName = profileRequest?.onSelect;

  try {
    const client = await getMainchainClient(false);
    requiresVault.value = !usesOperationalProfileNameRuntime(client);

    if (requiresVault.value) {
      await myVault.load();
      operatorName.value = profileRequest?.draftName || myVault.createdVault?.name || '';
    } else {
      const savedName = getOperationalProfileName(await loadOperationalAccount(walletKeys, client));
      operatorName.value = profileRequest?.draftName || savedName;
    }
  } catch (error) {
    operatorName.value = profileRequest?.draftName ?? '';
    errorMessage.value = error instanceof Error ? error.message : 'Unable to load your profile right now.';
  }
}

async function openOperationsName() {
  currentScreen.value = 'name';
  isLoaded.value = false;
  await load();
  isLoaded.value = true;
}

async function saveProfile() {
  if (isSaving.value) return;

  const nextOperatorName = operatorName.value.trim();
  errorMessage.value = '';
  clearSetupProgress();

  if (!nextOperatorName) {
    errorMessage.value = 'Enter an Operator name to continue.';
    return;
  }
  if (!isValidOperatorName(nextOperatorName)) {
    errorMessage.value = OPERATOR_NAME_REQUIREMENTS;
    return;
  }
  if (selectDraftName) {
    selectDraftName(nextOperatorName);
    closeOverlay();
    return;
  }

  isSaving.value = true;

  try {
    const client = await getMainchainClient(false);
    let txInfo: TransactionInfo | undefined;
    if (usesOperationalProfileNameRuntime(client)) {
      txInfo = await setOperationalProfileName({ transactionTracker, walletKeys, name: nextOperatorName, client });
    } else {
      await myVault.load();
      const createdVault = myVault.createdVault;
      if (!createdVault) {
        throw new Error('You need to create a vault before saving your profile.');
      }
      const delegateAddress = await walletKeys.getVaultDelegateKeypair().then(keypair => keypair.address);
      const delegateIsReady = await MyVault.isVaultDelegateReady(client, createdVault, delegateAddress);
      txInfo = delegateIsReady
        ? await myVault.setVaultName(nextOperatorName)
        : await myVault.setupVaultInviteProfile({ operatorName: nextOperatorName });
    }
    await waitForSetupTransaction(txInfo);
    controller.operatorName = nextOperatorName;

    closeOverlay();
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : 'Unable to save your profile right now.';
  } finally {
    isSaving.value = false;
  }
}

function handleOperatorNameInput(event: Event) {
  const input = event.currentTarget as HTMLInputElement;
  const enteredName = input.value;
  const nextOperatorName = normalizeOperatorNameInput(input.value);

  operatorNameInputNotice.value = getOperatorNameInputNotice(enteredName, nextOperatorName);
  operatorName.value = nextOperatorName;
  input.value = nextOperatorName;
}

async function waitForSetupTransaction(txInfo?: TransactionInfo) {
  if (!txInfo) {
    return;
  }

  setupTxInfo.value = txInfo;
  setupProgressMessage.value = 'Submitting to Argon...';
  unsubSetupProgress = txInfo.subscribeToProgress((args, error) => {
    setupProgressPct.value = args.progressPct;
    setupProgressMessage.value = generateProgressLabel(args.confirmations, args.expectedConfirmations, {
      blockType: 'Argon',
    });

    if (error) {
      setupProgressError.value = error.message ?? 'Transaction failed.';
    }
  });

  await txInfo.waitForPostProcessing;
  clearSetupProgress();
}

function clearSetupProgress() {
  unsubSetupProgress?.();
  unsubSetupProgress = undefined;
  setupTxInfo.value = null;
  setupProgressPct.value = 0;
  setupProgressMessage.value = '';
  setupProgressError.value = null;
}

function closeOverlay() {
  isOpen.value = false;
  selectDraftName = undefined;
  basics.overlayIsOpen = false;
}

async function openOperationalProfileOverlay(request: void | IOperationalProfileRequest) {
  const requestId = ++openRequestId;
  openedFromSettings.value = !!request && 'screen' in request;
  currentScreen.value = openedFromSettings.value ? 'settings' : 'name';
  if (openedFromSettings.value) {
    const client = await getMainchainClient(false);
    supportsFlexibleAssets.value = supportsFlexibleAssetsRuntime(client);
  } else {
    await load(request || undefined);
  }
  // Runtime compatibility can unmount this global overlay while the profile load is pending.
  if (requestId !== openRequestId) return;
  isOpen.value = true;
  isLoaded.value = true;
  basics.overlayIsOpen = true;
}

basicEmitter.on('openOperationalProfileOverlay', openOperationalProfileOverlay);

Vue.onUnmounted(() => {
  openRequestId += 1;
  basicEmitter.off('openOperationalProfileOverlay', openOperationalProfileOverlay);
  clearSetupProgress();
});
</script>

<style scoped>
@reference "../main.css";

table {
  @apply text-md mt-6 font-mono;
  thead {
    @apply font-bold uppercase;
  }
  td {
    @apply border-b border-slate-400/30 py-3;
  }
}

span[tag] {
  @apply ml-1 rounded-full px-2 text-xs font-bold text-white uppercase;
}

.fade-in-out {
  animation: fadeInOut 1s ease-in-out infinite;
  animation-delay: 0s;
}

@keyframes fadeInOut {
  0% {
    opacity: 0.3;
  }
  50% {
    opacity: 1;
  }
  100% {
    opacity: 0.3;
  }
}
</style>
