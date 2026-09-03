CREATE TABLE BitcoinFissions (
  ownerAccount TEXT NOT NULL,
  origin TEXT NOT NULL CHECK(origin IN ('created', 'lock-migration')),
  fissionId INTEGER NOT NULL,
  liquidId INTEGER NOT NULL,
  utxoId INTEGER NOT NULL,
  satoshis TEXT NOT NULL,
  microgonsAtTargetPerBtc TEXT NOT NULL,
  liquidityPromised TEXT NOT NULL,
  createdAtArgonBlock INTEGER NOT NULL,
  ratchetNumber INTEGER NOT NULL,
  lastUpdatedArgonBlock INTEGER NOT NULL,
  createdAtTick INTEGER,
  createdBlockHash TEXT,
  createdBlockTime DATETIME,
  createdExtrinsicIndex INTEGER,
  closedAtArgonBlock INTEGER,
  closedAtTick INTEGER,
  closedBlockHash TEXT,
  closedBlockTime DATETIME,
  closedExtrinsicIndex INTEGER,
  closeReason TEXT CHECK(closeReason IN ('closed', 'lock-spent')),
  redemptionAmount TEXT,
  closeTxFee TEXT,
  btcPriceAtCloseMicrogons TEXT,
  createdAt DATETIME DEFAULT CURRENT_TIMESTAMP,
  updatedAt DATETIME DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (ownerAccount, fissionId)
);

CREATE TABLE BitcoinFissionRatchets (
  ownerAccount TEXT NOT NULL,
  fissionId INTEGER NOT NULL,
  liquidId INTEGER NOT NULL,
  utxoId INTEGER NOT NULL,
  source TEXT NOT NULL CHECK(source IN ('lock', 'fission')),
  sourceRatchetIndex INTEGER NOT NULL,
  ratchetNumber INTEGER,
  microgonsAtTargetPerBtc TEXT NOT NULL,
  liquidityPromised TEXT,
  amountMinted TEXT NOT NULL,
  amountBurned TEXT NOT NULL,
  mintPending TEXT NOT NULL,
  securityFee TEXT,
  txFee TEXT,
  blockNumber INTEGER NOT NULL,
  tick INTEGER,
  blockHash TEXT,
  blockTime DATETIME,
  extrinsicIndex INTEGER,
  updatedAt DATETIME DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (ownerAccount, fissionId, source, sourceRatchetIndex)
);

-- Spec 159 migrated the liquidity carried by funded Locks without emitting
-- FissionCreated. Retain that durable financial-history evidence as a migrated
-- Fission projection; it is not used as current runtime state.
INSERT INTO BitcoinFissions (
  ownerAccount, origin, fissionId, liquidId, utxoId, satoshis,
  microgonsAtTargetPerBtc, liquidityPromised, createdAtArgonBlock, ratchetNumber,
  lastUpdatedArgonBlock, createdAt, updatedAt
)
SELECT
  json_extract(lockDetails, '$.ownerAccount'),
  'lock-migration',
  utxoId,
  utxoId,
  utxoId,
  CAST(satoshis AS TEXT),
  CAST(lockedTargetPrice AS TEXT),
  CAST(liquidityPromised AS TEXT),
  COALESCE(json_extract(lockDetails, '$.createdAtArgonBlock'), 0),
  0,
  COALESCE(
    (SELECT MAX(json_extract(ratchet.value, '$.blockHeight')) FROM json_each(BitcoinLocks.ratchets) ratchet),
    json_extract(lockDetails, '$.createdAtArgonBlock'),
    0
  ),
  createdAt,
  updatedAt
FROM BitcoinLocks
WHERE utxoId IS NOT NULL
  AND status IN ('LockedAndIsMinting', 'LockedAndMinted', 'Releasing', 'Released')
  AND CAST(liquidityPromised AS INTEGER) > 0
  AND json_extract(lockDetails, '$.ownerAccount') IS NOT NULL;

-- Pre-159 Lock ratchets are the opening ledger for the migrated Fission. Their
-- array index is deliberately kept in a separate source namespace from the
-- runtime's post-159 Fission ratchet number.
INSERT INTO BitcoinFissionRatchets (
  ownerAccount, fissionId, liquidId, utxoId, source, sourceRatchetIndex,
  microgonsAtTargetPerBtc, liquidityPromised, amountMinted, amountBurned,
  mintPending, securityFee, txFee, blockNumber, extrinsicIndex
)
SELECT
  json_extract(BitcoinLocks.lockDetails, '$.ownerAccount'),
  BitcoinLocks.utxoId,
  BitcoinLocks.utxoId,
  BitcoinLocks.utxoId,
  'lock',
  CAST(ratchet.key AS INTEGER),
  RTRIM(json_extract(ratchet.value, '$.lockedTargetPrice'), 'n'),
  RTRIM(json_extract(ratchet.value, '$.liquidityPromised'), 'n'),
  RTRIM(json_extract(ratchet.value, '$.mintAmount'), 'n'),
  COALESCE(RTRIM(json_extract(ratchet.value, '$.burned'), 'n'), '0'),
  RTRIM(json_extract(ratchet.value, '$.mintPending'), 'n'),
  RTRIM(json_extract(ratchet.value, '$.securityFee'), 'n'),
  RTRIM(json_extract(ratchet.value, '$.txFee'), 'n'),
  json_extract(ratchet.value, '$.blockHeight'),
  json_extract(ratchet.value, '$.extrinsicIndex')
FROM BitcoinLocks
JOIN json_each(BitcoinLocks.ratchets) ratchet
WHERE BitcoinLocks.utxoId IS NOT NULL
  AND BitcoinLocks.status IN ('LockedAndIsMinting', 'LockedAndMinted', 'Releasing', 'Released')
  AND CAST(BitcoinLocks.liquidityPromised AS INTEGER) > 0
  AND json_extract(BitcoinLocks.lockDetails, '$.ownerAccount') IS NOT NULL;

CREATE INDEX BitcoinFissionsByLock ON BitcoinFissions(ownerAccount, utxoId);
CREATE INDEX BitcoinFissionsByLiquid ON BitcoinFissions(ownerAccount, liquidId);
CREATE INDEX BitcoinFissionRatchetsByBlock
  ON BitcoinFissionRatchets(ownerAccount, blockNumber, extrinsicIndex);

CREATE TABLE BitcoinSecuritizationHistory (
  ownerAccount TEXT NOT NULL,
  snapshotId TEXT NOT NULL,
  utxoId INTEGER NOT NULL,
  termIndex INTEGER NOT NULL,
  origin TEXT NOT NULL CHECK(origin IN ('created', 'resecuritized')),
  startTick INTEGER NOT NULL,
  startBlockNumber INTEGER NOT NULL,
  startBlockHash TEXT,
  startExtrinsicIndex INTEGER,
  securitizedSatoshis TEXT NOT NULL,
  securitizationCoverageMicrogons TEXT,
  cumulativeNetSecurityFee TEXT NOT NULL,
  addedNetSecurityFee TEXT NOT NULL,
  endTick INTEGER,
  endBlockNumber INTEGER,
  endBlockHash TEXT,
  endExtrinsicIndex INTEGER,
  endReason TEXT CHECK(endReason IN ('resecuritized', 'released')),
  PRIMARY KEY (ownerAccount, snapshotId, utxoId, termIndex)
);

CREATE INDEX BitcoinSecuritizationHistoryBySnapshot
  ON BitcoinSecuritizationHistory(ownerAccount, snapshotId, utxoId, termIndex);

-- Funding versus orphan is durable UTXO identity. It must not be inferred from
-- a release status after the deposit moves through its independent lifecycle.
ALTER TABLE BitcoinUtxos ADD COLUMN role TEXT CHECK(role IN ('Funding', 'Orphan'));

UPDATE BitcoinUtxos
SET role = CASE
  WHEN EXISTS (
    SELECT 1
    FROM BitcoinLocks
    WHERE BitcoinLocks.fundingUtxoRecordId = BitcoinUtxos.id
  ) THEN 'Funding'
  WHEN BitcoinUtxos.status = 'FundingUtxo' THEN 'Funding'
  WHEN EXISTS (
    SELECT 1
    FROM BitcoinUtxoStatusHistory
    WHERE BitcoinUtxoStatusHistory.utxoRecordId = BitcoinUtxos.id
      AND BitcoinUtxoStatusHistory.newStatus = 'FundingUtxo'
  ) THEN 'Funding'
  WHEN BitcoinUtxos.status = 'Orphaned' THEN 'Orphan'
  WHEN EXISTS (
    SELECT 1
    FROM BitcoinUtxoStatusHistory
    WHERE BitcoinUtxoStatusHistory.utxoRecordId = BitcoinUtxos.id
      AND BitcoinUtxoStatusHistory.newStatus = 'Orphaned'
  ) THEN 'Orphan'
END;

CREATE INDEX idxBitcoinUtxosRole ON BitcoinUtxos (role);

-- Liquidity and ratchet history now live above in the Fission ledger. Rebuild
-- the Lock row around custody, security, script identity, and local lifecycle.
DROP TRIGGER IF EXISTS BitcoinLocksUpdateTimestamp;
DROP TRIGGER IF EXISTS BitcoinLocksStatusChangeHistoryRecorder;

ALTER TABLE BitcoinLocks RENAME TO BitcoinLocks_before_fissions;

CREATE TABLE BitcoinLocks (
  uuid TEXT NOT NULL PRIMARY KEY,
  status TEXT NOT NULL CHECK(status IN (
    'LockIsProcessingOnArgon',
    'LockPendingFunding',
    'LockFailedAcknowledged',
    'LockFailed',
    'LockFunded',
    'Releasing',
    'Released'
  )) DEFAULT 'LockIsProcessingOnArgon',
  utxoId INTEGER,
  securitizedSatoshis TEXT NOT NULL,
  ownerAccount TEXT,
  microgonsAtTargetPerBtc TEXT,
  securitizationCoverageMicrogons TEXT,
  securitizationTick INTEGER,
  fissionedSatoshis TEXT,
  securitizationRatio REAL,
  securityFees TEXT,
  couponFeesPaid TEXT,
  scriptDetails JSON,
  fundingExpirationHeight INTEGER,
  isFlexible BOOLEAN,
  fundHoldExtensionsByBitcoinExpirationHeight JSON,
  createdAtArgonBlock INTEGER,
  cosignVersion TEXT NOT NULL,
  network TEXT NOT NULL,
  hdPath TEXT NOT NULL,
  vaultId INTEGER NOT NULL,
  relayMetadataJson JSON,
  blockExtrinsicErrorJson JSON,
  releaseRedemptionMicrogons TEXT,
  releaseArgonTxFeeMicrogons TEXT,
  releaseCompensationMicrogons TEXT,
  removalBlockNumber INTEGER,
  removalBlockHash TEXT,
  removalBlockTime DATETIME,
  removalExtrinsicIndex INTEGER,
  removalReason TEXT,
  btcPriceAtRemovalMicrogons TEXT,
  isHistoryRecoveryPending BOOLEAN NOT NULL DEFAULT 0,
  createdAt DATETIME DEFAULT CURRENT_TIMESTAMP,
  updatedAt DATETIME DEFAULT CURRENT_TIMESTAMP
);

INSERT INTO BitcoinLocks (
  uuid, status, utxoId, securitizedSatoshis, ownerAccount,
  microgonsAtTargetPerBtc, securitizationCoverageMicrogons, securitizationTick,
  fissionedSatoshis, securitizationRatio, securityFees, couponFeesPaid,
  scriptDetails, fundingExpirationHeight, isFlexible, fundHoldExtensionsByBitcoinExpirationHeight,
  createdAtArgonBlock, cosignVersion, network, hdPath, vaultId, relayMetadataJson,
  blockExtrinsicErrorJson, releaseRedemptionMicrogons, releaseArgonTxFeeMicrogons,
  releaseCompensationMicrogons, removalBlockNumber, removalBlockHash, removalBlockTime,
  removalExtrinsicIndex, removalReason, btcPriceAtRemovalMicrogons,
  isHistoryRecoveryPending, createdAt, updatedAt
)
SELECT
  uuid,
  CASE
    WHEN status IN ('LockedAndIsMinting', 'LockedAndMinted') THEN 'LockFunded'
    WHEN status IN (
      'LockExpiredWaitingForFunding',
      'LockExpiredWaitingForFundingAcknowledged',
      'LockFundingReadyToResume'
    ) THEN 'LockPendingFunding'
    ELSE status
  END,
  utxoId,
  COALESCE(
    RTRIM(json_extract(lockDetails, '$.securitizedSatoshis'), 'n'),
    CAST(satoshis AS TEXT)
  ),
  json_extract(lockDetails, '$.ownerAccount'),
  RTRIM(json_extract(lockDetails, '$.microgonsAtTargetPerBtc'), 'n'),
  RTRIM(json_extract(lockDetails, '$.securitizationCoverageMicrogons'), 'n'),
  json_extract(lockDetails, '$.securitizationTick'),
  RTRIM(json_extract(lockDetails, '$.fissionedSatoshis'), 'n'),
  json_extract(lockDetails, '$.securitizationRatio'),
  RTRIM(json_extract(lockDetails, '$.securityFees'), 'n'),
  RTRIM(json_extract(lockDetails, '$.couponFeesPaid'), 'n'),
  CASE
    WHEN json_extract(lockDetails, '$.p2wshScriptHashHex') IS NULL THEN NULL
    ELSE json_object(
      'p2wshScriptHashHex', json_extract(lockDetails, '$.p2wshScriptHashHex'),
      'vaultPubkey', json_extract(lockDetails, '$.vaultPubkey'),
      'vaultClaimPubkey', json_extract(lockDetails, '$.vaultClaimPubkey'),
      'ownerPubkey', json_extract(lockDetails, '$.ownerPubkey'),
      'vaultXpubSources', json(json_extract(lockDetails, '$.vaultXpubSources')),
      'vaultClaimHeight', json_extract(lockDetails, '$.vaultClaimHeight'),
      'openClaimHeight', json_extract(lockDetails, '$.openClaimHeight'),
      'createdAtHeight', json_extract(lockDetails, '$.createdAtHeight')
    )
  END,
  json_extract(lockDetails, '$.fundingExpirationHeight'),
  json_extract(lockDetails, '$.isFlexible'),
  COALESCE(json_extract(lockDetails, '$.fundHoldExtensionsByBitcoinExpirationHeight'), '{}'),
  json_extract(lockDetails, '$.createdAtArgonBlock'),
  cosignVersion,
  network,
  hdPath,
  vaultId,
  relayMetadataJson,
  blockExtrinsicErrorJson,
  releaseRedemptionMicrogons,
  releaseArgonTxFeeMicrogons,
  releaseCompensationMicrogons,
  removalBlockNumber,
  removalBlockHash,
  removalBlockTime,
  removalExtrinsicIndex,
  removalReason,
  btcPriceAtRemovalMicrogons,
  isHistoryRecoveryPending,
  createdAt,
  updatedAt
FROM BitcoinLocks_before_fissions;

DROP TABLE BitcoinLocks_before_fissions;

CREATE UNIQUE INDEX idxBitcoinLocksPendingHdPath ON BitcoinLocks (hdPath) WHERE utxoId IS NULL;

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
