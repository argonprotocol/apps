ALTER TABLE BitcoinLocks ADD COLUMN relayMetadataJson JSON;

CREATE TABLE BitcoinLockCoupons (
  id INTEGER NOT NULL PRIMARY KEY,
  operatorHost TEXT NOT NULL,
  inviteCode TEXT NOT NULL,
  offerCode TEXT NOT NULL UNIQUE,
  vaultId INTEGER NOT NULL,
  couponToken TEXT NOT NULL,
  expirationTick INTEGER,
  usedLockUuid TEXT,
  usedAt DATETIME,
  createdAt DATETIME DEFAULT CURRENT_TIMESTAMP,
  updatedAt DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idxBitcoinLockCouponsOperatorVault ON BitcoinLockCoupons (operatorHost, vaultId);

CREATE TRIGGER BitcoinLockCouponsUpdateTimestamp
AFTER UPDATE ON BitcoinLockCoupons
BEGIN
  UPDATE BitcoinLockCoupons SET updatedAt = CURRENT_TIMESTAMP WHERE id = NEW.id;
END;
