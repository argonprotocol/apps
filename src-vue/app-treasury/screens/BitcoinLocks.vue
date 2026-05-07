<template>
  <div class="flex h-full flex-col px-9">
    <div v-if="!isLoaded" class="flex grow items-center justify-center text-slate-500">Loading...</div>

    <template v-else>
      <!-- Active lock stats + child rows -->
      <div v-if="isLoaded && totalLockedSatoshis > 0n" class="flex flex-col">
        <section class="mt-5 mb-10 flex flex-row items-end gap-x-2 text-center">
          <div class="w-1/3 border-b border-slate-400/30 py-5">
            <div class="text-5xl font-bold">
              {{ currency.symbol }}
              <FormattedMoney :value="totalLockedSatoshis" :unitOfMeasurement="UnitOfMeasurement.Satoshi" />
            </div>
            <div>Market Value of BTC</div>
          </div>
          <div class="relative h-full w-px bg-slate-400/30">
            <div
              class="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 bg-white pt-1 pb-3 text-6xl leading-5"
            >
              =
            </div>
          </div>
          <div class="w-1/3 border-b border-slate-400/30 py-5">
            <div class="text-5xl font-bold">{{ numeral(liquidLockingReturn).format('0,0.[00]') }}%</div>
            <div>Liquid Locking Returns</div>
          </div>
          <div class="relative h-full w-px bg-slate-400/30">
            <div
              class="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 bg-white pt-2 pb-4 text-4xl leading-5 font-semibold"
            >
              vs
            </div>
          </div>
          <div class="w-1/3 border-b border-slate-400/30 py-5">
            <div class="text-5xl font-bold">{{ numeral(hodlingReturn).format('0,0.[00]') }}%</div>
            <div>Hodling Returns</div>
          </div>
        </section>

        <p>You have {{ nonReleasedLocks.length }} BTC transaction{{ nonReleasedLocks.length === 1 ? '' : 's' }}...</p>
        <div class="mt-2 flex flex-col gap-y-3">
          <div
            v-for="lock in nonReleasedLocks"
            :key="lock.uuid ?? lock.utxoId"
            @click="openDetail(lock)"
            class="flex cursor-pointer flex-row items-center gap-2.5 rounded border border-slate-400/50 bg-white px-3.5 shadow hover:bg-slate-50"
          >
            <BitcoinIcon class="h-18 text-slate-400" />
            <div class="grow">
              <div class="flex flex-row gap-1 pt-4 text-lg text-slate-800">
                <span class="font-semibold">{{ formatBtc(lock) }} BTC</span>
                <span class="font-light">expires in {{ expirationDate(lock).diff(dayjs.utc(), 'days') }} days</span>
                <div class="text-md flex grow flex-row items-center justify-end gap-x-2 text-right">
                  <button
                    @click="openRatchetingOverlay($event, lock)"
                    :class="[
                      individualReturns[lock.uuid]?.bitcoin
                        ? 'bg-argon-600 border-argon-800 text-white'
                        : 'pointer-events-none border-slate-800/5 bg-slate-600/20 text-white',
                    ]"
                    class="cursor-pointer rounded-md border px-2"
                  >
                    Ratchet
                    <span v-if="individualReturns[lock.uuid]?.bitcoin">
                      {{ individualReturns[lock.uuid]?.bitcoin > 0 ? '+' : ''
                      }}{{ numeral(individualReturns[lock.uuid]?.bitcoin).format('0,0.[00]') }}%
                    </span>
                    <template v-else>Disabled</template>
                  </button>
                  <button
                    @click="openUnlockingOverlay($event, lock)"
                    class="text-argon-600 border-argon-800 cursor-pointer rounded-md border px-2"
                  >
                    Unlock
                  </button>
                </div>
              </div>
              <div
                class="mt-3 flex flex-row divide-x-1 divide-slate-400/50 border-t border-slate-400/30 pt-3 pb-3 text-center text-slate-500"
              >
                <span class="grow">
                  {{ currency.symbol }}{{ satToMoneyNm(lock.satoshis).format('0,0.00') }} market value
                </span>
                <span class="grow">
                  {{ currency.symbol
                  }}{{ microgonToMoneyNm(getDisplayLiquidityPromised(lock)).format('0,0.00') }} received ({{
                    bitcoinLocks.getMintPercent(lock)
                  }}% minted)
                </span>
                <span class="grow">
                  {{ currency.symbol }}{{ microgonToMoneyNm(redemptiveRates[lock.uuid]).format('0,0.00') }} debt
                </span>
                <span class="grow">{{ numeral(individualReturns[lock.uuid]?.total).format('0,0.[00]') }}% return</span>
              </div>
            </div>
          </div>
        </div>

        <div
          @click="showLockingOverlay = true"
          class="mt-5 flex cursor-pointer flex-col items-center justify-center border-2 border-dashed border-slate-500/30 py-12"
        >
          + Lock Another Bitcoin
        </div>
      </div>

      <div v-else-if="isLoaded && releasedLocks.length > 0" class="flex flex-col gap-1.5">
        <div class="px-1 text-xs font-medium tracking-wide text-slate-400 uppercase">Released</div>
        <div
          v-for="lock in releasedLocks"
          :key="lock.uuid ?? lock.utxoId"
          @click="openDetail(lock)"
          class="flex cursor-pointer flex-row items-center rounded border border-slate-200/50 bg-white/50 px-4 py-2 opacity-50 hover:opacity-70"
        >
          <BitcoinIcon class="h-14 text-slate-400" />
          <div class="grow">
            <div class="font-mono text-sm font-semibold text-slate-700">{{ formatBtc(lock) }} BTC</div>
            <div class="text-xs text-slate-400">
              {{ currency.symbol }}{{ microgonToMoneyNm(getDisplayLiquidityPromised(lock)).format('0,0.00') }}
              liquidity Released
            </div>
          </div>
        </div>
      </div>

      <!-- Blank state -->
      <div v-else class="flex grow flex-col items-center justify-center">
        <div class="flex w-7/12 max-w-200 flex-col items-center pb-10">
          <div class="relative">
            <div class="relative z-10 w-20 rounded bg-white shadow-md">
              <VaultIcon class="text-argon-600 inline-block h-full w-full" />
            </div>
            <BitcoinIcon class="text-argon-600 absolute top-1/2 -left-4 z-0 h-16 w-16 -translate-1/2" />
          </div>
          <p class="mt-10 w-0 min-w-full border-y border-slate-400/50 py-4 text-[17px]/7 font-light whitespace-normal">
            Argon's Liquid Locking converts the full market value of your Bitcoin into stablecoins. If Bitcoin's price
            drops after you lock, the protocol covers the difference. Either way, you retain the full value of your
            Bitcoin based on the moment it was locked — no matter what the market does afterwards. Your stablecoins are
            then yours to invest or spend however you want.
          </p>
          <span class="relative">
            <button
              @click="openLockingOverlay"
              :class="walletBalance ? '' : 'pointer-events-none bg-slate-600 opacity-40'"
              class="bg-argon-button hover:bg-argon-button-hover mt-12 cursor-pointer rounded-md px-12 py-2.5 text-base font-bold text-white"
            >
              Liquid Lock Your Bitcoin
            </button>
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

            <div v-if="walletBalance" class="text-argon-600 relative text-xl font-bold">
              Your account has {{ currency.symbol }}{{ microgonToMoneyNm(walletBalance).format('0,0.00') }} in savings
              that is
              <br />
              ready for immediate deployment.
            </div>
            <div v-else class="text-argon-600 relative text-xl leading-8 font-bold">
              This feature is disabled until your
              <br />
              <span @click="openArgonWallet" class="hover:text-argon-600/80 cursor-pointer underline">
                argon wallet
              </span>
              is funded.
            </div>
          </div>
        </div>
      </div>
    </template>

    <BitcoinLockingOverlay
      v-if="showLockingOverlay"
      :coupon="currentCoupon"
      :currentTick="currentTick"
      :personalLock="selectedLock"
      :vault="vault"
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

    <BitcoinRatchetingOverlay
      v-if="showRatchetingOverlay && selectedLock"
      :personalLock="selectedLock"
      @close="showRatchetingOverlay = false"
      @submitted="onRatchetSubmitted"
    />
  </div>
</template>

<script setup lang="ts">
import * as Vue from 'vue';
import dayjs from 'dayjs';
import utc from 'dayjs/plugin/utc.js';
import numeral, { createNumeralHelpers } from '../../lib/numeral.ts';
import { getCurrency } from '../../stores/currency.ts';
import { getVaults } from '../../stores/vaults.ts';
import { getBitcoinLocks } from '../../stores/bitcoin.ts';
import { getConfig } from '../../stores/config.ts';
import { getMiningFrames } from '../../stores/mainchain.ts';
import { getWalletKeys, useWallets } from '../../stores/wallets.ts';
import { BitcoinLock, SATS_PER_BTC, Vault } from '@argonprotocol/mainchain';
import { BitcoinLockStatus, type IBitcoinLockRecord } from '../../lib/db/BitcoinLocksTable.ts';
import type { IBitcoinLockCouponStatus } from '@argonprotocol/apps-router';
import BitcoinIcon from '../../assets/wallets/bitcoin.svg?component';
import VaultIcon from '../../assets/vault.svg';
import BitcoinLockingOverlay from '../../app-shared/overlays/BitcoinLockingOverlay.vue';
import BitcoinLockDetailOverlay from '../../app-shared/overlays/BitcoinLockDetailOverlay.vue';
import BitcoinUnlockingOverlay from '../../app-shared/overlays/BitcoinUnlockingOverlay.vue';
import { getUpstreamOperatorClient } from '../../stores/upstreamOperator.ts';
import CurvedArrow from '../../components/CurvedArrow.vue';
import basicEmitter from '../../emitters/basicEmitter.ts';
import { WalletType } from '../../lib/Wallet.ts';
import BigNumber from 'bignumber.js';
import { calculatePerformanceReturn, IPerformanceReturnInput } from '../lib/PerformanceReturn.ts';
import BitcoinRatchetingOverlay from '../overlays/BitcoinRatchetingOverlay.vue';
import FormattedMoney from '../../components/FormattedMoney.vue';
import { bigIntMax, UnitOfMeasurement } from '@argonprotocol/apps-core';

dayjs.extend(utc);

const currency = getCurrency();
const config = getConfig();
const vaults = getVaults();
const wallets = useWallets();
const bitcoinLocks = getBitcoinLocks();
const miningFrames = getMiningFrames();
const walletKeys = getWalletKeys();
const { microgonToMoneyNm, satToMoneyNm } = createNumeralHelpers(currency);

let vault: Vault | undefined;
const availableSecuritizationMicrogons = Vue.ref(0n);
const vaultSecuritizationMicrogons = Vue.ref(0n);
const coupons = Vue.ref<IBitcoinLockCouponStatus[]>([]);
const currentTick = Vue.ref(0);
const isLoaded = Vue.ref(false);
const showLockingOverlay = Vue.ref(false);
const showDetailOverlay = Vue.ref(false);
const showUnlockingOverlay = Vue.ref(false);
const showRatchetingOverlay = Vue.ref(false);
const selectedLock = Vue.ref<IBitcoinLockRecord | undefined>();
const hodlingReturn = Vue.ref(0);
const liquidLockingReturn = Vue.ref(0);
const redemptiveRates = Vue.ref<Record<string, bigint>>({});
const individualReturns = Vue.ref<Record<string, { total: number; totalCost: bigint; bitcoin: number }>>({});

const walletBalance = Vue.computed(() => wallets.investmentWallet.availableMicrogons);

const allLocks = Vue.computed(() => {
  return bitcoinLocks.getAllLocks();
});

const nonReleasedLocks = Vue.computed(() => {
  return allLocks.value.filter(l => l.status !== BitcoinLockStatus.Released);
});

const releasedLocks = Vue.computed(() => {
  return allLocks.value.filter(l => l.status === BitcoinLockStatus.Released);
});

const totalLockedSatoshis = Vue.computed(() => {
  return nonReleasedLocks.value.reduce((sum, l) => sum + l.satoshis, 0n);
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

function expirationDate(lock: IBitcoinLockRecord) {
  const expirationMillis = bitcoinLocks.unlockDeadlineTime(lock);
  console.log('LOCK: ', lock, expirationMillis);
  return dayjs.utc(expirationMillis);
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

function openUnlockingOverlay(eventOrLock: MouseEvent | IBitcoinLockRecord, maybeLock?: IBitcoinLockRecord) {
  const lock = maybeLock ?? (eventOrLock as IBitcoinLockRecord);
  if (eventOrLock instanceof MouseEvent) {
    eventOrLock.stopPropagation();
  }

  showDetailOverlay.value = false;
  selectedLock.value = lock;
  showUnlockingOverlay.value = true;
}

function openRatchetingOverlay(event: MouseEvent, lock: IBitcoinLockRecord) {
  event.stopPropagation();
  showDetailOverlay.value = false;
  selectedLock.value = lock;
  showRatchetingOverlay.value = true;
}

async function onRatchetSubmitted() {
  showRatchetingOverlay.value = false;
  await bitcoinLocks.load();
  await updateRedemptiveRates();
}

let unsubVault: (() => void) | undefined;
let unsubMiningFrames: (() => void) | undefined;

function updateAvailableSpace(rawVault: Vault) {
  vault = rawVault;
  vaultSecuritizationMicrogons.value = rawVault.securitization;
  availableSecuritizationMicrogons.value = rawVault.availableSecuritization();
}

async function loadCurrentCoupon() {
  const upstreamOperatorClient = getUpstreamOperatorClient();
  if (!upstreamOperatorClient.operatorHost || !config.upstreamOperator?.vaultId) {
    coupons.value = [];
    return;
  }

  coupons.value = await upstreamOperatorClient.getBitcoinLockCoupons(walletKeys.liquidLockingAddress);
}

function openArgonWallet() {
  basicEmitter.emit('openWalletOverlay', { walletType: WalletType.investment });
}

async function updateRedemptiveRates() {
  const promises = nonReleasedLocks.value.map(async lock => {
    const rate = await BitcoinLock.getRedemptionRate(currency.priceIndex, lock).catch(() => 0n);
    redemptiveRates.value[lock.uuid] = rate;
  });
  await Promise.all(promises);
}

function calculateBitcoinReturn(investment: bigint, valueOfBtc: bigint): number {
  const earnings = valueOfBtc - investment;
  const pctBn = BigNumber(earnings).dividedBy(investment);
  return pctBn.multipliedBy(100).toNumber();
}

function calculateTotalReturn(
  investment: bigint,
  totalCost: bigint,
  totalLiquidity: bigint,
  valueBeyondLiquidity: bigint,
): number {
  const earnings = totalLiquidity + valueBeyondLiquidity - (investment + totalCost);
  const pctBn = BigNumber(earnings).dividedBy(investment);
  return pctBn.multipliedBy(100).toNumber();
}

function updateIndividualReturns() {
  const hodlingInvestments: IPerformanceReturnInput[] = [];
  const liquidInvestments: IPerformanceReturnInput[] = [];

  for (const lock of allLocks.value) {
    if (!lock.ratchets[0]) continue;
    const btc = currency.convertSatToBtc(lock.satoshis);
    const valueOfBtc = currency.convertBtcToMicrogon(btc);
    const totalCost = lock.ratchets.reduce((t, r) => t + r.txFee + r.securityFee, 0n);
    const totalLiquidity = lock.ratchets.reduce((t, r) => t + r.mintAmount, 0n);
    const valueBeyondLiquidity = bigIntMax(valueOfBtc - lock.lockedMarketRate, 0n);
    const startCapital = lock.ratchets[0].lockedMarketRate;
    const totalReturn = calculateTotalReturn(startCapital, totalCost, totalLiquidity, valueBeyondLiquidity);
    const bitcoinReturn = calculateBitcoinReturn(lock.lockedMarketRate, valueOfBtc);
    individualReturns.value[lock.uuid] = { bitcoin: bitcoinReturn, total: totalReturn, totalCost };

    hodlingInvestments.push({
      startDate: lock.createdAt,
      endDate: new Date(),
      startCapital: startCapital,
      endCapital: valueOfBtc,
    });
    liquidInvestments.push({
      startDate: lock.createdAt,
      endDate: new Date(),
      startCapital: startCapital,
      endCapital: totalLiquidity + valueBeyondLiquidity - totalCost,
    });
  }

  hodlingReturn.value = calculatePerformanceReturn(hodlingInvestments).percent;
  liquidLockingReturn.value = calculatePerformanceReturn(liquidInvestments).percent;
}

Vue.watch([isLoaded, () => config.upstreamOperator?.vaultId], async () => {
  if (!isLoaded.value) return;
  await loadCurrentCoupon();

  if (!config.upstreamOperator?.vaultId) return;
  unsubVault?.();
  unsubVault = await vaults.subscribeToVault(config.upstreamOperator?.vaultId, updateAvailableSpace);
});

Vue.watch([isLoaded, allLocks], () => {
  if (!isLoaded) return;
  void updateIndividualReturns();
  void updateRedemptiveRates();
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
