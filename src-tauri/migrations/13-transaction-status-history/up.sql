ALTER TABLE Transactions ADD COLUMN txNonce INTEGER;

CREATE TABLE TransactionStatusHistory (
  id INTEGER NOT NULL PRIMARY KEY,
  transactionId INTEGER NOT NULL,
  status TEXT NOT NULL CHECK(status IN (
    'Submitted',
    'Broadcast',
    'InBlock',
    'Finalized',
    'Error',
    'TimedOutWaitingForBlock',
    'Retracted',
    'Dropped',
    'Usurped',
    'Invalid'
  )),
  source TEXT NOT NULL CHECK(source IN (
    'Local',
    'Watch',
    'Block'
  )),
  blockHeight INTEGER,
  blockHash TEXT,
  replacementTxHash TEXT,
  createdAt DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idxTransactionStatusHistoryTransactionIdCreatedAt
ON TransactionStatusHistory (transactionId, createdAt, id);

INSERT INTO TransactionStatusHistory (
  transactionId,
  status,
  source,
  createdAt
)
SELECT
  id,
  'Submitted',
  'Local',
  COALESCE(submittedAtTime, createdAt, CURRENT_TIMESTAMP)
FROM Transactions;

INSERT INTO TransactionStatusHistory (
  transactionId,
  status,
  source,
  blockHeight,
  blockHash,
  createdAt
)
SELECT
  id,
  'InBlock',
  'Block',
  blockHeight,
  blockHash,
  COALESCE(blockTime, updatedAt, createdAt, CURRENT_TIMESTAMP)
FROM Transactions
WHERE blockHeight IS NOT NULL;

INSERT INTO TransactionStatusHistory (
  transactionId,
  status,
  source,
  blockHeight,
  createdAt
)
SELECT
  id,
  'Finalized',
  'Block',
  COALESCE(lastFinalizedBlockHeight, blockHeight),
  COALESCE(lastFinalizedBlockTime, updatedAt, createdAt, CURRENT_TIMESTAMP)
FROM Transactions
WHERE isFinalized = 1 OR status = 'Finalized';

INSERT INTO TransactionStatusHistory (
  transactionId,
  status,
  source,
  createdAt
)
SELECT
  id,
  'Error',
  'Local',
  COALESCE(updatedAt, createdAt, CURRENT_TIMESTAMP)
FROM Transactions
WHERE status = 'Error' OR submissionErrorJson IS NOT NULL;

INSERT INTO TransactionStatusHistory (
  transactionId,
  status,
  source,
  createdAt
)
SELECT
  id,
  'TimedOutWaitingForBlock',
  'Local',
  COALESCE(updatedAt, createdAt, CURRENT_TIMESTAMP)
FROM Transactions
WHERE status = 'TimedOutWaitingForBlock';
