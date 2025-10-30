<!-- prettier-ignore -->
<template>
  <div class="Panel VaultIsInstalling flex flex-col items-center justify-center px-[15%] h-full w-full pb-[10%]">
    <div>
      <VaultIcon class="w-36 block mb-3 mx-auto text-argon-800/80 pulse-animation" />
      <h1 class="mt-5 text-4xl font-bold text-center text-argon-600">Creating Your Vault</h1>

      <p v-if="errorMessage != ''" class="pt-3 font-light">
        There was an error setting up your vault: <span class="text-red-700">{{ errorMessage }}</span>
      </p>

      <p v-else class="pt-1 pb-2 font-light text-center opacity-70">
        {{ abbreviateAddress(config.vaultingAccount.address, 20) }}
      </p>

      <div class="flex flex-col w-140 pt-7">
        <ProgressBar
          :hasError="errorMessage != ''"
          :progress="setupProgressPct"
        />
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
const vault = useMyVault();
const currency = useCurrency();

const setupProgressPct = Vue.ref(0);
const errorMessage = Vue.ref('');

const vaultingRules = config.vaultingRules;
const isSecuritizingVault = Vue.ref(false);

async function createVault() {
  if (vault.createdVault) {
    setupProgressPct.value = 50;
    return;
  }

  const masterXpubPath = DEFAULT_MASTER_XPUB_PATH;
  console.log('Loading installing page', config.vaultingAccount.address);

  try {
    await vault.create({
      argonKeyring: Vue.toRaw(config.vaultingAccount),
      rules: config.vaultingRules,
      masterXpubPath,
      xprivSeed: Vue.toRaw(config.bitcoinXprivSeed),
      progressCallback(progress: number, message) {
        console.log(`Vault creation progress: Step ${progress} - ${message}`);
        setupProgressPct.value = progress / 2;
      },
    });
  } catch (error: any) {
    console.error('Error creating vault:', error);
    errorMessage.value = error.message || 'Unknown error occurred while creating vault.';
  }
  setupProgressPct.value = 50;
}

async function activateVault() {
  if (errorMessage.value) return;

  try {
    await currency.load();
    await vault.initialActivate({
      argonKeyring: config.vaultingAccount,
      bip39Seed: config.bitcoinXprivSeed,
      rules: vaultingRules,
      txProgressCallback(progress: number) {
        if (progress > 0) {
          isSecuritizingVault.value = true;
        }
        setupProgressPct.value = 50 + progress / 2;
      },
    });
    setupProgressPct.value = 100;
    config.isVaultActivated = true;
    void config.save();
    if (isSecuritizingVault.value) {
      setTimeout(() => (isSecuritizingVault.value = false), 60000);
    }
  } catch (error) {
    console.error('Error prebonding treasury pool:', error);
    errorMessage.value = error instanceof Error ? error.message : `${error}`;
  }
}

Vue.onMounted(async () => {
  await vault.load();
  await createVault();
  await activateVault();
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
