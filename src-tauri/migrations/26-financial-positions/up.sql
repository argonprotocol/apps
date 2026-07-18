ALTER TABLE Cohorts ADD COLUMN argonotPriceAtBid TEXT NOT NULL DEFAULT '0';
ALTER TABLE Cohorts ADD COLUMN closingArgonotPrice TEXT NOT NULL DEFAULT '0';

-- Release-request facts survive after the on-chain request is removed, while
-- the removal identity and BTC mark make a completed lock independently valued.
ALTER TABLE BitcoinLocks ADD COLUMN releaseRedemptionMicrogons TEXT;
ALTER TABLE BitcoinLocks ADD COLUMN releaseArgonTxFeeMicrogons TEXT;
ALTER TABLE BitcoinLocks ADD COLUMN releaseCompensationMicrogons TEXT;
ALTER TABLE BitcoinLocks ADD COLUMN removalBlockNumber INTEGER;
ALTER TABLE BitcoinLocks ADD COLUMN removalBlockHash TEXT;
ALTER TABLE BitcoinLocks ADD COLUMN removalBlockTime DATETIME;
ALTER TABLE BitcoinLocks ADD COLUMN removalExtrinsicIndex INTEGER;
ALTER TABLE BitcoinLocks ADD COLUMN removalReason TEXT;
ALTER TABLE BitcoinLocks ADD COLUMN btcPriceAtRemovalMicrogons TEXT;

-- Earlier wallet scans only discovered incoming purchases, so existing rows
-- cannot prove that their stored purchase basis still owns the current ARGN.
ALTER TABLE StableSwapSyncState ADD COLUMN isPurchaseBasisIntact BOOLEAN NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS idxCohortFramesCohortId
ON CohortFrames (cohortId);

-- Older bot records did not capture the final auction price. Prefer the latest
-- valid bidding-frame price, falling forward only when no earlier sample exists.
UPDATE Cohorts
SET argonotPriceAtBid = COALESCE(
  (
    SELECT CAST(RTRIM(json_extract(
        f.microgonToArgonot,
        '$[' || (json_array_length(f.microgonToArgonot) - 1) || ']'
      ), 'n') AS INTEGER)
    FROM Frames f
    WHERE f.id < Cohorts.id
      AND json_array_length(f.microgonToArgonot) > 0
      AND CAST(RTRIM(json_extract(
          f.microgonToArgonot,
          '$[' || (json_array_length(f.microgonToArgonot) - 1) || ']'
        ), 'n') AS INTEGER) > 0
    ORDER BY f.id DESC
    LIMIT 1
  ),
  (
    SELECT CAST(RTRIM(json_extract(
        f.microgonToArgonot,
        '$[' || (json_array_length(f.microgonToArgonot) - 1) || ']'
      ), 'n') AS INTEGER)
    FROM Frames f
    WHERE f.id >= Cohorts.id
      AND json_array_length(f.microgonToArgonot) > 0
      AND CAST(RTRIM(json_extract(
          f.microgonToArgonot,
          '$[' || (json_array_length(f.microgonToArgonot) - 1) || ']'
        ), 'n') AS INTEGER) > 0
    ORDER BY f.id ASC
    LIMIT 1
  ),
  0
);

-- A completed seat is valued at the first ARGNOT price in the frame after its
-- ten-frame term. BotSyncer fills this directly for new cohorts.
UPDATE Cohorts
SET closingArgonotPrice = COALESCE(
  (
    SELECT RTRIM(json_extract(f.microgonToArgonot, '$[0]'), 'n')
    FROM Frames f
    WHERE f.id = Cohorts.id + 10
      AND json_array_length(f.microgonToArgonot) > 0
  ),
  '0'
);

CREATE TABLE BondLotHistory (
  id INTEGER NOT NULL PRIMARY KEY,
  accountId TEXT NOT NULL,
  programType TEXT NOT NULL CHECK(programType IN ('Vault', 'Argonot')),
  bondLotId INTEGER NOT NULL,
  vaultId INTEGER,
  nativeAsset TEXT NOT NULL CHECK(nativeAsset IN ('ARGN', 'ARGNOT')),
  nativePrincipal TEXT NOT NULL,
  createdFrame INTEGER NOT NULL,
  firstObservedBlockNumber INTEGER NOT NULL,
  firstObservedBlockHash TEXT NOT NULL,
  purchaseBlockNumber INTEGER,
  purchaseBlockHash TEXT,
  purchaseBlockTime DATETIME,
  purchaseExtrinsicIndex INTEGER,
  entryArgonotRateMicrogons TEXT,
  releaseFrame INTEGER,
  releaseBlockNumber INTEGER,
  releaseBlockHash TEXT,
  releaseBlockTime DATETIME,
  releaseExtrinsicIndex INTEGER,
  releaseParentHash TEXT,
  releaseReason TEXT,
  participatedFrames INTEGER,
  cumulativeEarningsMicrogons TEXT,
  closingArgonotRateMicrogons TEXT,
  createdAt DATETIME DEFAULT CURRENT_TIMESTAMP,
  updatedAt DATETIME DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(accountId, programType, bondLotId)
);

CREATE INDEX idxBondLotHistoryOwner
ON BondLotHistory (accountId, bondLotId);

ALTER TABLE VaultRevenueEvents ADD COLUMN extrinsicIndex INTEGER;
ALTER TABLE VaultRevenueEvents ADD COLUMN blockTime DATETIME;

-- A vault can collect once in a block. Keep the extrinsic as provenance, but
-- use the block/source identity so recovery cannot duplicate older NULL rows.
DELETE FROM VaultRevenueEvents
WHERE id NOT IN (
  SELECT MIN(id)
  FROM VaultRevenueEvents
  GROUP BY blockHash, source
);

DROP INDEX IF EXISTS idxVaultRevenueEventsUnique;

CREATE UNIQUE INDEX idxVaultRevenueEventsBlockIdentity
ON VaultRevenueEvents (blockHash, source);

DROP INDEX IF EXISTS idxVaultRevenueEventsBlockHash;

CREATE TABLE VaultCapitalHistory (
  id INTEGER NOT NULL PRIMARY KEY,
  walletAddress TEXT NOT NULL,
  vaultId INTEGER NOT NULL,
  eventType TEXT NOT NULL CHECK(eventType IN (
    'created',
    'modified',
    'releaseScheduled',
    'released',
    'closed',
    'capitalLost'
  )),
  amount TEXT,
  securitization TEXT,
  securitizationTarget TEXT,
  releaseHeight TEXT,
  securitizationRemaining TEXT,
  securitizationReleased TEXT,
  blockNumber INTEGER NOT NULL,
  blockHash TEXT NOT NULL,
  blockTime DATETIME,
  extrinsicIndex INTEGER,
  createdAt DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX idxVaultCapitalHistoryIdentity
ON VaultCapitalHistory (walletAddress, vaultId, blockHash, COALESCE(extrinsicIndex, -1), eventType);

CREATE INDEX idxVaultCapitalHistoryOwner
ON VaultCapitalHistory (walletAddress, vaultId, blockNumber);

CREATE INDEX idxVaultCapitalHistoryTimeline
ON VaultCapitalHistory (walletAddress, blockNumber, COALESCE(extrinsicIndex, -1), id);

DROP INDEX idxStableSwapPurchasesProofStatus;

CREATE INDEX idxStableSwapPurchasesMissingProofs
ON StableSwapPurchases (walletAddress, blockNumber DESC, transactionIndex)
WHERE proofStatus != 'Ready';

-- SQLite treats NULL values as distinct in a normal unique index. Historical
-- recovery needs faucet and cross-chain receipts without a counterparty to be
-- idempotent too.
ALTER TABLE WalletTransfers ADD COLUMN blockTime DATETIME;

-- Previous app versions persisted best-chain transfers before finality. A
-- crash could leave an orphaned row behind; sparse finalized recovery will
-- restore it if the block later became canonical.
DELETE FROM WalletTransfers
WHERE blockHash IN (
  SELECT blockHash FROM WalletLedger WHERE isFinalized = 0
);

DELETE FROM WalletTransfers
WHERE id NOT IN (
  SELECT MIN(id)
  FROM WalletTransfers
  GROUP BY walletAddress, COALESCE(otherParty, ''), extrinsicIndex, amount, currency, blockHash
);

DROP INDEX IF EXISTS idxWalletTransfersUnique;

CREATE UNIQUE INDEX idxWalletTransfersIdentity
ON WalletTransfers (
  walletAddress,
  COALESCE(otherParty, ''),
  extrinsicIndex,
  amount,
  currency,
  blockHash
);

CREATE INDEX idxWalletTransfersCounterparty
ON WalletTransfers (otherParty, currency, blockNumber);

CREATE TABLE FinancialCache (
  type TEXT NOT NULL,
  scope TEXT NOT NULL,
  state JSON NOT NULL,
  createdAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updatedAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (type, scope)
);
