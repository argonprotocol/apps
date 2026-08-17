import * as Vue from 'vue';
import { afterEach, expect, it, vi } from 'vitest';
import type { IBitcoinLockCouponStatus } from '@argonprotocol/apps-router';
import type BitcoinLocks from '../lib/BitcoinLocks.ts';
import type { UpstreamOperatorClient } from '../lib/UpstreamOperatorClient.ts';
import type { Config } from '../stores/config.ts';
import { createBitcoinLockCouponsState } from '../stores/bitcoin.ts';
import type { Vaults } from '../stores/vaults.ts';

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

it('refreshes fee waivers while mounted and drops stale state when the upstream changes', async () => {
  vi.useFakeTimers();
  vi.stubGlobal('window', new EventTarget());

  const createdAt = new Date('2026-08-17T12:00:00Z');
  const openCoupon = {
    coupon: {
      id: 1,
      userId: 1,
      sequence: 1,
      offerCode: 'fee-waiver',
      vaultId: 12,
      maxSatoshis: 25_000n,
      estimatedGiftUsd: 10,
      btcPctFee: 2,
      feeCreditMicrogons: 68_000_000n,
      expiresAfterTicks: 60,
      createdAt,
      updatedAt: createdAt,
    },
    originalFeeCreditMicrogons: 68_000_000n,
    usedFeeCreditMicrogons: 0n,
    pendingFeeCreditMicrogons: 0n,
    remainingFeeCreditMicrogons: 68_000_000n,
    status: 'Open',
  } satisfies IBitcoinLockCouponStatus;
  const getBitcoinLockCoupons = vi
    .fn()
    .mockResolvedValueOnce([])
    .mockResolvedValueOnce([openCoupon])
    .mockResolvedValueOnce([openCoupon])
    .mockResolvedValueOnce([]);
  const config = Vue.reactive({
    isLoaded: true,
    isLoadedPromise: Promise.resolve(),
    bootstrapDetails: { routerHost: 'upstream.test' },
  }) as unknown as Vue.Reactive<Config>;
  let resolveCapacity: (value: { availableLiquidityMicrogons: bigint }) => void;
  const capacity = new Promise<{ availableLiquidityMicrogons: bigint }>(resolve => {
    resolveCapacity = resolve;
  });
  const vault = { vaultId: 12 };
  const bitcoinLocks = {
    load: vi.fn().mockResolvedValue(undefined),
    getLockableBitcoinCapacity: vi.fn().mockReturnValue(capacity),
  } as unknown as BitcoinLocks;
  const vaults = {
    load: vi.fn().mockResolvedValue(undefined),
    vaultsById: { 12: vault },
    subscribeToVault: vi.fn().mockResolvedValue(undefined),
  } as unknown as Vaults;
  const upstreamOperatorClient = {
    resolveOperatorHost: vi.fn().mockResolvedValue('upstream.test'),
    getBitcoinLockCoupons,
  } as unknown as UpstreamOperatorClient;
  const scope = Vue.effectScope();
  const store = scope.run(() =>
    createBitcoinLockCouponsState({ bitcoinLocks, config, upstreamOperatorClient, vaults }),
  )!;

  await vi.advanceTimersByTimeAsync(0);
  expect(getBitcoinLockCoupons).toHaveBeenCalledOnce();
  expect(store.currentCoupon).toBeUndefined();

  await vi.advanceTimersByTimeAsync(30_000);
  expect(getBitcoinLockCoupons).toHaveBeenCalledTimes(2);
  expect(store.currentCoupon?.coupon.offerCode).toBe('fee-waiver');

  window.dispatchEvent(new Event('focus'));
  await vi.advanceTimersByTimeAsync(0);
  expect(getBitcoinLockCoupons).toHaveBeenCalledTimes(3);

  config.bootstrapDetails!.routerHost = 'replacement.test';
  await vi.advanceTimersByTimeAsync(0);
  expect(store.currentCoupon).toBeUndefined();

  resolveCapacity!({ availableLiquidityMicrogons: 100n });
  await vi.advanceTimersByTimeAsync(0);
  expect(store.couponOfferLiquidityMicrogons).toBeUndefined();

  scope.stop();
});
