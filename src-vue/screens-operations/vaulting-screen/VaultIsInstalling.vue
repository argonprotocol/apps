<!-- prettier-ignore -->
<template>
  <div class="Screen VaultIsInstalling flex flex-col items-center justify-center px-[15%] h-full w-full pb-[10%]">
    <div>
      <VaultIcon :class="errorMessage ? '' : 'pulse-animation'" class="w-36 block mb-3 mx-auto text-argon-800/80" />
      <h1 class="mt-5 text-4xl font-bold text-center text-argon-600">Creating Your Vault</h1>

      <p v-if="errorMessage != ''" class="pt-3 font-light w-140 text-center">
        There was an error setting up your vault: <span class="text-red-700">{{ errorMessage }}</span>
      </p>

      <p v-else class="pt-1 pb-2 font-light text-center opacity-70">
        {{ abbreviateAddress(walletKeys.vaultingAddress, 20) }}
      </p>

      <div class="flex flex-col w-140 pt-7">
        <ProgressBar
          :hasError="errorMessage !== ''"
          :progress="progressPct"
        />
        <div class="text-gray-500 text-center font-light mt-3">
          {{progressLabel}}
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import * as Vue from 'vue';
import { getConfig } from '../../stores/config';
import { getMyVault } from '../../stores/vaults.ts';
import ProgressBar from '../../components/ProgressBar.vue';
import { DEFAULT_MASTER_XPUB_PATH } from '../../lib/MyVault.ts';
import VaultIcon from '../../assets/vault.svg?component';
import { abbreviateAddress, generateProgressLabel } from '../../lib/Utils.ts';
import { getCurrency } from '../../stores/currency.ts';
import { getWalletKeys } from '../../stores/wallets.ts';

const config = getConfig();
const walletKeys = getWalletKeys();
const myVault = getMyVault();

const progressPct = Vue.ref(0);
const errorMessage = Vue.ref('');

const vaultingRules = config.vaultingRules;
const blockConfirmations = Vue.ref(-1);

let expectedConfirmations = 0;

const progressLabel = Vue.computed(() => {
  const prefix = progressPct.value <= 50 ? 'Submitted Vault ' : 'Activated Funding';
  return generateProgressLabel(blockConfirmations.value, expectedConfirmations, {
    prefix,
    blockType: 'Argon',
  });
});

async function createVault() {
  await myVault.load();

  if (myVault.createdVault) {
    progressPct.value = 50;
    void activateVault();
    return;
  }

  const masterXpubPath = DEFAULT_MASTER_XPUB_PATH;

  try {
    const txInfo = await myVault.createNew({
      rules: config.vaultingRules,
      masterXpubPath,
    });

    txInfo.subscribeToProgress(
      (
        args: { progressPct: number; confirmations: number; expectedConfirmations: number },
        error: Error | undefined,
      ) => {
        console.log(`Vault creation progress: Step ${args.progressPct}% - ${args.confirmations} confirmations`);
        blockConfirmations.value = args.confirmations;
        progressPct.value = args.progressPct / 2;
        expectedConfirmations = args.expectedConfirmations;
        if (error) {
          console.error('Error creating vault:', error);
          errorMessage.value = error.message || 'Unknown error occurred while creating vault.';
        }
      },
    );
    void txInfo.waitForPostProcessing.then(activateVault);
  } catch (error: any) {
    console.error('Error creating vault:', error);
    errorMessage.value = error.message || 'Unknown error occurred while creating vault.';
  }
}

async function activateVault() {
  if (errorMessage.value) return;

  try {
    console.log('Activating vault');
    const txInfo = await myVault.activateSecuritizationAndTreasury({
      rules: vaultingRules,
    });
    if (!txInfo) {
      void finalizeVault();
      return;
    }
    txInfo.subscribeToProgress(
      (
        args: { progressPct: number; confirmations: number; expectedConfirmations: number },
        error: Error | undefined,
      ) => {
        console.log(`Vault activation progress: Step ${args.progressPct}% - ${args.confirmations} confirmations`);
        blockConfirmations.value = args.confirmations;
        progressPct.value = 50 + args.progressPct / 2;
        expectedConfirmations = args.expectedConfirmations;
        if (error) {
          console.error('Error activating vault:', error);
          errorMessage.value = error.message || 'Unknown error occurred while activating vault.';
        }
      },
    );
    void txInfo.waitForPostProcessing.then(finalizeVault);
  } catch (error) {
    console.error('Error prebonding treasury pool:', error);
    errorMessage.value = error instanceof Error ? error.message : `${error}`;
  }
}

function finalizeVault() {
  progressPct.value = 100;
  config.isVaultActivated = true;
  void config.save();
}

Vue.onMounted(async () => {
  await createVault();
});
</script>

<style scoped>
.pulse-animation {
  animation: pulse 1.5s ease-in-out infinite;
  transform-origin: center bottom;
}

@keyframes pulse {
  0%,
  100% {
    opacity: 0.8;
    transform: scale(1);
  }
  50% {
    opacity: 1;
    transform: scale(1.05);
  }
}
</style>
