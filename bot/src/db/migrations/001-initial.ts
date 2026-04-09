import type { ISqliteMigration } from '@argonprotocol/apps-core';

export const InitialMigration: ISqliteMigration = db => {
  db.exec(`
    CREATE TABLE BitcoinLockRelays (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      offerCode TEXT NOT NULL UNIQUE,
      vaultId INTEGER NOT NULL,
      maxSatoshis TEXT NOT NULL,
      expirationTick INTEGER NOT NULL,
      status TEXT NOT NULL,
      error TEXT,
      requestedSatoshis TEXT NOT NULL,
      securitizationUsedMicrogons TEXT NOT NULL,
      ownerAccountAddress TEXT NOT NULL,
      ownerBitcoinPubkey TEXT NOT NULL,
      microgonsPerBtc TEXT NOT NULL,
      delegateAddress TEXT,
      extrinsicHash TEXT,
      extrinsicMethodJson TEXT,
      nonce INTEGER,
      submittedAtBlockHeight INTEGER,
      submittedAtTime TEXT,
      expiresAtBlockHeight INTEGER,
      inBlockHeight INTEGER,
      inBlockHash TEXT,
      finalizedHeight INTEGER,
      txFeePlusTip TEXT,
      txTip TEXT,
      utxoId INTEGER,
      createdAt TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updatedAt TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE INDEX idx_bitcoin_lock_relays_status ON BitcoinLockRelays(status);
    CREATE INDEX idx_bitcoin_lock_relays_extrinsic_hash ON BitcoinLockRelays(extrinsicHash);
    CREATE INDEX idx_bitcoin_lock_relays_created_at ON BitcoinLockRelays(createdAt DESC);
  `);
};
