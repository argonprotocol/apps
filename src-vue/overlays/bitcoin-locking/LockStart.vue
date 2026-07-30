<template>
  <div class="flex flex-col px-10 py-5">
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

      <div
        v-if="hasCouponForVault && isOperatorCouponExpired"
        class="mt-4 rounded-md border border-red-300 bg-red-50 px-4 py-3 text-sm text-red-700"
      >
        This liquid lock coupon has expired and will not be applied. Ask {{ couponProviderLabel }} for a new invite if
        you want a free lock.
      </div>

      <div
        v-else-if="isOperatorCouponLock"
        class="bg-argon-50/35 border-argon-300/70 mt-4 rounded-md border px-4 py-3 text-sm text-slate-800"
      >
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

      <div class="mt-8 flex flex-col">
        <div class="mb-2 flex flex-row items-center">
          <label class="grow font-bold opacity-40">Bitcoin to Lock</label>
          <span v-if="bitcoinAmount === minLockBtc" class="text-sm text-gray-600/60">You're At Min Amount</span>
          <button
            v-else
            type="button"
            class="text-argon-600 hover:text-argon-700 cursor-pointer text-sm"
            :disabled="isSaving || isLoadingLiquidity || availableLiquidityBtc <= 0"
            @click="setBitcoinAmount(minLockBtc)"
          >
            Min
          </button>
          <span class="mx-3 h-4 border-l border-gray-300" />
          <span v-if="bitcoinAmount === availableLiquidityBtc" class="text-sm text-gray-600/60">
            You're At Vault Capacity
          </span>
          <button
            v-else
            type="button"
            class="text-argon-600 hover:text-argon-700 cursor-pointer text-sm"
            :disabled="isSaving || isLoadingLiquidity || availableLiquidityBtc <= 0"
            @click="setBitcoinAmount(availableLiquidityBtc)"
          >
            Max
          </button>
        </div>
        <div class="relative flex w-full flex-row items-center rounded-md border border-slate-700/50">
          <div class="w-1/2">
            <InputNumber
              data-testid="LockStart.bitcoinAmount"
              v-model="bitcoinAmount"
              @input="handleBtcChange"
              :disabled="isSaving || isLoadingLiquidity"
              :maxDecimals="8"
              :min="0"
              :max="availableLiquidityBtc"
              suffix=" BTC"
              :dragBy="0.1"
              :dragByMin="0.01"
              :hideArrows="true"
              class="w-fit border-0 px-1 py-2 text-[17px]!"
            />
          </div>
          <!--          <div class="relative z-10 h-5 w-5 bg-white px-2 font-light">-->
          <!--            <div class="absolute top-[7.5px] left-1/2 -translate-x-1/2 -translate-y-1/2 text-3xl opacity-50">=</div>-->
          <!--          </div>-->
          <!--          <div class="absolute top-1/2 left-1/2 h-[140%] w-px origin-center -translate-x-1/2 -translate-y-1/2 rotate-45 bg-slate-700/30" />-->
          <div class="flex w-1/2 flex-row justify-end">
            <InputMoney
              data-testid="LockStart.argonAmount"
              v-model="liquidityToReceive"
              @input="handleArgonChange"
              :disabled="isSaving || isLoadingLiquidity"
              :maxDecimals="0"
              :min="0n"
              :max="availableLiquidityMicrogons"
              :dragBy="1_000_000n"
              :dragByMin="1_000_000n"
              prefix="~"
              suffix=" CURRENT MARKET VALUE"
              class="w-fit border-0 px-1 py-2 text-[17px]!"
            />
          </div>
        </div>
        <div class="text-md mt-2 text-slate-700/70">
          Cost: {{ microgonToArgonNm(securityFee).format('0,0.[00]') }} ARGN will be pulled from your Internal App
          Wallet. See One-Time Lock Fee below.
        </div>
        <WalletFundingCallout v-if="neededMicrogons" @open-wallet="openWallet">
          <AlertIcon class="mr-2 h-4 text-yellow-700" />
          Your wallet needs another {{ microgonToArgonNm(neededMicrogons).format('0,0.[00]') }} ARGN to initialize this
          lock.
        </WalletFundingCallout>

        <section class="border-argon-600/30 mt-6 rounded-md border">
          <div class="flex flex-row py-7 text-center">
            <div class="w-1/3 px-3">
              <header class="font-bold opacity-40">ONE-TIME LOCK FEE</header>
              <div class="text-argon-600 py-1 text-3xl font-bold">
                <template v-if="isFeeWaived">Waived</template>
                <template v-else>{{ microgonToArgonNm(securityFee).format('0,0.[00]') }} ARGN</template>
              </div>
              <div class="font-light opacity-80">
                <template v-if="isOperatorCouponLock">
                  {{ couponProviderLabel }} Gifted You {{ currency.symbol
                  }}{{ microgonToMoneyNm(oneTimeLockFee).format('0,0.00') }}
                </template>
                <template v-else-if="isVaultOperator">No Operator Fee Charged</template>
                <template v-else>{{ currency.symbol }}{{ microgonToMoneyNm(securityFee).format('0,0.00') }}</template>
              </div>
            </div>
            <div class="min-h-full min-w-px bg-slate-600/20" />
            <div class="w-1/3 px-3">
              <header class="font-bold opacity-40">YOU WILL RECEIVE</header>
              <div class="text-argon-600 py-1 text-3xl font-bold">
                {{ currency.symbol }}{{ microgonToMoneyNm(liquidityToReceive).format('0,0') }}
              </div>
              <div class="font-light opacity-80">In Unencumbered Argons</div>
            </div>
            <div class="min-h-full min-w-px bg-slate-600/20" />
            <div class="w-1/3 px-3">
              <header class="font-bold opacity-40">PROJECTED EARNINGS</header>
              <div class="text-argon-600 py-1 text-3xl font-bold">
                +{{ currency.symbol }}{{ microgonToMoneyNm(projectedEarnings).format('0,0') }}
              </div>
              <div class="font-light opacity-80">Modeled Over One Year</div>
            </div>
          </div>
          <div class="mx-2 border-t border-slate-600/30 px-2 py-3 font-light italic opacity-70">
            * The value of your {{ numeral(bitcoinAmount).format('0,0.[00000000]') }} BTC is protected even if bitcoin's
            market's price falls.
            <a :href="`${NetworkConfig.websiteHost}/docs/assets-and-entities/bitcoin-locks`" target="_blank">
              Learn more.
            </a>
          </div>
        </section>
      </div>
    </div>

    <div class="mt-3 flex flex-row items-center justify-end gap-x-3 py-3">
      <button
        v-if="props.canChangeVault"
        data-testid="LockStart.changeVault()"
        class="text-argon-600 hover:text-argon-700 mr-auto cursor-pointer px-2 py-2 text-sm font-semibold disabled:opacity-40"
        @click="emit('changeVault')"
        :disabled="isSaving"
      >
        Choose Different Vault
      </button>
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
        class="bg-argon-button hover:bg-argon-button-hover cursor-pointer rounded-md px-10 py-2 font-semibold text-white disabled:cursor-default disabled:opacity-40"
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
import { ChevronDoubleRightIcon, ExclamationTriangleIcon } from '@heroicons/vue/24/outline';
import InputNumber from '../../components/InputNumber.vue';
import InputMoney from '../../components/InputMoney.vue';
import numeral, { createNumeralHelpers } from '../../lib/numeral.ts';
import { getCurrency } from '../../stores/currency.ts';
import { BitcoinLock, MICROGONS_PER_ARGON, SATS_PER_BTC, Vault } from '@argonprotocol/mainchain';
import type { IBitcoinLockCouponStatus } from '@argonprotocol/apps-router';
import { useDebounceFn } from '@vueuse/core';
import { getBitcoinLockCoupons, getBitcoinLocks } from '../../stores/bitcoin.ts';
import { getConfig } from '../../stores/config.ts';
import { getVaults } from '../../stores/vaults.ts';
import { getWalletKeys, useWallets } from '../../stores/wallets.ts';
import type { IBitcoinLockRecord } from '../../lib/db/BitcoinLocksTable.ts';
import { bigNumberToBigInt, NetworkConfig } from '@argonprotocol/apps-core';
import WalletFundingCallout from '../../components/WalletFundingCallout.vue';
import basicEmitter from '../../emitters/basicEmitter.ts';
import { WalletType } from '../../lib/Wallet.ts';
import AlertIcon from '../../assets/alert.svg';
import BigNumber from 'bignumber.js';
import { useVaultingStats } from '../../stores/vaultingStats.ts';

const props = defineProps<{
  canChangeVault?: boolean;
  coupon?: IBitcoinLockCouponStatus;
  currentTick?: number;
  vault: Vault;
}>();

const emit = defineEmits<{
  (e: 'changeVault'): void;
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

const { microgonToMoneyNm, microgonToArgonNm } = createNumeralHelpers(currency);

const availableLiquidityMicrogons = Vue.ref(0n);
const availableLiquidityBtc = Vue.ref(0);

const isSaving = Vue.ref(false);
const isLoadingLiquidity = Vue.ref(true);
const errorMessage = Vue.ref<string | null>(null);
const bitcoinAmount = Vue.ref(0);
const liquidityToReceive = Vue.ref(0n);
const lockSatoshis = Vue.ref(0n);
const securityFee = Vue.ref(0n);
const hasEditedAmounts = Vue.ref(false);

const minLockBtc = Vue.computed(() => Math.min(0.01, availableLiquidityBtc.value));

const isVaultOperator = Vue.computed(() => {
  return walletKeys.defaultArgonAddress === props.vault.operatorAccountId;
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

  return {
    vaultId: props.coupon.coupon.vaultId,
    offerCode: props.coupon.coupon.offerCode,
    accountId: props.coupon.coupon.accountId,
  };
});

const isOperatorCouponLock = Vue.computed(() => {
  return !!operatorCoupon.value;
});

const couponProviderLabel = Vue.computed(() => {
  const name = config.upstreamOperator?.name;
  return name || 'The vault operator';
});

const couponMaxBtcLabel = Vue.computed(() => {
  if (!props.coupon) {
    return numeral(currency.convertSatToBtc(lockSatoshis.value)).format('0,0.[00000000]');
  }

  return numeral(availableLiquidityBtc.value || currency.convertSatToBtc(props.coupon.coupon.maxSatoshis)).format(
    '0,0.[00000000]',
  );
});

const neededMicrogons = Vue.computed(() => {
  if (securityFee.value <= 0n) return 0n;
  const buffer = 25_000n;
  const needed = securityFee.value + buffer;
  if (wallets.liquidLockingWallet.availableMicrogons >= needed) return 0n;
  return needed - wallets.liquidLockingWallet.availableMicrogons;
});

function openWallet() {
  basicEmitter.emit('openWalletOverlay', { walletType: WalletType.defaultArgon });
}

const oneTimeLockFee = Vue.computed(() => {
  if (liquidityToReceive.value <= 0n) return 0n;
  return props.vault.calculateBitcoinFee(liquidityToReceive.value);
});

const isFeeWaived = Vue.computed(() => {
  return isVaultOperator.value || isOperatorCouponLock.value;
});

const projectedEarnings = Vue.computed(() => {
  const bitcoinAPR = Math.max(0, Math.min(999, vaultingStats.bitcoinAPR));
  return bigNumberToBigInt(BigNumber(liquidityToReceive.value.toString()).multipliedBy(bitcoinAPR).dividedBy(100));
});

const cannotContinue = Vue.computed(() => {
  return (
    isSaving.value ||
    isLoadingLiquidity.value ||
    lockSatoshis.value <= 0n ||
    liquidityToReceive.value <= 0n ||
    liquidityToReceive.value > availableLiquidityMicrogons.value ||
    neededMicrogons.value > 0n
  );
});

const debouncedHandleBtcChange = useDebounceFn(internalHandleBtcChange, 100, { maxWait: 200 });
const debouncedHandleArgonChange = useDebounceFn(internalHandleArgonChange, 100, { maxWait: 200 });

let lastSetLiquidityMicrogons = 0n;
let lastSetBitcoinAmount = 0;
let availableLiquiditySyncId = 0;
let pendingAmountSync: Promise<unknown> | undefined;

function updateFeeEstimate() {
  if (!props.vault || liquidityToReceive.value <= 0n || isVaultOperator.value || isOperatorCouponLock.value) {
    securityFee.value = 0n;
    return;
  }
  securityFee.value = props.vault.calculateBitcoinFee(liquidityToReceive.value);
}

function initializeDefaultAmounts(satoshis: bigint, liquidityMicrogons: bigint) {
  const btc = currency.convertSatToBtc(satoshis);

  lockSatoshis.value = satoshis;
  liquidityToReceive.value = liquidityMicrogons;
  bitcoinAmount.value = btc;

  lastSetLiquidityMicrogons = liquidityMicrogons;
  lastSetBitcoinAmount = btc;
}

async function internalHandleArgonChange(liquidityMicrogons: bigint) {
  if (liquidityMicrogons === lastSetLiquidityMicrogons) {
    return;
  }
  const sats = await bitcoinLocks.satoshisForArgonLiquidity(liquidityMicrogons);
  lockSatoshis.value = sats;
  const btc = currency.convertSatToBtc(sats);
  bitcoinAmount.value = btc;
  lastSetBitcoinAmount = bitcoinAmount.value;
  lastSetLiquidityMicrogons = liquidityMicrogons;
  updateFeeEstimate();
}

async function internalHandleBtcChange(value: number) {
  if (value === lastSetBitcoinAmount) {
    return;
  }
  const satoshis = BigInt(Math.round(value * Number(SATS_PER_BTC)));
  lockSatoshis.value = satoshis;
  liquidityToReceive.value = BitcoinLock.calculateRedemptionAmountFromSatoshis(currency.priceIndex, satoshis);
  lastSetLiquidityMicrogons = liquidityToReceive.value;
  lastSetBitcoinAmount = value;
  updateFeeEstimate();
}

function handleArgonChange(liquidityMicrogons: bigint) {
  hasEditedAmounts.value = true;
  const sync = debouncedHandleArgonChange(liquidityMicrogons).finally(() => {
    if (pendingAmountSync === sync) {
      pendingAmountSync = undefined;
    }
  });
  pendingAmountSync = sync;
}

function handleBtcChange(value: number) {
  hasEditedAmounts.value = true;
  const sync = debouncedHandleBtcChange(value).finally(() => {
    if (pendingAmountSync === sync) {
      pendingAmountSync = undefined;
    }
  });
  pendingAmountSync = sync;
}

function setBitcoinAmount(value: number) {
  bitcoinAmount.value = value;
  handleBtcChange(value);
}

async function submitLiquidLock() {
  if (isSaving.value) return;

  try {
    await config.isLoadedPromise;
    await pendingAmountSync;

    let satoshis = lockSatoshis.value;
    isSaving.value = true;
    errorMessage.value = null;
    if (satoshis <= 0n && liquidityToReceive.value > 0n) {
      satoshis = await bitcoinLocks.satoshisForArgonLiquidity(liquidityToReceive.value);
      lockSatoshis.value = satoshis;
    }
    if (satoshis <= 0n) {
      throw new Error('Please enter a valid amount of Argons to receive.');
    }
    if (
      BitcoinLock.calculateRedemptionAmountFromSatoshis(currency.priceIndex, satoshis) >
      (props.vault.availableBitcoinSpace() ?? 0n)
    ) {
      throw new Error(
        "This amount rounds above the vault's remaining capacity. Lower the requested Argons slightly and try again.",
      );
    }

    await bitcoinLocks.initializeLock({
      satoshis,
      vault: props.vault,
      operatorCoupon: operatorCoupon.value,
    });
    if (operatorCoupon.value) {
      await bitcoinLockCoupons.refresh();
    }
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

async function setLiquidityVariables() {
  const syncId = ++availableLiquiditySyncId;
  const { availableSatoshis: nextAvailableSatoshis, availableLiquidityMicrogons: nextAvailableLiquidityMicrogons } =
    await bitcoinLocks.getLockableBitcoinCapacity({
      vault: props.vault,
      maxSatoshis: props.coupon && isOperatorCouponLock.value ? props.coupon.coupon.maxSatoshis : undefined,
    });
  const nextWholeArgonLiquidityMicrogons =
    nextAvailableLiquidityMicrogons - (nextAvailableLiquidityMicrogons % BigInt(MICROGONS_PER_ARGON));
  const nextWholeArgonSatoshis =
    nextWholeArgonLiquidityMicrogons > 0n
      ? await bitcoinLocks.satoshisForArgonLiquidity(nextWholeArgonLiquidityMicrogons)
      : 0n;

  if (syncId !== availableLiquiditySyncId) return;

  availableLiquidityMicrogons.value = nextWholeArgonLiquidityMicrogons;
  availableLiquidityBtc.value = currency.convertSatToBtc(nextAvailableSatoshis);

  if (!hasEditedAmounts.value || (liquidityToReceive.value === 0n && lockSatoshis.value === 0n)) {
    initializeDefaultAmounts(nextWholeArgonSatoshis, nextWholeArgonLiquidityMicrogons);
    if (syncId !== availableLiquiditySyncId) return;
  }

  updateFeeEstimate();
}

Vue.onMounted(async () => {
  await config.isLoadedPromise;
  try {
    await setLiquidityVariables();
  } finally {
    isLoadingLiquidity.value = false;
  }
});
</script>
