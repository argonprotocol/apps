import type { ISqliteMigration } from '@argonprotocol/apps-core';

export const BitcoinLockRelaysMigration: ISqliteMigration = db => {
  db.exec(`
    PRAGMA foreign_keys = OFF;

    CREATE TABLE BitcoinLockRelaysNext (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      requestId TEXT NOT NULL UNIQUE,
      legacyCouponId INTEGER,
      status TEXT NOT NULL,
      requestedSatoshis TEXT NOT NULL,
      securitizationUsedMicrogons TEXT NOT NULL,
      ownerAccountId TEXT NOT NULL,
      ownerBitcoinPubkey TEXT NOT NULL,
      microgonsAtTargetPerBtc TEXT NOT NULL,
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
      updatedAt TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    INSERT INTO BitcoinLockRelaysNext (
      id, requestId, legacyCouponId, status, requestedSatoshis, securitizationUsedMicrogons,
      ownerAccountId, ownerBitcoinPubkey, microgonsAtTargetPerBtc,
      error, delegateAddress, extrinsicHash, extrinsicMethodJson, txNonce,
      txSubmittedAtBlockHeight, txSubmittedAtTime, txExpiresAtBlockHeight,
      txInBlockHeight, txInBlockHash, txFinalizedHeight, txFeePlusTip, txTip, utxoId,
      createdAt, updatedAt
    )
    SELECT
      id, 'legacy-' || id, couponId, status, requestedSatoshis, securitizationUsedMicrogons,
      ownerAccountId, ownerBitcoinPubkey, microgonsAtTargetPerBtc,
      error, delegateAddress, extrinsicHash, extrinsicMethodJson, txNonce,
      txSubmittedAtBlockHeight, txSubmittedAtTime, txExpiresAtBlockHeight,
      txInBlockHeight, txInBlockHash, txFinalizedHeight, txFeePlusTip, txTip, utxoId,
      createdAt, updatedAt
    FROM BitcoinLockRelays;

    DROP TABLE BitcoinLockRelays;
    ALTER TABLE BitcoinLockRelaysNext RENAME TO BitcoinLockRelays;

    CREATE INDEX idx_bitcoin_lock_relays_status ON BitcoinLockRelays(status);
    CREATE INDEX idx_bitcoin_lock_relays_extrinsic_hash ON BitcoinLockRelays(extrinsicHash);
    CREATE INDEX idx_bitcoin_lock_relays_created_at ON BitcoinLockRelays(createdAt DESC);

    PRAGMA foreign_keys = ON;
  `);
};
