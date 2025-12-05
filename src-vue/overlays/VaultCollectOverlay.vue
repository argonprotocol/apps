<template>
  <Overlay
    :isOpen="isOpen"
    :showCloseIcon="true"
    :title="collectRevenue ? 'Collect Pending Revenue' : 'Sign Bitcoin Transactions'"
    @close="closeOverlay">
    <div box class="flex flex-col px-3 py-3">
      <div class="flex flex-col gap-y-2" v-if="!isSubmitted">
        <p>
          <span v-if="myVault.data.pendingCollectRevenue">
            Your vault has
            <strong>
              {{ currency.symbol
              }}{{ microgonToMoneyNm(myVault.data.pendingCollectRevenue).formatIfElse('< 1_000', '0,0.00', '0,0') }}
            </strong>
            in uncollected revenue.
            <CountdownClock :time="nextCollectDueDate" v-slot="{ hours, minutes, days, seconds }">
              <template v-if="hours || minutes || days || seconds">
                You must collect this within
                <span v-if="days > 0">{{ days }} day{{ days === 1 ? '' : 's' }}.</span>
                <span v-else-if="hours || minutes > 0">
                  <span class="mr-2" v-if="hours">{{ hours }} hour{{ hours === 1 ? '' : 's' }}</span>
                  <span v-if="minutes">{{ minutes }} minute{{ minutes === 1 ? '' : 's' }}</span>
                </span>
                <span v-else-if="seconds">{{ seconds }} second{{ seconds === 1 ? '' : 's' }}</span>
                ; otherwise,
                <strong>
                  {{ currency.symbol
                  }}{{ microgonToMoneyNm(myVault.data.expiringCollectAmount).formatIfElse('< 1_000', '0,0.00', '0,0') }}
                </strong>
                will expire and be lost forever.
              </template>
            </CountdownClock>
          </span>
          <span v-if="myVault.data.pendingCosignUtxoIds.size">
            {{ myVault.data.pendingCollectRevenue ? 'Also, you' : 'You' }} have
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

        <p>
          Click the button below to complete
          {{ signatures && collectRevenue ? 'both tasks at the same time' : 'this task' }}.
        </p>

        <button
          @click="collect"
          :disabled="isSubmitted"
          class="bg-argon-600 hover:bg-argon-700 mt-4 cursor-pointer rounded-md px-6 py-2 text-lg font-bold text-white">
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

      <div v-if="isSubmitted" class="flex flex-col space-y-5 px-28 pt-10 pb-20">
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
import { useMyVault } from '../stores/vaults.ts';
import { useCurrency } from '../stores/currency.ts';
import numeral, { createNumeralHelpers } from '../lib/numeral.ts';
import ProgressBar from '../components/ProgressBar.vue';
import Overlay from './Overlay.vue';

dayjs.extend(utc);

const emit = defineEmits<{
  close: [];
}>();

const progressPct = Vue.ref(0);
const blockConfirmations = Vue.ref(-1);
const transactionError = Vue.ref('');
const isOpen = Vue.ref(true);

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

const isSubmitted = Vue.ref(false);
const myVault = useMyVault();
const currency = useCurrency();

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

async function collect() {
  isSubmitted.value = true;
  try {
    const txInfo = await myVault.collect();
    if (txInfo) {
      txInfo.subscribeToProgress((args, error) => {
        progressPct.value = args.progressPct;
        blockConfirmations.value = args.confirmations;
        expectedConfirmations = args.expectedConfirmations;
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
  isSubmitted.value = true;
  txInfo.subscribeToProgress((args, error) => {
    progressPct.value = args.progressPct;
    blockConfirmations.value = args.confirmations;
    expectedConfirmations = args.expectedConfirmations;
    if (error) {
      transactionError.value = error.message;
    }
  });
}
</script>
