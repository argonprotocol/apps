<template>
  <div class="flex min-h-0 grow flex-col">
    <section class="mt-5 flex flex-row items-end gap-x-2 px-9 text-center">
      <div class="w-1/3 border-b border-slate-400/30 py-5">
        <div class="text-argon-600 inline-flex text-5xl font-bold">
          <span>{{ currency.symbol }}</span>
          <FormattedMoney :value="financials.liquidTotalSatoshis" :unitOfMeasurement="UnitOfMeasurement.Satoshi" />
        </div>
        <div class="font-light text-slate-900/70">Market Value of BTC</div>
      </div>
      <div class="relative h-full w-px bg-slate-400/30">
        <div
          class="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 bg-white pt-1 pb-3 text-6xl leading-5 text-slate-500/80"
        >
          =
        </div>
      </div>
      <div class="w-1/3 border-b border-slate-400/30 py-5">
        <div class="text-argon-600 text-5xl font-bold">
          {{ numeral(financials.liquidPerformanceReturn).format('0,0.[00]') }}%
        </div>
        <div class="font-light text-slate-900/70">Liquid Locking Returns</div>
      </div>
      <div class="relative h-full w-px bg-slate-400/30">
        <div
          class="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 bg-white pt-2 pb-4 text-4xl leading-5 font-semibold text-slate-500/80"
        >
          vs
        </div>
      </div>
      <div class="w-1/3 border-b border-slate-400/30 py-5">
        <div class="text-argon-600 text-5xl font-bold">
          {{ numeral(financials.liquidHodlingReturn).format('0,0.[00]') }}%
        </div>
        <div class="font-light text-slate-900/70">Hodling Returns</div>
      </div>
    </section>

    <div class="relative flex min-h-0 grow flex-col">
      <div class="flex grow flex-col overflow-y-auto pt-10">
        <div class="flex flex-row items-center px-9 text-slate-800/70">
          <span class="grow">
            <template v-if="financials.isHistoryRecoveryInProgress">Restoring BTC transaction history...</template>
            <template v-else>
              You have {{ financials.bitcoinLockDisplayRecords.length }} BTC transaction{{
                financials.bitcoinLockDisplayRecords.length === 1 ? '' : 's'
              }}...
            </template>
          </span>
          <div class="flex flex-row items-stretch gap-x-3">
            <span class="relative">
              <button
                data-testid="BitcoinLocks.openLockingOverlay()"
                @click="openLockingOverlay"
                class="text-md text-argon-600 cursor-pointer"
              >
                Lock Another Bitcoin
              </button>
              <ArrowCalloutButton
                v-if="controller.activeGuideId === OperationalStepId.LiquidLock"
                guidance="Start your next liquid lock here."
                class="absolute top-1/2 right-0 z-50 translate-x-[calc(100%+0.75rem)] -translate-y-1/2"
              />
            </span>
            <div class="w-px bg-slate-400/50" />
            <a
              class="whitespace-nowrap"
              :href="`${NetworkConfig.websiteHost}/docs/assets-and-entities/bitcoin-locks`"
              target="_blank"
            >
              View Docs
            </a>
          </div>
        </div>

        <section class="mt-4 flex grow flex-col gap-y-3 px-9 pb-10">
          <BitcoinRecord
            :data-testid="`BitcoinLocks.lockEntry.${lockSummary.uuid}`"
            v-for="lockSummary in financials.bitcoinLockDisplayRecords"
            :key="lockSummary.uuid ?? lockSummary.utxoId"
            :lockSummary="lockSummary"
            @click="openDetail(lockSummary)"
            @ratchet="openRatchetingOverlay"
            @unlock="openUnlockingOverlay"
          />
          <BitcoinsReleasedOverlay v-if="financials.liquidInvisibleRecords.length" @open-detail="openDetail" />
        </section>
        <div class="relative px-0.5 pb-0.5">
          <img src="/treasury-footers/bitcoin-locks.png" class="w-full opacity-50" />
        </div>
      </div>
      <div class="absolute top-0 left-0 h-10 w-full bg-linear-to-b from-white to-transparent" />
    </div>
  </div>

  <BitcoinLockDetailOverlay
    v-if="showDetailOverlay && selectedLock"
    :lock="selectedLock.record"
    @close="showDetailOverlay = false"
    @unlock="openUnlockingOverlay"
  />

  <BitcoinUnlockingOverlay
    v-if="showUnlockingOverlay"
    :personalLock="selectedLock?.record"
    @close="showUnlockingOverlay = false"
  />

  <BitcoinRatchetingOverlay
    v-if="showRatchetingOverlay && selectedLock"
    :personalLock="selectedLock.record"
    @close="showRatchetingOverlay = false"
    @completed="onRatchetCompleted"
  />
</template>

<script setup lang="ts">
import * as Vue from 'vue';
import numeral from '../../lib/numeral.ts';
import { getCurrency } from '../../stores/currency.ts';
import { getBitcoinLockCoupons, getBitcoinLocks } from '../../stores/bitcoin.ts';
import { getMiningFrames } from '../../stores/mainchain.ts';
import { type IBitcoinLockRecord } from '../../lib/db/BitcoinLocksTable.ts';
import BitcoinLockDetailOverlay from '../../overlays/BitcoinLockDetailOverlay.vue';
import BitcoinUnlockingOverlay from '../../overlays/BitcoinUnlockingOverlay.vue';
import basicEmitter from '../../emitters/basicEmitter.ts';
import BitcoinRatchetingOverlay from '../../overlays/BitcoinRatchetingOverlay.vue';
import FormattedMoney from '../../components/FormattedMoney.vue';
import { NetworkConfig, UnitOfMeasurement } from '@argonprotocol/apps-core';
import type { IBitcoinLockSummary } from '../../interfaces/IBitcoinLockSummary.ts';
import { useFinancials } from '../../stores/financials.ts';
import BitcoinRecord from '../treasury-screens/components/BitcoinRecord.vue';
import BitcoinsReleasedOverlay from '../../overlays/BitcoinsReleasedOverlay.vue';
import ArrowCalloutButton from '../../components/ArrowCalloutButton.vue';
import { OperationalStepId, useCertificationController } from '../../stores/certificationController.ts';

const controller = useCertificationController();
const currency = getCurrency();
const financials = useFinancials();
const bitcoinLocks = getBitcoinLocks();
const bitcoinLockCoupons = getBitcoinLockCoupons();
const miningFrames = getMiningFrames();

const currentTick = Vue.ref(0);
const pageSourcesAreLoaded = Vue.ref(false);
const showDetailOverlay = Vue.ref(false);
const showUnlockingOverlay = Vue.ref(false);
const showRatchetingOverlay = Vue.ref(false);
const selectedLock = Vue.ref<IBitcoinLockSummary>();

function openDetail(lock: IBitcoinLockSummary) {
  if (lock.record.isHistoryRecoveryPending) return;

  selectedLock.value = lock;
  if (bitcoinLocks.isLockedStatus(lock.record) || bitcoinLocks.isFinishedStatus(lock.record)) {
    showDetailOverlay.value = true;
  } else {
    openLockingOverlay();
  }
}

function openLockingOverlay() {
  basicEmitter.emit('openBitcoinLock', selectedLock.value ? { lock: selectedLock.value.record } : undefined);
}

function openUnlockingOverlay(eventOrLock: MouseEvent | IBitcoinLockRecord, maybeLock?: IBitcoinLockRecord) {
  const lockRecord = maybeLock ?? (eventOrLock as IBitcoinLockRecord);
  if (eventOrLock instanceof MouseEvent) {
    eventOrLock.stopPropagation();
  }

  selectedLock.value = bitcoinLocks.createLockSummary(lockRecord);
  showDetailOverlay.value = false;
  showUnlockingOverlay.value = true;
}

function openRatchetingOverlay(event: MouseEvent, lock: IBitcoinLockSummary) {
  event.stopPropagation();
  showDetailOverlay.value = false;
  selectedLock.value = lock;
  showRatchetingOverlay.value = true;
}

async function onRatchetCompleted() {
  showRatchetingOverlay.value = false;
  await bitcoinLocks.load();
}

let unsubMiningFrames: (() => void) | undefined;

Vue.onMounted(async () => {
  void bitcoinLockCoupons.refresh().catch(error => {
    console.error('Unable to refresh Bitcoin lock coupons', error);
  });
  await Promise.all([currency.isLoadedPromise, bitcoinLocks.load(), miningFrames.load()]);

  currentTick.value = miningFrames.currentTick;
  unsubMiningFrames = miningFrames.onTick(() => {
    currentTick.value = miningFrames.currentTick;
  }).unsubscribe;

  pageSourcesAreLoaded.value = true;
});

Vue.onUnmounted(() => {
  unsubMiningFrames?.();
});
</script>
