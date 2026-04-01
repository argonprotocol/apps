import { mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname } from 'node:path';

const require = createRequire(import.meta.url);
const { DatabaseSync }: typeof import('node:sqlite') = require('node:sqlite');

const DB_PATH = process.env.ROUTER_DB_PATH || '/server/router/router.sqlite';
mkdirSync(dirname(DB_PATH), { recursive: true });

const db = new DatabaseSync(DB_PATH);

db.exec(`
  CREATE TABLE IF NOT EXISTS Profile (
    name TEXT
  );

  CREATE TABLE IF NOT EXISTS CapitalInvites (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    inviteCode TEXT NOT NULL UNIQUE,
    vaultId INTEGER NOT NULL,
    couponTxId INTEGER,
    couponPublicKey TEXT NOT NULL,
    couponPrivateKey TEXT NOT NULL,
    couponMaxSatoshis TEXT NOT NULL,
    couponExpirationFrame INTEGER,
    couponExpiresAt TEXT NOT NULL,
    firstClickedAt TEXT,
    lastClickedAt TEXT,
    registeredAppAt TEXT,
    lockedBitcoinAt TEXT,
    appLastSeenAt TEXT,
    createdAt TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );

  CREATE INDEX IF NOT EXISTS idx_capital_invites_coupon_public_key ON CapitalInvites(couponPublicKey);
`);

export { db };
