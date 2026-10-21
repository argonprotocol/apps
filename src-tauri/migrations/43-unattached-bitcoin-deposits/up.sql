DROP TRIGGER BitcoinUtxosUpdateTimestamp;
DROP TRIGGER BitcoinUtxosStatusInsertHistoryRecorder;
DROP TRIGGER BitcoinUtxosStatusChangeHistoryRecorder;

CREATE TABLE BitcoinUtxos_with_unattached (
  id INTEGER PRIMARY KEY,
  lockId INTEGER NOT NULL,
  txid TEXT NOT NULL,
  vout INTEGER NOT NULL,
  satoshis TEXT NOT NULL,
  network TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('SeenOnMempool', 'FundingUtxo', 'Orphaned', 'Unattached')),
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
  updatedAt DATETIME DEFAULT CURRENT_TIMESTAMP,
  fundingRejectionReason TEXT,
  isDepositAcknowledged INTEGER NOT NULL DEFAULT 0,
  isOnArgonChain INTEGER
);

INSERT INTO BitcoinUtxos_with_unattached SELECT * FROM BitcoinUtxos;
DROP TABLE BitcoinUtxos;
ALTER TABLE BitcoinUtxos_with_unattached RENAME TO BitcoinUtxos;

CREATE TABLE BitcoinUtxoStatusHistory_with_unattached (
  id INTEGER PRIMARY KEY,
  utxoRecordId INTEGER NOT NULL,
  newStatus TEXT NOT NULL CHECK(newStatus IN ('SeenOnMempool', 'FundingUtxo', 'Orphaned', 'Unattached')),
  createdAt DATETIME DEFAULT CURRENT_TIMESTAMP
);

INSERT INTO BitcoinUtxoStatusHistory_with_unattached SELECT * FROM BitcoinUtxoStatusHistory;
DROP TABLE BitcoinUtxoStatusHistory;
ALTER TABLE BitcoinUtxoStatusHistory_with_unattached RENAME TO BitcoinUtxoStatusHistory;

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
