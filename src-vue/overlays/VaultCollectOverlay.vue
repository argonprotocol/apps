<template>
  <Overlay
    :isOpen="isOpen"
    :showCloseIcon="true"
    :title="collectRevenue ? 'Collect Pending Revenue' : 'Sign Bitcoin Transactions'"
    @close="closeOverlay"
    class="">
    <div box class="flex flex-col px-5 py-3">
      <div class="flex flex-col gap-y-2" v-if="!isProcessing">
        <p>
          <span v-if="isProcessing">
            <template v-if="collectRevenue">
              You are collecting
              <strong>
                {{ currency.symbol }}{{ microgonToMoneyNm(collectRevenue).formatIfElse('< 1_000', '0,0.00', '0,0') }}
              </strong>
              in vault revenue.
            </template>
            <template v-else>
              You are co-signing
              <strong>{{ signatures }} transaction{{ signatures !== 1 ? 's' : '' }}</strong>
              .
            </template>
          </span>
          <span v-else-if="collectRevenue">
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
                </span>
                ; if not,
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
                { name: 'Vaulting Account', value: 'Vaulting' },
                { name: 'Mining Account', value: 'Mining' },
              ]"
              class="mt-5 flex max-w-2/3" />
          </span>
          <span v-else-if="myVault.data.pendingCosignUtxoIds.size">
            {{ collectRevenue ? 'Also, you' : 'You' }} have
            <strong>
              {{ myVault.data.pendingCosignUtxoIds.size }} transaction{{
                myVault.data.pendingCosignUtxoIds.size === 1 ? '' : 's'
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
              {{ currency.symbol }}{{ microgonToMoneyNm(securitization).formatIfElse('< 1_000', '0,0.00', '0,0') }}
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
      <div v-if="transactionError" class="flex flex-col px-5 pt-6 pb-3">
        <div class="flex flex-row items-center justify-center">
          <div class="flex flex-col items-center justify-center">
            <div class="text-2xl font-bold">Error</div>
            <div class="text-sm text-gray-500">{{ transactionError }}</div>
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
  </Overlay>
</template>

<script setup lang="ts">
import * as Vue from 'vue';
import dayjs from 'dayjs';
import utc from 'dayjs/plugin/utc';
import CountdownClock from '../components/CountdownClock.vue';
import { getMyVault } from '../stores/vaults.ts';
import { getCurrency } from '../stores/currency.ts';
import numeral, { createNumeralHelpers } from '../lib/numeral.ts';
import ProgressBar from '../components/ProgressBar.vue';
import Overlay from './Overlay.vue';
import InputMenu from '../components/InputMenu.vue';
import { MoveTo } from '@argonprotocol/apps-core';

dayjs.extend(utc);

const emit = defineEmits<{
  close: [];
}>();
const moveTo = Vue.ref<MoveTo>(MoveTo.Vaulting);
const progressPct = Vue.ref(0);
const progressLabel = Vue.ref('');
const transactionError = Vue.ref('');
const isOpen = Vue.ref(true);

const isProcessing = Vue.ref(false);
const myVault = getMyVault();
const currency = getCurrency();

const signatures = Vue.ref(myVault.data.pendingCosignUtxoIds.size);
const collectRevenue = Vue.ref(myVault.data.pendingCollectRevenue);

const { microgonToMoneyNm } = createNumeralHelpers(currency);

const securitization = Vue.computed(() => {
  return myVault.createdVault?.securitization ?? 0n;
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

async function submitCollect() {
  isProcessing.value = true;
  try {
    progressLabel.value = 'Preparing Transaction...';
    const moveToDest = moveTo.value;
    const txInfo = await myVault.collect({ moveTo: moveToDest });
    if (txInfo) {
      txInfo.subscribeToProgress((args, error) => {
        progressPct.value = args.progressPct;
        progressLabel.value = args.progressMessage;
        if (error) {
          transactionError.value = error.message;
        }
      });
    }
  } catch (error) {
    console.error('Error collecting pending revenue:', error);
    transactionError.value = error instanceof Error ? error.message : `${error}`;
  }
}

if (myVault.data.pendingCollectTxInfo) {
  const txInfo = myVault.data.pendingCollectTxInfo;
  signatures.value = txInfo.tx.metadataJson.cosignedUtxoIds.length;
  collectRevenue.value = txInfo.tx.metadataJson.expectedCollectRevenue;
  isProcessing.value = true;
  txInfo.subscribeToProgress((args, error) => {
    progressPct.value = args.progressPct;
    progressLabel.value = args.progressMessage;
    if (error) {
      transactionError.value = error.message;
    }
  });
}
</script>
