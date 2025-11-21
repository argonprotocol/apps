CREATE TABLE WalletLedger  (
  id INTEGER NOT NULL PRIMARY KEY,
  walletAddress TEXT NOT NULL,
  walletName TEXT NOT NULL,
  availableMicrogons TEXT NOT NULL,
  reservedMicrogons TEXT NOT NULL,
  availableMicronots TEXT NOT NULL,
  reservedMicronots TEXT NOT NULL,
  microgonChange TEXT NOT NULL,
  micronotChange TEXT NOT NULL,
  microgonsForUsd TEXT NOT NULL,
  microgonsForArgonot TEXT NOT NULL,
  inboundTransfersJson JSON NOT NULL,
  extrinsicEventsJson JSON NOT NULL,
  blockNumber INTEGER NOT NULL,
  blockHash TEXT NOT NULL,
  isFinalized INTEGER NOT NULL DEFAULT 0,
  createdAt DATETIME DEFAULT CURRENT_TIMESTAMP,
  updatedAt DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TRIGGER WalletLedgerUpdateTimestamp
AFTER UPDATE ON WalletLedger
BEGIN
  UPDATE WalletLedger SET updatedAt = CURRENT_TIMESTAMP WHERE id = NEW.id;
END;
