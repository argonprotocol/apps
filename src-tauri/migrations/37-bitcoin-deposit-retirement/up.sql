-- Keep deposit classification separate from rejection, dismissal, and current Argon availability.
ALTER TABLE BitcoinUtxos ADD COLUMN fundingRejectionReason TEXT;
ALTER TABLE BitcoinUtxos ADD COLUMN isFailureAcknowledged INTEGER NOT NULL DEFAULT 0;
ALTER TABLE BitcoinUtxos ADD COLUMN isOnArgonChain INTEGER;
