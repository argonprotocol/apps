import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { runSqliteMigrations } from '@argonprotocol/apps-core';
import { InitialMigration } from '../src/db/migrations/001-initial.ts';
import { RenameBitcoinLockRelayTargetRateMigration } from '../src/db/migrations/002-rename-bitcoin-lock-relay-target-rate.ts';
import { AddBitcoinLockCouponEstimatedGiftUsdMigration } from '../src/db/migrations/003-add-bitcoin-lock-coupon-estimated-gift-usd.ts';
import { AddBitcoinLockCouponSequenceMigration } from '../src/db/migrations/004-add-bitcoin-lock-coupon-sequence.ts';
import { BitcoinLockRelaysMigration } from '../src/db/migrations/005-bitcoin-lock-relays.ts';

describe('BitcoinLockRelaysMigration', () => {
  it('retains the historical coupon relation only for router import', () => {
    const db = new DatabaseSync(':memory:');
    runSqliteMigrations(db, [
      InitialMigration,
      RenameBitcoinLockRelayTargetRateMigration,
      AddBitcoinLockCouponEstimatedGiftUsdMigration,
      AddBitcoinLockCouponSequenceMigration,
    ]);
    db.prepare(
      `
      INSERT INTO BitcoinLockCoupons (id, userId, offerCode, vaultId, maxSatoshis, expiresAfterTicks)
      VALUES (7, 3, 'offer-code', 12, '25000', 60)
    `,
    ).run();
    db.prepare(
      `
      INSERT INTO BitcoinLockRelays (
        id, couponId, status, requestedSatoshis, securitizationUsedMicrogons,
        ownerAccountId, ownerBitcoinPubkey, microgonsAtTargetPerBtc
      ) VALUES (9, 7, 'Submitted', '25000', '100', 'member', '0x1234', '75000000')
    `,
    ).run();

    BitcoinLockRelaysMigration(db);

    expect(db.prepare('SELECT requestId, legacyCouponId FROM BitcoinLockRelays').get()).toEqual({
      requestId: 'legacy-9',
      legacyCouponId: 7,
    });
    expect(db.prepare('PRAGMA table_info(BitcoinLockRelays)').all()).not.toContainEqual(
      expect.objectContaining({ name: 'couponId' }),
    );
    db.close();
  });
});
