-- Preserve existing release workflows while allowing cooperative deposit returns.
CREATE TABLE BitcoinCooperativeReleasesMigration (
  id TEXT NOT NULL PRIMARY KEY,
  kind TEXT NOT NULL CHECK(kind IN ('Lock', 'Orphan', 'Cooperative')),
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
    'Failed',
    'FailedAcknowledged'
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
  cooperativeRequest JSON,
  CHECK(
    (kind = 'Lock' AND releaseNumber IS NOT NULL) OR
    (kind IN ('Orphan', 'Cooperative') AND releaseNumber IS NULL)
  )
);

INSERT INTO BitcoinCooperativeReleasesMigration SELECT *, NULL FROM BitcoinReleases;
DROP TABLE BitcoinReleases;
ALTER TABLE BitcoinCooperativeReleasesMigration RENAME TO BitcoinReleases;

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
