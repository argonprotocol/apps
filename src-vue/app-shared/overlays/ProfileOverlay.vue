<!-- prettier-ignore -->
<template>
  <OverlayBase :isOpen="isOpen" @close="closeOverlay" @esc="closeOverlay" class="w-6/12">
    <template #title>
      <div class="text-2xl font-bold inline-block relative">
        Your Profile
      </div>
    </template>

    <div class="flex flex-col w-full pt-3 pb-5 px-5 gap-x-5">
      <div v-if="!isLoaded">
        Loading...
      </div>

      <div v-else-if="!hasVault" class="text-center my-16 text-slate-700/50">
        You need to create a vault before setting up your profile.
      </div>

      <div v-else class="pt-2">
        <div v-if="errorMessage" class="mb-4 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
          {{ errorMessage }}
        </div>

        <p class="text-base font-light leading-6 text-slate-900">
          Set your Vault's name. This name will be visible to people as they search for vaults in Argon and in invites
          you send to family and friends.
        </p>

        <div class="mt-4">
          <label class="text-sm font-medium text-slate-700">Vault Name</label>
          <input
            v-model.trim="vaultName"
            type="text"
            maxlength="18"
            placeholder="ArgonFamilyVault"
            class="inner-input-shadow mt-2 w-full rounded-lg border border-slate-400/70 bg-white px-2.5 py-1.5 text-lg font-normal text-slate-700 placeholder:text-slate-300 outline-none transition focus:border-argon-500 focus:ring-2 focus:ring-argon-500/15"
          />
          <div class="mt-2 text-xs text-slate-500">
            Start with a capital letter and use up to 18 letters or numbers.
          </div>
        </div>

        <div v-if="setupTxInfo" class="mt-5">
          <div class="text-sm font-medium text-slate-700">Submitting your vault setup on Argon.</div>
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
import OverlayBase from './OverlayBase.vue';
import basicEmitter from '../../emitters/basicEmitter.ts';
import ProgressBar from '../../components/ProgressBar.vue';
import { useBasics } from '../../stores/basics.ts';
import { getMyVault } from '../../stores/vaults.ts';
import type { TransactionInfo } from '../../lib/TransactionInfo.ts';
import { generateProgressLabel } from '../../lib/Utils.ts';

const basics = useBasics();
const myVault = getMyVault();

const isOpen = Vue.ref(false);
const isLoaded = Vue.ref(false);
const isSaving = Vue.ref(false);
const errorMessage = Vue.ref('');
const vaultName = Vue.ref('');
const setupTxInfo = Vue.ref<TransactionInfo | null>(null);
const setupProgressPct = Vue.ref(0);
const setupProgressMessage = Vue.ref('');
const setupProgressError = Vue.ref<string | null>(null);

let unsubSetupProgress: (() => void) | undefined;

const hasVault = Vue.computed(() => {
  return !!myVault.createdVault?.vaultId;
});

async function load() {
  errorMessage.value = '';
  clearSetupProgress();

  try {
    await myVault.load();
    vaultName.value = myVault.createdVault?.name ?? '';
  } catch (error: any) {
    vaultName.value = '';
    errorMessage.value = error?.message ?? 'Unable to load your vault right now. Please try again.';
  }
}

async function saveProfile() {
  if (isSaving.value) return;

  const nextVaultName = vaultName.value.trim();
  isSaving.value = true;
  errorMessage.value = '';
  clearSetupProgress();

  try {
    await myVault.load();
    const createdVault = myVault.createdVault;
    if (!createdVault) {
      errorMessage.value = 'You need to create a vault before saving your profile.';
      return;
    }
    if (!nextVaultName) {
      errorMessage.value = 'Enter a vault name to continue.';
      return;
    }

    const txInfo = createdVault.bitcoinLockDelegateAccount
      ? await myVault.setVaultName(nextVaultName)
      : await myVault.setupVaultInviteProfile(nextVaultName);
    await waitForSetupTransaction(txInfo);

    if (txInfo) {
      void txInfo.txResult.waitForFinalizedBlock.then(() => myVault.load(true)).catch(() => null);
    }

    closeOverlay();
  } catch (error: any) {
    errorMessage.value = error?.message ?? 'Unable to save your profile right now. Please try again.';
  } finally {
    isSaving.value = false;
  }
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

  await txInfo.txResult.waitForInFirstBlock;
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
  basics.overlayIsOpen = false;
}

basicEmitter.on('openProfileOverlay', async () => {
  await load();
  isOpen.value = true;
  isLoaded.value = true;
  basics.overlayIsOpen = true;
});

Vue.onUnmounted(() => {
  clearSetupProgress();
});
</script>

<style scoped>
@reference "../../main.css";

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
