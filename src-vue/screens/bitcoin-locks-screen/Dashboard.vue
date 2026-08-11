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
          <template v-if="financials.liquidPerformanceReturn !== undefined">
            {{ numeral(financials.liquidPerformanceReturn).format('0,0.[00]') }}%
          </template>
          <template v-else>&mdash;</template>
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
          <template v-if="financials.liquidHodlingReturn !== undefined">
            {{ numeral(financials.liquidHodlingReturn).format('0,0.[00]') }}%
          </template>
          <template v-else>&mdash;</template>
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
                @click="openNewLockingOverlay"
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
          <section
            v-if="actionableOrphanRecords.length || showReturnedOrphans"
            data-testid="BitcoinOrphans"
            :class="financials.liquidInvisibleRecords.length ? 'border-b' : ''"
            class="mt-2 space-y-2 border-t border-slate-300/70 py-4"
          >
            <div>
              <h2 class="font-semibold text-slate-800">Orphaned Bitcoin</h2>
              <p class="text-sm text-slate-500">Bitcoin deposits handled outside a lock.</p>
            </div>
            <button
              v-for="record in visibleOrphanRecords"
              :key="record.id"
              :data-testid="`BitcoinOrphans.record.${record.id}`"
              type="button"
              @click="selectedOrphan = record"
              class="hover:border-argon-400 flex w-full cursor-pointer items-center rounded-lg border border-slate-300 bg-white px-4 py-3 text-left"
            >
              <div class="grow">
                <div class="font-semibold text-slate-800">
                  {{ numeral(currency.convertSatToBtc(record.satoshis)).format('0,0.[00000000]') }} BTC received
                </div>
                <div class="text-sm text-slate-500">
                  {{ dayjs(record.firstSeenAt).format('MMM D, YYYY') }} · Lock expected
                  {{
                    numeral(
                      currency.convertSatToBtc(bitcoinLocks.getLockByUtxoId(record.lockUtxoId)?.satoshis ?? 0n),
                    ).format('0,0.[00000000]')
                  }}
                  BTC
                </div>
              </div>
              <div class="text-right">
                <div class="text-sm font-semibold" :class="record.statusError ? 'text-red-700' : 'text-argon-700'">
                  {{ orphanStatus(record) }}
                </div>
                <div class="text-sm text-slate-500">{{ orphanAction(record) }}</div>
              </div>
            </button>
            <button
              v-if="returnedOrphanCount"
              type="button"
              data-testid="BitcoinOrphans.toggleReturned()"
              @click="showReturnedOrphans = !showReturnedOrphans"
              class="text-argon-600 ml-auto block cursor-pointer text-sm whitespace-nowrap hover:underline"
            >
              {{ showReturnedOrphans ? 'Hide returned' : `Show returned (${returnedOrphanCount})` }}
            </button>
          </section>
          <button
            v-else-if="returnedOrphanCount"
            type="button"
            data-testid="BitcoinOrphans.showReturned()"
            @click="showReturnedOrphans = true"
            class="hover:text-argon-600 cursor-pointer self-end text-sm text-slate-500 hover:underline"
          >
            Show orphaned Bitcoin ({{ returnedOrphanCount }})
          </button>
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

  <BitcoinOrphanRecoveryOverlay
    v-if="selectedOrphan && selectedOrphanLock"
    :record="selectedOrphan"
    :lock="selectedOrphanLock"
    @close="selectedOrphan = undefined"
  />
</template>

<script setup lang="ts">
import * as Vue from 'vue';
import dayjs from 'dayjs';
import numeral from '../../lib/numeral.ts';
import { getCurrency } from '../../stores/currency.ts';
import { getBitcoinLockCoupons, getBitcoinLocks } from '../../stores/bitcoin.ts';
import { getMiningFrames } from '../../stores/mainchain.ts';
import { type IBitcoinLockRecord } from '../../lib/db/BitcoinLocksTable.ts';
import { BitcoinUtxoStatus, type IBitcoinUtxoRecord } from '../../lib/db/BitcoinUtxosTable.ts';
import { TransactionStatus } from '../../lib/db/TransactionsTable.ts';
import BitcoinLockDetailOverlay from '../../overlays/BitcoinLockDetailOverlay.vue';
import BitcoinUnlockingOverlay from '../../overlays/BitcoinUnlockingOverlay.vue';
import basicEmitter from '../../emitters/basicEmitter.ts';
import BitcoinRatchetingOverlay from '../../overlays/BitcoinRatchetingOverlay.vue';
import BitcoinOrphanRecoveryOverlay from '../../overlays/BitcoinOrphanRecoveryOverlay.vue';
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
const showReturnedOrphans = Vue.ref(false);
const selectedLock = Vue.ref<IBitcoinLockSummary>();
const selectedOrphan = Vue.ref<IBitcoinUtxoRecord>();

const orphanRecords = Vue.computed(() => {
  if (
    financials.isHistoryRecoveryInProgress ||
    bitcoinLocks.recovery.hasPendingHistoryRecovery ||
    bitcoinLocks.data.isReconciliationPending
  ) {
    return [];
  }

  const locks = bitcoinLocks.getAllLocks();
  const fundingRecordIds = new Set(
    locks
      .map(lock => bitcoinLocks.utxoTracking.getAcceptedFundingRecordForLock(lock)?.id)
      .filter((id): id is number => id !== undefined),
  );

  return bitcoinLocks.utxoTracking
    .getAllOrphanLifecycleUtxos()
    .filter(record => !fundingRecordIds.has(record.id))
    .sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime());
});
const actionableOrphanRecords = Vue.computed(() =>
  orphanRecords.value.filter(record => !bitcoinLocks.utxoTracking.isReleaseCompleteStatus(record.status)),
);
const visibleOrphanRecords = Vue.computed(() => {
  if (showReturnedOrphans.value) return orphanRecords.value;
  return actionableOrphanRecords.value;
});
const returnedOrphanCount = Vue.computed(
  () => orphanRecords.value.filter(record => bitcoinLocks.utxoTracking.isReleaseCompleteStatus(record.status)).length,
);

const selectedOrphanLock = Vue.computed(() => {
  if (!selectedOrphan.value) return undefined;
  return bitcoinLocks.getLockByUtxoId(selectedOrphan.value.lockUtxoId);
});

function orphanStatus(record: IBitcoinUtxoRecord): string {
  if (record.statusError) return 'Recovery needs attention';
  if (bitcoinLocks.utxoTracking.isReleaseCompleteStatus(record.status)) return 'Returned';
  if (record.status === BitcoinUtxoStatus.Orphaned) return 'Return required';
  if (record.status === BitcoinUtxoStatus.ReleaseIsProcessingOnBitcoin) return 'Returning on Bitcoin';
  if (record.releaseCosignVaultSignature) return 'Preparing return';
  const txStatus = bitcoinLocks.orphanReleases.getTransactionInfo(record.lockUtxoId, record)?.tx.status;
  if (txStatus && [TransactionStatus.Submitted, TransactionStatus.InBlock].includes(txStatus)) {
    return 'Submitting return request';
  }
  return 'Awaiting vault signature';
}

function orphanAction(record: IBitcoinUtxoRecord): string {
  if (record.statusError || record.status === BitcoinUtxoStatus.Orphaned) return 'Return Bitcoin';
  if (bitcoinLocks.utxoTracking.isReleaseCompleteStatus(record.status)) return 'View details';
  return 'View progress';
}

Vue.watch(visibleOrphanRecords, records => {
  if (selectedOrphan.value && !records.some(record => record.id === selectedOrphan.value?.id)) {
    selectedOrphan.value = undefined;
  }
});

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

function openNewLockingOverlay() {
  selectedLock.value = undefined;
  openLockingOverlay();
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
