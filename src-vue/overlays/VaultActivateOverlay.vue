<template>
  <Overlay :isOpen="true" @close="cancelOverlay" @esc="cancelOverlay" title="Activate Unused Argons">
    <div box class="flex flex-col px-5 pt-6 pb-3">
      <template v-if="isSubmitted == false">
        <p>
          You have {{ microgonToArgonNm(microgonsToActivate).format('0,0.[00]') }} unused argons that are ready to
          activate. We've divided them between bitcoin security and treasury bonds based on your current config values,
          however, you can adjust below.
        </p>

        <div class="mt-5 flex flex-col gap-x-5">
          <div class="flex grow flex-col space-y-1">
            <label class="font-bold opacity-40">Allocate to Bitcoin Security</label>
            <div class="flex w-full flex-row items-center gap-x-2">
              <div class="w-7/12">
                <InputArgon
                  v-model="securitizationAmount"
                  @update:modelValue="handleBitcoinSecurityChange"
                  :maxDecimals="8"
                  :min="0n"
                  :max="maxSecuritizationAmount"
                  :dragBy="1_000_000n"
                  :dragByMin="1_000n"
                  class="px-1 py-2" />
              </div>
              <div class="py-2 opacity-50">=</div>
              <div class="py-2 opacity-50">{{ numeral(securitizationPct).format('0,0.[00]') }}%</div>
            </div>
          </div>
          <div class="mt-5 flex grow flex-col space-y-1">
            <label class="font-bold opacity-40">Allocate to Treasury Bonds</label>
            <div class="flex w-full flex-row items-center gap-x-2">
              <div class="w-7/12">
                <InputArgon
                  v-model="treasuryAmount"
                  @update:modelValue="handleTreasuryBondsChange"
                  :maxDecimals="0"
                  :min="0n"
                  :max="maxTreasuryAmount"
                  :dragBy="1_000_000n"
                  :dragByMin="1_000n"
                  class="px-1 py-2" />
              </div>
              <div class="py-2 opacity-50">=</div>
              <div class="py-2 opacity-50">{{ numeral(treasuryPct).format('0,0.[00]') }}%</div>
            </div>
          </div>
        </div>

        <div class="mt-10 flex flex-row items-center justify-end gap-x-3 border-t border-black/20 pt-4">
          <button
            class="cursor-pointer rounded-lg bg-gray-200 px-10 py-2 text-lg font-bold text-black hover:bg-gray-300"
            @click="cancelOverlay"
            :disabled="isSubmitted">
            Cancel
          </button>
          <button
            class="cursor-pointer rounded-lg px-10 py-2 text-lg font-bold text-white"
            :class="[isSubmitted ? 'bg-argon-600/60' : 'bg-argon-600 hover:bg-argon-700']"
            :disabled="isSubmitted"
            @click="finalizeActivation">
            <template v-if="isSubmitted">Finalizing...</template>
            <template v-else>Finalize Activation</template>
          </button>
        </div>
      </template>
      <div v-if="transactionError" class="flex flex-col px-5 pt-6 pb-3">
        <div class="flex flex-row items-center justify-center">
          <div class="flex flex-col items-center justify-center">
            <div class="text-2xl font-bold">Error</div>
            <div class="text-sm text-gray-500">{{ transactionError }}</div>
          </div>
        </div>
      </div>

      <div v-if="isSubmitted" class="flex flex-col space-y-5 px-28 pt-10 pb-20">
        <p class="font-light text-gray-700">
          Your request to activate {{ microgonToArgonNm(microgonsToActivate).format('0,0.[00]') }} unused argons has
          been submitted to the Argon network and is now awaiting finalization. This process usually takes four to five
          minutes to complete.
        </p>

        <p class="mb-2 font-light italic opacity-80">
          NOTE: You can close this overlay without disrupting the process.
        </p>

        <div class="mt-10">
          <div class="fade-progress text-center text-5xl font-bold">{{ numeral(progressPct).format('0.00') }}%</div>
        </div>

        <ProgressBar :progress="progressPct" :showLabel="false" class="h-4" />
        <div class="text-center font-light text-gray-500">
          {{ progressLabel }}
        </div>
      </div>
    </div>
  </Overlay>
</template>

<script setup lang="ts">
import * as Vue from 'vue';
import { toRaw } from 'vue';
import dayjs from 'dayjs';
import utc from 'dayjs/plugin/utc';
import InputArgon from '../components/InputArgon.vue';
import Overlay from './Overlay.vue';
import { useMyVault } from '../stores/vaults.ts';
import numeral, { createNumeralHelpers } from '../lib/numeral.ts';
import { useCurrency } from '../stores/currency.ts';
import { useConfig } from '../stores/config.ts';
import { useWallets } from '../stores/wallets.ts';
import { bigIntMax, JsonExt } from '@argonprotocol/apps-core';
import BigNumber from 'bignumber.js';
import { MyVault } from '../lib/MyVault.ts';
import ProgressBar from '../components/ProgressBar.vue';

dayjs.extend(utc);

const config = useConfig();
const currency = useCurrency();
const myVault = useMyVault();
const wallets = useWallets();

const { microgonToArgonNm } = createNumeralHelpers(currency);
const emit = defineEmits<{
  (e: 'close', shouldFinishLocking: boolean): void;
}>();

const isSubmitted = Vue.ref(false);

const microgonsToActivate = Vue.ref(
  bigIntMax(wallets.vaultingWallet.availableMicrogons - MyVault.OperationalReserves, 0n),
);

const securitizationAmount = Vue.ref(0n);
const securitizationPct = Vue.computed(() => {
  return BigNumber(securitizationAmount.value).div(microgonsToActivate.value).toNumber() * 100;
});
const maxSecuritizationAmount = Vue.computed(() => {
  return wallets.vaultingWallet.availableMicrogons - securitizationAmount.value;
});

const treasuryAmount = Vue.ref(0n);
const treasuryPct = Vue.computed(() => {
  return BigNumber(treasuryAmount.value).div(microgonsToActivate.value).toNumber() * 100;
});
const maxTreasuryAmount = Vue.computed(() => {
  return wallets.vaultingWallet.availableMicrogons - treasuryAmount.value;
});

async function handleBitcoinSecurityChange(microgons: bigint) {
  securitizationAmount.value = microgons;
}

async function handleTreasuryBondsChange(microgons: bigint) {
  treasuryAmount.value = microgons;
}

const vault = useMyVault();

const progressPct = Vue.ref(0);
const blockConfirmations = Vue.ref(-1);
const transactionError = Vue.ref('');

let expectedConfirmations = 0;

const progressLabel = Vue.computed(() => {
  if (blockConfirmations.value === -1) {
    return 'Waiting for 1st Block...';
  } else if (blockConfirmations.value === 0 && expectedConfirmations > 0) {
    return 'Waiting for 2nd Block...';
  } else if (blockConfirmations.value === 1 && expectedConfirmations > 1) {
    return 'Waiting for 3rd Block...';
  } else if (blockConfirmations.value === 2 && expectedConfirmations > 2) {
    return 'Waiting for 4th Block...';
  } else if (blockConfirmations.value === 3 && expectedConfirmations > 3) {
    return 'Waiting for 5th Block...';
  } else if (blockConfirmations.value === 4 && expectedConfirmations > 4) {
    return 'Waiting for 6th Block...';
  } else if (blockConfirmations.value === 5 && expectedConfirmations > 5) {
    return 'Waiting for 7th Block...';
  } else if (blockConfirmations.value === 6 && expectedConfirmations > 6) {
    return 'Waiting for 8th Block...';
  } else {
    return 'Waiting for Finalization...';
  }
});

async function finalizeActivation() {
  if (!vault.createdVault) return;
  let fallbackRules = JsonExt.stringify(toRaw(config.vaultingRules));
  try {
    isSubmitted.value = true;
    transactionError.value = '';
    const txInfo = await vault.increaseVaultAllocations({
      addedSecuritizationMicrogons: securitizationAmount.value,
      addedTreasuryMicrogons: treasuryAmount.value,
    });
    config.vaultingRules.baseMicrogonCommitment += securitizationAmount.value + treasuryAmount.value;
    await config.saveVaultingRules();
    console.log('TX INFO', txInfo);
    if (txInfo) {
      txInfo.subscribeToProgress(async (args, error) => {
        progressPct.value = args.progressPct;
        blockConfirmations.value = args.confirmations;
        expectedConfirmations = args.expectedConfirmations;
        if (error) {
          await failed(error, fallbackRules);
        }
      });
    }
  } catch (err) {
    await failed(err, fallbackRules);
  }
}

async function failed(error: unknown, fallbackRules: string) {
  console.error('Error during vault allocation: %o', error);
  transactionError.value = 'Allocation failed, please try again';
  config.vaultingRules = JsonExt.parse(fallbackRules);
  isSubmitted.value = false;
  await config.saveVaultingRules();
}

function cancelOverlay() {
  emit('close', false);
}

Vue.onMounted(async () => {
  await myVault.load();
  if (myVault.data.pendingAllocateTxInfo) {
    const txInfo = myVault.data.pendingAllocateTxInfo;
    isSubmitted.value = true;
    securitizationAmount.value = txInfo.tx.metadataJson.addedSecuritizationMicrogons;
    treasuryAmount.value = txInfo.tx.metadataJson.addedTreasuryMicrogons;
    microgonsToActivate.value = securitizationAmount.value + treasuryAmount.value;
    txInfo.subscribeToProgress((args, error) => {
      progressPct.value = args.progressPct;
      blockConfirmations.value = args.confirmations;
      expectedConfirmations = args.expectedConfirmations;
      if (error) {
        transactionError.value = error.message;
      }
    });
  } else {
    const newAllocation = await myVault.getVaultAllocations(microgonsToActivate.value, config.vaultingRules);
    securitizationAmount.value = newAllocation.proposedSecuritizationMicrogons - newAllocation.securitizationMicrogons;
    treasuryAmount.value = newAllocation.proposedTreasuryMicrogons - newAllocation.treasuryMicrogons;
  }
});
</script>
