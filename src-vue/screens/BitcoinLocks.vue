<template>
  <div DashBox data-testid="BitcoinLocksScreen" class="flex h-full min-h-0 grow flex-col">
    <div v-if="!isLoaded" class="flex grow items-center justify-center text-slate-500">Loading...</div>

    <!-- Blank state -->
    <div v-else-if="!financials.liquidAllRecords.length" class="flex grow flex-col">
      <div class="flex grow flex-col items-center justify-center">
        <div class="flex w-8/12 max-w-200 flex-col items-center py-10">
          <header class="text-argon-600 pb-3 text-xl font-bold">
            Argon Converts Your Bitcoin Into An Income Producing Asset
          </header>
          <p
            class="w-0 min-w-full border-y border-slate-400/50 py-4 text-justify text-[17px]/7 font-light whitespace-normal"
          >
            Argon Liquid Locking converts the full market value of your Bitcoin into unencumbered stablecoins. If
            Bitcoin's price drops after you lock, the protocol covers the difference. Either way, you retain the full
            value of your Bitcoin based on the moment it was locked — no matter what the market does afterwards. Your
            stablecoins are then yours to invest or spend however you want.
          </p>
          <span class="relative">
            <button
              @click="openLockingOverlay"
              :class="
                canStartLocking
                  ? 'bg-argon-button hover:bg-argon-button-hover border-transparent text-white'
                  : 'pointer-events-none border-gray-500 bg-white text-gray-500 opacity-40'
              "
              class="mt-12 cursor-pointer rounded-md border px-12 py-3 text-lg font-bold"
            >
              Liquid Lock Your Bitcoin
            </button>
            <ArrowCalloutButton
              v-if="controller.activeGuideId === OperationalStepId.LiquidLock && canStartLocking"
              guidance="Start your liquid lock here."
              class="absolute right-0 top-1/2 z-50 -translate-y-1/2 translate-x-[calc(100%+0.75rem)]"
            />
            <CurvedArrow class="pointer-events-none absolute top-14 left-full h-22 translate-y-1 text-slate-400/80" />
          </span>
          <div class="relative mt-14 text-center">
            <div class="pointer-events-none absolute inset-0 flex items-center justify-center">
              <div
                class="h-24 w-80 rounded-full opacity-95 blur-lg"
                style="
                  background: radial-gradient(
                    ellipse at center,
                    #fffedc 0%,
                    #fffedc 42%,
                    rgba(255, 254, 220, 0.45) 62%,
                    rgba(255, 255, 255, 0) 78%
                  );
                "
              />
            </div>

            <div v-if="bitcoinLockCoupons.currentCoupon" class="text-argon-600 relative text-xl leading-8 font-bold">
              {{ couponProviderLabel }} is gifting your first liquid lock
              <br />
              for free, up to {{ currency.symbol
              }}{{ microgonToMoneyNm(bitcoinLockCoupons.couponOfferLiquidityMicrogons || 0n).format('0,0') }}!
            </div>
            <div
              v-else-if="financials.savingsTotalReadyToUse"
              class="text-argon-600 relative text-xl leading-8 font-bold"
            >
              Your account has {{ currency.symbol
              }}{{ microgonToMoneyNm(financials.savingsTotalReadyToUse).format('0,0.00') }} in savings that is
              <br />
              ready for immediate deployment.
            </div>
            <div v-else class="text-argon-600 relative text-xl leading-8 font-bold">
              This feature is disabled until your
              <br />
              <span @click="openArgonWallet" class="hover:text-argon-600/80 inline-block cursor-pointer underline">
                argon wallet
              </span>
              is funded.
            </div>
          </div>
        </div>
      </div>
      <div class="relative px-0.5 pb-0.5">
        <img src="/treasury-footers/bitcoin-locks.png" class="w-full opacity-50" />
      </div>
    </div>

    <!-- Active lock stats + child rows -->
    <div v-else class="flex min-h-0 grow flex-col">
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
              You have {{ financials.liquidVisibleRecords.length }} BTC transaction{{
                financials.liquidVisibleRecords.length === 1 ? '' : 's'
              }}...
            </span>
            <div class="flex flex-row items-stretch gap-x-3">
              <span class="relative">
                <button @click="openLockingOverlay" class="text-md text-argon-600 cursor-pointer">
                  Lock Another Bitcoin
                </button>
                <ArrowCalloutButton
                  v-if="controller.activeGuideId === OperationalStepId.LiquidLock"
                  guidance="Start your next liquid lock here."
                  class="absolute right-0 top-1/2 z-50 -translate-y-1/2 translate-x-[calc(100%+0.75rem)]"
                />
              </span>
              <div class="w-px bg-slate-400/50" />
              <a href="https://argon.network/" target="_blank" class="text-md text-argon-600 cursor-pointer">
                View Docs
              </a>
            </div>
          </div>

          <section class="mt-4 flex grow flex-col gap-y-3 px-9 pb-10">
            <BitcoinRecord
              :data-testid="`BitcoinLocks.lockEntry.${lockSummary.uuid}`"
              v-for="lockSummary in financials.liquidVisibleRecords"
              :key="lockSummary.uuid ?? lockSummary.utxoId"
              :lockSummary="lockSummary"
              @click="openDetail(lockSummary)"
              @ratchet="openRatchetingOverlay"
              @unlock="openUnlockingOverlay"
            />
          </section>
          <div class="relative px-0.5 pb-0.5">
            <img src="/treasury-footers/bitcoin-locks.png" class="w-full opacity-50" />
          </div>
        </div>
        <div class="absolute top-0 left-0 h-10 w-full bg-linear-to-b from-white to-transparent" />
      </div>
    </div>

    <BitcoinLockingOverlay
      v-if="showLockingOverlay"
      :coupon="bitcoinLockCoupons.currentCoupon"
      :currentTick="currentTick"
      :personalLock="selectedLock?.record"
      :vault="defaultVault"
      @close="closeLockingOverlay"
    />

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
      @submitted="onRatchetSubmitted"
    />
  </div>
</template>

<script setup lang="ts">
import * as Vue from 'vue';
import numeral, { createNumeralHelpers } from '../lib/numeral.ts';
import { getCurrency } from '../stores/currency.ts';
import { getBitcoinLockCoupons, getBitcoinLocks } from '../stores/bitcoin.ts';
import { getConfig } from '../stores/config.ts';
import { getMiningFrames } from '../stores/mainchain.ts';
import { type IBitcoinLockRecord } from '../lib/db/BitcoinLocksTable.ts';
import BitcoinLockingOverlay from '../overlays/BitcoinLockingOverlay.vue';
import BitcoinLockDetailOverlay from '../overlays/BitcoinLockDetailOverlay.vue';
import BitcoinUnlockingOverlay from '../overlays/BitcoinUnlockingOverlay.vue';
import CurvedArrow from '../components/CurvedArrow.vue';
import basicEmitter from '../emitters/basicEmitter.ts';
import { WalletType } from '../lib/Wallet.ts';
import BitcoinRatchetingOverlay from '../overlays/BitcoinRatchetingOverlay.vue';
import FormattedMoney from '../components/FormattedMoney.vue';
import { UnitOfMeasurement } from '@argonprotocol/apps-core';
import type { IBitcoinLockSummary } from '../interfaces/IBitcoinLockSummary.ts';
import { useFinancials } from '../stores/financials.ts';
import { getMyVault, getVaults } from '../stores/vaults.ts';
import BitcoinRecord from './treasury-screens/components/BitcoinRecord.vue';
import ArrowCalloutButton from '../components/ArrowCalloutButton.vue';
import { OperationalStepId, useCertificationController } from '../stores/certificationController.ts';

const config = getConfig();
const controller = useCertificationController();
const currency = getCurrency();
const financials = useFinancials();
const bitcoinLocks = getBitcoinLocks();
const bitcoinLockCoupons = getBitcoinLockCoupons();
const miningFrames = getMiningFrames();
const myVault = getMyVault();
const vaults = getVaults();

const { microgonToMoneyNm } = createNumeralHelpers(currency);
const currentTick = Vue.ref(0);
const isLoaded = Vue.ref(false);
const showLockingOverlay = Vue.ref(false);
const showDetailOverlay = Vue.ref(false);
const showUnlockingOverlay = Vue.ref(false);
const showRatchetingOverlay = Vue.ref(false);
const selectedLock = Vue.ref<IBitcoinLockSummary>();
const couponProviderLabel = config.upstreamOperator?.name || 'The vault operator';
const defaultVault = Vue.computed(() => {
  const vaultId = myVault.vaultId;
  if (vaultId) {
    return myVault.createdVault ?? vaults.vaultsById[vaultId];
  }

  const couponVaultId = bitcoinLockCoupons.currentCoupon?.coupon.vaultId;
  return couponVaultId ? vaults.vaultsById[couponVaultId] : undefined;
});

const canStartLocking = Vue.computed(() => {
  return financials.savingsTotalReadyToUse > 0n || !!bitcoinLockCoupons.currentCoupon;
});

function openDetail(lock: IBitcoinLockSummary) {
  selectedLock.value = lock;
  if (bitcoinLocks.isLockedStatus(lock.record) || bitcoinLocks.isFinishedStatus(lock.record)) {
    showDetailOverlay.value = true;
  } else {
    openLockingOverlay();
  }
}

function openLockingOverlay() {
  showLockingOverlay.value = true;
}

function closeLockingOverlay() {
  showLockingOverlay.value = false;
  selectedLock.value = undefined;
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

async function onRatchetSubmitted() {
  showRatchetingOverlay.value = false;
  await bitcoinLocks.load();
}

let unsubMiningFrames: (() => void) | undefined;

function openArgonWallet() {
  basicEmitter.emit('openWalletOverlay', { walletType: WalletType.defaultArgon });
}

Vue.onMounted(async () => {
  await Promise.all([currency.isLoadedPromise, bitcoinLockCoupons.refresh(), bitcoinLocks.load(), miningFrames.load()]);

  currentTick.value = miningFrames.currentTick;
  unsubMiningFrames = miningFrames.onTick(() => {
    currentTick.value = miningFrames.currentTick;
  }).unsubscribe;

  isLoaded.value = true;
});

Vue.onUnmounted(() => {
  unsubMiningFrames?.();
});
</script>
