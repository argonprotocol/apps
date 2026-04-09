import type { ISqliteMigration } from '@argonprotocol/apps-core';

export const InitialMigration: ISqliteMigration = db => {
  db.exec(`
    CREATE TABLE Profile (
      name TEXT
    );

    CREATE TABLE UserInvites (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      inviteType TEXT NOT NULL,
      name TEXT NOT NULL,
      inviteCode TEXT NOT NULL UNIQUE,
      firstClickedAt TEXT,
      lastClickedAt TEXT,
      accountAddress TEXT,
      createdAt TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE BitcoinLockCoupons (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      inviteId INTEGER NOT NULL,
      offerCode TEXT NOT NULL UNIQUE,
      offerToken TEXT NOT NULL,
      vaultId INTEGER NOT NULL,
      maxSatoshis TEXT NOT NULL,
      expiresAfterTicks INTEGER NOT NULL,
      expirationTick INTEGER,
      expiresAt TEXT,
      createdAt TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE INDEX idx_user_invites_invite_type ON UserInvites(inviteType);
    CREATE INDEX idx_user_invites_created_at ON UserInvites(createdAt DESC);
    CREATE INDEX idx_bitcoin_lock_coupons_invite_id ON BitcoinLockCoupons(inviteId);
    CREATE INDEX idx_bitcoin_lock_coupons_vault_id ON BitcoinLockCoupons(vaultId);
    CREATE INDEX idx_bitcoin_lock_coupons_created_at ON BitcoinLockCoupons(createdAt DESC);
  `);
};
