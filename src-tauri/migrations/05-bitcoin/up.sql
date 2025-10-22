ALTER TABLE BitcoinLocks ADD lockProcessingOnBitcoinAtBitcoinHeight INTEGER;
ALTER TABLE BitcoinLocks ADD lockProcessingOnBitcoinAtOracleBitcoinHeight INTEGER;
ALTER TABLE BitcoinLocks RENAME releasedAtHeight to releasedAtBitcoinHeight;
ALTER TABLE BitcoinLocks RENAME requestedReleaseAtHeight to requestedReleaseAtTick;
ALTER TABLE BitcoinLocks RENAME releaseCosignSignature to releaseCosignVaultSignature;

ALTER TABLE BitcoinLocks ADD COLUMN status2 TEXT NOT NULL CHECK(status2 IN (
  'LockInitialized', 'LockVerificationExpired', 'LockReceivedWrongAmount', 'LockProcessingOnBitcoin',
  'LockedAndMinting', 'LockedAndMinted', 'ReleaseSubmittingToArgon', 'ReleaseWaitingForVault', 'ReleasedByVault',
  'ReleaseProcessingOnBitcoin', 'ReleaseComplete'
  )
) DEFAULT 'LockInitialized';
UPDATE BitcoinLocks SET status2 = status;
ALTER TABLE BitcoinLocks DROP COLUMN status;
ALTER TABLE BitcoinLocks RENAME COLUMN status2 TO status;
