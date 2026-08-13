<!-- prettier-ignore -->
<template>
  <div DashBox data-testid="OnboardingIsInstalling" class="Screen VaultIsInstalling flex flex-col items-center justify-center px-[15%] h-full w-full pb-[10%]">
    <div>
      <OnboardingIcon :class="errorMessage ? '' : 'pulse-animation'" class="mx-auto mb-3 block h-28 text-argon-800/80" />
      <h1 class="mt-5 text-5xl font-bold text-center text-argon-600">Initializing Onboarding</h1>

      <p v-if="errorMessage != ''" class="mx-auto w-140 pt-3 text-center font-light">
        There was an error activating member onboarding: <span class="text-red-700">{{ errorMessage }}</span>
      </p>

      <div class="mx-auto flex w-140 flex-col pt-7">
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
import OnboardingIcon from '../../assets/onboarding.svg?component';
import ProgressBar from '../../components/ProgressBar.vue';
import { OnboardingSetupStatus } from '../../interfaces/IConfig.ts';
import { activateOperationalAccountSetup } from '../../lib/OperationalAccount.ts';
import { generateProgressLabel } from '../../lib/Utils.ts';
import { getConfig } from '../../stores/config.ts';
import { getMainchainClient } from '../../stores/mainchain.ts';
import { getTransactionTracker } from '../../stores/transactions.ts';
import { getMyVault } from '../../stores/vaults.ts';
import { getWalletKeys } from '../../stores/wallets.ts';

const props = defineProps<{
  operatorName?: string;
}>();

const config = getConfig();
const myVault = getMyVault();
const transactionTracker = getTransactionTracker();
const walletKeys = getWalletKeys();

const progressPct = Vue.ref(0);
const progressLabel = Vue.ref('Preparing your operator profile…');
const errorMessage = Vue.ref('');

let unsubscribeProgress: VoidFunction | undefined;

async function activateMemberOnboarding() {
  try {
    if (!config.isServerInstalled) {
      config.onboardingSetupStatus = OnboardingSetupStatus.Checklist;
      await config.save();
      return;
    }

    const client = await getMainchainClient(false);

    await activateOperationalAccountSetup({
      client,
      myVault,
      transactionTracker,
      walletKeys,
      operatorName: props.operatorName?.trim() ?? '',
      onTransaction: async transaction => {
        if (!transaction) {
          progressPct.value = 100;
          return;
        }

        unsubscribeProgress?.();
        unsubscribeProgress = transaction.subscribeToProgress((progress, error) => {
          progressPct.value = progress.progressPct;
          progressLabel.value = generateProgressLabel(progress.confirmations, progress.expectedConfirmations, {
            prefix: 'Submitted Member Onboarding',
            blockType: 'Argon',
          });
          errorMessage.value = error?.message ?? '';
        });
        await transaction.waitForPostProcessing;
      },
    });

    progressPct.value = 100;
    progressLabel.value = 'Member onboarding is active.';
    config.onboardingSetupStatus = OnboardingSetupStatus.Finished;
    await config.save();
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : 'Unable to activate member onboarding.';
  }
}

Vue.onMounted(activateMemberOnboarding);

Vue.onUnmounted(() => {
  unsubscribeProgress?.();
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
