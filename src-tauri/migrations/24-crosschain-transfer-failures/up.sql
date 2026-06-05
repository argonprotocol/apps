ALTER TABLE CrosschainInboundTransfers ADD COLUMN failureReason TEXT;
ALTER TABLE CrosschainInboundTransfers ADD COLUMN isFailureAcknowledged INTEGER NOT NULL DEFAULT 0;

ALTER TABLE CrosschainOutboundTransfers ADD COLUMN failureReason TEXT;
ALTER TABLE CrosschainOutboundTransfers ADD COLUMN isFailureAcknowledged INTEGER NOT NULL DEFAULT 0;
