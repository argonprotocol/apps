import type { ISqliteMigration } from '@argonprotocol/apps-core';

export const InitialMigration: ISqliteMigration = db => {
  db.exec(`
    CREATE TABLE Profile (
      name TEXT
    );

    CREATE TABLE TreasuryUserInvites (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      inviteCode TEXT NOT NULL UNIQUE,
      offerCode TEXT NOT NULL UNIQUE,
      vaultId INTEGER NOT NULL,
      maxSatoshis TEXT NOT NULL,
      expiresAfterTicks INTEGER NOT NULL,
      offerToken TEXT,
      expirationTick INTEGER,
      expiresAt TEXT,
      firstClickedAt TEXT,
      lastClickedAt TEXT,
      accountAddress TEXT,
      redeemedAt TEXT,
      lockedBitcoinAt TEXT,
      createdAt TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE INDEX idx_treasury_user_invites_vault_id ON TreasuryUserInvites(vaultId);
    CREATE INDEX idx_treasury_user_invites_created_at ON TreasuryUserInvites(createdAt DESC);
  `);
};
