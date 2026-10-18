-- Terminated migrated Liquids retained a release quote rather than actual repayment,
-- and dropped any paid request fee. Keep them unavailable until history repairs both.
UPDATE BitcoinFissions
SET redemptionAmount = NULL,
    closeTxFee = NULL,
    feeHistoryCompleteThroughBlock = NULL
WHERE origin = 'lock-migration' AND closeReason = 'lock-spent';
