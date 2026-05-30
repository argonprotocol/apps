CREATE TABLE WalletHdKeys (
  id INTEGER NOT NULL PRIMARY KEY,
  keyRole TEXT NOT NULL CHECK(keyRole IN ('bitcoinLock', 'councilSigner', 'mintingAuthority')),
  scopeKey TEXT NOT NULL,
  hdIndex INTEGER NOT NULL,
  hdPath TEXT NOT NULL,
  address TEXT NOT NULL,
  publicKeyHex TEXT,
  createdAt DATETIME DEFAULT CURRENT_TIMESTAMP,
  updatedAt DATETIME DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(keyRole, scopeKey, hdIndex),
  UNIQUE(keyRole, scopeKey, address),
  UNIQUE(address),
  UNIQUE(hdPath)
);

CREATE TRIGGER WalletHdKeysUpdateTimestamp
AFTER UPDATE ON WalletHdKeys
BEGIN
  UPDATE WalletHdKeys SET updatedAt = CURRENT_TIMESTAMP WHERE id = NEW.id;
END;
