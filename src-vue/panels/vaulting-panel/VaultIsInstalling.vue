<!-- prettier-ignore -->
<template>
  <div class="Panel VaultIsInstalling flex flex-col items-center justify-center px-[15%] h-full w-full pb-[10%]">
    <div>
      <VaultIcon :class="errorMessage ? '' : 'pulse-animation'" class="w-36 block mb-3 mx-auto text-argon-800/80" />
      <h1 class="mt-5 text-4xl font-bold text-center text-argon-600">Creating Your Vault</h1>

      <p v-if="errorMessage != ''" class="pt-3 font-light w-140 text-center">
        There was an error setting up your vault: <span class="text-red-700">{{ errorMessage }}</span>
      </p>

      <p v-else class="pt-1 pb-2 font-light text-center opacity-70">
        {{ abbreviateAddress(config.vaultingAccount.address, 20) }}
      </p>

      <div class="flex flex-col w-140 pt-7">
        <ProgressBar
          :hasError="errorMessage != ''"
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
import { useConfig } from '../../stores/config';
import { useMyVault } from '../../stores/vaults.ts';
import ProgressBar from '../../components/ProgressBar.vue';
import { DEFAULT_MASTER_XPUB_PATH } from '../../lib/MyVault.ts';
import VaultIcon from '../../assets/vault.svg?component';
import { abbreviateAddress } from '../../lib/Utils.ts';
import { useCurrency } from '../../stores/currency.ts';

const config = useConfig();
const myVault = useMyVault();
const currency = useCurrency();

const progressPct = Vue.ref(0);
const errorMessage = Vue.ref('');

const vaultingRules = config.vaultingRules;
const blockConfirmations = Vue.ref(-1);

const progressLabel = Vue.computed(() => {
  const step = progressPct.value <= 50 ? 'Submitted Vault ' : 'Activated Funding';
  if (blockConfirmations.value === -1) {
    return `'${step}... Waiting for 1st Block...'`;
  } else if (blockConfirmations.value === 0) {
    return `${step}... Waiting for 2nd Block...`;
  } else if (blockConfirmations.value === 1) {
    return `${step}... Waiting for 3rd Block...`;
  } else if (blockConfirmations.value === 2) {
    return `${step}... Waiting for 4th Block...`;
  } else if (blockConfirmations.value === 3) {
    return `${step}... Waiting for 5th Block...`;
  } else if (blockConfirmations.value === 4) {
    return `${step}... Waiting for 6th Block...`;
  } else {
    return `${step}... Waiting for Finalization...`;
  }
});

async function createVault() {
  await myVault.load();

  if (myVault.createdVault) {
    progressPct.value = 50;
    void activateVault();
    return;
  }

  const masterXpubPath = DEFAULT_MASTER_XPUB_PATH;
  console.log('Loading installing page', config.vaultingAccount.address);

  try {
    const txInfo = await myVault.createNew({
      argonKeyring: Vue.toRaw(config.vaultingAccount),
      rules: config.vaultingRules,
      masterXpubPath,
      xprivSeed: Vue.toRaw(config.bitcoinXprivSeed),
    });

    txInfo.subscribeToProgress(
      (args: { progress: number; confirmations: number; isMaxed: boolean }, error: Error | undefined) => {
        const { progress, confirmations } = args;
        console.log(`Vault creation progress: Step ${progress}% - ${confirmations} confirmations`);
        blockConfirmations.value = confirmations;
        progressPct.value = progress / 2;
        if (progress === 100) {
          void activateVault();
        }
      },
    );
  } catch (error: any) {
    console.error('Error creating vault:', error);
    errorMessage.value = error.message || 'Unknown error occurred while creating vault.';
  }
}

async function activateVault() {
  if (errorMessage.value) return;

  try {
    console.log('Activating vault');
    await currency.load();
    const txInfo = await myVault.activateSecuritizationAndTreasury({
      argonKeyring: config.vaultingAccount,
      bip39Seed: config.bitcoinXprivSeed,
      rules: vaultingRules,
    });
    if (!txInfo) {
      void finalizeVault();
      return;
    }
    txInfo?.subscribeToProgress(
      (args: { progress: number; confirmations: number; isMaxed: boolean }, error: Error | undefined) => {
        const { progress, confirmations } = args;
        console.log(`Vault activation progress: Step ${progress}% - ${confirmations} confirmations`);
        blockConfirmations.value = confirmations;
        progressPct.value = 50 + progress / 2;
        if (progress === 100) {
          void finalizeVault();
        }
      },
    );
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
  await myVault.load();
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
