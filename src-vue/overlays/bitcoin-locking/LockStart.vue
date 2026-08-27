<template>
  <div v-if="isLoadingLiquidity" class="flex min-h-105 flex-col items-center justify-center gap-3 text-slate-500">
    <div class="border-t-argon-500 h-8 w-8 animate-spin rounded-full border-3 border-slate-200" />
    <div>Checking vault capacity...</div>
  </div>

  <div
    v-else-if="availableLiquidityBtc <= 0"
    class="flex min-h-105 flex-col items-center justify-center px-10 py-5 text-center"
  >
    <AlertIcon class="h-18 text-yellow-700" />
    <h1 class="mt-8 text-xl font-bold text-yellow-800">This Vault Has No Bitcoin Space</h1>
    <p class="mt-4 max-w-150 text-lg leading-relaxed font-light">
      Contact the person who invited you and let them know their vault has no more bitcoin space.
    </p>
  </div>

  <div v-else class="flex flex-col px-10 py-5">
    <div class="flex flex-col pt-3">
      <h1 class="text-3xl font-bold">Choose How Much Bitcoin to Liquid Lock</h1>

      <p class="mt-3 leading-relaxed font-light">
        Liquid locking lets you maintain your bitcoin’s full chain-of-custody while protecting against price drops.
        You’ll also receive the full market value in inflation-resistant Argon stablecoins.
        <a
          class="whitespace-nowrap"
          :href="`${NetworkConfig.websiteHost}/docs/assets-and-entities/bitcoin-locks`"
          target="_blank"
        >
          Learn more.
        </a>
      </p>

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

      <div class="mt-8 flex flex-col">
        <div class="mb-2 flex flex-row items-baseline">
          <label class="grow font-bold opacity-40">Amount to Lock</label>
          <div class="flex items-baseline text-sm">
            <span v-if="isMinimumAmount" class="text-gray-600/60">Min</span>
            <button
              v-else
              type="button"
              class="text-argon-600 hover:text-argon-700 cursor-pointer"
              :disabled="isSaving || isLoadingLiquidity || availableLiquidityBtc <= 0"
              @click="setMinimumAmount"
            >
              Min
            </button>
            <span class="mx-2 text-gray-300">|</span>
            <Tooltip
              :asChild="true"
              :content="`Sets the BTC amount needed to meet the ${argonSymbol}${microgonToArgonNm(treasuryBitcoinCertificationDisplayAmount).format('0,0')} Treasury Certification requirement at the current conversion rate.`"
              side="top"
            >
              <span class="inline-flex cursor-help items-center gap-0.5">
                <span v-if="isCertificationAmount" class="text-gray-600/60">Certification</span>
                <button
                  v-else
                  type="button"
                  class="text-argon-600 hover:text-argon-700 cursor-pointer"
                  :disabled="isSaving || isLoadingLiquidity || availableLiquidityBtc <= 0"
                  @click="setCertificationAmount"
                >
                  Certification
                </button>
                <InformationCircleIcon class="size-3.5 text-gray-400" />
              </span>
            </Tooltip>
            <span class="mx-2 text-gray-300">|</span>
            <span v-if="isMaximumAmount" class="text-gray-600/60">Max</span>
            <button
              v-else
              type="button"
              class="text-argon-600 hover:text-argon-700 cursor-pointer"
              :disabled="isSaving || isLoadingLiquidity || availableLiquidityBtc <= 0"
              @click="setMaximumAmount"
            >
              Max
            </button>
          </div>
        </div>
        <div
          ref="amountInputs"
          class="focus-within:inner-input-shadow focus-within:outline-argon-button shadow-inner-lg relative flex w-full cursor-text flex-row items-center rounded-md border border-slate-700/50 focus-within:z-90 focus-within:outline-2 focus-within:-outline-offset-2"
          @click="focusAmountInput"
        >
          <div class="min-w-0 grow">
            <InputNumber
              data-testid="LockStart.bitcoinAmount"
              :data-synced-satoshis="lockSatoshis.toString()"
              :data-microgons-per-btc="conversionQuoteMicrogonsPerBtc.toString()"
              v-model="bitcoinAmount"
              @input="handleBtcChange"
              :disabled="isSaving || isLoadingLiquidity"
              :minDecimals="2"
              :maxDecimals="8"
              :min="0"
              :dragBy="0.1"
              :dragByMin="0.01"
              :hideArrows="true"
              suffix=" BTC"
              class="w-fit border-0 px-1 py-2 text-[17px]! focus-within:shadow-none! focus-within:outline-0! hover:bg-transparent!"
            />
          </div>
        </div>
        <div class="mt-2 flex items-center justify-between gap-4 text-sm text-slate-500">
          <span
            data-testid="LockStart.convertedAmounts"
            class="inline-flex items-center gap-3 rounded px-1 transition-colors duration-300"
            :class="isConversionRateHighlighted ? 'animate-pulse bg-amber-100 text-amber-800' : ''"
          >
            <span>≈ {{ argonSymbol }}{{ microgonToArgonNm(liquidityToReceive).format('0,0.00') }}</span>
            <span>·</span>
            <span>{{ usdSymbol }}{{ microgonToNm(liquidityToReceive, UnitOfMeasurement.USD).format('0,0.00') }}</span>
          </span>
          <span class="shrink-0">
            One-time fee:
            <template v-if="isVaultOperator">Waived</template>
            <template v-else-if="operatorCoupon">
              <span class="line-through">
                {{ argonSymbol }}{{ microgonToArgonNm(oneTimeLockFee).format('0,0.00') }}
              </span>
              {{ argonSymbol }}{{ microgonToArgonNm(securityFee).format('0,0.00') }} after gift
            </template>
            <template v-else>
              {{ argonSymbol }}{{ microgonToArgonNm(securityFee).format('0,0.00') }}, paid from your wallet
            </template>
          </span>
        </div>
        <div
          v-if="isOverVaultBitcoinCapacity"
          class="relative mt-3 flex items-center rounded border border-yellow-400/70 bg-yellow-100 px-3 py-3 text-yellow-900"
        >
          <AlertIcon class="mr-2 h-4 shrink-0 text-yellow-700" />
          <span>
            <template v-if="liquidityToReceive === treasuryBitcoinCertificationDisplayAmount">
              Treasury Certification requires {{ argonSymbol
              }}{{ microgonToArgonNm(treasuryBitcoinCertificationDisplayAmount).format('0,0') }} of locked Bitcoin, but
              {{ vaultLabel }} currently has space for only {{ argonSymbol
              }}{{ microgonToArgonNm(availableLiquidityMicrogons).format('0,0') }}.
            </template>
            <template v-else>
              {{ vaultLabel }} currently has space for only {{ argonSymbol
              }}{{ microgonToArgonNm(availableLiquidityMicrogons).format('0,0') }} of locked Bitcoin.
            </template>
            Choose Max to use that available Bitcoin space.
          </span>
        </div>
        <WalletFundingCallout
          v-else-if="isCheckingWalletBalance && availableMicrogons < vault.terms.bitcoinBaseFee"
          arrowSide="right"
          @open-wallet="openWallet"
        >
          <AlertIcon class="mr-2 h-4 text-yellow-700" />
          Your wallet can’t cover the {{ argonSymbol
          }}{{ microgonToArgonNm(vault.terms.bitcoinBaseFee).format('0,0.00') }} base fee. Checking the full balance
          needed…
        </WalletFundingCallout>
        <WalletFundingCallout v-else-if="neededMicrogons" arrowSide="right" @open-wallet="openWallet">
          <AlertIcon class="mr-2 h-4 text-yellow-700" />
          <template v-if="requiredWalletBalanceMicrogons != null">
            Your wallet needs a balance of {{ argonSymbol
            }}{{ microgonToArgonNm(requiredWalletBalanceMicrogons).format('0,0.00') }} to initialize this lock.
          </template>
          <template v-else>
            Your wallet needs {{ availableMicrogons ? '' : 'another' }} {{ argonSymbol
            }}{{ microgonToArgonNm(neededMicrogons).format('0,0.00') }} to initialize this lock.
          </template>
        </WalletFundingCallout>

        <section class="border-argon-600/30 mt-6 rounded-md border">
          <div class="flex flex-row py-7 text-center">
            <div class="w-1/3 px-3">
              <header class="font-bold opacity-40">ONE-TIME LOCK FEE</header>
              <div class="text-argon-600 py-1 text-3xl font-bold">
                <template v-if="isVaultOperator">Waived</template>
                <template v-else-if="operatorCoupon">
                  <span class="text-slate-400 line-through">
                    {{ argonSymbol }}{{ microgonToArgonNm(securityFee + coveredFee).format('0,0.00') }}
                  </span>
                  <span class="ml-2">{{ argonSymbol }}{{ microgonToArgonNm(securityFee).format('0,0.00') }}</span>
                </template>
                <template v-else>{{ argonSymbol }}{{ microgonToArgonNm(securityFee).format('0,0.00') }}</template>
              </div>
              <div class="font-light opacity-80">
                <template v-if="operatorCoupon">
                  {{ argonSymbol }}{{ microgonToArgonNm(coveredFee).format('0,0.00') }} fee waiver from
                  {{ couponProviderLabel }}
                </template>
                <template v-else-if="isVaultOperator">No Operator Fee Charged</template>
                <template v-else>It's the Only Cost of Locking</template>
              </div>
            </div>
            <div class="min-h-full min-w-px bg-slate-600/20" />
            <div class="w-1/3 px-3">
              <header class="font-bold opacity-40">YOU WILL RECEIVE</header>
              <div class="text-argon-600 py-1 text-3xl font-bold">
                {{ argonSymbol }}{{ microgonToArgonNm(liquidityToReceive).format('0,0') }}
              </div>
              <div class="font-light opacity-80">In Unencumbered Argons</div>
            </div>
            <div class="min-h-full min-w-px bg-slate-600/20" />
            <div class="w-1/3 px-3">
              <header class="font-bold opacity-40">PROJECTED EARNINGS</header>
              <div class="text-argon-600 py-1 text-3xl font-bold">
                +{{ argonSymbol }}{{ microgonToArgonNm(projectedEarnings).format('0,0') }}
              </div>
              <div class="font-light opacity-80">Modeled Over One Year</div>
            </div>
          </div>
          <div class="mx-2 border-t border-slate-600/30 px-2 py-3 font-light italic opacity-70">
            * The value of your {{ formatBtc(bitcoinAmount) }} BTC is protected even if bitcoin's market's price falls.
            <a :href="`${NetworkConfig.websiteHost}/docs/assets-and-entities/bitcoin-locks`" target="_blank">
              Learn more.
            </a>
          </div>
        </section>
      </div>
    </div>

    <div class="mt-3 flex flex-row items-center justify-end gap-x-3 py-3">
      <button
        class="cursor-pointer rounded-md border border-slate-300 px-10 py-2 text-slate-600 hover:bg-slate-50 disabled:opacity-40"
        @click="closeOverlay"
        :disabled="isSaving"
      >
        Cancel
      </button>
      <button
        :disabled="cannotContinue"
        @click="submitLiquidLock"
        class="bg-argon-button enabled:hover:bg-argon-button-hover cursor-pointer rounded-md px-10 py-2 font-semibold text-white disabled:cursor-default disabled:opacity-40"
      >
        <template v-if="isSaving">Initializing Liquid Lock</template>
        <template v-else>
          Continue to Locking
          <ChevronDoubleRightIcon class="relative -top-px inline-block size-5" />
        </template>
      </button>
    </div>
  </div>
</template>

<script setup lang="ts">
import * as Vue from 'vue';
import { ChevronDoubleRightIcon, ExclamationTriangleIcon, InformationCircleIcon } from '@heroicons/vue/24/outline';
import InputNumber from '../../components/InputNumber.vue';
import Tooltip from '../../components/Tooltip.vue';
import { createNumeralHelpers, formatBtc } from '../../lib/numeral.ts';
import { getCurrency } from '../../stores/currency.ts';
import { MICROGONS_PER_ARGON } from '@argonprotocol/mainchain';
import type { IBitcoinLockCouponStatus } from '@argonprotocol/apps-router';
import { useDebounceFn } from '@vueuse/core';
import { getBitcoinLockCoupons, getBitcoinLocks } from '../../stores/bitcoin.ts';
import { getConfig } from '../../stores/config.ts';
import { getVaults } from '../../stores/vaults.ts';
import { getWalletKeys, useWallets } from '../../stores/wallets.ts';
import { getMainchainClient } from '../../stores/mainchain.ts';
import type { IBitcoinLockRecord } from '../../lib/db/BitcoinLocksTable.ts';
import { BitcoinLockWalletFundingError } from '../../lib/BitcoinLocks.ts';
import {
  bigIntMax,
  bigIntMin,
  bigNumberToBigInt,
  NetworkConfig,
  UnitOfMeasurement,
  BitcoinLock,
  SATS_PER_BTC,
  Vault,
} from '@argonprotocol/apps-core';
import WalletFundingCallout from '../../components/WalletFundingCallout.vue';
import basicEmitter from '../../emitters/basicEmitter.ts';
import { WalletType } from '../../lib/Wallet.ts';
import AlertIcon from '../../assets/alert.svg?component';
import BigNumber from 'bignumber.js';
import { useVaultingStats } from '../../stores/vaultingStats.ts';
import { treasuryBitcoinCertificationDisplayAmount } from '../../stores/certificationController.ts';

const props = defineProps<{
  coupon?: IBitcoinLockCouponStatus;
  currentTick?: number;
  vault: Vault;
}>();

const emit = defineEmits<{
  (e: 'close'): void;
  (e: 'lockCreated', lock: IBitcoinLockRecord): void;
}>();

const currency = getCurrency();
const vaults = getVaults();
const bitcoinLocks = getBitcoinLocks();
const bitcoinLockCoupons = getBitcoinLockCoupons();
const config = getConfig();
const wallets = useWallets();
const walletKeys = getWalletKeys();
const vaultingStats = useVaultingStats();

const { microgonToArgonNm, microgonToNm } = createNumeralHelpers(currency);
const argonSymbol = currency.recordsByKey[UnitOfMeasurement.ARGN].symbol;
const usdSymbol = currency.recordsByKey[UnitOfMeasurement.USD].symbol;
const vaultLabel = Vue.computed(() => {
  const name = vaults.operatorNamesByVaultId[props.vault.vaultId];
  if (name) return `${name}’s Vault`;
  return 'This vault';
});

const availableLiquidityMicrogons = Vue.ref(0n);
const availableLiquidityBtc = Vue.ref(0);
const minimumLockSatoshis = Vue.ref(0n);
const conversionQuoteMicrogonsPerBtc = Vue.ref(0n);
const isConversionRateHighlighted = Vue.ref(false);

const isSaving = Vue.ref(false);
const isLoadingLiquidity = Vue.ref(true);
const errorMessage = Vue.ref<string | null>(null);
const bitcoinAmount = Vue.ref(0);
const liquidityToReceive = Vue.ref(0n);
const lockSatoshis = Vue.ref(0n);
const securityFee = Vue.ref(0n);
const requiredWalletBalanceMicrogons = Vue.ref<bigint>();
const isCheckingWalletBalance = Vue.ref(false);
const amountSelection = Vue.ref<'bitcoin' | 'minimum' | 'certification' | 'maximum'>();
const amountInputs = Vue.ref<HTMLElement | null>(null);

function focusAmountInput(event: MouseEvent) {
  const target = event.target as HTMLElement;
  if (target.closest('[data-testid="LockStart.bitcoinAmount"]')) {
    return;
  }

  amountInputs.value?.querySelector<HTMLElement>('[data-testid="input-number"]')?.focus();
}

const isMinimumAmount = Vue.computed(() => lockSatoshis.value === minimumLockSatoshis.value);
const isCertificationAmount = Vue.computed(
  () => liquidityToReceive.value === treasuryBitcoinCertificationDisplayAmount,
);
const isMaximumAmount = Vue.computed(() => liquidityToReceive.value === availableLiquidityMicrogons.value);
const isOverVaultBitcoinCapacity = Vue.computed(() => liquidityToReceive.value > availableLiquidityMicrogons.value);

const isVaultOperator = Vue.computed(() => {
  return walletKeys.defaultArgonAddress === props.vault.operatorAccountId;
});

const operatorCoupon = Vue.computed(() => {
  const resumableCoupon = bitcoinLockCoupons.resumableCoupon;
  const currentCoupon = bitcoinLockCoupons.currentCoupon;

  let coupon;
  if (resumableCoupon?.coupon.vaultId === props.vault.vaultId) coupon = resumableCoupon;
  else if (currentCoupon?.coupon.vaultId === props.vault.vaultId) coupon = currentCoupon;

  if (!coupon) return;
  if (
    coupon.coupon.expirationTick != null &&
    props.currentTick != null &&
    props.currentTick >= coupon.coupon.expirationTick
  )
    return;

  const pendingInitialization = coupon.uses?.find(use => use.status === 'Prepared' && use.feeCoupon);

  return {
    vaultId: coupon.coupon.vaultId,
    offerCode: coupon.coupon.offerCode,
    accountId: coupon.coupon.accountId,
    remainingFeeCreditMicrogons: coupon.remainingFeeCreditMicrogons,
    pendingInitialization,
  };
});

const capacityLockOwner = Vue.computed(() => {
  return operatorCoupon.value ? undefined : walletKeys.liquidLockingAddress;
});

const couponProviderLabel = Vue.computed(() => {
  const name = config.upstreamOperator?.name;
  return name || 'The vault operator';
});

const availableMicrogons = Vue.computed(() => {
  return wallets.liquidLockingWallet.availableMicrogons;
});

const neededMicrogons = Vue.computed(() => {
  if (!wallets.isLoaded) return 0n;
  if (operatorCoupon.value && requiredWalletBalanceMicrogons.value == null) return 0n;
  const requiredBalance = requiredWalletBalanceMicrogons.value ?? securityFee.value;
  if (requiredBalance <= 0n) return 0n;
  if (availableMicrogons.value >= requiredBalance) return 0n;
  return requiredBalance - availableMicrogons.value;
});

function openWallet() {
  basicEmitter.emit('openWalletOverlay', { walletType: WalletType.defaultArgon });
}

const oneTimeLockFee = Vue.computed(() => {
  if (liquidityToReceive.value <= 0n) return 0n;
  return props.vault.calculateBitcoinFee(liquidityToReceive.value);
});

const coveredFee = Vue.computed(() => {
  if (!operatorCoupon.value) return 0n;
  const variableFee = bigIntMax(oneTimeLockFee.value - props.vault.terms.bitcoinBaseFee, 0n);
  const feeCredit =
    (operatorCoupon.value?.pendingInitialization?.feeCreditMicrogons ?? 0n) +
    (operatorCoupon.value?.remainingFeeCreditMicrogons ?? 0n);
  return bigIntMin(variableFee, feeCredit);
});

const projectedEarnings = Vue.computed(() => {
  const bitcoinAPR = Math.max(0, Math.min(999, vaultingStats.bitcoinAPR));
  return bigNumberToBigInt(BigNumber(liquidityToReceive.value.toString()).multipliedBy(bitcoinAPR).dividedBy(100));
});

const cannotContinue = Vue.computed(() => {
  return (
    isSaving.value ||
    isLoadingLiquidity.value ||
    !wallets.isLoaded ||
    isCheckingWalletBalance.value ||
    (operatorCoupon.value && requiredWalletBalanceMicrogons.value == null) ||
    lockSatoshis.value <= 0n ||
    liquidityToReceive.value <= 0n ||
    liquidityToReceive.value > availableLiquidityMicrogons.value ||
    neededMicrogons.value > 0n
  );
});

const debouncedHandleBtcChange = useDebounceFn(internalHandleBtcChange, 100, { maxWait: 200 });

const lastSetLiquidityMicrogons = Vue.ref(0n);
let lastSetBitcoinAmount = 0;
let availableLiquiditySyncId = 0;
let pendingAmountSync: Promise<unknown> | undefined;
let pendingQuoteRefresh: Promise<boolean> | undefined;
let feeCouponRefreshTimeout: ReturnType<typeof setTimeout> | undefined;
let conversionQuoteExpiresAt = 0;
let conversionQuoteRefreshTimeout: ReturnType<typeof setTimeout> | undefined;
let conversionHighlightTimeout: ReturnType<typeof setTimeout> | undefined;
let walletBalanceEstimateSyncId = 0;
let amountSelectionSyncId = 0;
let isUnmounted = false;

const CONVERSION_QUOTE_REFRESH_ERROR = 'Unable to refresh the Bitcoin conversion rate. Retrying shortly.';
const WALLET_BALANCE_ESTIMATE_ERROR = 'Unable to check the wallet balance needed for this lock. Please try again.';

function updateFeeEstimate() {
  if (!props.vault || liquidityToReceive.value <= 0n || isVaultOperator.value) {
    securityFee.value = 0n;
    return;
  }
  securityFee.value = props.vault.calculateBitcoinFee(liquidityToReceive.value) - coveredFee.value;
}

const estimateWalletBalance = useDebounceFn(
  async (syncId: number) => {
    try {
      const estimate = await bitcoinLocks.getInitializeFeeEstimate({
        vault: props.vault,
        satoshis: lockSatoshis.value,
        microgonsAtTargetPerBtc: conversionQuoteMicrogonsPerBtc.value,
        feeDiscountMicrogons: coveredFee.value,
      });
      if (syncId !== walletBalanceEstimateSyncId || isUnmounted) return;

      requiredWalletBalanceMicrogons.value = estimate.requiredWalletBalanceMicrogons;
      if (errorMessage.value === WALLET_BALANCE_ESTIMATE_ERROR) errorMessage.value = null;
    } catch (error) {
      if (syncId !== walletBalanceEstimateSyncId || isUnmounted) return;

      console.error('Error estimating the Bitcoin lock wallet balance:', error);
      errorMessage.value = WALLET_BALANCE_ESTIMATE_ERROR;
    } finally {
      if (syncId === walletBalanceEstimateSyncId) isCheckingWalletBalance.value = false;
    }
  },
  100,
  { maxWait: 200 },
);

Vue.watch(coveredFee, updateFeeEstimate);
Vue.watch(
  [() => !!operatorCoupon.value, lockSatoshis, conversionQuoteMicrogonsPerBtc, coveredFee],
  () => {
    const syncId = ++walletBalanceEstimateSyncId;
    requiredWalletBalanceMicrogons.value = undefined;
    isCheckingWalletBalance.value =
      !!operatorCoupon.value && lockSatoshis.value > 0n && conversionQuoteMicrogonsPerBtc.value > 0n;

    if (isCheckingWalletBalance.value) void estimateWalletBalance(syncId);
  },
  { immediate: true },
);

function initializeDefaultAmounts(satoshis: bigint, liquidityMicrogons: bigint) {
  const btc = currency.convertSatToBtc(satoshis);

  lockSatoshis.value = satoshis;
  liquidityToReceive.value = liquidityMicrogons;
  bitcoinAmount.value = btc;

  lastSetLiquidityMicrogons.value = liquidityMicrogons;
  lastSetBitcoinAmount = btc;
}

async function internalHandleBtcChange(value: number) {
  if (value === lastSetBitcoinAmount) {
    return;
  }
  const satoshis = bigNumberToBigInt(BigNumber(value).multipliedBy(SATS_PER_BTC.toString()));
  lockSatoshis.value = satoshis;
  liquidityToReceive.value = bitcoinLocks.argonLiquidityForSatoshis(satoshis, conversionQuoteMicrogonsPerBtc.value);
  lastSetLiquidityMicrogons.value = liquidityToReceive.value;
  lastSetBitcoinAmount = value;
  updateFeeEstimate();

  if (Date.now() >= conversionQuoteExpiresAt) {
    try {
      await refreshConversionQuote();
    } catch (error) {
      handleConversionQuoteRefreshError(error);
    }
  }
}

function handleBtcChange(value: number) {
  amountSelection.value = 'bitcoin';
  amountSelectionSyncId += 1;
  const sync = debouncedHandleBtcChange(value).finally(() => {
    if (pendingAmountSync === sync) {
      pendingAmountSync = undefined;
    }
  });
  pendingAmountSync = sync;
}

function setMinimumAmount() {
  amountSelection.value = 'minimum';
  amountSelectionSyncId += 1;
  const liquidityMicrogons = bitcoinLocks.argonLiquidityForSatoshis(
    minimumLockSatoshis.value,
    conversionQuoteMicrogonsPerBtc.value,
  );
  initializeDefaultAmounts(minimumLockSatoshis.value, liquidityMicrogons);
  updateFeeEstimate();
}

async function setCertificationAmount() {
  amountSelection.value = 'certification';
  amountSelectionSyncId += 1;
  const satoshis = await bitcoinLocks.satoshisForArgonLiquidity(
    treasuryBitcoinCertificationDisplayAmount,
    conversionQuoteMicrogonsPerBtc.value,
  );
  initializeDefaultAmounts(satoshis, treasuryBitcoinCertificationDisplayAmount);
  updateFeeEstimate();
}

async function setMaximumAmount() {
  amountSelection.value = 'maximum';
  amountSelectionSyncId += 1;
  const satoshis = await bitcoinLocks.satoshisForArgonLiquidity(
    availableLiquidityMicrogons.value,
    conversionQuoteMicrogonsPerBtc.value,
  );
  initializeDefaultAmounts(satoshis, availableLiquidityMicrogons.value);
  updateFeeEstimate();
}

async function submitLiquidLock() {
  if (cannotContinue.value) return;
  isSaving.value = true;

  try {
    await config.isLoadedPromise;
    await pendingAmountSync;

    if (Date.now() >= conversionQuoteExpiresAt) {
      const quoteChanged = await refreshConversionQuote();
      if (quoteChanged) {
        errorMessage.value = 'The Bitcoin conversion rate was updated. Review the new amount and continue again.';
        isSaving.value = false;
        return;
      }
    }

    let satoshis = lockSatoshis.value;
    errorMessage.value = null;
    if (satoshis <= 0n && liquidityToReceive.value > 0n) {
      satoshis = await bitcoinLocks.satoshisForArgonLiquidity(
        liquidityToReceive.value,
        conversionQuoteMicrogonsPerBtc.value,
      );
      lockSatoshis.value = satoshis;
    }
    if (satoshis <= 0n) {
      throw new Error('Please enter a valid amount of Bitcoin to lock.');
    }
    const currentAvailableLiquidity = props.vault.availableBitcoinSpace(capacityLockOwner.value) ?? 0n;
    if (liquidityToReceive.value - currentAvailableLiquidity > 1n) {
      throw new Error("This amount is above the vault's remaining capacity. Lower the Bitcoin amount and try again.");
    }

    const { pendingLock } = await bitcoinLocks.initializeLock({
      satoshis,
      vault: props.vault,
      operatorCoupon: operatorCoupon.value,
      microgonsAtTargetPerBtc: conversionQuoteMicrogonsPerBtc.value,
    });
    emit('lockCreated', pendingLock);
    if (operatorCoupon.value) {
      void bitcoinLockCoupons.refresh().catch(error => {
        console.warn('Unable to refresh the Bitcoin fee coupon after initialization', error);
      });
    }
  } catch (error) {
    console.error('Error initializing liquid lock:', error);
    if (operatorCoupon.value) {
      await bitcoinLockCoupons.refresh().catch(refreshError => {
        console.warn('Unable to refresh the Bitcoin fee coupon', refreshError);
      });
    }
    if (error instanceof BitcoinLockWalletFundingError) {
      requiredWalletBalanceMicrogons.value = error.requiredWalletBalanceMicrogons;
      errorMessage.value = null;
    } else {
      errorMessage.value = error instanceof Error ? error.message : String(error);
    }
    isSaving.value = false;
  }
}

function closeOverlay() {
  if (isSaving.value) return;
  emit('close');
}

async function setLiquidityVariables() {
  const syncId = ++availableLiquiditySyncId;
  const amountSyncId = amountSelectionSyncId;
  const [capacity, nextMinimumLockSatoshis] = await Promise.all([
    bitcoinLocks.getLockableBitcoinCapacity({
      vault: props.vault,
      lockOwner: capacityLockOwner.value,
      maxSatoshis: operatorCoupon.value ? bitcoinLockCoupons.maximumCoveredLockSatoshis : undefined,
      microgonsAtTargetPerBtc: conversionQuoteMicrogonsPerBtc.value,
    }),
    bitcoinLocks.minimumSatoshiPerLock(),
  ]);
  const {
    availableLiquidityMicrogons: nextAvailableLiquidityMicrogons,
    availableSatoshis: nextAvailableSatoshis,
    vaultCapacitySatoshis,
  } = capacity;
  const wholeArgonMicrogons = BigInt(MICROGONS_PER_ARGON);
  const partialArgonMicrogons = nextAvailableLiquidityMicrogons % wholeArgonMicrogons;
  const nextWholeArgonLiquidityMicrogons =
    nextAvailableSatoshis === vaultCapacitySatoshis && partialArgonMicrogons === wholeArgonMicrogons - 1n
      ? nextAvailableLiquidityMicrogons + 1n
      : nextAvailableLiquidityMicrogons - partialArgonMicrogons;
  const nextWholeArgonSatoshis =
    nextWholeArgonLiquidityMicrogons > 0n
      ? await bitcoinLocks.satoshisForArgonLiquidity(
          nextWholeArgonLiquidityMicrogons,
          conversionQuoteMicrogonsPerBtc.value,
        )
      : 0n;
  if (syncId !== availableLiquiditySyncId) return;

  availableLiquidityMicrogons.value = nextWholeArgonLiquidityMicrogons;
  availableLiquidityBtc.value = currency.convertSatToBtc(nextWholeArgonSatoshis);
  minimumLockSatoshis.value = nextMinimumLockSatoshis;
  if (amountSyncId !== amountSelectionSyncId) return;

  const pendingSatoshis = operatorCoupon.value?.pendingInitialization?.requestedSatoshis;
  const isInitialAmount = amountSelection.value == null;
  const selection = amountSelection.value ?? (pendingSatoshis ? 'bitcoin' : 'certification');

  let selectedSatoshis = lockSatoshis.value;
  let selectedLiquidityMicrogons: bigint;

  if (selection === 'minimum') {
    selectedSatoshis = nextMinimumLockSatoshis;
    selectedLiquidityMicrogons = bitcoinLocks.argonLiquidityForSatoshis(
      selectedSatoshis,
      conversionQuoteMicrogonsPerBtc.value,
    );
  } else if (selection === 'maximum') {
    selectedSatoshis = nextWholeArgonSatoshis;
    selectedLiquidityMicrogons = nextWholeArgonLiquidityMicrogons;
  } else if (selection === 'certification') {
    selectedLiquidityMicrogons = treasuryBitcoinCertificationDisplayAmount;
    selectedSatoshis = await bitcoinLocks.satoshisForArgonLiquidity(
      selectedLiquidityMicrogons,
      conversionQuoteMicrogonsPerBtc.value,
    );
  } else {
    selectedSatoshis = isInitialAmount ? (pendingSatoshis ?? 0n) : selectedSatoshis;
    selectedLiquidityMicrogons = bitcoinLocks.argonLiquidityForSatoshis(
      selectedSatoshis,
      conversionQuoteMicrogonsPerBtc.value,
    );
  }

  if (syncId !== availableLiquiditySyncId || amountSyncId !== amountSelectionSyncId) return;

  amountSelection.value = selection;
  initializeDefaultAmounts(selectedSatoshis, selectedLiquidityMicrogons);

  updateFeeEstimate();
}

async function refreshConversionQuote(): Promise<boolean> {
  if (pendingQuoteRefresh) return await pendingQuoteRefresh;

  const refresh = (async () => {
    const quoteClient = await getMainchainClient(false);
    const [, eligibleRates, currentTick] = await Promise.all([
      currency.fetchMainchainRates(quoteClient, { ignoreCache: true }),
      quoteClient.query.bitcoinLocks.microgonPerBtcHistory(),
      quoteClient.query.ticks.currentTick(),
    ]);

    const previousQuote = conversionQuoteMicrogonsPerBtc.value;
    const eligibleRate = eligibleRates.at(-1);
    if (!eligibleRate || eligibleRate[1] <= 0n) {
      throw new Error('Network bitcoin pricing is currently unavailable. Please try again later.');
    }
    const nextQuote = eligibleRate[1];
    const quoteTicksRemaining = Math.max(
      1,
      Number(eligibleRate[0]) + quoteClient.consts.bitcoinLocks.maxBtcPriceTickAge.toNumber() - currentTick,
    );
    const quoteDurationMillis = quoteTicksRemaining * NetworkConfig.tickMillis;
    conversionQuoteMicrogonsPerBtc.value = nextQuote;
    try {
      await setLiquidityVariables();
    } catch (error) {
      conversionQuoteMicrogonsPerBtc.value = previousQuote;
      throw error;
    }

    conversionQuoteExpiresAt = Date.now() + quoteDurationMillis;
    if (errorMessage.value === CONVERSION_QUOTE_REFRESH_ERROR) errorMessage.value = null;
    scheduleConversionQuoteRefresh(quoteDurationMillis);

    const quoteChanged = previousQuote > 0n && previousQuote !== nextQuote;
    if (quoteChanged && !isUnmounted) {
      isConversionRateHighlighted.value = true;
      if (conversionHighlightTimeout) clearTimeout(conversionHighlightTimeout);
      conversionHighlightTimeout = setTimeout(() => {
        isConversionRateHighlighted.value = false;
      }, 4e3);
    }
    return quoteChanged;
  })();

  pendingQuoteRefresh = refresh;
  try {
    return await refresh;
  } finally {
    pendingQuoteRefresh = undefined;
  }
}

function scheduleConversionQuoteRefresh(delay: number) {
  if (isUnmounted) return;
  if (conversionQuoteRefreshTimeout) clearTimeout(conversionQuoteRefreshTimeout);
  conversionQuoteRefreshTimeout = setTimeout(() => {
    void refreshConversionQuote().catch(handleConversionQuoteRefreshError);
  }, delay);
}

function handleConversionQuoteRefreshError(error: unknown) {
  console.error('Error refreshing Bitcoin conversion quote:', error);
  errorMessage.value = CONVERSION_QUOTE_REFRESH_ERROR;
  scheduleConversionQuoteRefresh(30e3);
}

function scheduleFeeCouponRefresh(delay = 5e3) {
  if (feeCouponRefreshTimeout) clearTimeout(feeCouponRefreshTimeout);
  feeCouponRefreshTimeout = undefined;
  if (isUnmounted || !operatorCoupon.value || operatorCoupon.value.remainingFeeCreditMicrogons != null) {
    return;
  }

  feeCouponRefreshTimeout = setTimeout(() => {
    void bitcoinLockCoupons
      .refresh()
      .catch(() => undefined)
      .finally(() => scheduleFeeCouponRefresh());
  }, delay);
}

Vue.watch(
  () => operatorCoupon.value?.remainingFeeCreditMicrogons,
  () => scheduleFeeCouponRefresh(0),
  {
    immediate: true,
  },
);

Vue.onMounted(async () => {
  await config.isLoadedPromise;
  try {
    await refreshConversionQuote();
  } finally {
    isLoadingLiquidity.value = false;
  }
});

Vue.onUnmounted(() => {
  isUnmounted = true;
  if (feeCouponRefreshTimeout) clearTimeout(feeCouponRefreshTimeout);
  if (conversionQuoteRefreshTimeout) clearTimeout(conversionQuoteRefreshTimeout);
  if (conversionHighlightTimeout) clearTimeout(conversionHighlightTimeout);
});
</script>
