import type { ISqliteMigration } from '@argonprotocol/apps-core';

export const BitcoinLockCouponUseUtxoMigration: ISqliteMigration = db => {
  db.exec('ALTER TABLE BitcoinLockCouponUses ADD COLUMN utxoId INTEGER');
};
