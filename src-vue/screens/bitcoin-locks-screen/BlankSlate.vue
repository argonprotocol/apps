<template>
  <div class="flex grow flex-col">
    <div class="flex grow flex-col items-center justify-center">
      <div class="relative flex w-8/12 max-w-200 flex-col items-center py-10">
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
            data-testid="BitcoinLocks.openLockingOverlay()"
            data-curved-arrow-end
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
            class="absolute top-1/2 right-0 z-50 translate-x-[calc(100%+0.75rem)] -translate-y-1/2"
          />
        </span>
        <div data-curved-arrow-start class="text-argon-600 relative mt-14 text-center text-xl leading-8 font-bold">
          <CurvedArrowRadialGradient />
          <div class="relative">
            <template v-if="bitcoinLockCoupons.currentCoupon">
              {{ couponProviderLabel }} is gifting your first liquid lock
              <br />
              for free, up to {{ currency.symbol
              }}{{ microgonToMoneyNm(bitcoinLockCoupons.couponOfferLiquidityMicrogons || 0n).format('0,0') }} in fees!
            </template>
            <template v-else-if="financials.savingsTotalReadyToUse">
              Your account has enough capital to
              <br />
              lock your first bitcoin!
            </template>
            <template v-else>
              This feature is disabled until your
              <br />
              <span @click="openArgonWallet" class="hover:text-argon-600/80 inline-block cursor-pointer underline">
                internal app wallet
              </span>
              is funded.
            </template>
          </div>
        </div>
        <CurvedArrow
          dynamic
          class="pointer-events-none absolute inset-0 h-full w-full overflow-visible text-slate-400/80"
        />
      </div>
    </div>
    <div class="relative px-0.5 pb-0.5">
      <img src="/treasury-footers/bitcoin-locks.png" class="w-full opacity-50" />
    </div>
  </div>

  <!-- Active lock stats + child rows -->
</template>

<script setup lang="ts">
import * as Vue from 'vue';
import numeral, { createNumeralHelpers } from '../../lib/numeral.ts';
import { getCurrency } from '../../stores/currency.ts';
import { getBitcoinLockCoupons, getBitcoinLocks } from '../../stores/bitcoin.ts';
import { getConfig } from '../../stores/config.ts';
import { getMiningFrames } from '../../stores/mainchain.ts';
import { type IBitcoinLockRecord } from '../../lib/db/BitcoinLocksTable.ts';
import BitcoinLockingOverlay from '../../overlays/BitcoinLockingOverlay.vue';
import BitcoinLockDetailOverlay from '../../overlays/BitcoinLockDetailOverlay.vue';
import BitcoinUnlockingOverlay from '../../overlays/BitcoinUnlockingOverlay.vue';
import CurvedArrow from '../../components/CurvedArrow.vue';
import CurvedArrowRadialGradient from '../../components/CurvedArrowRadialGradient.vue';
import basicEmitter from '../../emitters/basicEmitter.ts';
import { WalletType } from '../../lib/Wallet.ts';
import BitcoinRatchetingOverlay from '../../overlays/BitcoinRatchetingOverlay.vue';
import FormattedMoney from '../../components/FormattedMoney.vue';
import { NetworkConfig, UnitOfMeasurement } from '@argonprotocol/apps-core';
import type { IBitcoinLockSummary } from '../../interfaces/IBitcoinLockSummary.ts';
import { useFinancials } from '../../stores/financials.ts';
import { getMyVault, getVaults } from '../../stores/vaults.ts';
import BitcoinRecord from '../treasury-screens/components/BitcoinRecord.vue';
import BitcoinsReleasedOverlay from '../../overlays/BitcoinsReleasedOverlay.vue';
import ArrowCalloutButton from '../../components/ArrowCalloutButton.vue';
import { OperationalStepId, useCertificationController } from '../../stores/certificationController.ts';

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
const pageSourcesAreLoaded = Vue.ref(false);
const showLockingOverlay = Vue.ref(false);
const showDetailOverlay = Vue.ref(false);
const showUnlockingOverlay = Vue.ref(false);
const showRatchetingOverlay = Vue.ref(false);
const selectedLock = Vue.ref<IBitcoinLockSummary>();
const couponProviderLabel = config.upstreamOperator?.name || 'The vault operator';
const hasBitcoinRecords = Vue.computed(() => {
  return financials.bitcoinLockDisplayRecords.length > 0 || financials.liquidInvisibleRecords.length > 0;
});
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
  if (lock.record.isHistoryRecoveryPending) return;

  selectedLock.value = lock;
  if (bitcoinLocks.isLockedStatus(lock.record) || bitcoinLocks.isFinishedStatus(lock.record)) {
    showDetailOverlay.value = true;
  } else {
    openLockingOverlay();
  }
}

function openLockingOverlay() {
  basicEmitter.emit('openBitcoinLock', undefined);
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

async function onRatchetCompleted() {
  showRatchetingOverlay.value = false;
  await bitcoinLocks.load();
}

let unsubMiningFrames: (() => void) | undefined;

function openArgonWallet() {
  basicEmitter.emit('openWalletOverlay', { walletType: WalletType.defaultArgon });
}

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
