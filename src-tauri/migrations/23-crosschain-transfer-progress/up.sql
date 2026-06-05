DROP TRIGGER IF EXISTS CrosschainInboundTransfersUpdateTimestamp;

ALTER TABLE CrosschainInboundTransfers RENAME TO CrosschainInboundTransfers_old;

CREATE TABLE CrosschainInboundTransfers (
  id TEXT NOT NULL PRIMARY KEY,
  sourceChain TEXT NOT NULL,
  token TEXT NOT NULL,
  amountBaseUnits TEXT NOT NULL,
  sourceAddress TEXT,
  argonDestinationAddress TEXT NOT NULL,
  sourceTxHash TEXT,
  sourceBlockNumber INTEGER,
  sourceBlockHash TEXT,
  sourceLogIndex INTEGER,
  gatewayActivityNonce TEXT,
  argonBlockNumber INTEGER,
  argonBlockHash TEXT,
  progressJson TEXT NOT NULL DEFAULT '{}',
  status TEXT NOT NULL CHECK(status IN ('SourceSubmitted', 'SourceFinalized', 'ArgonFinalized')),
  createdAt DATETIME DEFAULT CURRENT_TIMESTAMP,
  updatedAt DATETIME DEFAULT CURRENT_TIMESTAMP
);

INSERT INTO CrosschainInboundTransfers (
  id,
  sourceChain,
  token,
  amountBaseUnits,
  sourceAddress,
  argonDestinationAddress,
  sourceTxHash,
  sourceBlockNumber,
  sourceBlockHash,
  sourceLogIndex,
  gatewayActivityNonce,
  argonBlockNumber,
  argonBlockHash,
  progressJson,
  status,
  createdAt,
  updatedAt
)
SELECT
  transferId,
  sourceChain,
  token,
  amountBaseUnits,
  sourceAddress,
  argonDestinationAddress,
  sourceTxHash,
  sourceBlockNumber,
  sourceBlockHash,
  sourceLogIndex,
  gatewayActivityNonce,
  argonBlockNumber,
  argonBlockHash,
  '{}',
  status,
  createdAt,
  updatedAt
FROM CrosschainInboundTransfers_old;

DROP TABLE CrosschainInboundTransfers_old;

CREATE TRIGGER CrosschainInboundTransfersUpdateTimestamp
AFTER UPDATE ON CrosschainInboundTransfers
BEGIN
  UPDATE CrosschainInboundTransfers SET updatedAt = CURRENT_TIMESTAMP WHERE id = NEW.id;
END;

CREATE INDEX IF NOT EXISTS CrosschainInboundTransfersBySourceChainTokenUpdatedAt
ON CrosschainInboundTransfers(sourceChain, token, updatedAt DESC, createdAt DESC);

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
    'RequestSubmittedToArgon',
    'RequestFinalizedOnArgon',
    'MintingAuthorized',
    'TransferSubmittedToTargetChain',
    'TransferFinalizedOnTargetChain'
  )),
  createdAt DATETIME DEFAULT CURRENT_TIMESTAMP,
  updatedAt DATETIME DEFAULT CURRENT_TIMESTAMP
);

INSERT INTO CrosschainOutboundTransfers (
  id,
  transferId,
  destinationChain,
  token,
  amount,
  argonSourceAddress,
  destinationAddress,
  argonRequestTransactionId,
  mintingAuthorizationTransactionId,
  targetTxHash,
  targetBlockNumber,
  targetBlockHash,
  mintingAuthorizedMicrogons,
  mintingAuthorizedMicronots,
  mintingAuthorizedArgonBlockNumber,
  mintingAuthorizedArgonBlockHash,
  gatewayActivityNonce,
  finalizeRequestJson,
  finalizeProofJson,
  progressJson,
  status,
  createdAt,
  updatedAt
)
SELECT
  transferId,
  transferId,
  destinationChain,
  token,
  amount,
  argonSourceAddress,
  destinationAddress,
  NULL,
  NULL,
  targetTxHash,
  targetBlockNumber,
  targetBlockHash,
  collateralizedMicrogons,
  collateralizedMicronots,
  collateralizedArgonBlockNumber,
  collateralizedArgonBlockHash,
  gatewayActivityNonce,
  finalizeRequestJson,
  finalizeProofJson,
  '{}',
  CASE status
    WHEN 'ArgonSubmitted' THEN 'RequestSubmittedToArgon'
    WHEN 'ArgonFinalized' THEN 'RequestFinalizedOnArgon'
    WHEN 'Collateralized' THEN 'MintingAuthorized'
    WHEN 'TargetSubmitted' THEN 'TransferSubmittedToTargetChain'
    WHEN 'TargetFinalized' THEN 'TransferFinalizedOnTargetChain'
    ELSE status
  END,
  createdAt,
  updatedAt
FROM CrosschainOutboundTransfers_old;

DROP TABLE CrosschainOutboundTransfers_old;

CREATE TRIGGER CrosschainOutboundTransfersUpdateTimestamp
AFTER UPDATE ON CrosschainOutboundTransfers
BEGIN
  UPDATE CrosschainOutboundTransfers SET updatedAt = CURRENT_TIMESTAMP WHERE id = NEW.id;
END;

CREATE INDEX IF NOT EXISTS CrosschainOutboundTransfersByDestinationChainTokenUpdatedAt
ON CrosschainOutboundTransfers(destinationChain, token, updatedAt DESC, createdAt DESC);
