import * as Fs from 'node:fs';
import os from 'node:os';
import Path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { IBitcoinLockCouponRecord } from '@argonprotocol/apps-core';
import { Db } from '../src/Db.ts';

describe('BitcoinLockCouponsTable', () => {
  let db: Db | undefined;

  afterEach(() => {
    db?.close();
  });

  it('restores by offer code without preserving a foreign database id', () => {
    const tempDir = Fs.mkdtempSync(Path.join(os.tmpdir(), 'bitcoin-lock-coupon-restore-test-'));
    db = new Db(tempDir);
    db.migrate();

    const coupon: IBitcoinLockCouponRecord = {
      id: 11,
      userId: 7,
      sequence: 1,
      offerCode: 'recovered-offer',
      vaultId: 12,
      maxSatoshis: 25_000n,
      estimatedGiftUsd: 16.25,
      btcPctFee: 2.5,
      expiresAfterTicks: 60,
      expirationTick: 1_000,
      accountId: '5RecoveredMember',
      createdAt: new Date('2026-07-20T12:00:00.000Z'),
      updatedAt: new Date('2026-07-20T12:05:00.000Z'),
    };

    const restored = db.bitcoinLockCouponsTable.restoreCoupon(coupon);
    expect(restored).toEqual({
      ...coupon,
      id: expect.any(Number),
    });
    expect(restored.id).not.toBe(coupon.id);
    const { sequence: _legacySequence, ...legacyCoupon } = coupon;
    expect(db.bitcoinLockCouponsTable.restoreCoupon(legacyCoupon)).toEqual(restored);

    expect(() =>
      db!.bitcoinLockCouponsTable.restoreCoupon({
        ...coupon,
        accountId: '5ConflictingMember',
      }),
    ).toThrow('Recovered bitcoin lock coupon conflicts with existing bot state.');
  });

  it('keeps the highest coupon sequence for the same user', () => {
    const tempDir = Fs.mkdtempSync(Path.join(os.tmpdir(), 'bitcoin-lock-coupon-current-test-'));
    db = new Db(tempDir);
    db.migrate();

    const previous = db.bitcoinLockCouponsTable.insertCoupon({
      userId: 7,
      offerCode: 'previous-offer',
      vaultId: 12,
      maxSatoshis: 25_000n,
      estimatedGiftUsd: 15,
      btcPctFee: 2,
      expiresAfterTicks: 60,
    });
    const current = db.bitcoinLockCouponsTable.insertCoupon({
      userId: 7,
      offerCode: 'current-offer',
      vaultId: 12,
      maxSatoshis: 50_000n,
      estimatedGiftUsd: 30,
      btcPctFee: 2,
      expiresAfterTicks: 60,
    });
    const activated = db.bitcoinLockCouponsTable.activateCoupon(current.id, '5RecoveredMember', 2_000)!;
    expect(previous.sequence).toBe(1);
    expect(activated.sequence).toBe(2);

    const kept = db.bitcoinLockCouponsTable.restoreCoupon({
      ...activated,
      id: 99,
      sequence: 1,
      offerCode: 'old-recovery-offer',
      maxSatoshis: 25_000n,
      expirationTick: 1_000,
    });

    expect(kept).toEqual(activated);

    const restored = db.bitcoinLockCouponsTable.restoreCoupon({
      ...activated,
      id: 100,
      sequence: 3,
      offerCode: 'new-recovery-offer',
      maxSatoshis: 75_000n,
      expirationTick: 3_000,
    });
    expect(restored).toMatchObject({
      sequence: 3,
      offerCode: 'new-recovery-offer',
      maxSatoshis: 75_000n,
    });
    expect(db.bitcoinLockCouponsTable.fetchLatestByUserId(7)).toEqual(restored);
  });
});
