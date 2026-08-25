import * as Vue from 'vue';
import type { IBitcoinLockCouponStatus } from '@argonprotocol/apps-router';
import { BitcoinPrices, BitcoinFees, type Vault } from '@argonprotocol/apps-core';

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
    bitcoinLockCoupons = scope.run(() =>
      createBitcoinLockCouponsState({
        bitcoinLocks: getBitcoinLocks(),
        config: getConfig(),
        upstreamOperatorClient: getUpstreamOperatorClient(),
        vaults: getVaults(),
      }),
    )!;
  }

  return bitcoinLockCoupons;
}

export function createBitcoinLockCouponsState({
  bitcoinLocks,
  config,
  upstreamOperatorClient,
  vaults,
}: {
  bitcoinLocks: BitcoinLocks;
  config: ReturnType<typeof getConfig>;
  upstreamOperatorClient: ReturnType<typeof getUpstreamOperatorClient>;
  vaults: ReturnType<typeof getVaults>;
}) {
  const coupons = Vue.shallowRef<IBitcoinLockCouponStatus[]>([]);
  const couponOfferLiquidityMicrogons = Vue.ref<bigint>();

  const currentCoupon = Vue.computed(() => {
    return coupons.value.find(coupon => coupon.status === 'Open');
  });
  const resumableCoupon = Vue.computed(() => {
    return coupons.value.find(coupon => {
      return coupon.status === 'Prepared' && coupon.uses?.some(use => use.status === 'Prepared' && use.feeCoupon);
    });
  });
  const maximumCoveredLockSatoshis = Vue.computed(() => {
    const coupon = currentCoupon.value?.coupon;
    if (!coupon || coupon.feeCreditMicrogons != null) return;

    return coupon.maxSatoshis;
  });
  const openCouponCount = Vue.computed(() => {
    return coupons.value.filter(coupon => coupon.status === 'Open').length;
  });

  let couponOfferSyncId = 0;
  let selectedVaultSubscriptionKey = 0;
  let couponRefresh: { subscriptionKey: number; promise: Promise<void> } | undefined;
  let couponStatusRefreshTimeout: ReturnType<typeof setTimeout> | undefined;
  let unsubVault: (() => void) | undefined;

  Vue.watch(
    () => [config.isLoaded, config.bootstrapDetails?.routerHost ?? ''] as const,
    ([isLoaded, routerHost]) => {
      selectedVaultSubscriptionKey += 1;
      const subscriptionKey = selectedVaultSubscriptionKey;
      couponOfferSyncId += 1;

      if (couponStatusRefreshTimeout) clearTimeout(couponStatusRefreshTimeout);
      couponStatusRefreshTimeout = undefined;
      unsubVault?.();
      unsubVault = undefined;
      coupons.value = [];
      couponOfferLiquidityMicrogons.value = undefined;

      if (!isLoaded || !routerHost) return;

      void refresh(subscriptionKey).catch(error => {
        console.warn('Unable to refresh upstream Bitcoin lock coupons', error);
      });
    },
    { immediate: true },
  );

  Vue.onScopeDispose(() => {
    selectedVaultSubscriptionKey += 1;
    if (couponStatusRefreshTimeout) clearTimeout(couponStatusRefreshTimeout);
    if (typeof window !== 'undefined') window.removeEventListener('focus', refreshOnFocus);
    unsubVault?.();
    unsubVault = undefined;
  });

  if (typeof window !== 'undefined') window.addEventListener('focus', refreshOnFocus);

  return Vue.proxyRefs({
    couponOfferLiquidityMicrogons,
    currentCoupon,
    resumableCoupon,
    maximumCoveredLockSatoshis,
    openCouponCount,
    applyRestore,
    refresh,
  });

  function applyRestore(nextCoupons: IBitcoinLockCouponStatus[]) {
    coupons.value = nextCoupons;
  }

  async function refresh(subscriptionKey = selectedVaultSubscriptionKey): Promise<void> {
    if (couponRefresh?.subscriptionKey === subscriptionKey) return await couponRefresh.promise;
    if (couponStatusRefreshTimeout) clearTimeout(couponStatusRefreshTimeout);
    couponStatusRefreshTimeout = undefined;

    const promise = refreshCoupons(subscriptionKey);
    couponRefresh = { subscriptionKey, promise };
    let refreshFailed = false;
    try {
      await promise;
    } catch (error) {
      refreshFailed = true;
      throw error;
    } finally {
      if (couponRefresh?.promise === promise) {
        couponRefresh = undefined;
      }
      if (subscriptionKey === selectedVaultSubscriptionKey) {
        const hasPendingCoupon = coupons.value.some(coupon => {
          return coupon.status === 'Prepared' || coupon.status === 'Submitted' || coupon.status === 'InBlock';
        });
        couponStatusRefreshTimeout = setTimeout(
          () => {
            void refresh(subscriptionKey).catch(error => {
              console.warn('Unable to refresh upstream Bitcoin lock coupons', error);
            });
          },
          !refreshFailed && hasPendingCoupon ? 5e3 : 30e3,
        );
      }
    }
  }

  async function refreshCoupons(subscriptionKey: number): Promise<void> {
    await Promise.all([config.isLoadedPromise, bitcoinLocks.load(), vaults.load().catch(() => null)]);

    if (!(await upstreamOperatorClient.resolveOperatorHost())) {
      if (subscriptionKey !== selectedVaultSubscriptionKey) return;
      coupons.value = [];
      couponOfferLiquidityMicrogons.value = undefined;
      return;
    }

    const nextCoupons = await upstreamOperatorClient.getBitcoinLockCoupons();
    if (subscriptionKey !== selectedVaultSubscriptionKey) return;
    coupons.value = nextCoupons;

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

  function refreshOnFocus() {
    if (!config.isLoaded || !config.bootstrapDetails?.routerHost) return;

    void refresh().catch(error => {
      console.warn('Unable to refresh upstream Bitcoin lock coupons', error);
    });
  }

  async function syncCouponOfferValue(vault: Vault) {
    const syncId = ++couponOfferSyncId;
    if (!currentCoupon.value) {
      couponOfferLiquidityMicrogons.value = undefined;
      return;
    }

    const { availableLiquidityMicrogons } = await bitcoinLocks.getLockableBitcoinCapacity({
      vault,
      maxSatoshis: maximumCoveredLockSatoshis.value,
    });
    if (syncId !== couponOfferSyncId) return;

    couponOfferLiquidityMicrogons.value = availableLiquidityMicrogons;
  }
}
