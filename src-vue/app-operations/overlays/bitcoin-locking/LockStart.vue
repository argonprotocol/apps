<template>
  <div class="flex flex-col px-2 pt-6 pb-3">
    <div class="flex flex-col px-10">
      <p class="font-light">
        {{ vaultLabel }} has enough securitization to support up to {{ currency.symbol
        }}{{ microgonToMoneyNm(vaultCapacityLiquidityMicrogons).format('0,0.00') }} of bitcoin liquidity, which
        currently corresponds to {{ numeral(vaultCapacityBtc).format('0,0.[00000000]') }} BTC. As part of this process,
        you'll receive the full market value of your bitcoin in the form of fully liquid, unencumbered Argon
        stablecoins. We call this process "Liquid Locking".
      </p>

      <div
        v-if="hasCouponForVault && isOperatorCouponExpired"
        class="mt-4 rounded-md border border-red-300 bg-red-50 px-4 py-3 text-sm text-red-700">
        This liquid lock coupon has expired and will not be applied. Ask {{ couponProviderLabel }} for a new invite if
        you want a free lock.
      </div>

      <div
        v-else-if="isOperatorCouponLock"
        class="bg-argon-50/35 border-argon-300/70 mt-4 rounded-md border px-4 py-3 text-sm text-slate-800">
        <div class="text-argon-700 font-semibold">Free Liquid Lock Coupon Applied</div>
        <p class="mt-1">
          {{ couponProviderLabel }} is covering the vault operator fee for up to {{ couponMaxBtcLabel }} BTC with this
          coupon.
        </p>
      </div>

      <div v-if="errorMessage" data-testid="LockStart.errorMessage" class="mt-4 rounded-md bg-red-50 p-4">
        <div class="flex">
          <div class="shrink-0">
            <ExclamationTriangleIcon class="size-5 text-red-400" aria-hidden="true" />
          </div>
          <div class="ml-3">
            <div class="text-sm text-red-700">
              <p>{{ errorMessage }}</p>
            </div>
          </div>
        </div>
      </div>

      <div class="mt-5 flex flex-row gap-x-5">
        <div class="flex w-1/2 grow flex-col space-y-1">
          <label class="font-bold opacity-40">Bitcoins to Lock</label>
          <InputNumber
            data-testid="LockStart.bitcoinAmount"
            v-model="bitcoinAmount"
            @input="handleBtcChange"
            :maxDecimals="8"
            :min="0"
            :max="availableLiquidityBtc"
            suffix=" BTC"
            :dragBy="0.1"
            :dragByMin="0.01"
            class="px-1 py-2 text-lg" />
        </div>
        <div class="flex flex-col space-y-1">
          <label>&nbsp;</label>
          <div class="py-2 text-xl">=</div>
        </div>
        <div class="flex w-1/2 grow flex-col space-y-1">
          <label class="font-bold opacity-40">Argons to Receive</label>
          <InputMoney
            data-testid="LockStart.argonAmount"
            v-model="liquidityToReceiveMicrogons"
            @input="handleArgonChange"
            :maxDecimals="0"
            :min="0n"
            :max="availableLiquidityMicrogons"
            :dragBy="1_000_000n"
            :dragByMin="1_000_000n"
            class="px-1 py-2 text-lg" />
        </div>
      </div>
    </div>

    <div v-if="showFeePanel" class="mt-5 px-10">
      <section class="rounded-md border border-slate-200/80 bg-slate-50/70 px-4 py-2.5">
        <div class="flex flex-row items-center justify-between gap-x-6">
          <div>
            <div class="text-[11px] font-medium tracking-wide text-slate-400 uppercase">Lock Fee</div>
            <div class="mt-0.5 font-mono text-base text-slate-600">
              {{ currency.symbol }}{{ microgonToMoneyNm(securityFee).format('0,0.[00]') }}
            </div>
            <p class="mt-0.5 text-xs text-slate-400">Charged by the vault operator when the lock is initialized.</p>
          </div>

          <div class="min-w-42 text-right">
            <div class="text-[11px] font-medium tracking-wide text-slate-400 uppercase">Wallet Check</div>
            <div v-if="neededMicrogons > 0n" class="mt-0.5 font-mono text-sm text-red-600">
              Need {{ currency.symbol }}{{ microgonToMoneyNm(neededMicrogons).format('0,0.[00]') }} more
            </div>
            <div v-else class="mt-0.5 font-mono text-sm text-slate-600">You can afford it</div>
            <p class="mt-0.5 text-xs text-slate-400">
              {{ currency.symbol
              }}{{ microgonToMoneyNm(wallets.liquidLockingWallet.availableMicrogons).format('0,0.[00]') }}
              available
            </p>
          </div>
        </div>
      </section>
    </div>

    <div class="mt-16 flex flex-row items-center justify-end gap-x-3 border-t border-black/20 pt-4 pr-4">
      <button
        class="border-argon-600/20 cursor-pointer rounded-lg border bg-gray-200 px-10 py-1 text-lg text-black hover:bg-gray-300"
        @click="closeOverlay"
        :disabled="isSaving">
        Cancel
      </button>
      <button
        :class="isSaving ? 'bg-argon-600/60 pointer-events-none' : 'bg-argon-600 hover:bg-argon-700'"
        :disabled="isSaving"
        @click="submitLiquidLock"
        class="cursor-pointer rounded-lg px-10 py-2 text-lg font-bold text-white">
        <template v-if="isSaving">Initializing Liquid Lock</template>
        <template v-else>
          Initialize Liquid Lock
          <ChevronDoubleRightIcon class="relative -top-px inline-block size-5" />
        </template>
      </button>
    </div>
  </div>
</template>

<script setup lang="ts">
import * as Vue from 'vue';
import { ChevronDoubleRightIcon, ExclamationTriangleIcon } from '@heroicons/vue/24/outline';
import InputNumber from '../../../components/InputNumber.vue';
import InputMoney from '../../../components/InputMoney.vue';
import numeral, { createNumeralHelpers } from '../../../lib/numeral.ts';
import { getCurrency } from '../../../stores/currency.ts';
import { SATS_PER_BTC, Vault } from '@argonprotocol/mainchain';
import type { IBitcoinLockCouponStatus } from '@argonprotocol/apps-router';
import { useDebounceFn } from '@vueuse/core';
import { getBitcoinLocks } from '../../../stores/bitcoin.ts';
import { getConfig } from '../../../stores/config.ts';
import { getVaults } from '../../../stores/vaults.ts';
import { getWalletKeys, useWallets } from '../../../stores/wallets.ts';
import type { IBitcoinLockRecord } from '../../../lib/db/BitcoinLocksTable.ts';

const props = defineProps<{
  coupon?: IBitcoinLockCouponStatus;
  currentTick?: number;
  maxLockLiquidityMicrogons: bigint;
  vault: Vault;
}>();

const emit = defineEmits<{
  (e: 'close'): void;
  (e: 'lockCreated', lock: IBitcoinLockRecord): void;
}>();

const currency = getCurrency();
const vaults = getVaults();
const bitcoinLocks = getBitcoinLocks();
const config = getConfig();
const wallets = useWallets();
const walletKeys = getWalletKeys();

const { microgonToMoneyNm } = createNumeralHelpers(currency);

const vaultCapacityLiquidityMicrogons = Vue.ref(0n);
const vaultCapacityBtc = Vue.ref(0);
const availableLiquidityMicrogons = Vue.ref(0n);
const availableLiquidityBtc = Vue.ref(0);

const isSaving = Vue.ref(false);
const errorMessage = Vue.ref<string | null>(null);
const bitcoinAmount = Vue.ref(0);
const liquidityToReceiveMicrogons = Vue.ref(0n);
const lockSatoshis = Vue.ref(0n);
const securityFee = Vue.ref(0n);
const hasEditedAmounts = Vue.ref(false);

const isVaultOperator = Vue.computed(() => {
  return walletKeys.vaultingAddress === props.vault.operatorAccountId;
});

const hasCouponForVault = Vue.computed(() => {
  return props.coupon?.coupon.vaultId === props.vault.vaultId;
});

const isOperatorCouponExpired = Vue.computed(() => {
  return (
    props.coupon?.coupon.expirationTick != null &&
    props.currentTick != null &&
    props.currentTick >= props.coupon.coupon.expirationTick
  );
});

const operatorCoupon = Vue.computed(() => {
  if (!hasCouponForVault.value || isOperatorCouponExpired.value || !props.coupon) {
    return undefined;
  }

  const inviteCode = config.upstreamOperator?.inviteCode;
  const operatorHost = config.bootstrapDetails?.routerHost;
  if (!inviteCode || !operatorHost) {
    return undefined;
  }

  return {
    vaultId: props.coupon.coupon.vaultId,
    inviteCode,
    offerCode: props.coupon.coupon.offerCode,
    operatorHost,
    accountId: props.coupon.coupon.accountId,
  };
});

const isOperatorCouponLock = Vue.computed(() => {
  return !!operatorCoupon.value;
});

const vaultLabel = Vue.computed(() => {
  if (!hasCouponForVault.value) return 'Your vault';

  const name = config.upstreamOperator?.name;
  return name ? `${name}'s vault` : 'The vault';
});

const couponProviderLabel = Vue.computed(() => {
  const name = config.upstreamOperator?.name;
  return name || 'The vault operator';
});

const couponMaxBtcLabel = Vue.computed(() => {
  if (!props.coupon) {
    return numeral(currency.convertSatToBtc(lockSatoshis.value)).format('0,0.[00000000]');
  }

  return numeral(currency.convertSatToBtc(props.coupon.coupon.maxSatoshis)).format('0,0.[00000000]');
});

const neededMicrogons = Vue.computed(() => {
  if (securityFee.value <= 0n) return 0n;
  const buffer = 25_000n;
  const needed = securityFee.value + buffer;
  if (wallets.liquidLockingWallet.availableMicrogons >= needed) return 0n;
  return needed - wallets.liquidLockingWallet.availableMicrogons;
});

const showFeePanel = Vue.computed(() => {
  return !isVaultOperator.value && !isOperatorCouponLock.value && securityFee.value > 0n;
});

const handleBtcChange = useDebounceFn(internalHandleBtcChange, 100, { maxWait: 200 });
const handleArgonChange = useDebounceFn(internalHandleArgonChange, 100, { maxWait: 200 });

let lastSetLiquidityMicrogons = 0n;
let lastSetBitcoinAmount = 0;
let availableLiquiditySyncId = 0;

function updateFeeEstimate() {
  if (!props.vault || liquidityToReceiveMicrogons.value <= 0n || isVaultOperator.value || isOperatorCouponLock.value) {
    securityFee.value = 0n;
    return;
  }
  securityFee.value = props.vault.calculateBitcoinFee(liquidityToReceiveMicrogons.value);
}

function initializeDefaultAmounts(satoshis: bigint, liquidityMicrogons: bigint) {
  const btc = currency.convertSatToBtc(satoshis);

  lockSatoshis.value = satoshis;
  liquidityToReceiveMicrogons.value = liquidityMicrogons;
  bitcoinAmount.value = btc;

  lastSetLiquidityMicrogons = liquidityMicrogons;
  lastSetBitcoinAmount = btc;
}

async function internalHandleArgonChange(liquidityMicrogons: bigint) {
  if (liquidityMicrogons === lastSetLiquidityMicrogons) {
    return;
  }
  hasEditedAmounts.value = true;
  const sats = await bitcoinLocks.satoshisForArgonLiquidity(liquidityMicrogons);
  lockSatoshis.value = sats;
  const btc = currency.convertSatToBtc(sats);
  console.log(`${liquidityMicrogons} liquidity microgons -> ${sats} sats -> ${btc} btc`);
  bitcoinAmount.value = btc;
  lastSetBitcoinAmount = bitcoinAmount.value;
  lastSetLiquidityMicrogons = liquidityMicrogons;
  updateFeeEstimate();
}

async function internalHandleBtcChange(value: number) {
  if (value === lastSetBitcoinAmount) {
    return;
  }
  hasEditedAmounts.value = true;
  const sats = BigInt(Math.round(value * Number(SATS_PER_BTC)));
  lockSatoshis.value = sats;
  liquidityToReceiveMicrogons.value = await vaults.getMarketRateInMicrogons(sats);
  console.log(`Btc market rate of ${sats} sats -> ${liquidityToReceiveMicrogons.value} liquidity microgons`);
  lastSetLiquidityMicrogons = liquidityToReceiveMicrogons.value;
  lastSetBitcoinAmount = value;
  updateFeeEstimate();
}

async function submitLiquidLock() {
  if (isSaving.value) return;

  let satoshis = lockSatoshis.value;
  try {
    await config.isLoadedPromise;
    isSaving.value = true;
    errorMessage.value = null;
    if (satoshis <= 0n && liquidityToReceiveMicrogons.value > 0n) {
      satoshis = await bitcoinLocks.satoshisForArgonLiquidity(liquidityToReceiveMicrogons.value);
      lockSatoshis.value = satoshis;
    }
    if (satoshis <= 0n) {
      throw new Error('Please enter a valid amount of Argons to receive.');
    }

    await bitcoinLocks.initializeLock({
      satoshis,
      vault: props.vault,
      operatorCoupon: operatorCoupon.value,
    });
    const createdLock = bitcoinLocks.data.pendingLocks.at(-1);
    if (createdLock) {
      emit('lockCreated', createdLock);
    }
  } catch (e: any) {
    console.error('Error initializing liquid lock:', e);
    errorMessage.value = e.message;
    isSaving.value = false;
  }
}

function closeOverlay() {
  if (isSaving.value) return;
  emit('close');
}

Vue.watch(
  () => props.maxLockLiquidityMicrogons,
  async liquidityMicrogons => {
    const syncId = ++availableLiquiditySyncId;
    const nextVaultCapacityLiquidityMicrogons = liquidityMicrogons ?? 0n;
    const nextVaultCapacitySatoshis = await bitcoinLocks.satoshisForArgonLiquidity(nextVaultCapacityLiquidityMicrogons);
    let nextAvailableSatoshis = nextVaultCapacitySatoshis;

    if (props.coupon && isOperatorCouponLock.value) {
      nextAvailableSatoshis =
        props.coupon.coupon.maxSatoshis < nextVaultCapacitySatoshis
          ? props.coupon.coupon.maxSatoshis
          : nextVaultCapacitySatoshis;
    }

    const nextLiquidityMicrogons = await vaults.getMarketRateInMicrogons(nextAvailableSatoshis);

    if (syncId !== availableLiquiditySyncId) return;

    vaultCapacityLiquidityMicrogons.value = nextVaultCapacityLiquidityMicrogons;
    vaultCapacityBtc.value = currency.convertSatToBtc(nextVaultCapacitySatoshis);
    availableLiquidityMicrogons.value = nextLiquidityMicrogons;
    availableLiquidityBtc.value = currency.convertSatToBtc(nextAvailableSatoshis);

    if (!hasEditedAmounts.value || (liquidityToReceiveMicrogons.value === 0n && lockSatoshis.value === 0n)) {
      initializeDefaultAmounts(nextAvailableSatoshis, nextLiquidityMicrogons);
      if (syncId !== availableLiquiditySyncId) return;
    }

    updateFeeEstimate();
  },
  { immediate: true },
);

Vue.onMounted(async () => {
  await config.isLoadedPromise;
});
</script>
