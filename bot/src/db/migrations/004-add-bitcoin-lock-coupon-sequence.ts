import type { ISqliteMigration } from '@argonprotocol/apps-core';

export const AddBitcoinLockCouponSequenceMigration: ISqliteMigration = db => {
  db.exec(`
    ALTER TABLE BitcoinLockCoupons
    ADD COLUMN sequence INTEGER NOT NULL DEFAULT 1;

    UPDATE BitcoinLockCoupons
    SET
      createdAt = strftime('%Y-%m-%dT%H:%M:%fZ', createdAt),
      updatedAt = strftime('%Y-%m-%dT%H:%M:%fZ', updatedAt);

    CREATE UNIQUE INDEX idx_bitcoin_lock_coupons_user_sequence
    ON BitcoinLockCoupons(userId, sequence);
  `);
};
