-- CohortFrames
CREATE INDEX IF NOT EXISTS idxCohortFramesFrameId ON CohortFrames (frameId);

-- Cohorts
CREATE INDEX IF NOT EXISTS idxCohortsHasSeats ON Cohorts (seatCountWon, id);

-- Frames
CREATE INDEX IF NOT EXISTS idxFramesIsProcessed ON Frames (isProcessed, id DESC);

-- FrameBids
CREATE UNIQUE INDEX IF NOT EXISTS idxFrameBidsFrame ON FrameBids (frameId);

-- Main composite index for "finalize up to block"
CREATE INDEX IF NOT EXISTS idxWalletLedgerFinalizeUpTo ON WalletLedger (isFinalized, blockNumber);

-- Direct lookups by blockHash
CREATE INDEX IF NOT EXISTS idxWalletLedgerBlockHash ON WalletLedger (blockHash);

CREATE TABLE VaultRevenueEvents  (
  id INTEGER NOT NULL PRIMARY KEY,
  amount TEXT NOT NULL,
  source TEXT NOT NULL,
  blockNumber INTEGER NOT NULL,
  blockHash TEXT NOT NULL,
  createdAt DATETIME DEFAULT CURRENT_TIMESTAMP,
  updatedAt DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TRIGGER VaultRevenueEventsUpdated
AFTER UPDATE ON VaultRevenueEvents
BEGIN
  UPDATE VaultRevenueEvents SET updatedAt = CURRENT_TIMESTAMP WHERE id = NEW.id;
END;

-- Direct lookups by blockHash
CREATE INDEX IF NOT EXISTS idxVaultRevenueEventsBlockHash ON VaultRevenueEvents (blockHash);

CREATE TABLE WalletTransfers  (
  id INTEGER NOT NULL PRIMARY KEY,
  walletAddress TEXT NOT NULL,
  walletName TEXT NOT NULL,
  amount TEXT NOT NULL,
  currency TEXT NOT NULL,
  otherParty TEXT,
  transferType TEXT NOT NULL,
  isInternal INTEGER NOT NULL,
  extrinsicIndex INTEGER NOT NULL,
  blockNumber INTEGER NOT NULL,
  blockHash TEXT NOT NULL,
  createdAt DATETIME DEFAULT CURRENT_TIMESTAMP,
  updatedAt DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TRIGGER WalletTransfersUpdated
AFTER UPDATE ON WalletTransfers
BEGIN
  UPDATE WalletTransfers SET updatedAt = CURRENT_TIMESTAMP WHERE id = NEW.id;
END;

-- Direct lookups by blockHash
CREATE INDEX IF NOT EXISTS idxWalletTransfersBlockHash ON WalletTransfers (blockHash);

ALTER TABLE Vaults ADD COLUMN personalBitcoinMintAmountMovedOut TEXT NOT NULL DEFAULT '0';
ALTER TABLE Transactions ADD COLUMN followOnTxId INTEGER;
