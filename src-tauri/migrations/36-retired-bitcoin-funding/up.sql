-- Migration 33 mapped unacknowledged expired locks back to pending funding.
-- Retain their terminal history without rewriting a shipped migration or any
-- subsequently accepted funding/release state. This repairs recorded expirations
-- under the former funding rules.
UPDATE BitcoinLocks
SET removalReason = 'expired'
WHERE status IN ('LockPendingFunding', 'LockFailedAcknowledged')
  AND lockId IS NOT NULL
  AND scriptDetails IS NOT NULL
  AND removalReason IS NULL
  AND CAST(fundedSatoshis AS INTEGER) = 0
  AND json_array_length(fundingUtxoIds) = 0
  AND activeReleaseId IS NULL
  AND EXISTS (
    SELECT 1 FROM BitcoinLockStatusHistory expired
    WHERE expired.uuid = BitcoinLocks.uuid
      AND expired.newStatus IN ('LockExpiredWaitingForFunding', 'LockExpiredWaitingForFundingAcknowledged')
      AND NOT EXISTS (
        SELECT 1 FROM BitcoinLockStatusHistory later
        WHERE later.uuid = expired.uuid AND later.rowid > expired.rowid
          AND later.newStatus NOT IN ('LockExpiredWaitingForFunding', 'LockExpiredWaitingForFundingAcknowledged', 'LockPendingFunding', 'LockFailedAcknowledged')
      )
  );
