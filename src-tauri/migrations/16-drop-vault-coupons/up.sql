DROP TRIGGER IF EXISTS VaultCouponsUpdateTimestamp;

DROP INDEX IF EXISTS idxVaultCouponsVaultId;
DROP INDEX IF EXISTS idxVaultCouponsTxId;

DROP TABLE IF EXISTS VaultCoupons;
