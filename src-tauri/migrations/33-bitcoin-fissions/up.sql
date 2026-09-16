CREATE TABLE BitcoinFissions (
  ownerAccount TEXT NOT NULL,
  origin TEXT NOT NULL CHECK(origin IN ('created', 'lock-migration')),
  fissionId INTEGER NOT NULL,
  liquidId INTEGER NOT NULL,
  lockId INTEGER NOT NULL,
  satoshis TEXT NOT NULL,
  microgonsAtTargetPerBtc TEXT NOT NULL,
  liquidityPromised TEXT NOT NULL,
  createdAtArgonBlock INTEGER NOT NULL,
  ratchetNumber INTEGER NOT NULL,
  lastUpdatedArgonBlock INTEGER NOT NULL,
  feeHistoryCompleteThroughBlock INTEGER,
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
  lockId INTEGER NOT NULL,
  source TEXT NOT NULL CHECK(source IN ('lock', 'fission')),
  sourceRatchetIndex INTEGER NOT NULL,
  ratchetNumber INTEGER,
  microgonsAtTargetPerBtc TEXT NOT NULL,
  liquidityPromised TEXT,
  amountMinted TEXT NOT NULL,
  amountBurned TEXT NOT NULL,
  mintPending TEXT NOT NULL,
  securityFee TEXT,
  securityFeeCoupon TEXT,
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
  ownerAccount, origin, fissionId, liquidId, lockId, satoshis,
  microgonsAtTargetPerBtc, liquidityPromised, createdAtArgonBlock, ratchetNumber,
  lastUpdatedArgonBlock, redemptionAmount, createdAt, updatedAt
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
  CASE WHEN status = 'Released' THEN CAST(releaseRedemptionMicrogons AS TEXT) END,
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
  ownerAccount, fissionId, liquidId, lockId, source, sourceRatchetIndex,
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

CREATE INDEX BitcoinFissionsByLock ON BitcoinFissions(ownerAccount, lockId);
CREATE INDEX BitcoinFissionsByLiquid ON BitcoinFissions(ownerAccount, liquidId);
CREATE INDEX BitcoinFissionRatchetsByBlock
  ON BitcoinFissionRatchets(ownerAccount, blockNumber, extrinsicIndex);

CREATE TABLE BitcoinSecuritizationHistory (
  ownerAccount TEXT NOT NULL,
  snapshotId TEXT NOT NULL,
  lockId INTEGER NOT NULL,
  termIndex INTEGER NOT NULL,
  origin TEXT NOT NULL CHECK(origin IN ('created', 'resecuritized', 'partial-release')),
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
  endReason TEXT CHECK(endReason IN ('resecuritized', 'partial-release', 'released')),
  PRIMARY KEY (ownerAccount, snapshotId, lockId, termIndex)
);

CREATE INDEX BitcoinSecuritizationHistoryBySnapshot
  ON BitcoinSecuritizationHistory(ownerAccount, snapshotId, lockId, termIndex);

-- A Release owns outbound workflow state shared by one or more input UTXOs.
-- Migration 32 stored the runtime release script on each input UTXO.
CREATE TABLE BitcoinReleases (
  id TEXT NOT NULL PRIMARY KEY,
  kind TEXT NOT NULL CHECK(kind IN ('Lock', 'Orphan')),
  lockId INTEGER NOT NULL,
  sendId TEXT NOT NULL,
  releaseNumber INTEGER,
  status TEXT NOT NULL CHECK(status IN (
    'SubmittingRequestOnArgon',
    'WaitingForVaultCosign',
    'ReadyForBitcoinBroadcast',
    'ConfirmingOnBitcoin',
    'WaitingForArgonRecognition',
    'Complete',
    'Cancelled',
    'Failed'
  )),
  inputUtxoIds JSON NOT NULL,
  requestedReleaseAtTick INTEGER,
  toScriptPubkey TEXT NOT NULL,
  bitcoinNetworkFee TEXT NOT NULL,
  destinationSatoshis TEXT NOT NULL,
  changeSatoshis TEXT NOT NULL,
  cosignDueFrame INTEGER,
  expectedTransactionId TEXT,
  insuredMicrogons TEXT,
  argonTxFeeMicrogons TEXT,
  compensationMicrogons TEXT,
  vaultSignatures JSON NOT NULL DEFAULT '[]',
  cosignBlockNumber INTEGER,
  bitcoinTxid TEXT,
  bitcoinFirstSeenAt DATETIME,
  bitcoinFirstSeenHeight INTEGER,
  bitcoinFirstSeenOracleHeight INTEGER,
  bitcoinLastConfirmationCheckAt DATETIME,
  bitcoinLastConfirmationCheckOracleHeight INTEGER,
  bitcoinConfirmedHeight INTEGER,
  argonCompletionBlockNumber INTEGER,
  argonCompletionBlockHash TEXT,
  argonCompletionBlockTime DATETIME,
  argonCompletionExtrinsicIndex INTEGER,
  statusError TEXT,
  createdAt DATETIME DEFAULT CURRENT_TIMESTAMP,
  updatedAt DATETIME DEFAULT CURRENT_TIMESTAMP,
  CHECK(
    (kind = 'Lock' AND releaseNumber IS NOT NULL) OR
    (kind = 'Orphan' AND releaseNumber IS NULL)
  )
);

INSERT INTO BitcoinReleases (
  id, kind, lockId, sendId, releaseNumber, status, inputUtxoIds, requestedReleaseAtTick,
  toScriptPubkey, bitcoinNetworkFee, destinationSatoshis, changeSatoshis,
  insuredMicrogons, argonTxFeeMicrogons,
  compensationMicrogons, vaultSignatures, cosignBlockNumber, bitcoinTxid,
  bitcoinFirstSeenAt, bitcoinFirstSeenHeight, bitcoinFirstSeenOracleHeight,
  bitcoinLastConfirmationCheckAt, bitcoinLastConfirmationCheckOracleHeight,
  bitcoinConfirmedHeight, argonCompletionBlockNumber, argonCompletionBlockHash,
  argonCompletionBlockTime, argonCompletionExtrinsicIndex, statusError,
  createdAt, updatedAt
)
SELECT
  CASE
    WHEN BitcoinLocks.fundingUtxoRecordId = BitcoinUtxos.id
      THEN 'lock:' || BitcoinUtxos.lockUtxoId || ':1'
    ELSE 'migration-33-release-' || BitcoinUtxos.id
  END,
  CASE
    WHEN BitcoinLocks.fundingUtxoRecordId = BitcoinUtxos.id THEN 'Lock'
    ELSE 'Orphan'
  END,
  BitcoinUtxos.lockUtxoId,
  CASE
    WHEN BitcoinLocks.fundingUtxoRecordId = BitcoinUtxos.id
      THEN 'lock:' || BitcoinUtxos.lockUtxoId || ':1'
    ELSE 'migration-33-release-' || BitcoinUtxos.id
  END,
  CASE WHEN BitcoinLocks.fundingUtxoRecordId = BitcoinUtxos.id THEN 1 END,
  CASE
    WHEN BitcoinUtxos.status = 'ReleaseCompleteAcknowledged' OR BitcoinLocks.status = 'Released' THEN 'Complete'
    WHEN BitcoinUtxos.status = 'ReleaseComplete' THEN 'WaitingForArgonRecognition'
    WHEN BitcoinUtxos.releaseTxid IS NOT NULL THEN 'ConfirmingOnBitcoin'
    WHEN BitcoinUtxos.releaseCosignVaultSignature IS NOT NULL THEN 'ReadyForBitcoinBroadcast'
    WHEN BitcoinUtxos.requestedReleaseAtTick IS NOT NULL THEN 'WaitingForVaultCosign'
    ELSE 'SubmittingRequestOnArgon'
  END,
  json_array(BitcoinUtxos.id),
  BitcoinUtxos.requestedReleaseAtTick,
  BitcoinUtxos.releaseToDestinationAddress,
  CAST(BitcoinUtxos.releaseBitcoinNetworkFee AS TEXT),
  CAST(CAST(BitcoinUtxos.satoshis AS INTEGER) - CAST(BitcoinUtxos.releaseBitcoinNetworkFee AS INTEGER) AS TEXT),
  '0',
  NULL,
  CASE
    WHEN BitcoinLocks.fundingUtxoRecordId = BitcoinUtxos.id THEN BitcoinLocks.releaseArgonTxFeeMicrogons
    ELSE NULL
  END,
  CASE
    WHEN BitcoinLocks.fundingUtxoRecordId = BitcoinUtxos.id THEN BitcoinLocks.releaseCompensationMicrogons
    ELSE NULL
  END,
  CASE
    WHEN BitcoinUtxos.releaseCosignVaultSignature IS NULL THEN json_array()
    WHEN CAST(BitcoinUtxos.releaseCosignVaultSignature AS TEXT) LIKE '0x%'
      THEN json_array(lower(CAST(BitcoinUtxos.releaseCosignVaultSignature AS TEXT)))
    ELSE json_array('0x' || lower(hex(BitcoinUtxos.releaseCosignVaultSignature)))
  END,
  BitcoinUtxos.releaseCosignHeight,
  BitcoinUtxos.releaseTxid,
  BitcoinUtxos.releaseFirstSeenAt,
  BitcoinUtxos.releaseFirstSeenBitcoinHeight,
  BitcoinUtxos.releaseFirstSeenOracleHeight,
  BitcoinUtxos.releaseLastConfirmationCheckAt,
  BitcoinUtxos.releaseLastConfirmationCheckOracleHeight,
  BitcoinUtxos.releasedAtBitcoinHeight,
  CASE WHEN BitcoinUtxos.status = 'ReleaseCompleteAcknowledged' OR BitcoinLocks.status = 'Released'
    THEN BitcoinLocks.removalBlockNumber END,
  CASE WHEN BitcoinUtxos.status = 'ReleaseCompleteAcknowledged' OR BitcoinLocks.status = 'Released'
    THEN BitcoinLocks.removalBlockHash END,
  CASE WHEN BitcoinUtxos.status = 'ReleaseCompleteAcknowledged' OR BitcoinLocks.status = 'Released'
    THEN BitcoinLocks.removalBlockTime END,
  CASE WHEN BitcoinUtxos.status = 'ReleaseCompleteAcknowledged' OR BitcoinLocks.status = 'Released'
    THEN BitcoinLocks.removalExtrinsicIndex END,
  BitcoinUtxos.statusError,
  BitcoinUtxos.createdAt,
  BitcoinUtxos.updatedAt
FROM BitcoinUtxos
JOIN BitcoinLocks ON BitcoinLocks.utxoId = BitcoinUtxos.lockUtxoId
WHERE BitcoinUtxos.status IN (
  'ReleaseIsProcessingOnArgon',
  'ReleaseIsProcessingOnBitcoin',
  'ReleaseComplete',
  'ReleaseCompleteAcknowledged'
);

CREATE INDEX idxBitcoinReleasesLockId ON BitcoinReleases (lockId);
CREATE INDEX idxBitcoinReleasesStatus ON BitcoinReleases (status);
CREATE INDEX idxBitcoinReleasesSendId ON BitcoinReleases (sendId);
CREATE UNIQUE INDEX idxBitcoinReleasesLockNumber
  ON BitcoinReleases (lockId, releaseNumber)
  WHERE kind = 'Lock' AND releaseNumber IS NOT NULL;

CREATE TRIGGER BitcoinReleasesUpdateTimestamp
AFTER UPDATE ON BitcoinReleases
BEGIN
  UPDATE BitcoinReleases SET updatedAt = CURRENT_TIMESTAMP WHERE id = NEW.id;
END;

-- Keep inbound observation/classification on the UTXO and move all outbound
-- workflow fields to BitcoinReleases.
DROP TRIGGER IF EXISTS BitcoinUtxosUpdateTimestamp;
DROP TRIGGER IF EXISTS BitcoinUtxosStatusInsertHistoryRecorder;
DROP TRIGGER IF EXISTS BitcoinUtxosStatusChangeHistoryRecorder;

ALTER TABLE BitcoinUtxos RENAME TO BitcoinUtxos_before_release_ownership;
ALTER TABLE BitcoinUtxoStatusHistory RENAME TO BitcoinUtxoStatusHistory_before_release_ownership;

DROP INDEX IF EXISTS idxBitcoinUtxosLockOutpoint;
DROP INDEX IF EXISTS idxBitcoinUtxosLockUtxoId;
DROP INDEX IF EXISTS idxBitcoinUtxosStatus;
DROP INDEX IF EXISTS idxBitcoinUtxoStatusHistoryUtxoRecordIdCreatedAt;

CREATE TABLE BitcoinUtxos (
  id INTEGER PRIMARY KEY,
  lockId INTEGER NOT NULL,
  txid TEXT NOT NULL,
  vout INTEGER NOT NULL,
  satoshis TEXT NOT NULL,
  network TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('SeenOnMempool', 'FundingUtxo', 'Orphaned')),
  spendStatus TEXT NOT NULL CHECK(spendStatus IN ('Unspent', 'Spent')) DEFAULT 'Unspent',
  activeReleaseId TEXT,
  createdByReleaseId TEXT,
  spentByReleaseId TEXT,
  statusError TEXT,
  mempoolObservation JSON,
  firstSeenAt DATETIME NOT NULL,
  firstSeenOnArgonAt DATETIME,
  firstSeenBitcoinHeight INTEGER NOT NULL,
  firstSeenOracleHeight INTEGER,
  lastConfirmationCheckAt DATETIME,
  lastConfirmationCheckOracleHeight INTEGER,
  createdAt DATETIME DEFAULT CURRENT_TIMESTAMP,
  updatedAt DATETIME DEFAULT CURRENT_TIMESTAMP
);

INSERT INTO BitcoinUtxos (
  id, lockId, txid, vout, satoshis, network, status, spendStatus,
  activeReleaseId, createdByReleaseId, spentByReleaseId, statusError,
  mempoolObservation, firstSeenAt, firstSeenOnArgonAt, firstSeenBitcoinHeight,
  firstSeenOracleHeight, lastConfirmationCheckAt,
  lastConfirmationCheckOracleHeight, createdAt, updatedAt
)
SELECT
  source.id,
  source.lockUtxoId,
  source.txid,
  source.vout,
  CAST(source.satoshis AS TEXT),
  source.network,
  CASE
    WHEN EXISTS (SELECT 1 FROM BitcoinLocks WHERE fundingUtxoRecordId = source.id) THEN 'FundingUtxo'
    WHEN EXISTS (
      SELECT 1 FROM BitcoinUtxoStatusHistory_before_release_ownership history
      WHERE history.utxoRecordId = source.id AND history.newStatus = 'FundingUtxo'
    ) THEN 'FundingUtxo'
    WHEN source.status = 'Orphaned' OR EXISTS (
      SELECT 1 FROM BitcoinUtxoStatusHistory_before_release_ownership history
      WHERE history.utxoRecordId = source.id AND history.newStatus = 'Orphaned'
    ) THEN 'Orphaned'
    ELSE 'SeenOnMempool'
  END,
  CASE WHEN source.status IN ('ReleaseComplete', 'ReleaseCompleteAcknowledged') THEN 'Spent' ELSE 'Unspent' END,
  CASE
    WHEN source.status NOT IN ('ReleaseIsProcessingOnArgon', 'ReleaseIsProcessingOnBitcoin', 'ReleaseComplete')
      THEN NULL
    WHEN EXISTS (SELECT 1 FROM BitcoinLocks WHERE fundingUtxoRecordId = source.id)
      THEN 'lock:' || source.lockUtxoId || ':1'
    ELSE 'migration-33-release-' || source.id
  END,
  NULL,
  CASE
    WHEN source.status NOT IN ('ReleaseComplete', 'ReleaseCompleteAcknowledged') THEN NULL
    WHEN EXISTS (SELECT 1 FROM BitcoinLocks WHERE fundingUtxoRecordId = source.id)
      THEN 'lock:' || source.lockUtxoId || ':1'
    ELSE 'migration-33-release-' || source.id
  END,
  CASE
    WHEN source.status IN ('ReleaseIsProcessingOnArgon', 'ReleaseIsProcessingOnBitcoin', 'ReleaseComplete', 'ReleaseCompleteAcknowledged')
    THEN NULL
    ELSE source.statusError
  END,
  source.mempoolObservation,
  source.firstSeenAt,
  source.firstSeenOnArgonAt,
  source.firstSeenBitcoinHeight,
  source.firstSeenOracleHeight,
  source.lastConfirmationCheckAt,
  source.lastConfirmationCheckOracleHeight,
  source.createdAt,
  source.updatedAt
FROM BitcoinUtxos_before_release_ownership source;

CREATE TABLE BitcoinUtxoStatusHistory (
  id INTEGER PRIMARY KEY,
  utxoRecordId INTEGER NOT NULL,
  newStatus TEXT NOT NULL CHECK(newStatus IN ('SeenOnMempool', 'FundingUtxo', 'Orphaned')),
  createdAt DATETIME DEFAULT CURRENT_TIMESTAMP
);

INSERT INTO BitcoinUtxoStatusHistory (id, utxoRecordId, newStatus, createdAt)
SELECT
  id,
  utxoRecordId,
  CASE WHEN newStatus = 'FundingCandidate' THEN 'SeenOnMempool' ELSE newStatus END,
  createdAt
FROM BitcoinUtxoStatusHistory_before_release_ownership
WHERE newStatus IN ('SeenOnMempool', 'FundingCandidate', 'FundingUtxo', 'Orphaned');

CREATE UNIQUE INDEX idxBitcoinUtxosLockOutpoint ON BitcoinUtxos (lockId, txid, vout);
CREATE INDEX idxBitcoinUtxosLockId ON BitcoinUtxos (lockId);
CREATE INDEX idxBitcoinUtxosStatus ON BitcoinUtxos (status);
CREATE INDEX idxBitcoinUtxoStatusHistoryUtxoRecordIdCreatedAt
  ON BitcoinUtxoStatusHistory (utxoRecordId, createdAt);

CREATE TRIGGER BitcoinUtxosUpdateTimestamp
AFTER UPDATE ON BitcoinUtxos
BEGIN
  UPDATE BitcoinUtxos SET updatedAt = CURRENT_TIMESTAMP WHERE id = NEW.id;
END;

CREATE TRIGGER BitcoinUtxosStatusInsertHistoryRecorder
AFTER INSERT ON BitcoinUtxos
BEGIN
  INSERT INTO BitcoinUtxoStatusHistory (utxoRecordId, newStatus, createdAt)
  VALUES (NEW.id, NEW.status, NEW.createdAt);
END;

CREATE TRIGGER BitcoinUtxosStatusChangeHistoryRecorder
AFTER UPDATE OF status ON BitcoinUtxos
WHEN OLD.status IS NOT NEW.status
BEGIN
  INSERT INTO BitcoinUtxoStatusHistory (utxoRecordId, newStatus)
  VALUES (NEW.id, NEW.status);
END;

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
  lockId INTEGER,
  securitizedSatoshis TEXT NOT NULL,
  fundedSatoshis TEXT NOT NULL DEFAULT '0',
  fundingUtxoIds JSON NOT NULL DEFAULT '[]',
  activeReleaseId TEXT,
  ownerAccount TEXT,
  microgonsAtTargetPerBtc TEXT,
  securitizationCoverageMicrogons TEXT,
  securitizationTick INTEGER,
  fissionedSatoshis TEXT,
  securitizationRatio REAL,
  securityFees TEXT,
  couponFeesPaid TEXT,
  scriptDetails JSON,
  securitizationHoldExpirationBitcoinHeight INTEGER,
  isFlexible BOOLEAN,
  fundHoldExtensionsByBitcoinExpirationHeight JSON,
  createdAtArgonBlock INTEGER,
  cosignVersion TEXT NOT NULL,
  network TEXT NOT NULL,
  hdPath TEXT NOT NULL,
  vaultId INTEGER NOT NULL,
  relayMetadataJson JSON,
  blockExtrinsicErrorJson JSON,
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
  uuid, status, lockId, securitizedSatoshis, fundedSatoshis, fundingUtxoIds,
  activeReleaseId, ownerAccount,
  microgonsAtTargetPerBtc, securitizationCoverageMicrogons, securitizationTick,
  fissionedSatoshis, securitizationRatio, securityFees, couponFeesPaid,
  scriptDetails, securitizationHoldExpirationBitcoinHeight, isFlexible, fundHoldExtensionsByBitcoinExpirationHeight,
  createdAtArgonBlock, cosignVersion, network, hdPath, vaultId, relayMetadataJson,
  blockExtrinsicErrorJson, removalBlockNumber, removalBlockHash, removalBlockTime,
  removalExtrinsicIndex, removalReason, btcPriceAtRemovalMicrogons,
  isHistoryRecoveryPending, createdAt, updatedAt
)
SELECT
  uuid,
  CASE
    WHEN EXISTS (
      SELECT 1 FROM BitcoinReleases
      WHERE BitcoinReleases.lockId = BitcoinLocks_before_fissions.utxoId
        AND BitcoinReleases.kind = 'Lock'
        AND BitcoinReleases.status NOT IN ('Complete', 'Cancelled', 'Failed')
    ) THEN 'Releasing'
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
  COALESCE(
    (SELECT CAST(satoshis AS TEXT) FROM BitcoinUtxos WHERE id = fundingUtxoRecordId),
    RTRIM(json_extract(lockDetails, '$.fundedSatoshis'), 'n'),
    '0'
  ),
  CASE WHEN fundingUtxoRecordId IS NULL THEN json_array() ELSE json_array(fundingUtxoRecordId) END,
  (
    SELECT id FROM BitcoinReleases
    WHERE BitcoinReleases.lockId = BitcoinLocks_before_fissions.utxoId
      AND BitcoinReleases.kind = 'Lock'
      AND BitcoinReleases.status NOT IN ('Complete', 'Cancelled', 'Failed')
    LIMIT 1
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
DROP TABLE BitcoinUtxos_before_release_ownership;
DROP TABLE BitcoinUtxoStatusHistory_before_release_ownership;

CREATE UNIQUE INDEX idxBitcoinLocksPendingHdPath ON BitcoinLocks (hdPath) WHERE lockId IS NULL;
CREATE UNIQUE INDEX idxBitcoinLocksLockId ON BitcoinLocks (lockId) WHERE lockId IS NOT NULL;

CREATE TRIGGER BitcoinLocksUpdateTimestamp
AFTER UPDATE ON BitcoinLocks
BEGIN
  UPDATE BitcoinLocks SET updatedAt = CURRENT_TIMESTAMP WHERE uuid = NEW.uuid;
END;

-- Persisted transaction history predates the runtime's Lock naming. Preserve
-- creation UUIDs and output references while normalizing Lock references.
UPDATE Transactions
SET metadataJson = json_remove(
  json_set(metadataJson, '$.lockId', json_extract(metadataJson, '$.utxoId')),
  '$.utxoId'
)
WHERE json_valid(metadataJson)
  AND json_type(metadataJson, '$.utxoId') IS NOT NULL;

-- Pending release transaction post-processors resolve the workflow directly by
-- Release ID after the cutover. Attach the deterministic IDs created above to
-- deployed transaction metadata before those post-processors resume.
UPDATE Transactions
SET metadataJson = json_set(
  metadataJson,
  '$.releaseId',
  (
    SELECT BitcoinReleases.id
    FROM BitcoinReleases
    WHERE BitcoinReleases.kind = 'Lock'
      AND BitcoinReleases.lockId = json_extract(Transactions.metadataJson, '$.lockId')
    ORDER BY BitcoinReleases.createdAt DESC
    LIMIT 1
  )
)
WHERE extrinsicType = 'BitcoinRequestRelease'
  AND json_valid(metadataJson)
  AND json_type(metadataJson, '$.releaseId') IS NULL
  AND EXISTS (
    SELECT 1
    FROM BitcoinReleases
    WHERE BitcoinReleases.kind = 'Lock'
      AND BitcoinReleases.lockId = json_extract(Transactions.metadataJson, '$.lockId')
  );

UPDATE Transactions
SET metadataJson = json_set(
  metadataJson,
  '$.releaseId',
  (
    SELECT BitcoinReleases.id
    FROM BitcoinReleases
    WHERE BitcoinReleases.kind = 'Orphan'
      AND json_extract(BitcoinReleases.inputUtxoIds, '$[0]') = json_extract(Transactions.metadataJson, '$.utxoRecordId')
    ORDER BY BitcoinReleases.createdAt DESC
    LIMIT 1
  )
)
WHERE extrinsicType = 'BitcoinOrphanedUtxoRelease'
  AND json_valid(metadataJson)
  AND json_type(metadataJson, '$.releaseId') IS NULL
  AND EXISTS (
    SELECT 1
    FROM BitcoinReleases
    WHERE BitcoinReleases.kind = 'Orphan'
      AND json_extract(BitcoinReleases.inputUtxoIds, '$[0]') = json_extract(Transactions.metadataJson, '$.utxoRecordId')
  );

UPDATE Transactions
SET metadataJson = json_set(
  metadataJson,
  '$.releaseNumber',
  COALESCE(
    (
      SELECT BitcoinReleases.releaseNumber
      FROM BitcoinReleases
      WHERE BitcoinReleases.kind = 'Lock'
        AND BitcoinReleases.lockId = json_extract(Transactions.metadataJson, '$.lockId')
      ORDER BY BitcoinReleases.createdAt DESC
      LIMIT 1
    ),
    1
  )
)
WHERE extrinsicType IN ('BitcoinRequestRelease', 'VaultCosignBitcoinRelease')
  AND json_valid(metadataJson)
  AND json_type(metadataJson, '$.lockId') IS NOT NULL
  AND json_type(metadataJson, '$.releaseNumber') IS NULL;

UPDATE Transactions
SET metadataJson = json_set(
  metadataJson,
  '$.sendId',
  COALESCE(
    (
      SELECT BitcoinReleases.sendId
      FROM BitcoinReleases
      WHERE BitcoinReleases.id = json_extract(Transactions.metadataJson, '$.releaseId')
      LIMIT 1
    ),
    json_extract(metadataJson, '$.releaseId')
  )
)
WHERE extrinsicType = 'BitcoinRequestRelease'
  AND json_valid(metadataJson)
  AND json_type(metadataJson, '$.releaseId') IS NOT NULL
  AND json_type(metadataJson, '$.sendId') IS NULL;

UPDATE Transactions
SET metadataJson = json_remove(
  json_set(
    metadataJson,
    '$.cosignedReleases',
    json(
      (
        SELECT json_group_array(json_object('lockId', lockId.value, 'releaseNumber', 1))
        FROM json_each(
          COALESCE(
            json_extract(Transactions.metadataJson, '$.cosignedLockIds'),
            json_extract(Transactions.metadataJson, '$.cosignedUtxoIds')
          )
        ) lockId
      )
    )
  ),
  '$.cosignedLockIds',
  '$.cosignedUtxoIds'
)
WHERE extrinsicType = 'VaultCollect'
  AND json_valid(metadataJson)
  AND (
    json_type(metadataJson, '$.cosignedLockIds') = 'array'
    OR json_type(metadataJson, '$.cosignedUtxoIds') = 'array'
  );

UPDATE Transactions
SET metadataJson = json_remove(
  json_set(metadataJson, '$.bitcoin.lockId', json_extract(metadataJson, '$.bitcoin.utxoId')),
  '$.bitcoin.utxoId'
)
WHERE json_valid(metadataJson)
  AND json_type(metadataJson, '$.bitcoin.utxoId') IS NOT NULL;

UPDATE Transactions
SET metadataJson = json_set(
  metadataJson,
  '$.fissions',
  (
    SELECT json_group_array(
      json(
        json_remove(
          json_set(fission.value, '$.lockId', json_extract(fission.value, '$.utxoId')),
          '$.utxoId'
        )
      )
    )
    FROM json_each(metadataJson, '$.fissions') fission
  )
)
WHERE json_valid(metadataJson)
  AND json_type(metadataJson, '$.fissions') = 'array';

UPDATE Transactions
SET metadataJson = json_set(
  metadataJson,
  '$.resecuritizations',
  (
    SELECT json_group_array(
      json(
        CASE
          WHEN json_type(resecuritization.value, '$.bitcoin.utxoId') IS NULL THEN resecuritization.value
          ELSE json_remove(
            json_set(
              resecuritization.value,
              '$.bitcoin.lockId',
              json_extract(resecuritization.value, '$.bitcoin.utxoId')
            ),
            '$.bitcoin.utxoId'
          )
        END
      )
    )
    FROM json_each(metadataJson, '$.resecuritizations') resecuritization
  )
)
WHERE json_valid(metadataJson)
  AND json_type(metadataJson, '$.resecuritizations') = 'array';

UPDATE Transactions
SET metadataJson = json_remove(
  json_set(
    metadataJson,
    '$.resecuritizedLockIds',
    json_extract(metadataJson, '$.resecuritizedUtxoIds')
  ),
  '$.resecuritizedUtxoIds'
)
WHERE json_valid(metadataJson)
  AND json_type(metadataJson, '$.resecuritizedUtxoIds') = 'array';

CREATE TRIGGER BitcoinLocksStatusChangeHistoryRecorder
AFTER UPDATE OF status ON BitcoinLocks
WHEN OLD.status IS NOT NEW.status
BEGIN
  INSERT INTO BitcoinLockStatusHistory (uuid, newStatus)
  VALUES (NEW.uuid, NEW.status);
END;
