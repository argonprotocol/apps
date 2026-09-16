CREATE TABLE WalletsNext (
  id INTEGER NOT NULL PRIMARY KEY,
  walletType TEXT NOT NULL CHECK(walletType IN ('argon', 'ethereum')),
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
    (walletType = 'argon' AND secretKind IS NULL AND encryptedSecret IS NULL) OR
    (
      walletType = 'ethereum' AND (
        (secretKind = 'coreMnemonic' AND encryptedSecret IS NULL) OR
        (secretKind IN ('privateKey', 'mnemonic') AND encryptedSecret IS NOT NULL)
      )
    )
  ),
  UNIQUE(address)
);

INSERT INTO WalletsNext (
  id,
  walletType,
  name,
  address,
  sortOrder,
  keyReference,
  derivationPath,
  secretKind,
  encryptedSecret,
  createdAt,
  updatedAt
)
SELECT
  id,
  walletType,
  name,
  address,
  sortOrder,
  keyReference,
  derivationPath,
  secretKind,
  encryptedSecret,
  createdAt,
  updatedAt
FROM Wallets;

DROP TABLE Wallets;
ALTER TABLE WalletsNext RENAME TO Wallets;

CREATE UNIQUE INDEX WalletsOneArgon
ON Wallets(walletType)
WHERE walletType = 'argon';

CREATE TRIGGER WalletsUpdateTimestamp
AFTER UPDATE ON Wallets
BEGIN
  UPDATE Wallets SET updatedAt = CURRENT_TIMESTAMP WHERE id = NEW.id;
END;

UPDATE Transactions
SET metadataJson = json_set(metadataJson, '$.sourceWalletType', 'argon')
WHERE extrinsicType = 'CrosschainTransferTransferOut'
  AND json_valid(metadataJson)
  AND json_extract(metadataJson, '$.sourceWalletType') = 'defaultArgon';

UPDATE Transactions
SET metadataJson = json_set(metadataJson, '$.rewardAccount', 'argon')
WHERE extrinsicType = 'OperationalActivateAndClaim'
  AND json_valid(metadataJson)
  AND json_extract(metadataJson, '$.rewardAccount') = 'defaultArgon';

UPDATE Transactions
SET metadataJson = json_set(metadataJson, '$.claimAccount', 'argon')
WHERE extrinsicType = 'OperationalClaimRewards'
  AND json_valid(metadataJson)
  AND json_extract(metadataJson, '$.claimAccount') = 'defaultArgon';

UPDATE WalletTransfers
SET walletName = 'argon'
WHERE walletName = 'defaultArgon';
