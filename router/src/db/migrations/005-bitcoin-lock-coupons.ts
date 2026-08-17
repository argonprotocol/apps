import type { ISqliteMigration } from '@argonprotocol/apps-core';

export const BitcoinLockCouponsMigration: ISqliteMigration = db => {
  db.exec(`
    CREATE TABLE BitcoinLockCoupons (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      userId INTEGER NOT NULL,
      sequence INTEGER NOT NULL,
      offerCode TEXT NOT NULL UNIQUE,
      vaultId INTEGER NOT NULL,
      maxSatoshis TEXT NOT NULL,
      estimatedGiftUsd REAL NOT NULL,
      btcPctFee REAL NOT NULL,
      feeCreditMicrogons TEXT,
      expiresAfterTicks INTEGER NOT NULL,
      expirationTick INTEGER,
      accountId TEXT,
      feeCouponJson TEXT,
      usedAt TEXT,
      relayRequestId TEXT UNIQUE,
      relayJson TEXT,
      createdAt TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updatedAt TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (userId) REFERENCES Users(id)
    );

    CREATE INDEX idx_router_bitcoin_lock_coupons_user_id
    ON BitcoinLockCoupons(userId, sequence DESC);

    CREATE TABLE BitcoinLockCouponUses (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      couponId INTEGER NOT NULL,
      requestId TEXT NOT NULL UNIQUE,
      status TEXT NOT NULL,
      feeCreditMicrogons TEXT NOT NULL,
      requestedSatoshis TEXT NOT NULL,
      ownerAccountId TEXT NOT NULL,
      ownerBitcoinPubkey TEXT NOT NULL,
      microgonsAtTargetPerBtc TEXT NOT NULL,
      feeCouponJson TEXT,
      relayJson TEXT,
      createdAt TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updatedAt TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (couponId) REFERENCES BitcoinLockCoupons(id)
    );

    CREATE INDEX idx_router_bitcoin_lock_coupon_uses_coupon_id
    ON BitcoinLockCouponUses(couponId, id);
  `);
};
