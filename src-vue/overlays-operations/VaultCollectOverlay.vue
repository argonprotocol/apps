<!-- prettier-ignore -->
<template>
  <OverlayBase
    :isOpen="isOpen"
    :showCloseIcon="true"
    :title="collectRevenue ? 'Collect Pending Revenue' : 'Sign Bitcoin Transactions'"
    @close="closeOverlay"
    class="">
    <div box class="flex flex-col px-5 py-3">
      <div class="flex flex-col gap-y-2" v-if="!isProcessing">
        <p>
          <span v-if="collectRevenue">
            Your vault has
            <strong>
              {{ currency.symbol }}{{ microgonToMoneyNm(collectRevenue).formatIfElse('< 1_000', '0,0.00', '0,0') }}
            </strong>
            in uncollected revenue.
            <CountdownClock :time="nextCollectDueDate" v-slot="{ hours, minutes, days, seconds }">
              <template v-if="hours || minutes || days || seconds">
                You must collect this within
                <span>
                  <span v-if="days > 0">{{ days }} day{{ days === 1 ? '' : 's' }}</span>
                  <span v-else-if="hours || minutes > 0">
                    <span class="mr-2" v-if="hours">{{ hours }} hour{{ hours === 1 ? '' : 's' }}</span>
                    <span v-if="minutes">{{ minutes }} minute{{ minutes === 1 ? '' : 's' }}</span>
                  </span>
                  <span v-else-if="seconds">{{ seconds }} second{{ seconds === 1 ? '' : 's' }}</span>
                </span>;
                if not,
                <template v-if="collectRevenue === myVault.data.expiringCollectAmount">it</template>
                <strong v-else>
                  {{ currency.symbol
                  }}{{ microgonToMoneyNm(myVault.data.expiringCollectAmount).formatIfElse('< 1_000', '0,0.00', '0,0') }}
                </strong>
                will be lost forever. Where should this capital be placed?
              </template>
            </CountdownClock>

            <InputMenu
              v-model="moveTo"
              :options="[
                { name: 'Vaulting Account', value: MoveTo.VaultingHold },
                { name: 'Mining Account', value: MoveTo.MiningHold },
              ]"
              class="mt-5 flex max-w-2/3" />
          </span>
          <span v-else-if="manualPendingCosignCount">
            {{ collectRevenue ? 'Also, you' : 'You' }} have
            <strong>
              {{ manualPendingCosignCount }} transaction{{
                manualPendingCosignCount === 1 ? '' : 's'
              }}
            </strong>
            that must be signed. Failure to do so within
            <CountdownClock :time="nextCollectDueDate" v-slot="{ hours, minutes, days }">
              <span v-if="days > 0">{{ days }} day{{ days === 1 ? '' : 's' }}</span>
              <template v-else>
                <span class="mr-2" v-if="hours">{{ hours }} hour{{ hours === 1 ? '' : 's' }}</span>
                <span v-if="minutes">{{ minutes }} minute{{ minutes === 1 ? '' : 's' }}</span>
              </template>
            </CountdownClock>
            will result in your vault forfeiting
            <strong>
              {{ currency.symbol }}{{ microgonToMoneyNm(manualPendingCosignSum).formatIfElse('< 1_000', '0,0.00', '0,0') }}
            </strong>
            in securitization.
          </span>
        </p>

        <button
          @click="submitCollect"
          :disabled="isProcessing"
          class="bg-argon-600 hover:bg-argon-700 mt-10 mb-2 cursor-pointer rounded-md px-6 py-2 text-lg font-bold text-white">
          <template v-if="collectRevenue">Collect Revenue</template>
          <template v-if="collectRevenue && signatures">+</template>
          <template v-if="signatures">Sign Transactions</template>
        </button>
      </div>
      <div v-if="transactionError" class="flex flex-col px-5 pt-6 pb-3 text-red-700">
        <div class="flex flex-row items-center justify-center">
          <div class="flex flex-col items-center justify-center">
            <div class="text-2xl font-bold">An Error has Occurred</div>
            <div class="text-sm text-gray-500 p-5 bg-red-50">{{ transactionError }}</div>
          </div>
        </div>
      </div>

      <div v-if="isProcessing" class="flex flex-col space-y-5 px-10 pt-5 pb-10">
        <p class="font-light text-gray-700">
          Your request to collect
          <template v-if="collectRevenue">Collect Revenue</template>
          <template v-if="collectRevenue && signatures">+</template>
          <template v-if="signatures">sign {{ signatures }} transaction{{ signatures !== 1 ? 's' : '' }}</template>
          has been submitted to the Argon network and is now awaiting finalization. This process usually takes four to
          five minutes to complete.
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
  </OverlayBase>
</template>

<script setup lang="ts">
import * as Vue from 'vue';
import dayjs from 'dayjs';
import utc from 'dayjs/plugin/utc';
import CountdownClock from '../components/CountdownClock.vue';
import { getMyVault } from '../stores/vaults.ts';
import { getBitcoinLocks } from '../stores/bitcoin.ts';
import { getCurrency } from '../stores/currency.ts';
import numeral, { createNumeralHelpers } from '../lib/numeral.ts';
import ProgressBar from '../components/ProgressBar.vue';
import OverlayBase from '../overlays-shared/OverlayBase.vue';
import InputMenu from '../components/InputMenu.vue';
import { bigIntMin, MoveTo } from '@argonprotocol/apps-core';

dayjs.extend(utc);

const emit = defineEmits<{
  close: [];
}>();
const moveTo = Vue.ref<MoveTo>(MoveTo.VaultingHold);
const progressPct = Vue.ref(0);
const progressLabel = Vue.ref('');
const transactionError = Vue.ref('');
const isOpen = Vue.ref(true);

const isProcessing = Vue.ref(false);
const myVault = getMyVault();
const bitcoinLocks = getBitcoinLocks();
const currency = getCurrency();

const signatures = Vue.ref(0);
const collectRevenue = Vue.ref(myVault.data.pendingCollectRevenue);

const myOwnPendingBitcoinCosignUtxoIds = Vue.computed(() => {
  const utxoIds = new Set<number>();

  for (const utxoId of myVault.data.pendingCosignUtxosById.keys()) {
    if (!bitcoinLocks.getLockByUtxoId(utxoId)) continue;
    utxoIds.add(utxoId);
  }

  return utxoIds;
});

const myPendingBitcoinCosignTxInfos = Vue.computed(() => {
  return Array.from(myVault.data.myPendingBitcoinCosignTxInfosByUtxoId.entries())
    .filter(([utxoId]) => myOwnPendingBitcoinCosignUtxoIds.value.has(utxoId))
    .map(([, txInfo]) => txInfo);
});

const latestMyPendingBitcoinCosignTxInfo = Vue.computed(() => {
  return myPendingBitcoinCosignTxInfos.value.at(-1);
});

const myPendingBitcoinCosignTxCount = Vue.computed(() => {
  return myPendingBitcoinCosignTxInfos.value.length;
});

const { microgonToMoneyNm } = createNumeralHelpers(currency);

const manualPendingCosignEntries = Vue.computed(() => {
  return Array.from(myVault.data.pendingCosignUtxosById.entries()).filter(([utxoId]) => {
    if (myOwnPendingBitcoinCosignUtxoIds.value.has(utxoId)) {
      return false;
    }
    return !myVault.data.myPendingBitcoinCosignTxInfosByUtxoId.has(utxoId);
  });
});

const manualPendingCosignCount = Vue.computed(() => {
  return manualPendingCosignEntries.value.length;
});

const manualPendingCosignSum = Vue.computed(() => {
  const sum = manualPendingCosignEntries.value.reduce((acc, [, utxo]) => acc + utxo.marketValue, 0n);
  return bigIntMin(sum, myVault.createdVault?.securitization ?? 0n);
});

const nextCollectDueDate = Vue.computed(() => {
  return dayjs.utc(myVault.data.nextCollectDueDate);
});

function closeOverlay() {
  isOpen.value = false;
  emit('close');
}
Vue.watch(
  () => myVault.data.pendingCollectRevenue,
  x => {
    if (!isProcessing.value) {
      collectRevenue.value = x;
    }
  },
);

Vue.watch(
  manualPendingCosignCount,
  x => {
    if (!isProcessing.value) {
      signatures.value = x;
    }
  },
  { immediate: true },
);

async function submitCollect() {
  isProcessing.value = true;
  try {
    progressLabel.value = 'Preparing Transaction...';
    const moveToDest = moveTo.value;
    await myVault.collect({ moveTo: moveToDest });
  } catch (error) {
    console.error('Error collecting pending revenue:', error);
    transactionError.value = error instanceof Error ? error.message : `${error}`;
    isProcessing.value = false;
    progressPct.value = 0;
    progressLabel.value = '';
  }
}

Vue.watch(
  [() => myVault.data.pendingCollectTxInfo, latestMyPendingBitcoinCosignTxInfo],
  ([pendingCollectTxInfo, myPendingBitcoinCosignTxInfo], _, onCleanup) => {
    if (pendingCollectTxInfo) {
      signatures.value = pendingCollectTxInfo.tx.metadataJson.cosignedUtxoIds.length;
      collectRevenue.value = pendingCollectTxInfo.tx.metadataJson.expectedCollectRevenue;
      isProcessing.value = true;
      const unsubscribe = pendingCollectTxInfo.subscribeToProgress((args, error) => {
        progressPct.value = args.progressPct;
        progressLabel.value = args.progressMessage;
        if (error) {
          transactionError.value = error.message;
        }
      });
      onCleanup(unsubscribe);
      return;
    }

    if (myPendingBitcoinCosignTxInfo) {
      signatures.value = myPendingBitcoinCosignTxCount.value;
      collectRevenue.value = 0n;
      isProcessing.value = true;
      const unsubscribe = myPendingBitcoinCosignTxInfo.subscribeToProgress((args, error) => {
        progressPct.value = args.progressPct;
        progressLabel.value = args.progressMessage;
        if (error) {
          transactionError.value = error.message;
        }
      });
      onCleanup(unsubscribe);
      return;
    }

    collectRevenue.value = myVault.data.pendingCollectRevenue;
    signatures.value = manualPendingCosignCount.value;

    if (!isProcessing.value) return;

    isProcessing.value = false;
    progressPct.value = 0;
    progressLabel.value = '';

    if (!collectRevenue.value && !manualPendingCosignCount.value && !transactionError.value) {
      closeOverlay();
    }
  },
  { immediate: true },
);
</script>
