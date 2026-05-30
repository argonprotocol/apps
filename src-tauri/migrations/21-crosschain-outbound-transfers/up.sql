DROP INDEX IF EXISTS CrosschainInboundTransfersByTokenUpdatedAt;

CREATE INDEX IF NOT EXISTS CrosschainInboundTransfersBySourceChainTokenUpdatedAt
ON CrosschainInboundTransfers(sourceChain, token, updatedAt DESC, createdAt DESC);

CREATE TABLE CrosschainOutboundTransfers (
  transferId TEXT NOT NULL PRIMARY KEY,
  destinationChain TEXT NOT NULL CHECK(destinationChain IN ('Ethereum')),
  token TEXT NOT NULL,
  amount TEXT NOT NULL,
  argonSourceAddress TEXT NOT NULL,
  destinationAddress TEXT NOT NULL,
  targetTxHash TEXT,
  targetBlockNumber INTEGER,
  targetBlockHash TEXT,
  collateralizedMicrogons TEXT,
  collateralizedMicronots TEXT,
  collateralizedArgonBlockNumber INTEGER,
  collateralizedArgonBlockHash TEXT,
  gatewayActivityNonce TEXT,
  finalizeRequestJson TEXT,
  finalizeProofJson TEXT,
  status TEXT NOT NULL CHECK(status IN ('RequestFinalizedOnArgon', 'Collateralized', 'TargetSubmitted', 'TargetFinalized')),
  createdAt DATETIME DEFAULT CURRENT_TIMESTAMP,
  updatedAt DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TRIGGER CrosschainOutboundTransfersUpdateTimestamp
AFTER UPDATE ON CrosschainOutboundTransfers
BEGIN
  UPDATE CrosschainOutboundTransfers SET updatedAt = CURRENT_TIMESTAMP WHERE transferId = NEW.transferId;
END;

CREATE INDEX IF NOT EXISTS CrosschainOutboundTransfersByDestinationChainTokenUpdatedAt
ON CrosschainOutboundTransfers(destinationChain, token, updatedAt DESC, createdAt DESC);
