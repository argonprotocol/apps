CREATE TABLE Wallets (
  id INTEGER NOT NULL PRIMARY KEY,
  walletType TEXT NOT NULL CHECK(walletType IN ('argon', 'ethereum')),
  role TEXT NOT NULL CHECK(role IN ('defaultArgon', 'defaultEthereum', 'externalEthereum')),
  name TEXT NOT NULL,
  address TEXT NOT NULL,
  sortOrder INTEGER NOT NULL DEFAULT 0,
  keyReference TEXT,
  derivationPath TEXT,
  secretKind TEXT CHECK(secretKind IN ('coreMnemonic', 'privateKey', 'mnemonic')),
  encryptedSecret TEXT,
  createdAt DATETIME DEFAULT CURRENT_TIMESTAMP,
  updatedAt DATETIME DEFAULT CURRENT_TIMESTAMP,
  CHECK(
    (walletType = 'argon' AND role = 'defaultArgon') OR
    (walletType = 'ethereum' AND role IN ('defaultEthereum', 'externalEthereum'))
  ),
  CHECK(
    (role IN ('defaultArgon', 'defaultEthereum') AND encryptedSecret IS NULL) OR
    (role = 'externalEthereum' AND encryptedSecret IS NOT NULL)
  ),
  UNIQUE(address)
);

CREATE UNIQUE INDEX WalletsOneDefaultArgon
ON Wallets(walletType)
WHERE walletType = 'argon';

CREATE UNIQUE INDEX WalletsOneDefaultEthereum
ON Wallets(role)
WHERE role = 'defaultEthereum';

CREATE TRIGGER WalletsUpdateTimestamp
AFTER UPDATE ON Wallets
BEGIN
  UPDATE Wallets SET updatedAt = CURRENT_TIMESTAMP WHERE id = NEW.id;
END;
