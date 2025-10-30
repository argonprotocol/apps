<template>
  <DialogRoot class="absolute inset-0 z-10" :open="true">
    <DialogPortal>
      <AnimatePresence>
        <DialogOverlay asChild>
          <Motion asChild :initial="{ opacity: 0 }" :animate="{ opacity: 1 }" :exit="{ opacity: 0 }">
            <BgOverlay @close="cancelOverlay" />
          </Motion>
        </DialogOverlay>

        <DialogContent asChild @escapeKeyDown="cancelOverlay" :aria-describedby="undefined">
          <Motion
            :ref="draggable.setModalRef"
            :initial="{ opacity: 0 }"
            :animate="{ opacity: 1 }"
            :exit="{ opacity: 0 }"
            :style="{
              top: `calc(50% + ${draggable.modalPosition.y}px)`,
              left: `calc(50% + ${draggable.modalPosition.x}px)`,
              transform: 'translate(-50%, -50%)',
              cursor: draggable.isDragging ? 'grabbing' : 'default',
            }"
            class="text-md absolute z-50 w-200 overflow-scroll rounded-lg border border-black/40 bg-white px-4 pt-2 pb-2 shadow-xl focus:outline-none">
            <h2
              @mousedown="draggable.onMouseDown($event)"
              :disabled="isSaving"
              :style="{ cursor: draggable.isDragging ? 'grabbing' : 'grab' }"
              class="mb-2 flex w-full flex-row items-center space-x-4 border-b border-black/20 px-3 pt-3 pb-3 text-5xl font-bold">
              <DialogTitle class="grow text-2xl font-bold">Liquid Lock Your Bitcoin</DialogTitle>
              <div
                @click="cancelOverlay"
                class="z-10 mr-1 flex h-[30px] w-[30px] cursor-pointer items-center justify-center rounded-md border border-slate-400/60 text-sm/6 font-semibold hover:border-slate-500/60 hover:bg-[#f1f3f7] focus:outline-none">
                <XMarkIcon class="h-5 w-5 stroke-4 text-[#B74CBA]" />
              </div>
            </h2>

            <div box class="flex flex-col px-3 py-3">
              <p>
                Your vault currently has enough securitization to lock up to {{ currency.symbol
                }}{{ microgonToMoneyNm(bitcoinSpaceInMicrogons).format('0,0.00') }} in bitcoin ({{
                  numeral(bitcoinSpaceInBtc).format('0,0.[00000000]')
                }}
                btc). As part of this Liquid Locking process, you'll be able to receive the full market value of your
                bitcoin in Argon stablecoins.
              </p>

              <div v-if="errorMessage" class="mt-4 rounded-md bg-red-50 p-4">
                <div class="flex">
                  <div class="shrink-0">
                    <XMarkIcon class="size-5 text-red-400" aria-hidden="true" />
                  </div>
                  <div class="ml-3">
                    <h3 class="text-sm font-medium text-red-800">Error</h3>
                    <div class="mt-1 text-sm text-red-700">
                      <p>{{ errorMessage }}</p>
                    </div>
                  </div>
                </div>
              </div>

              <div class="mt-5 flex flex-row gap-x-5">
                <div class="flex w-1/2 grow flex-col space-y-1">
                  <label class="font-bold opacity-40">Bitcoin Amount</label>
                  <InputNumber
                    v-model="bitcoinAmount"
                    @update:modelValue="handleBtcChange"
                    :maxDecimals="8"
                    :min="0"
                    :max="bitcoinSpaceInBtc"
                    :dragBy="0.1"
                    :dragByMin="0.01"
                    class="px-1 py-2 text-xl" />
                </div>
                <div class="flex flex-col space-y-1">
                  <label>&nbsp;</label>
                  <div class="py-2 text-xl">=</div>
                </div>
                <div class="flex w-1/2 grow flex-col space-y-1">
                  <label class="font-bold opacity-40">Argons to Receive</label>
                  <InputArgon
                    v-model="microgonAmount"
                    @update:modelValue="handleArgonChange"
                    :maxDecimals="0"
                    :min="0n"
                    :max="bitcoinSpaceInMicrogons"
                    :dragBy="1_000_000n"
                    :dragByMin="1_000_000n"
                    class="px-1 py-2 text-xl" />
                </div>
              </div>

              <div class="mt-10 flex flex-row items-center justify-end gap-x-3 border-t border-black/20 pt-4">
                <button
                  class="cursor-pointer rounded-lg bg-gray-200 px-10 py-2 text-lg font-bold text-black hover:bg-gray-300"
                  @click="cancelOverlay"
                  :disabled="isSaving">
                  Cancel
                </button>
                <button
                  class="cursor-pointer rounded-lg px-10 py-2 text-lg font-bold text-white"
                  :class="[isSaving ? 'bg-argon-600/60' : 'bg-argon-600 hover:bg-argon-700']"
                  :disabled="isSaving"
                  @click="liquidLock">
                  <template v-if="isSaving">Initializing Liquid Lock</template>
                  <template v-else>Liquid Lock Bitcoin</template>
                </button>
              </div>
            </div>
          </Motion>
        </DialogContent>
      </AnimatePresence>
    </DialogPortal>
  </DialogRoot>
</template>

<script setup lang="ts">
import * as Vue from 'vue';
import dayjs from 'dayjs';
import utc from 'dayjs/plugin/utc';
import { DialogContent, DialogOverlay, DialogPortal, DialogRoot, DialogTitle } from 'reka-ui';
import { AnimatePresence, Motion } from 'motion-v';
import BgOverlay from '../components/BgOverlay.vue';
import Draggable from './helpers/Draggable.ts';
import { XMarkIcon } from '@heroicons/vue/24/outline';
import InputNumber from '../components/InputNumber.vue';
import InputArgon from '../components/InputArgon.vue';
import numeral from 'numeral';
import { useMyVault, useVaults } from '../stores/vaults.ts';
import { createNumeralHelpers } from '../lib/numeral.ts';
import { useCurrency } from '../stores/currency.ts';
import { useBitcoinLocks } from '../stores/bitcoin.ts';
import { SATS_PER_BTC } from '@argonprotocol/mainchain';
import { useDebounceFn } from '@vueuse/core';
import { useConfig } from '../stores/config.ts';

const currency = useCurrency();

dayjs.extend(utc);
const { microgonToMoneyNm } = createNumeralHelpers(currency);

const emit = defineEmits<{
  (e: 'close', shouldFinishLocking: boolean): void;
}>();

const vault = useMyVault();
const vaults = useVaults();
const bitcoinLocksStore = useBitcoinLocks();
const config = useConfig();

const errorMessage = Vue.ref<string | null>(null);
const draggable = Vue.reactive(new Draggable());
const bitcoinAmount = Vue.ref(0);
const microgonAmount = Vue.ref(0n);
const bitcoinSpaceInMicrogons = Vue.ref(0n);
const bitcoinSpaceInBtc = Vue.ref(0);

let lastSetMicrogonAmount = 0n;
let lastSetBtcAmount = 0;

async function internalHandleArgonChange(microgons: bigint) {
  if (microgons === lastSetMicrogonAmount) {
    return;
  }
  const sats = await bitcoinLocksStore.satoshisForArgonLiquidity(microgons);
  const btc = currency.satsToBtc(sats);
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
  microgonAmount.value = await vaults.getMarketRate(sats);
  console.log(`Btc market rate of ${sats} sats -> ${microgonAmount.value} argons`);
  lastSetMicrogonAmount = microgonAmount.value;
  lastSetBtcAmount = value;
}

const handleBtcChange = useDebounceFn(internalHandleBtcChange, 100, { maxWait: 200 });
const handleArgonChange = useDebounceFn(internalHandleArgonChange, 100, { maxWait: 200 });

const isSaving = Vue.ref(false);

async function liquidLock() {
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

    await vault.lockBitcoin({
      microgonLiquidity: microgonLiquidity,
      argonKeyring: config.vaultingAccount,
      bip39Seed: config.bitcoinXprivSeed,
      txProgressCallback(progress: number) {
        console.log(`Lock Bitcoin Progress: ${Math.floor(progress * 100)}%`);
      },
    });
    emit('close', true);
  } catch (e: any) {
    errorMessage.value = e.message;
  } finally {
    isSaving.value = false;
  }
}

function cancelOverlay() {
  emit('close', false);
}

Vue.onMounted(async () => {
  await vault.load();
  await vault.subscribe();
  await config.load();

  bitcoinSpaceInMicrogons.value = vault.createdVault!.availableBitcoinSpace();
  bitcoinSpaceInBtc.value = currency.satsToBtc(
    await bitcoinLocksStore.satoshisForArgonLiquidity(bitcoinSpaceInMicrogons.value),
  );

  microgonAmount.value = bitcoinSpaceInMicrogons.value;
  bitcoinAmount.value = bitcoinSpaceInBtc.value;
});

Vue.onUnmounted(async () => {
  vault.unsubscribe();
});
</script>
