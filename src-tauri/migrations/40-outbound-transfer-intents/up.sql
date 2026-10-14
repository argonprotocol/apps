DROP TRIGGER IF EXISTS CrosschainOutboundTransfersUpdateTimestamp;

ALTER TABLE CrosschainOutboundTransfers RENAME TO CrosschainOutboundTransfers_old;

CREATE TABLE CrosschainOutboundTransfers (
  id TEXT NOT NULL PRIMARY KEY,
  transferId TEXT UNIQUE,
  destinationChain TEXT NOT NULL CHECK(destinationChain IN ('Ethereum')),
  token TEXT NOT NULL,
  amount TEXT NOT NULL,
  argonSourceAddress TEXT NOT NULL,
  destinationAddress TEXT NOT NULL,
  argonRequestTransactionId INTEGER,
  mintingAuthorizationTransactionId INTEGER,
  targetTxHash TEXT,
  targetBlockNumber INTEGER,
  targetBlockHash TEXT,
  mintingAuthorizedMicrogons TEXT,
  mintingAuthorizedMicronots TEXT,
  mintingAuthorizedArgonBlockNumber INTEGER,
  mintingAuthorizedArgonBlockHash TEXT,
  gatewayActivityNonce TEXT,
  finalizeRequestJson TEXT,
  finalizeProofJson TEXT,
  progressJson TEXT NOT NULL DEFAULT '{}',
  status TEXT NOT NULL CHECK(status IN (
    'RequestPendingSubmission',
    'RequestSubmittedToArgon',
    'RequestFinalizedOnArgon',
    'MintingAuthorized',
    'TransferSubmittedToTargetChain',
    'TransferFinalizedOnTargetChain'
  )),
  createdAt DATETIME DEFAULT CURRENT_TIMESTAMP,
  updatedAt DATETIME DEFAULT CURRENT_TIMESTAMP,
  failureReason TEXT,
  isFailureAcknowledged INTEGER NOT NULL DEFAULT 0
);

INSERT INTO CrosschainOutboundTransfers SELECT * FROM CrosschainOutboundTransfers_old;

DROP TABLE CrosschainOutboundTransfers_old;

CREATE TRIGGER CrosschainOutboundTransfersUpdateTimestamp
AFTER UPDATE ON CrosschainOutboundTransfers
BEGIN
  UPDATE CrosschainOutboundTransfers SET updatedAt = CURRENT_TIMESTAMP WHERE id = NEW.id;
END;

CREATE INDEX CrosschainOutboundTransfersByDestinationChainTokenUpdatedAt
ON CrosschainOutboundTransfers(destinationChain, token, updatedAt DESC, createdAt DESC);
