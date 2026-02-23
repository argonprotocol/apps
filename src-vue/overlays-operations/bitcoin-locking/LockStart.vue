<template>
  <div class="flex flex-col px-2 pt-6 pb-3">
    <div class="flex flex-col px-10">
      <p class="font-light">
        Your vault has enough securitization to lock up to {{ currency.symbol
        }}{{ microgonToMoneyNm(bitcoinSpaceInMicrogons).format('0,0.00') }} in bitcoin ({{
          numeral(bitcoinSpaceInBtc).format('0,0.[00000000]')
        }}
        btc). As part of this process, you'll receive the full market value of your bitcoin in the form of fully liquid,
        unencumbered Argon stablecoins. We call this process "Liquid Locking".
      </p>

      <div v-if="errorMessage" class="mt-4 rounded-md bg-red-50 p-4">
        <div class="flex">
          <div class="shrink-0">
            <ExclamationTriangleIcon class="size-5 text-red-400" aria-hidden="true" />
          </div>
          <div class="ml-3">
            <div class="text-sm text-red-700">
              <p>{{ errorMessage }}</p>
            </div>
          </div>
        </div>
      </div>

      <div class="mt-5 flex flex-row gap-x-5">
        <div class="flex w-1/2 grow flex-col space-y-1">
          <label class="font-bold opacity-40">Bitcoins to Lock</label>
          <InputNumber
            v-model="bitcoinAmount"
            @input="handleBtcChange"
            :maxDecimals="8"
            :min="0"
            :max="bitcoinSpaceInBtc"
            :dragBy="0.1"
            :dragByMin="0.01"
            class="px-1 py-2 text-lg" />
        </div>
        <div class="flex flex-col space-y-1">
          <label>&nbsp;</label>
          <div class="py-2 text-xl">=</div>
        </div>
        <div class="flex w-1/2 grow flex-col space-y-1">
          <label class="font-bold opacity-40">Argons to Receive</label>
          <InputMoney
            v-model="microgonAmount"
            @input="handleArgonChange"
            :maxDecimals="0"
            :min="0n"
            :max="bitcoinSpaceInMicrogons"
            :dragBy="1_000_000n"
            :dragByMin="1_000_000n"
            class="px-1 py-2 text-lg" />
        </div>
      </div>
    </div>

    <div class="mt-16 flex flex-row items-center justify-end gap-x-3 border-t border-black/20 pt-4 pr-4">
      <button
        class="border-argon-600/20 cursor-pointer rounded-lg border bg-gray-200 px-10 py-1 text-lg text-black hover:bg-gray-300"
        @click="closeOverlay"
        :disabled="isSaving">
        Cancel
      </button>
      <button
        :class="[isSaving ? 'bg-argon-600/60 pointer-events-none' : 'bg-argon-600 hover:bg-argon-700']"
        :disabled="isSaving"
        @click="submitLiquidLock"
        class="cursor-pointer rounded-lg px-10 py-2 text-lg font-bold text-white">
        <template v-if="isSaving">Initializing Liquid Lock</template>
        <template v-else>
          Initialize Liquid Lock
          <ChevronDoubleRightIcon class="relative -top-px inline-block size-5" />
        </template>
      </button>
    </div>
  </div>
</template>

<script setup lang="ts">
import * as Vue from 'vue';
import { ChevronDoubleRightIcon, ExclamationTriangleIcon } from '@heroicons/vue/24/outline';
import InputNumber from '../../components/InputNumber.vue';
import InputMoney from '../../components/InputMoney.vue';
import numeral, { createNumeralHelpers } from '../../lib/numeral.ts';
import { getCurrency } from '../../stores/currency.ts';
import { SATS_PER_BTC } from '@argonprotocol/mainchain';
import { useDebounceFn } from '@vueuse/core';
import { getBitcoinLocks } from '../../stores/bitcoin.ts';
import { getMyVault, getVaults } from '../../stores/vaults.ts';

const emit = defineEmits<{
  (e: 'close'): void;
}>();

const currency = getCurrency();
const myVault = getMyVault();
const vaults = getVaults();
const bitcoinLocksStore = getBitcoinLocks();

const { microgonToMoneyNm } = createNumeralHelpers(currency);

const bitcoinSpaceInMicrogons = Vue.ref(0n);
const bitcoinSpaceInBtc = Vue.ref(0);

const isSaving = Vue.ref(false);
const errorMessage = Vue.ref<string | null>(null);
const bitcoinAmount = Vue.ref(0);
const microgonAmount = Vue.ref(0n);

const handleBtcChange = useDebounceFn(internalHandleBtcChange, 100, { maxWait: 200 });
const handleArgonChange = useDebounceFn(internalHandleArgonChange, 100, { maxWait: 200 });

let lastSetMicrogonAmount = 0n;
let lastSetBtcAmount = 0;

async function internalHandleArgonChange(microgons: bigint) {
  if (microgons === lastSetMicrogonAmount) {
    return;
  }
  const sats = await bitcoinLocksStore.satoshisForArgonLiquidity(microgons);
  const btc = currency.convertSatToBtc(sats);
  console.log(`${microgons} microgons -> Btc market rate of ${sats} sats -> ${btc} btc`);
  bitcoinAmount.value = btc;
  lastSetBtcAmount = bitcoinAmount.value;
  lastSetMicrogonAmount = microgons;
}

async function internalHandleBtcChange(value: number) {
  if (value === lastSetBtcAmount) {
    return;
  }
  const sats = BigInt(Math.floor(value * Number(SATS_PER_BTC)));
  microgonAmount.value = await vaults.getMarketRateInMicrogons(sats);
  console.log(`Btc market rate of ${sats} sats -> ${microgonAmount.value} argons`);
  lastSetMicrogonAmount = microgonAmount.value;
  lastSetBtcAmount = value;
}

async function submitLiquidLock() {
  if (isSaving.value) return;

  let microgonLiquidity = microgonAmount.value;
  try {
    isSaving.value = true;
    errorMessage.value = null;
    if (microgonLiquidity <= 0n) {
      throw new Error('Please enter a valid amount of Argons to receive.');
    }
    if (microgonLiquidity > bitcoinSpaceInMicrogons.value) {
      microgonLiquidity = bitcoinSpaceInMicrogons.value;
    }

    await myVault.startBitcoinLocking({
      microgonLiquidity,
    });
  } catch (e: any) {
    console.error('Error initializing liquid lock:', e);
    errorMessage.value = e.message;
    isSaving.value = false;
  }
}

function closeOverlay() {
  if (isSaving.value) return;
  emit('close');
}

Vue.onMounted(async () => {
  await myVault.load();
  await myVault.subscribe();

  bitcoinSpaceInMicrogons.value = myVault.createdVault!.availableBitcoinSpace();
  bitcoinSpaceInBtc.value = currency.convertSatToBtc(
    await bitcoinLocksStore.satoshisForArgonLiquidity(bitcoinSpaceInMicrogons.value),
  );

  microgonAmount.value = bitcoinSpaceInMicrogons.value;
  bitcoinAmount.value = bitcoinSpaceInBtc.value;
});

Vue.onUnmounted(async () => {
  myVault.unsubscribe();
});
</script>
