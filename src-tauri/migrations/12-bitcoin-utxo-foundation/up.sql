DROP TRIGGER IF EXISTS BitcoinLocksUpdateTimestamp;
DROP TRIGGER IF EXISTS BitcoinLocksStatusChangeHistoryRecorder;
DROP TRIGGER IF EXISTS BitcoinUtxosUpdateTimestamp;
DROP TRIGGER IF EXISTS BitcoinUtxosStatusInsertHistoryRecorder;
DROP TRIGGER IF EXISTS BitcoinUtxosStatusChangeHistoryRecorder;

ALTER TABLE BitcoinLocks RENAME TO BitcoinLocks_old;

DROP TABLE IF EXISTS BitcoinUtxos;
DROP TABLE IF EXISTS BitcoinUtxoStatusHistory;
CREATE TABLE BitcoinUtxos (
  id INTEGER PRIMARY KEY,
  lockUtxoId INTEGER NOT NULL,
  txid TEXT NOT NULL,
  vout INTEGER NOT NULL,
  satoshis INTEGER NOT NULL,
  network TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN (
    'SeenOnMempool',
    'FundingCandidate',
    'FundingUtxo',
    'ReleaseIsProcessingOnArgon',
    'ReleaseIsProcessingOnBitcoin',
    'ReleaseComplete'
  )) DEFAULT 'FundingCandidate',
  statusError TEXT,
  mempoolObservation JSON,
  firstSeenAt DATETIME NOT NULL,
  firstSeenOnArgonAt DATETIME,
  firstSeenBitcoinHeight INTEGER NOT NULL,
  firstSeenOracleHeight INTEGER,
  lastConfirmationCheckAt DATETIME,
  lastConfirmationCheckOracleHeight INTEGER,
  requestedReleaseAtTick INTEGER,
  releaseBitcoinNetworkFee INTEGER,
  releaseToDestinationAddress TEXT,
  releaseCosignVaultSignature BLOB,
  releaseCosignHeight INTEGER,
  releaseTxid TEXT,
  releaseFirstSeenAt DATETIME,
  releaseFirstSeenBitcoinHeight INTEGER,
  releaseFirstSeenOracleHeight INTEGER,
  releaseLastConfirmationCheckAt DATETIME,
  releaseLastConfirmationCheckOracleHeight INTEGER,
  releasedAtBitcoinHeight INTEGER,
  createdAt DATETIME DEFAULT CURRENT_TIMESTAMP,
  updatedAt DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX IF NOT EXISTS idxBitcoinUtxosLockOutpoint
ON BitcoinUtxos (lockUtxoId, txid, vout);

CREATE INDEX IF NOT EXISTS idxBitcoinUtxosLockUtxoId
ON BitcoinUtxos (lockUtxoId);

CREATE INDEX IF NOT EXISTS idxBitcoinUtxosStatus
ON BitcoinUtxos (status);

CREATE TABLE BitcoinUtxoStatusHistory (
  id INTEGER PRIMARY KEY,
  utxoRecordId INTEGER NOT NULL,
  newStatus TEXT NOT NULL CHECK(newStatus IN (
    'SeenOnMempool',
    'FundingCandidate',
    'FundingUtxo',
    'ReleaseIsProcessingOnArgon',
    'ReleaseIsProcessingOnBitcoin',
    'ReleaseComplete'
  )),
  createdAt DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idxBitcoinUtxoStatusHistoryUtxoRecordIdCreatedAt
ON BitcoinUtxoStatusHistory (utxoRecordId, createdAt);

CREATE TRIGGER BitcoinUtxosStatusInsertHistoryRecorder
AFTER INSERT ON BitcoinUtxos
BEGIN
  INSERT INTO BitcoinUtxoStatusHistory (utxoRecordId, newStatus, createdAt)
  VALUES (NEW.id, NEW.status, NEW.createdAt);
END;

INSERT INTO BitcoinUtxos (
  lockUtxoId,
  txid,
  vout,
  satoshis,
  network,
  status,
  statusError,
  mempoolObservation,
  firstSeenAt,
  firstSeenOnArgonAt,
  firstSeenBitcoinHeight,
  firstSeenOracleHeight,
  lastConfirmationCheckAt,
  lastConfirmationCheckOracleHeight,
  requestedReleaseAtTick,
  releaseBitcoinNetworkFee,
  releaseToDestinationAddress,
  releaseCosignVaultSignature,
  releaseCosignHeight,
  releaseTxid,
  releaseFirstSeenAt,
  releaseFirstSeenBitcoinHeight,
  releaseFirstSeenOracleHeight,
  releaseLastConfirmationCheckAt,
  releaseLastConfirmationCheckOracleHeight,
  releasedAtBitcoinHeight,
  createdAt,
  updatedAt
)
SELECT
  old.utxoId,
  COALESCE(
    old.lockedTxid,
    NULLIF(json_extract(old.lockMempool, '$.txid'), '')
  ),
  COALESCE(
    old.lockedVout,
    CAST(NULLIF(json_extract(old.lockMempool, '$.vout'), '') AS INTEGER)
  ),
  COALESCE(
    old.lockedUtxoSatoshis,
    CAST(NULLIF(json_extract(old.lockMempool, '$.satoshis'), '') AS INTEGER),
    old.satoshis
  ),
  old.network,
  CASE
    WHEN old.releasedAtBitcoinHeight IS NOT NULL OR old.status = 'ReleaseComplete' THEN 'ReleaseComplete'
    WHEN old.status = 'ReleaseIsProcessingOnBitcoin' OR old.releasedTxid IS NOT NULL THEN 'ReleaseIsProcessingOnBitcoin'
    WHEN old.status IN ('ReleaseIsProcessingOnArgon', 'ReleaseIsWaitingForVault', 'ReleaseSigned') THEN 'ReleaseIsProcessingOnArgon'
    WHEN old.status = 'LockIsProcessingOnBitcoin' THEN 'SeenOnMempool'
    WHEN old.status IN (
      'LockReadyForBitcoin',
      'LockIsPendingFundingMismatchResolution',
      'LockFundingMismatchResolving',
      'LockReceivedWrongAmount',
      'LockFailedToHappen',
      'LockIsProcessingOnArgon'
    ) THEN 'FundingCandidate'
    ELSE 'FundingUtxo'
  END,
  NULL,
  old.lockMempool,
  COALESCE(
    old.lockProcessingOnBitcoinAtTime,
    DATETIME(NULLIF(json_extract(old.lockMempool, '$.transactionBlockTime'), 0), 'unixepoch'),
    old.createdAt,
    CURRENT_TIMESTAMP
  ),
  COALESCE(old.lockProcessingOnBitcoinAtTime, old.createdAt, CURRENT_TIMESTAMP),
  COALESCE(
    NULLIF(old.lockProcessingOnBitcoinAtBitcoinHeight, 0),
    NULLIF(json_extract(old.lockMempool, '$.transactionBlockHeight'), 0),
    COALESCE(json_extract(old.lockDetails, '$.createdAtHeight'), 0)
  ),
  COALESCE(
    NULLIF(old.lockProcessingOnBitcoinAtOracleBitcoinHeight, 0),
    NULLIF(json_extract(old.lockMempool, '$.argonBitcoinHeight'), 0),
    NULLIF(old.lockProcessingLastOracleBlockHeight, 0),
    COALESCE(json_extract(old.lockDetails, '$.createdAtHeight'), 0)
  ),
  COALESCE(
    old.lockProcessingLastOracleBlockDate,
    old.lockProcessingOnBitcoinAtTime,
    old.updatedAt,
    old.createdAt,
    CURRENT_TIMESTAMP
  ),
  COALESCE(
    NULLIF(old.lockProcessingLastOracleBlockHeight, 0),
    NULLIF(old.lockProcessingOnBitcoinAtOracleBitcoinHeight, 0),
    NULLIF(json_extract(old.lockMempool, '$.argonBitcoinHeight'), 0),
    COALESCE(json_extract(old.lockDetails, '$.createdAtHeight'), 0)
  ),
  old.requestedReleaseAtTick,
  old.releaseBitcoinNetworkFee,
  old.releaseToDestinationAddress,
  CASE
    WHEN old.releaseCosignVaultSignature IS NOT NULL THEN CAST(old.releaseCosignVaultSignature AS BLOB)
    ELSE NULL
  END,
  old.releaseCosignHeight,
  old.releasedTxid,
  old.releaseProcessingOnBitcoinAtDate,
  old.releaseProcessingOnBitcoinAtBitcoinHeight,
  old.releaseProcessingOnBitcoinAtOracleBitcoinHeight,
  old.releaseProcessingLastOracleBlockDate,
  old.releaseProcessingLastOracleBlockHeight,
  old.releasedAtBitcoinHeight,
  COALESCE(old.createdAt, CURRENT_TIMESTAMP),
  COALESCE(old.updatedAt, CURRENT_TIMESTAMP)
FROM BitcoinLocks_old old
WHERE old.utxoId IS NOT NULL
  AND COALESCE(old.lockedTxid, NULLIF(json_extract(old.lockMempool, '$.txid'), '')) IS NOT NULL
  AND COALESCE(old.lockedVout, CAST(NULLIF(json_extract(old.lockMempool, '$.vout'), '') AS INTEGER)) IS NOT NULL;

INSERT INTO BitcoinUtxoStatusHistory (utxoRecordId, newStatus, createdAt)
SELECT
  u.id,
  CASE
    WHEN h.newStatus = 'LockIsProcessingOnBitcoin' THEN 'SeenOnMempool'
    WHEN h.newStatus IN (
      'LockReadyForBitcoin',
      'LockIsPendingFundingMismatchResolution',
      'LockFundingMismatchResolving',
      'LockReceivedWrongAmount',
      'LockFailedToHappen'
    ) THEN 'FundingCandidate'
    WHEN h.newStatus IN ('ReleaseIsProcessingOnArgon', 'ReleaseIsWaitingForVault', 'ReleaseSigned') THEN 'ReleaseIsProcessingOnArgon'
    WHEN h.newStatus = 'ReleaseIsProcessingOnBitcoin' THEN 'ReleaseIsProcessingOnBitcoin'
    WHEN h.newStatus = 'ReleaseComplete' THEN 'ReleaseComplete'
    WHEN h.newStatus = 'LockIsProcessingOnArgon' THEN 'FundingCandidate'
    WHEN h.newStatus IN ('LockedAndIsMinting', 'LockedAndMinted') THEN 'FundingUtxo'
    ELSE NULL
  END,
  h.createdAt
FROM BitcoinLockStatusHistory h
JOIN BitcoinLocks_old old ON old.uuid = h.uuid
JOIN BitcoinUtxos u ON u.lockUtxoId = old.utxoId
WHERE old.utxoId IS NOT NULL
  AND CASE
    WHEN h.newStatus = 'LockIsProcessingOnBitcoin' THEN 'SeenOnMempool'
    WHEN h.newStatus IN (
      'LockReadyForBitcoin',
      'LockIsPendingFundingMismatchResolution',
      'LockFundingMismatchResolving',
      'LockReceivedWrongAmount',
      'LockFailedToHappen'
    ) THEN 'FundingCandidate'
    WHEN h.newStatus IN ('ReleaseIsProcessingOnArgon', 'ReleaseIsWaitingForVault', 'ReleaseSigned') THEN 'ReleaseIsProcessingOnArgon'
    WHEN h.newStatus = 'ReleaseIsProcessingOnBitcoin' THEN 'ReleaseIsProcessingOnBitcoin'
    WHEN h.newStatus = 'ReleaseComplete' THEN 'ReleaseComplete'
    WHEN h.newStatus = 'LockIsProcessingOnArgon' THEN 'FundingCandidate'
    WHEN h.newStatus IN ('LockedAndIsMinting', 'LockedAndMinted') THEN 'FundingUtxo'
    ELSE NULL
  END IS NOT NULL
ORDER BY h.createdAt;

CREATE TABLE BitcoinLocks (
  uuid TEXT NOT NULL PRIMARY KEY,
  status TEXT NOT NULL CHECK(status IN (
    'LockIsProcessingOnArgon',
    'LockPendingFunding',
    'LockExpiredWaitingForFunding',
    'LockedAndIsMinting',
    'LockedAndMinted',
    'Releasing',
    'Released'
  )) DEFAULT 'LockIsProcessingOnArgon',
  utxoId INTEGER,
  satoshis INTEGER NOT NULL,
  lockedMarketRate INTEGER NOT NULL DEFAULT 0,
  liquidityPromised INTEGER NOT NULL DEFAULT 0,
  ratchets JSON NOT NULL DEFAULT '[]',
  cosignVersion TEXT NOT NULL,
  lockDetails JSON NOT NULL DEFAULT '{}',
  fundingUtxoRecordId INTEGER REFERENCES BitcoinUtxos(id),
  network TEXT NOT NULL,
  hdPath TEXT NOT NULL,
  vaultId INTEGER NOT NULL,
  createdAt DATETIME DEFAULT CURRENT_TIMESTAMP,
  updatedAt DATETIME DEFAULT CURRENT_TIMESTAMP
);

INSERT INTO BitcoinLocks (
  uuid,
  status,
  utxoId,
  satoshis,
  lockedMarketRate,
  liquidityPromised,
  ratchets,
  cosignVersion,
  lockDetails,
  fundingUtxoRecordId,
  network,
  hdPath,
  vaultId,
  createdAt,
  updatedAt
)
SELECT
  old.uuid,
  CASE
    WHEN old.status = 'LockReadyForBitcoin' THEN 'LockPendingFunding'
    WHEN old.status = 'LockIsProcessingOnBitcoin' THEN 'LockPendingFunding'
    WHEN old.status = 'LockIsPendingFundingMismatchResolution' THEN 'LockPendingFunding'
    WHEN old.status = 'LockFundingMismatchResolving' THEN 'LockPendingFunding'
    WHEN old.status = 'LockReceivedWrongAmount' THEN 'LockPendingFunding'
    WHEN old.status = 'LockFailedToHappen' THEN 'LockExpiredWaitingForFunding'
    WHEN old.status IN ('ReleaseIsProcessingOnArgon', 'ReleaseIsWaitingForVault', 'ReleaseSigned', 'ReleaseIsProcessingOnBitcoin') THEN 'Releasing'
    WHEN old.status = 'ReleaseComplete' THEN 'Released'
    ELSE old.status
  END,
  old.utxoId,
  old.satoshis,
  old.lockedMarketRate,
  old.liquidityPromised,
  old.ratchets,
  old.cosignVersion,
  old.lockDetails,
  NULL,
  old.network,
  old.hdPath,
  old.vaultId,
  old.createdAt,
  old.updatedAt
FROM BitcoinLocks_old old;

UPDATE BitcoinLocks
SET fundingUtxoRecordId = (
  SELECT u.id
  FROM BitcoinUtxos u
  JOIN BitcoinLocks_old old ON old.uuid = BitcoinLocks.uuid
  WHERE u.lockUtxoId = BitcoinLocks.utxoId
    AND old.lockedTxid IS NOT NULL
    AND old.lockedVout IS NOT NULL
    AND u.txid = old.lockedTxid
    AND u.vout = old.lockedVout
  LIMIT 1
)
WHERE utxoId IS NOT NULL;

DROP TABLE BitcoinLocks_old;

CREATE UNIQUE INDEX IF NOT EXISTS idxBitcoinLocksHdPath ON BitcoinLocks (hdPath);
CREATE INDEX IF NOT EXISTS idxBitcoinLocksFundingUtxoRecordId ON BitcoinLocks (fundingUtxoRecordId);

CREATE TRIGGER BitcoinUtxosUpdateTimestamp
AFTER UPDATE ON BitcoinUtxos
BEGIN
  UPDATE BitcoinUtxos SET updatedAt = CURRENT_TIMESTAMP WHERE id = NEW.id;
END;

CREATE TRIGGER BitcoinUtxosStatusChangeHistoryRecorder
AFTER UPDATE OF status ON BitcoinUtxos
WHEN OLD.status IS NOT NEW.status
BEGIN
  INSERT INTO BitcoinUtxoStatusHistory (utxoRecordId, newStatus)
  VALUES (NEW.id, NEW.status);
END;

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
