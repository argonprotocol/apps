import * as Vue from 'vue';
import type { IBitcoinLockCouponStatus } from '@argonprotocol/apps-router';
import { BitcoinPrices, BitcoinFees, type Vault } from '@argonprotocol/apps-core';

import BitcoinLocks from '../lib/BitcoinLocks.ts';
import { BitcoinFissions } from '../lib/BitcoinFissions.ts';
import { BitcoinLiquidClose } from '../lib/txs/BitcoinLiquid.close.ts';
import { BitcoinLiquidCreate } from '../lib/txs/BitcoinLiquid.create.ts';
import { BitcoinLiquidRatchet } from '../lib/txs/BitcoinLiquid.ratchet.ts';
import { BitcoinOrphanRelease } from '../lib/txs/BitcoinOrphan.release.ts';
import { BitcoinLockCreate } from '../lib/txs/BitcoinLock.create.ts';
import { BitcoinLockRelease } from '../lib/txs/BitcoinLock.release.ts';
import { BitcoinLockResecuritize } from '../lib/txs/BitcoinLock.resecuritize.ts';
import { loadTransactionOperations, type TransactionOperations } from '../lib/txs/index.ts';
import { getDbPromise } from './helpers/dbPromise';
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
let fissions: BitcoinFissions;
let transactionOperations: TransactionOperations;
let transactionOperationsLoadPromise: Promise<TransactionOperations> | undefined;
let bitcoinLockCoupons: ReturnType<typeof createBitcoinLockCouponsState>;

export function getBitcoinLocks(): BitcoinLocks {
  if (!locks) {
    const dbPromise = getDbPromise();
    const transactionTracker = getTransactionTracker();
    const keys = getWalletKeys();
    const blockWatch = getBlockWatch();
    locks = new BitcoinLocks(dbPromise, keys, blockWatch, getCurrency(), transactionTracker);
    locks.data = Vue.reactive(locks.data) as any;
    locks.utxoTracking.data = Vue.reactive(locks.utxoTracking.data) as any;
  }
  void locks.load().catch(error => {
    console.error('[BitcoinLocks] Unable to load current state', error);
  });

  return locks;
}

export function getBitcoinFissions(): BitcoinFissions {
  if (!fissions) {
    fissions = new BitcoinFissions(getDbPromise(), getWalletKeys().defaultArgonAddress, getBlockWatch(), getCurrency());
    fissions.data = Vue.reactive(fissions.data) as BitcoinFissions['data'];
  }
  void fissions.load().catch(error => {
    console.error('[BitcoinFissions] Unable to load current state', error);
  });

  return fissions;
}

export function getBitcoinTransactionOperations(): TransactionOperations {
  if (!transactionOperations) {
    const transactionTracker = getTransactionTracker();
    const bitcoinLocks = getBitcoinLocks();
    const bitcoinFissions = getBitcoinFissions();
    const currency = getCurrency();
    const upstreamOperatorClient = getUpstreamOperatorClient();
    const bitcoinLockResecuritize = new BitcoinLockResecuritize(
      bitcoinLocks,
      transactionTracker,
      currency,
      upstreamOperatorClient,
    );

    transactionOperations = {
      bitcoinLiquidClose: new BitcoinLiquidClose(bitcoinFissions, transactionTracker, currency),
      bitcoinLiquidCreate: new BitcoinLiquidCreate(
        bitcoinFissions,
        transactionTracker,
        bitcoinLocks,
        getVaults(),
        bitcoinLockResecuritize,
        upstreamOperatorClient,
      ),
      bitcoinLiquidRatchet: new BitcoinLiquidRatchet(
        bitcoinFissions,
        transactionTracker,
        currency,
        bitcoinLocks,
        getVaults(),
        bitcoinLockResecuritize,
        upstreamOperatorClient,
      ),
      bitcoinOrphanRelease: new BitcoinOrphanRelease(bitcoinLocks, bitcoinLocks.orphanReleases, transactionTracker),
      bitcoinLockCreate: new BitcoinLockCreate(bitcoinLocks, transactionTracker, currency, upstreamOperatorClient),
      bitcoinLockRelease: new BitcoinLockRelease(bitcoinLocks, transactionTracker, currency),
      bitcoinLockResecuritize,
    };
  }
  if (!transactionOperationsLoadPromise) {
    const bitcoinLocks = getBitcoinLocks();
    const bitcoinFissions = getBitcoinFissions();
    const loadPromise = loadTransactionOperations(
      transactionOperations,
      Promise.all([bitcoinLocks.load(), bitcoinFissions.load()]),
    );
    transactionOperationsLoadPromise = loadPromise;
    void loadPromise.catch(error => {
      if (transactionOperationsLoadPromise === loadPromise) transactionOperationsLoadPromise = undefined;
      console.error('[BitcoinTransactions] Unable to restore pending operations', error);
    });
  }
  return transactionOperations;
}

export function loadBitcoinTransactionOperations(): Promise<TransactionOperations> {
  getBitcoinTransactionOperations();
  return transactionOperationsLoadPromise!;
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
