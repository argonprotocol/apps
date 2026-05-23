CREATE TABLE CrosschainInboundTransfers (
  transferId TEXT NOT NULL PRIMARY KEY,
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
  status TEXT NOT NULL CHECK(status IN ('SourceSubmitted', 'SourceFinalized', 'ArgonFinalized')),
  createdAt DATETIME DEFAULT CURRENT_TIMESTAMP,
  updatedAt DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TRIGGER CrosschainInboundTransfersUpdateTimestamp
AFTER UPDATE ON CrosschainInboundTransfers
BEGIN
  UPDATE CrosschainInboundTransfers SET updatedAt = CURRENT_TIMESTAMP WHERE transferId = NEW.transferId;
END;

CREATE INDEX IF NOT EXISTS CrosschainInboundTransfersByTokenUpdatedAt
ON CrosschainInboundTransfers(token, updatedAt DESC, createdAt DESC);
