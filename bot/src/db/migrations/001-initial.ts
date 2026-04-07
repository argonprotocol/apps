import type { ISqliteMigration } from '@argonprotocol/apps-core';

export const InitialMigration: ISqliteMigration = db => {
  db.exec(`
    CREATE TABLE BitcoinLockRelays (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      routerInviteId INTEGER NOT NULL,
      offerCode TEXT NOT NULL,
      vaultId INTEGER NOT NULL,
      maxSatoshis TEXT NOT NULL,
      expirationTick INTEGER NOT NULL,
      status TEXT NOT NULL,
      queueReason TEXT,
      error TEXT,
      requestedSatoshis TEXT NOT NULL,
      reservedSatoshis TEXT NOT NULL DEFAULT '0',
      reservedLiquidityMicrogons TEXT NOT NULL DEFAULT '0',
      ownerAccountAddress TEXT NOT NULL,
      ownerBitcoinPubkey TEXT NOT NULL,
      microgonsPerBtc TEXT NOT NULL,
      delegateAddress TEXT,
      extrinsicHash TEXT,
      extrinsicMethodJson TEXT,
      nonce INTEGER,
      submittedAtBlockHeight INTEGER,
      submittedAtTime TEXT,
      inBlockHeight INTEGER,
      inBlockHash TEXT,
      finalizedHeight INTEGER,
      txFeePlusTip TEXT,
      txTip TEXT,
      utxoId INTEGER,
      createdLock TEXT,
      createdAt TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updatedAt TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE INDEX idx_bitcoin_lock_relays_router_invite_id ON BitcoinLockRelays(routerInviteId);
    CREATE INDEX idx_bitcoin_lock_relays_status ON BitcoinLockRelays(status);
    CREATE INDEX idx_bitcoin_lock_relays_extrinsic_hash ON BitcoinLockRelays(extrinsicHash);
    CREATE INDEX idx_bitcoin_lock_relays_created_at ON BitcoinLockRelays(createdAt DESC);
  `);
};
