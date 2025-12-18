-- remove duplicate entries from WalletLedger based on walletAddress and blockHash
DELETE FROM WalletLedger
WHERE rowid NOT IN (
  SELECT MAX(rowid)
  FROM WalletLedger
  GROUP BY walletAddress, blockHash
);

CREATE UNIQUE INDEX IF NOT EXISTS idxWalletLedgerUnique ON WalletLedger (walletAddress, blockHash);
CREATE UNIQUE INDEX IF NOT EXISTS idxWalletTransfersUnique ON WalletTransfers (walletAddress, otherParty, extrinsicIndex, amount, currency, blockHash);
CREATE UNIQUE INDEX IF NOT EXISTS idxVaultRevenueEventsUnique ON VaultRevenueEvents (amount, source, blockHash);

CREATE TABLE SyncState  (
  key TEXT NOT NULL PRIMARY KEY,
  state JSON NOT NULL,
  createdAt DATETIME DEFAULT CURRENT_TIMESTAMP,
  updatedAt DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TRIGGER SyncStateUpdated
AFTER UPDATE ON SyncState
BEGIN
  UPDATE SyncState SET updatedAt = CURRENT_TIMESTAMP WHERE key = NEW.key;
END;
