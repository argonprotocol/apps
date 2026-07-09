import * as Vue from 'vue';
import type { IBitcoinLockCouponStatus } from '@argonprotocol/apps-router';
import { BitcoinPrices, BitcoinFees } from '@argonprotocol/apps-core';
import type { Vault } from '@argonprotocol/mainchain';
import BitcoinLocks from '../lib/BitcoinLocks.ts';
import { getDbPromise } from './helpers/dbPromise';
import handleFatalError from './helpers/handleFatalError.ts';
import { getBlockWatch } from './mainchain.ts';
import { getCurrency } from './currency.ts';
import { getConfig } from './config.ts';
import { getTransactionTracker } from './transactions.ts';
import { getUpstreamOperatorClient } from './upstreamOperator.ts';
import { getVaults } from './vaults.ts';
import { getWalletKeys } from './wallets.ts';

const bitcoinPrices = new BitcoinPrices();
const bitcoinFees = new BitcoinFees();

export function getBitcoinPrices() {
  return bitcoinPrices;
}

export function getBitcoinFees() {
  return bitcoinFees;
}

let locks: BitcoinLocks;
let bitcoinLockCoupons: ReturnType<typeof createBitcoinLockCouponsState>;

export function getBitcoinLocks(): BitcoinLocks {
  if (!locks) {
    const dbPromise = getDbPromise();
    const transactionTracker = getTransactionTracker();
    const keys = getWalletKeys();
    const blockWatch = getBlockWatch();
    locks = new BitcoinLocks(
      dbPromise,
      keys,
      blockWatch,
      getCurrency(),
      transactionTracker,
      undefined,
      getUpstreamOperatorClient(),
    );
    locks.data = Vue.reactive(locks.data) as any;
    locks.utxoTracking.data = Vue.reactive(locks.utxoTracking.data) as any;
  }
  void locks.load().catch(handleFatalError.bind('useBitcoinLocks'));

  return locks;
}

export function getBitcoinLockCoupons() {
  if (!bitcoinLockCoupons) {
    const scope = Vue.effectScope(true);
    bitcoinLockCoupons = scope.run(createBitcoinLockCouponsState)!;
  }

  return bitcoinLockCoupons;
}

function createBitcoinLockCouponsState() {
  const bitcoinLocks = getBitcoinLocks();
  const config = getConfig();
  const vaults = getVaults();

  const coupons = Vue.ref<IBitcoinLockCouponStatus[]>([]);
  const couponOfferLiquidityMicrogons = Vue.ref<bigint>();

  const currentCoupon = Vue.computed(() => {
    return coupons.value.find(coupon => coupon.status === 'Open');
  });
  const openCouponCount = Vue.computed(() => {
    return coupons.value.filter(coupon => coupon.status === 'Open').length;
  });

  let couponOfferSyncId = 0;
  let selectedVaultSubscriptionKey = 0;
  let unsubVault: (() => void) | undefined;

  Vue.watch(
    () => [config.isLoaded, config.bootstrapDetails?.routerHost ?? ''] as const,
    ([isLoaded, routerHost]) => {
      selectedVaultSubscriptionKey += 1;
      const subscriptionKey = selectedVaultSubscriptionKey;

      unsubVault?.();
      unsubVault = undefined;
      couponOfferLiquidityMicrogons.value = undefined;

      if (!isLoaded || !routerHost) {
        coupons.value = [];
        return;
      }

      void refresh(subscriptionKey).catch(handleFatalError.bind('getBitcoinLockCoupons'));
    },
    { immediate: true },
  );

  Vue.onScopeDispose(() => {
    selectedVaultSubscriptionKey += 1;
    unsubVault?.();
    unsubVault = undefined;
  });

  return Vue.proxyRefs({
    couponOfferLiquidityMicrogons,
    currentCoupon,
    openCouponCount,
    refresh,
  });

  async function refresh(subscriptionKey = selectedVaultSubscriptionKey) {
    await Promise.all([config.isLoadedPromise, bitcoinLocks.load(), vaults.load().catch(() => null)]);

    const upstreamOperatorClient = getUpstreamOperatorClient();
    if (!upstreamOperatorClient.operatorHost) {
      coupons.value = [];
      couponOfferLiquidityMicrogons.value = undefined;
      return;
    }

    coupons.value = await upstreamOperatorClient.getBitcoinLockCoupons();
    if (subscriptionKey !== selectedVaultSubscriptionKey) return;

    const selectedVaultId = currentCoupon.value?.coupon.vaultId;
    if (!selectedVaultId) {
      couponOfferLiquidityMicrogons.value = undefined;
      return;
    }

    const currentVault = vaults.vaultsById[selectedVaultId];
    if (currentVault) {
      updateVault(currentVault);
    }

    unsubVault?.();
    unsubVault = undefined;

    const unsub = await vaults.subscribeToVault(selectedVaultId, updateVault).catch(() => undefined);
    if (!unsub) return;
    if (subscriptionKey !== selectedVaultSubscriptionKey) {
      unsub();
      return;
    }

    unsubVault = unsub;
  }

  function updateVault(nextVault: Vault) {
    void syncCouponOfferValue(nextVault);
  }

  async function syncCouponOfferValue(vault: Vault) {
    const syncId = ++couponOfferSyncId;
    if (!currentCoupon.value) {
      couponOfferLiquidityMicrogons.value = undefined;
      return;
    }

    const { availableLiquidityMicrogons } = await bitcoinLocks.getLockableBitcoinCapacity({
      vault,
      maxSatoshis: currentCoupon.value.coupon.maxSatoshis,
    });
    if (syncId !== couponOfferSyncId) return;

    couponOfferLiquidityMicrogons.value = availableLiquidityMicrogons;
  }
}
