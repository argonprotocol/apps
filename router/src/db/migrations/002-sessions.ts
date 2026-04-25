import type { ISqliteMigration } from '@argonprotocol/apps-core';

export const SessionsMigration: ISqliteMigration = db => {
  db.exec(`
    CREATE TABLE Sessions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      sessionId TEXT NOT NULL UNIQUE,
      userId INTEGER NOT NULL,
      expiresAt TEXT NOT NULL,
      revokedAt TEXT,
      lastSeenAt TEXT,
      createdAt TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (userId) REFERENCES Users(id)
    );

    CREATE INDEX idx_sessions_session_id ON Sessions(sessionId);
    CREATE INDEX idx_sessions_user_id ON Sessions(userId);
    CREATE INDEX idx_sessions_expires_at ON Sessions(expiresAt);
    CREATE INDEX idx_sessions_revoked_at ON Sessions(revokedAt);
  `);
};
