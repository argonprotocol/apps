ALTER TABLE BitcoinLocks ADD COLUMN status2 TEXT NOT NULL CHECK(status2 IN (
  'LockInitialized', 'LockVerificationExpired', 'LockReceivedWrongAmount', 'LockProcessingOnBitcoin', 'LockedAndMinting', 'LockedAndMinted', 'ReleaseSubmittingToArgon', 'ReleaseWaitingForVault', 'ReleaseSubmittingToBitcoin', 'ReleaseProcessingOnBitcoin', 'ReleaseComplete'
  )
) DEFAULT 'LockInitialized';
UPDATE BitcoinLocks SET status2 = status;
ALTER TABLE BitcoinLocks DROP COLUMN status;
ALTER TABLE BitcoinLocks RENAME COLUMN status2 TO status;
