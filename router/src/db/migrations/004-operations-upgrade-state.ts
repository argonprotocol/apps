import type { ISqliteMigration } from '@argonprotocol/apps-core';

export const OperationsUpgradeStateMigration: ISqliteMigration = db => {
  db.exec(`
    ALTER TABLE Users
    ADD COLUMN operationalAccountId TEXT;

    ALTER TABLE UserInvites
    ADD COLUMN operationsUpgradeRequestedAt TEXT;

    ALTER TABLE UserInvites
    ADD COLUMN operationsUpgradedAt TEXT;

    CREATE UNIQUE INDEX idx_users_operational_account_id ON Users(operationalAccountId);
  `);
};
