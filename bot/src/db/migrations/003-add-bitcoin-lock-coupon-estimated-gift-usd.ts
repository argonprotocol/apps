import type { ISqliteMigration } from '@argonprotocol/apps-core';

export const AddBitcoinLockCouponEstimatedGiftUsdMigration: ISqliteMigration = db => {
  const columns = db.prepare('PRAGMA table_info(BitcoinLockCoupons)').all() as { name: string }[];
  if (columns.some(column => column.name === 'estimatedGiftUsd')) {
    return;
  }

  db.exec(`
    ALTER TABLE BitcoinLockCoupons
    ADD COLUMN estimatedGiftUsd REAL NOT NULL DEFAULT 0;
  `);
};
