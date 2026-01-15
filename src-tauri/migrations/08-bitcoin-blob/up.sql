ALTER TABLE BitcoinLocks ADD COLUMN releaseCosignVaultSignature2 TEXT;
UPDATE BitcoinLocks
SET releaseCosignVaultSignature2 = '0x' || lower(hex(releaseCosignVaultSignature))
WHERE releaseCosignVaultSignature IS NOT NULL
  AND length(releaseCosignVaultSignature) > 0;

ALTER TABLE BitcoinLocks DROP COLUMN releaseCosignVaultSignature;
ALTER TABLE BitcoinLocks RENAME COLUMN releaseCosignVaultSignature2 TO releaseCosignVaultSignature;
