import type { ISqliteMigration } from '@argonprotocol/apps-core';

export const AddBitcoinLockCouponEstimatedGiftUsdMigration: ISqliteMigration = db => {
  const columns = db.prepare('PRAGMA table_info(BitcoinLockCoupons)').all() as { name: string }[];
  const columnNames = new Set(columns.map(column => column.name));

  if (!columnNames.has('estimatedGiftUsd')) {
    db.exec(`
      ALTER TABLE BitcoinLockCoupons
      ADD COLUMN estimatedGiftUsd REAL NOT NULL DEFAULT 0;
    `);
  }

  if (!columnNames.has('btcPctFee')) {
    db.exec(`
      ALTER TABLE BitcoinLockCoupons
      ADD COLUMN btcPctFee REAL NOT NULL DEFAULT 0;
    `);
  }
};
