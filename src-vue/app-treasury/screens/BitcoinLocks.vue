<!-- prettier-ignore -->
<template>
  <div class="flex flex-col h-full">

    <div v-if="!isLoaded" class="flex grow items-center justify-center text-slate-500">
      Loading...
    </div>

    <template v-else>
      <!-- Active lock stats + child rows -->
      <div v-if="isLoaded && totalLockedSatoshis > 0n" class="flex flex-col">
        <div class="flex flex-row items-center gap-4 rounded-lg border border-slate-300/50 bg-white px-6 py-4 shadow-sm">
          <BitcoinIcon class="h-10 w-10 text-slate-600/60 shrink-0" />
          <div v-if="isLoaded && vaultSecuritizationMicrogons > 0n" class="mt-0.5 text-sm text-slate-400">
            <span class="font-medium text-slate-600">{{ currency.symbol }}{{ microgonToMoneyNm(availableSecuritizationMicrogons).format('0,0') }}</span>
            available in {{ operatorVaultLabel }}
            <span class="mx-1.5 text-slate-300">·</span>
            <span>{{ currency.symbol }}{{ microgonToMoneyNm(vaultSecuritizationMicrogons).format('0,0') }}</span>
            total capacity
          </div>

          <div class="flex flex-row gap-8 items-stretch grow">
            <div class="shrink-0">
              <div class="text-xs font-medium uppercase tracking-wide text-slate-400">Total Locked</div>
              <div class="mt-1 text-3xl font-bold text-slate-800 font-mono">
                {{ numeral(currency.convertSatToBtc(totalLockedSatoshis)).format('0,0.[0000]') }} BTC
              </div>
            </div>

            <div class="w-px bg-slate-100 self-stretch"></div>

            <div class="shrink-0">
              <div class="text-xs font-medium uppercase tracking-wide text-slate-400">Market Value</div>
              <div class="mt-1 text-2xl font-bold text-slate-700 font-mono">
                {{ currency.symbol }}{{ microgonToMoneyNm(totalLockedMarketValue).format('0,0.00') }}
              </div>
            </div>

            <div class="w-px bg-slate-100 self-stretch"></div>

            <div class="shrink-0">
              <div class="text-xs font-medium uppercase tracking-wide text-slate-400">Liquidity Captured</div>
              <div class="mt-1 text-2xl font-bold text-slate-700 font-mono">
                {{ currency.symbol }}{{ microgonToMoneyNm(totalLiquidityCaptured).format('0,0.00') }}
              </div>
            </div>
          </div>
        </div>

        <div class="flex flex-col gap-1.5 overflow-y-auto ml-3 mt-1.5">
          <div
            v-for="lock in nonReleasedLocks"
            :key="lock.uuid ?? lock.utxoId"
            @click="openDetail(lock)"
            class="flex cursor-pointer flex-row items-center gap-2.5 rounded border border-slate-300/50 bg-white px-3.5 py-2.5 shadow-sm hover:bg-slate-50">
            <ChevronRightIcon class="h-3.5 w-3.5 text-slate-400 shrink-0" />
            <div class="grow">
              <div class="font-mono text-sm font-semibold text-slate-800">
                {{ formatBtc(lock) }} BTC
              </div>
              <div class="text-xs text-slate-500">
                {{ currency.symbol }}{{ microgonToMoneyNm(getDisplayLiquidityPromised(lock)).format('0,0.00') }} liquidity
                · {{ lockStatusLabel(lock) }}
              </div>
            </div>
          </div>
        </div>
      </div>

      <div v-else-if="isLoaded && releasedLocks.length > 0" class="flex flex-col gap-1.5">
        <div class="text-xs font-medium uppercase tracking-wide text-slate-400 px-1">Released</div>
        <div
          v-for="lock in releasedLocks"
          :key="lock.uuid ?? lock.utxoId"
          @click="openDetail(lock)"
          class="flex cursor-pointer flex-row items-center rounded border border-slate-200/50 bg-white/50 px-4 py-2 opacity-50 hover:opacity-70">
          <div class="grow">
            <div class="font-mono text-sm font-semibold text-slate-700">
              {{ formatBtc(lock) }} BTC
            </div>
            <div class="text-xs text-slate-400">
              {{ currency.symbol }}{{ microgonToMoneyNm(getDisplayLiquidityPromised(lock)).format('0,0.00') }} liquidity
              · Released
            </div>
          </div>
        </div>
      </div>

      <!-- Blank state -->
      <div v-else class="grow flex flex-col items-center justify-center">
        <div class="flex flex-col w-7/12 max-w-200 pb-10 items-center">
          <div class="relative">
            <div class="bg-white shadow-md w-20 rounded relative z-10">
              <VaultIcon class="w-full h-full inline-block text-argon-600" />
            </div>
            <BitcoinIcon class="z-0 absolute top-1/2 -translate-1/2 -left-4 w-16 h-16 text-argon-600" />
          </div>
          <p class="w-0 min-w-full whitespace-normal border-y border-slate-400/50 py-4 mt-10 text-[17px]/7 font-light">
            Argon's Liquid Locking converts the full market value of your Bitcoin into stablecoins. If Bitcoin's price
            drops after you lock, the protocol covers the difference. Either way, you retain the full value of your
            Bitcoin based on the moment it was locked — no matter what the market does afterwards. Your stablecoins are then yours to invest
            or spend however you want.
          </p>
          <span class="relative">
            <button
              @click="openLockingOverlay"
              class="bg-argon-button hover:bg-argon-button-hover cursor-pointer rounded-md mt-12 px-12 py-2.5 text-base font-bold text-white">
              Liquid Lock Your Bitcoin
            </button>
            <CurvedArrow
              class="pointer-events-none absolute left-full top-14 h-22 text-slate-400/80 translate-y-1"
            />
          </span>
          <div class="relative mt-16 text-center">
            <div class="pointer-events-none absolute inset-0 flex items-center justify-center">
              <div
                class="h-24 w-80 rounded-full opacity-95 blur-lg"
                style="background: radial-gradient(ellipse at center, #FFFEDC 0%, #FFFEDC 42%, rgba(255, 254, 220, 0.45) 62%, rgba(255, 255, 255, 0) 78%);"
              />
            </div>

            <div class="relative text-argon-600 font-bold text-xl">
              Your account has $0.00 in savings<br />
              ready to work.
            </div>
          </div>
        </div>
      </div>

    </template>

    <BitcoinLockingOverlay
      v-if="showLockingOverlay && vault"
      :coupon="currentCoupon"
      :currentTick="currentTick"
      :personalLock="selectedLock"
      :maxLockLiquidityMicrogons="maxLockLiquidityMicrogons"
      :vault="vault!"
      @close="closeLockingOverlay"
    />

    <BitcoinLockDetailOverlay
      v-if="showDetailOverlay && selectedLock"
      :lock="selectedLock"
      @close="showDetailOverlay = false"
      @unlock="openUnlockingOverlay"
    />

    <BitcoinUnlockingOverlay
      v-if="showUnlockingOverlay"
      :personalLock="selectedLock"
      @close="showUnlockingOverlay = false"
    />
  </div>
</template>

<script setup lang="ts">
import * as Vue from 'vue';
import numeral, { createNumeralHelpers } from '../../lib/numeral.ts';
import { getCurrency } from '../../stores/currency.ts';
import { getVaults } from '../../stores/vaults.ts';
import { getBitcoinLocks } from '../../stores/bitcoin.ts';
import { getConfig } from '../../stores/config.ts';
import { getMiningFrames } from '../../stores/mainchain.ts';
import { getWalletKeys } from '../../stores/wallets.ts';
import { SATS_PER_BTC, Vault } from '@argonprotocol/mainchain';
import { BitcoinLockStatus, type IBitcoinLockRecord } from '../../lib/db/BitcoinLocksTable.ts';
import type { IBitcoinLockCouponStatus } from '@argonprotocol/apps-router';
import { ChevronRightIcon } from '@heroicons/vue/24/outline';
import BitcoinIcon from '../../assets/wallets/bitcoin.svg?component';
import VaultIcon from '../../assets/vault.svg';
import BitcoinLockingOverlay from '../../app-operations/overlays/BitcoinLockingOverlay.vue';
import BitcoinLockDetailOverlay from '../../app-operations/overlays/BitcoinLockDetailOverlay.vue';
import BitcoinUnlockingOverlay from '../../app-operations/overlays/BitcoinUnlockingOverlay.vue';
import { UpstreamOperatorClient } from '../../lib/UpstreamOperatorClient.ts';
import CurvedArrow from '../../components/CurvedArrow.vue';

const currency = getCurrency();
const config = getConfig();
const vaults = getVaults();
const bitcoinLocks = getBitcoinLocks();
const miningFrames = getMiningFrames();
const walletKeys = getWalletKeys();
const { microgonToMoneyNm } = createNumeralHelpers(currency);

let vault: Vault | undefined;
const availableSecuritizationMicrogons = Vue.ref(0n);
const maxLockLiquidityMicrogons = Vue.ref(0n);
const vaultSecuritizationMicrogons = Vue.ref(0n);
const coupons = Vue.ref<IBitcoinLockCouponStatus[]>([]);
const currentTick = Vue.ref(0);
const isLoaded = Vue.ref(false);
const showLockingOverlay = Vue.ref(false);
const showDetailOverlay = Vue.ref(false);
const showUnlockingOverlay = Vue.ref(false);
const selectedLock = Vue.ref<IBitcoinLockRecord | undefined>();

const activeLocks = Vue.computed(() => {
  return bitcoinLocks.getAllLocks();
});

const nonReleasedLocks = Vue.computed(() => {
  return activeLocks.value.filter(l => l.status !== BitcoinLockStatus.Released);
});

const releasedLocks = Vue.computed(() => {
  return activeLocks.value.filter(l => l.status === BitcoinLockStatus.Released);
});

const totalLockedSatoshis = Vue.computed(() => {
  return nonReleasedLocks.value.reduce((sum, l) => sum + l.satoshis, 0n);
});

const totalLockedMarketValue = Vue.computed(() => {
  if (totalLockedSatoshis.value <= 0n) return 0n;
  return (totalLockedSatoshis.value * currency.microgonsPer.BTC) / SATS_PER_BTC;
});

const totalLiquidityCaptured = Vue.computed(() => {
  return nonReleasedLocks.value.reduce((sum, l) => sum + getDisplayLiquidityPromised(l), 0n);
});

const operatorVaultLabel = Vue.computed(() => {
  const name = config.upstreamOperator?.name;
  if (name) return `${name}'s vault`;
  if (config.upstreamOperator?.vaultId) return `Vault #${config.upstreamOperator.vaultId}`;
  return 'the vault';
});

const couponProviderLabel = Vue.computed(() => {
  return config.upstreamOperator?.name || 'the vault operator';
});

const currentCoupon = Vue.computed(() => {
  return coupons.value.find(
    coupon => coupon.status === 'Open' && coupon.coupon.vaultId === config.upstreamOperator?.vaultId,
  );
});

function formatBtc(lock: IBitcoinLockRecord): string {
  return numeral(currency.convertSatToBtc(lock.satoshis)).format('0,0.[0000]');
}

function getDisplayLiquidityPromised(lock: IBitcoinLockRecord): bigint {
  return bitcoinLocks.getDisplayLiquidityPromised(lock);
}

function lockStatusLabel(lock: IBitcoinLockRecord): string {
  switch (lock.status) {
    case BitcoinLockStatus.LockIsProcessingOnArgon:
      if (lock.relayMetadataJson?.status === 'Failed') {
        return 'Submission Failed';
      }
      return 'Processing on Argon';
    case BitcoinLockStatus.LockPendingFunding:
      return 'Pending Funding';
    case BitcoinLockStatus.LockExpiredWaitingForFunding:
    case BitcoinLockStatus.LockExpiredWaitingForFundingAcknowledged:
      return 'Funding Expired';
    case BitcoinLockStatus.LockFundingReadyToResume:
      return 'Ready to Resume';
    case BitcoinLockStatus.LockedAndIsMinting: {
      const pct = bitcoinLocks.getMintPercent(lock);
      if (pct === 100) return 'Minted';
      return pct > 0 ? `Minting (${pct}%)` : 'Minting';
    }
    case BitcoinLockStatus.LockedAndMinted:
      return 'Locked & Minted';
    case BitcoinLockStatus.Releasing:
      return 'Releasing';
    case BitcoinLockStatus.Released:
      return 'Released';
    default:
      return lock.status;
  }
}

function openDetail(lock: IBitcoinLockRecord) {
  selectedLock.value = lock;
  if (bitcoinLocks.isLockedStatus(lock) || bitcoinLocks.isFinishedStatus(lock)) {
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

function openUnlockingOverlay(lock: IBitcoinLockRecord) {
  showDetailOverlay.value = false;
  selectedLock.value = lock;
  showUnlockingOverlay.value = true;
}

let unsubVault: (() => void) | undefined;
let unsubMiningFrames: (() => void) | undefined;

function updateAvailableSpace(rawVault: Vault) {
  vault = rawVault;
  vaultSecuritizationMicrogons.value = rawVault.securitization;
  availableSecuritizationMicrogons.value = rawVault.availableSecuritization();
  maxLockLiquidityMicrogons.value = rawVault.availableBitcoinSpace();
}

async function loadCurrentCoupon() {
  const operatorHost = config.bootstrapDetails?.routerHost;
  if (!operatorHost || !config.upstreamOperator?.vaultId) {
    coupons.value = [];
    return;
  }

  coupons.value = await UpstreamOperatorClient.getBitcoinLockCoupons(operatorHost, walletKeys.liquidLockingAddress);
}

Vue.watch([isLoaded, () => config.upstreamOperator?.vaultId], async () => {
  if (!isLoaded.value || !config.upstreamOperator?.vaultId) return;
  unsubVault?.();
  unsubVault = await vaults.subscribeToVault(config.upstreamOperator?.vaultId, updateAvailableSpace);
});

Vue.watch([isLoaded, () => config.upstreamOperator?.vaultId], async () => {
  if (!isLoaded.value) return;
  await loadCurrentCoupon();
});

Vue.onMounted(async () => {
  await config.isLoadedPromise;
  await currency.isLoadedPromise;
  await bitcoinLocks.load();
  await miningFrames.load();

  currentTick.value = miningFrames.currentTick;
  unsubMiningFrames = miningFrames.onTick(() => {
    currentTick.value = miningFrames.currentTick;
  }).unsubscribe;

  await loadCurrentCoupon();
  isLoaded.value = true;
});

Vue.onUnmounted(() => {
  unsubVault?.();
  unsubMiningFrames?.();
});
</script>
