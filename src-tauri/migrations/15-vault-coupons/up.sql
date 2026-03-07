CREATE TABLE VaultCoupons (
  id INTEGER NOT NULL PRIMARY KEY,
  vaultId INTEGER NOT NULL,
  txId INTEGER NOT NULL REFERENCES Transactions(id),
  label TEXT NOT NULL,
  publicKey TEXT NOT NULL UNIQUE,
  privateKey TEXT NOT NULL,
  maxSatoshis INTEGER NOT NULL,
  createdAt DATETIME DEFAULT CURRENT_TIMESTAMP,
  updatedAt DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idxVaultCouponsVaultId ON VaultCoupons (vaultId);
CREATE INDEX idxVaultCouponsTxId ON VaultCoupons (txId);

CREATE TRIGGER VaultCouponsUpdateTimestamp
AFTER UPDATE ON VaultCoupons
BEGIN
  UPDATE VaultCoupons SET updatedAt = CURRENT_TIMESTAMP WHERE id = NEW.id;
END;
