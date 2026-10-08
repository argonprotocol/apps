-- Keep deposit classification separate from rejection, dismissal, and current Argon availability.
ALTER TABLE BitcoinUtxos ADD COLUMN fundingRejectionReason TEXT;
ALTER TABLE BitcoinUtxos ADD COLUMN isDepositAcknowledged INTEGER NOT NULL DEFAULT 0;
ALTER TABLE BitcoinUtxos ADD COLUMN isOnArgonChain INTEGER;

-- Previously accepted deposits are history; pending deposits need a receipt when accepted.
UPDATE BitcoinUtxos SET isDepositAcknowledged = 1 WHERE status != 'SeenOnMempool';
