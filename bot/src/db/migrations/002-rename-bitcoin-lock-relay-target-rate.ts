import type { ISqliteMigration } from '@argonprotocol/apps-core';

export const RenameBitcoinLockRelayTargetRateMigration: ISqliteMigration = db => {
  db.exec(`
    ALTER TABLE BitcoinLockRelays
    RENAME COLUMN microgonsPerBtc TO microgonsAtTargetPerBtc;
  `);
};
