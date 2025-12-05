<!-- prettier-ignore -->
<template>
  <Overlay :disallowClose="true" :showCloseIcon="false" :isOpen="isOpen" class="w-6/12">
    <template #title>
      <div class="grow text-2xl font-bold">Wallet Funds Have Been Received</div>
    </template>

    <div class="flex min-h-60 w-full flex-row items-center justify-center gap-x-5 px-5 pt-3 pb-5"
         :class="{ 'flash-overlay': flash }">
      <div v-if="walletType === 'vaulting'">
        <template v-if="isVaultAllocationSubmitted == false">
          <p>
            <strong>{{ microgonToArgonNm(vaultMicrogonsToActivate).format('0,0.[00]') }} argons</strong> have been added to your <strong>vaulting</strong>
            wallet - you need to now choose how to allocate them. We've divided them between bitcoin security and
            treasury bonds based on your current config values, however, you can adjust below.
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

          <div v-if="transactionError" class="flex flex-col px-5 pt-6 pb-3">
            <div class="flex flex-row items-center justify-center">
              <div class="flex flex-col items-center justify-center">
                <div class="text-2xl font-bold">Error</div>
                <div class="text-sm text-gray-500">{{ transactionError }}</div>
              </div>
            </div>
          </div>
          <div class="mt-10 flex flex-row items-center justify-end gap-x-3 border-t border-black/20 pt-4">
            <button
              class="cursor-pointer rounded-lg px-10 py-2 text-lg font-bold text-white"
              :class="[isVaultAllocationSubmitted ? 'bg-argon-600/60' : 'bg-argon-600 hover:bg-argon-700']"
              :disabled="isVaultAllocationSubmitted"
              @click="finalizeActivation">
              <template v-if="isVaultAllocationSubmitted">Allocating...</template>
              <template v-else>Allocate These Funds</template>
            </button>
          </div>
        </template>

        <div v-if="isVaultAllocationSubmitted" class="flex flex-col space-y-5 px-28 pt-10 pb-20">
          <p class="font-light text-gray-700">
            Your request to allocate <strong>{{ microgonToArgonNm(vaultMicrogonsToActivate).format('0,0.[00]') }} argons</strong>
            has been submitted to the Argon network and is now awaiting finalization. This process usually takes four to
            five minutes to complete.
          </p>

          <p class="italic mb-2 font-light opacity-80">
            NOTE: You can close this overlay without disrupting the process.
          </p>

          <div class="mt-10">
            <div class="fade-progress text-center text-5xl font-bold">{{ numeral(progressPct).format('0.00') }}%</div>
          </div>

          <ProgressBar :progress="progressPct" :showLabel="false" class="h-4" />
          <div class="text-center font-light text-gray-500">
            {{ progressLabel }}
          </div>
          <button
            @click="closeOverlay"
            class="cursor-pointer rounded-lg bg-gray-200 px-10 py-2 text-lg font-bold text-black hover:bg-gray-300">
            {{  changes.length === 1 ? 'Close' : 'Show Next' }}
          </button>
        </div>
      </div>
      <div v-else>
        <div v-if="walletType === 'mining'">
          <strong>{{ fundsReceivedMessage }}</strong> has been added to your <strong>mining</strong> wallet.
          Your mining bot will begin using these funds as soon as they're needed.
        </div>
        <div v-else>
          <strong>{{ fundsReceivedMessage }}</strong> has been added to your <strong>holding</strong> wallet.
          You can choose how to distribute these funds from your wallet view.
        </div>

        <button
          @click="closeOverlay"
          class="inner-button-shadow bg-argon-600 hover:bg-argon-700 border-argon-700 mt-8 w-full cursor-pointer rounded-lg px-4 py-2 text-white focus:outline-none">
          {{  changes.length === 1 ? 'Ok' : 'Show Next' }}
        </button>
      </div>
    </div>
  </Overlay>
</template>

<script setup lang="ts">
import * as Vue from 'vue';
import { toRaw } from 'vue';
import { useConfig } from '../stores/config';
import { useCurrency } from '../stores/currency';
import Overlay from './Overlay.vue';
import numeral, { createNumeralHelpers } from '../lib/numeral';
import { IWalletType } from '../lib/Wallet.ts';
import InputArgon from '../components/InputArgon.vue';
import ProgressBar from '../components/ProgressBar.vue';
import { JsonExt } from '@argonprotocol/apps-core';
import BigNumber from 'bignumber.js';
import { useMyVault } from '../stores/vaults.ts';
import { useWallets } from '../stores/wallets.ts';
import { MyVault } from '../lib/MyVault.ts';

const isOpen = Vue.computed(() => changes.value.length > 0);

const currency = useCurrency();
const config = useConfig();
const wallets = useWallets();
const myVault = useMyVault();

const { microgonToArgonNm, micronotToArgonotNm } = createNumeralHelpers(currency);

const fundsReceivedMessage = Vue.computed(() => {
  let message = '';
  if (microgonsReceived.value > 0n) {
    message += `${currency.symbol}${microgonToArgonNm(microgonsReceived.value).format('0,0.00')} argons`;
  }
  if (micronotsReceived.value > 0n) {
    if (message.length > 0) {
      message += ' and ';
    }
    message += `${currency.symbol}${micronotToArgonotNm(micronotsReceived.value).format('0,0.00')} argonots`;
  }
  return message;
});

const changes = Vue.ref<
  { walletType: IWalletType; microgonsAdded: bigint; micronotsAdded: bigint; blockHash: string }[]
>([]);

const microgonsReceived = Vue.computed(() => changes.value[0]?.microgonsAdded ?? 0n);
const micronotsReceived = Vue.computed(() => changes.value[0]?.micronotsAdded ?? 0n);
const walletType = Vue.computed(() => changes.value[0]?.walletType ?? 'mining');

const isVaultAllocationSubmitted = Vue.ref(false);

async function loadVaultingChange() {
  await myVault.load();
  if (vaultMicrogonsToActivate.value <= 0n) {
    closeOverlay();
  }
  const newAllocation = await myVault.getVaultAllocations(vaultMicrogonsToActivate.value, config.vaultingRules);
  securitizationAmount.value = newAllocation.proposedSecuritizationMicrogons - newAllocation.securitizationMicrogons;
  treasuryAmount.value = newAllocation.proposedTreasuryMicrogons - newAllocation.treasuryMicrogons;
}

const vaultMicrogonsToActivate = Vue.computed(() => {
  const microgons = microgonsReceived.value;
  if (wallets.vaultingWallet.availableMicrogons - microgons < MyVault.OperationalReserves) {
    return wallets.vaultingWallet.availableMicrogons - MyVault.OperationalReserves;
  }
  return microgons;
});

const securitizationAmount = Vue.ref(0n);
const securitizationPct = Vue.computed(() => {
  return BigNumber(securitizationAmount.value).div(vaultMicrogonsToActivate.value).toNumber() * 100;
});
const maxSecuritizationAmount = Vue.computed(() => {
  return wallets.vaultingWallet.availableMicrogons - securitizationAmount.value;
});

const treasuryAmount = Vue.ref(0n);
const treasuryPct = Vue.computed(() => {
  return BigNumber(treasuryAmount.value).div(vaultMicrogonsToActivate.value).toNumber() * 100;
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

const progressPct = Vue.ref(0);
const blockConfirmations = Vue.ref(-1);
const transactionError = Vue.ref('');
let expectedConfirmations = 0;
const flash = Vue.ref(false);

function closeOverlay() {
  changes.value.shift();

  progressPct.value = 0;
  blockConfirmations.value = -1;
  transactionError.value = '';
  isVaultAllocationSubmitted.value = false;
  expectedConfirmations = 0;
}

Vue.watch(
  () => changes.value.length,
  (newLen, oldLen) => {
    if (newLen !== oldLen) {
      flash.value = false;
      requestAnimationFrame(() => {
        flash.value = true;
        setTimeout(() => (flash.value = false), 300); // length matches your CSS animation
      });
    }
  },
);

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
  if (!myVault.createdVault) return;
  let fallbackRules = JsonExt.stringify(toRaw(config.vaultingRules));
  try {
    isVaultAllocationSubmitted.value = true;
    transactionError.value = '';
    const txInfo = await myVault.increaseVaultAllocations({
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
  isVaultAllocationSubmitted.value = false;
  await config.saveVaultingRules();
}

Vue.watch(walletType, newType => {
  console.log('Inbound funding wallet type changed to %s', newType);
  if (walletType.value === 'vaulting') {
    void loadVaultingChange();
  }
});

wallets.registerWalletBalanceChangeEvents({
  onTransferIn(wallet, balanceChange) {
    if (wallet.type === 'vaulting' && !config.isVaultReadyToCreate) {
      console.log('Skipping vaulting wallet change - no created vault');
      return;
    }
    if (wallet.type === 'mining' && !config.isMinerReadyToInstall) {
      console.log('Skipping mining wallet change - no created miner');
      return;
    }
    if (balanceChange.microgonsAdded === 0n && balanceChange.micronotsAdded === 0n) {
      console.log('Skipping wallet change - no funds added');
      return;
    }
    changes.value.push({
      walletType: wallet.type,
      microgonsAdded: balanceChange.microgonsAdded,
      micronotsAdded: balanceChange.micronotsAdded,
      blockHash: balanceChange.block.blockHash,
    });
  },
  onBlockDeleted(block) {
    const index = changes.value.findIndex(c => c.blockHash === block.blockHash);
    if (index !== -1) {
      changes.value.splice(index, 1);
    }
  },
});

Vue.onMounted(async () => {
  await config.load();
});
</script>

<style scoped>
@reference "../main.css";

span[tag] {
  @apply ml-1 rounded-full px-2 text-xs font-bold text-white uppercase;
}
.flash-overlay {
  animation: flash-bg 0.3s ease;
}

@keyframes flash-bg {
  0% {
    background-color: rgba(255, 255, 0, 0.3);
  }
  100% {
    background-color: transparent;
  }
}
</style>
