import type { ISqliteMigration } from '@argonprotocol/apps-core';

export const BitcoinCooperativeReleasesMigration: ISqliteMigration = db => {
  db.exec(`CREATE TABLE BitcoinCooperativeReleases (
    releaseId TEXT PRIMARY KEY,
    ownerAccount TEXT NOT NULL,
    vaultId INTEGER NOT NULL,
    utxoTxid TEXT NOT NULL,
    utxoOutputIndex INTEGER NOT NULL,
    requestJson TEXT NOT NULL,
    vaultSignatureHex TEXT,
    operatorError TEXT,
    createdAt INTEGER NOT NULL,
    updatedAt INTEGER NOT NULL,
    UNIQUE(ownerAccount, utxoTxid, utxoOutputIndex)
  );
  CREATE INDEX BitcoinCooperativeReleasesPending ON BitcoinCooperativeReleases(vaultId, createdAt, releaseId) WHERE vaultSignatureHex IS NULL;`);
};
