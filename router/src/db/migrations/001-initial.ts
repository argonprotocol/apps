import type { ISqliteMigration } from '@argonprotocol/apps-core';

export const InitialMigration: ISqliteMigration = db => {
  db.exec(`
    CREATE TABLE Profile (
      name TEXT
    );

    CREATE TABLE Users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      role TEXT NOT NULL,
      name TEXT NOT NULL,
      accountId TEXT,
      createdAt TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE UserInvites (
      userId INTEGER PRIMARY KEY,
      inviteCode TEXT NOT NULL UNIQUE,
      firstClickedAt TEXT,
      lastClickedAt TEXT,
      createdAt TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (userId) REFERENCES Users(id)
    );

    CREATE INDEX idx_users_role ON Users(role);
    CREATE INDEX idx_users_account_id ON Users(accountId);
  `);
};
