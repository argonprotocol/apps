import type { ISqliteMigration } from '@argonprotocol/apps-core';

export const InitialMigration: ISqliteMigration = db => {
  db.exec(`
    CREATE TABLE BitcoinLockCoupons (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      userId INTEGER NOT NULL,
      offerCode TEXT NOT NULL UNIQUE,
      vaultId INTEGER NOT NULL,
      maxSatoshis TEXT NOT NULL,
      expiresAfterTicks INTEGER NOT NULL,
      expirationTick INTEGER,
      accountId TEXT,
      createdAt TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updatedAt TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE BitcoinLockRelays (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      couponId INTEGER NOT NULL UNIQUE,
      status TEXT NOT NULL,
      requestedSatoshis TEXT NOT NULL,
      securitizationUsedMicrogons TEXT NOT NULL,
      ownerAccountId TEXT NOT NULL,
      ownerBitcoinPubkey TEXT NOT NULL,
      microgonsPerBtc TEXT NOT NULL,
      error TEXT,
      delegateAddress TEXT,
      extrinsicHash TEXT,
      extrinsicMethodJson TEXT,
      txNonce INTEGER,
      txSubmittedAtBlockHeight INTEGER,
      txSubmittedAtTime TEXT,
      txExpiresAtBlockHeight INTEGER,
      txInBlockHeight INTEGER,
      txInBlockHash TEXT,
      txFinalizedHeight INTEGER,
      txFeePlusTip TEXT,
      txTip TEXT,
      utxoId INTEGER,
      createdAt TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updatedAt TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (couponId) REFERENCES BitcoinLockCoupons(id)
    );

    CREATE INDEX idx_bitcoin_lock_coupons_user_id ON BitcoinLockCoupons(userId);
    CREATE INDEX idx_bitcoin_lock_coupons_account_id ON BitcoinLockCoupons(accountId);
    CREATE INDEX idx_bitcoin_lock_coupons_created_at ON BitcoinLockCoupons(createdAt DESC);

    CREATE INDEX idx_bitcoin_lock_relays_status ON BitcoinLockRelays(status);
    CREATE INDEX idx_bitcoin_lock_relays_extrinsic_hash ON BitcoinLockRelays(extrinsicHash);
    CREATE INDEX idx_bitcoin_lock_relays_created_at ON BitcoinLockRelays(createdAt DESC);
  `);
};
