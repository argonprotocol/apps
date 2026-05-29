DROP TRIGGER IF EXISTS BitcoinLocksUpdateTimestamp;
DROP TRIGGER IF EXISTS BitcoinLocksStatusChangeHistoryRecorder;

ALTER TABLE BitcoinLocks RENAME TO BitcoinLocks_old;

CREATE TABLE BitcoinLocks (
  uuid TEXT NOT NULL PRIMARY KEY,
  status TEXT NOT NULL CHECK(status IN (
    'LockIsProcessingOnArgon',
    'LockPendingFunding',
    'LockExpiredWaitingForFunding',
    'LockExpiredWaitingForFundingAcknowledged',
    'LockFailedAcknowledged',
    'LockFundingReadyToResume',
    'LockFailed',
    'LockedAndIsMinting',
    'LockedAndMinted',
    'Releasing',
    'Released'
  )) DEFAULT 'LockIsProcessingOnArgon',
  utxoId INTEGER,
  satoshis INTEGER NOT NULL,
  lockedTargetPrice INTEGER NOT NULL DEFAULT 0,
  liquidityPromised INTEGER NOT NULL DEFAULT 0,
  ratchets JSON NOT NULL DEFAULT '[]',
  cosignVersion TEXT NOT NULL,
  lockDetails JSON NOT NULL DEFAULT '{}',
  fundingUtxoRecordId INTEGER REFERENCES BitcoinUtxos(id),
  network TEXT NOT NULL,
  hdPath TEXT NOT NULL,
  vaultId INTEGER NOT NULL,
  relayMetadataJson JSON,
  blockExtrinsicErrorJson JSON,
  createdAt DATETIME DEFAULT CURRENT_TIMESTAMP,
  updatedAt DATETIME DEFAULT CURRENT_TIMESTAMP
);

INSERT INTO BitcoinLocks (
  uuid,
  status,
  utxoId,
  satoshis,
  lockedTargetPrice,
  liquidityPromised,
  ratchets,
  cosignVersion,
  lockDetails,
  fundingUtxoRecordId,
  network,
  hdPath,
  vaultId,
  relayMetadataJson,
  blockExtrinsicErrorJson,
  createdAt,
  updatedAt
)
SELECT
  uuid,
  status,
  utxoId,
  satoshis,
  lockedTargetPrice,
  liquidityPromised,
  ratchets,
  cosignVersion,
  lockDetails,
  fundingUtxoRecordId,
  network,
  hdPath,
  vaultId,
  relayMetadataJson,
  blockExtrinsicErrorJson,
  createdAt,
  updatedAt
FROM BitcoinLocks_old;

DROP TABLE BitcoinLocks_old;

CREATE UNIQUE INDEX IF NOT EXISTS idxBitcoinLocksHdPath ON BitcoinLocks (hdPath);
CREATE INDEX IF NOT EXISTS idxBitcoinLocksFundingUtxoRecordId ON BitcoinLocks (fundingUtxoRecordId);

CREATE TRIGGER BitcoinLocksUpdateTimestamp
AFTER UPDATE ON BitcoinLocks
BEGIN
  UPDATE BitcoinLocks SET updatedAt = CURRENT_TIMESTAMP WHERE uuid = NEW.uuid;
END;

CREATE TRIGGER BitcoinLocksStatusChangeHistoryRecorder
AFTER UPDATE OF status ON BitcoinLocks
WHEN OLD.status IS NOT NEW.status
BEGIN
  INSERT INTO BitcoinLockStatusHistory (uuid, newStatus)
  VALUES (NEW.uuid, NEW.status);
END;
