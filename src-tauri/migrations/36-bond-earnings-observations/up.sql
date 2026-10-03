ALTER TABLE BondLotHistory ADD COLUMN lastObservedBlockNumber INTEGER NOT NULL DEFAULT 0;
UPDATE BondLotHistory SET lastObservedBlockNumber = COALESCE(releaseBlockNumber, firstObservedBlockNumber);
ALTER TABLE BondLotHistory ADD COLUMN earningsDestination TEXT NOT NULL DEFAULT 'VaultForFlexible';
ALTER TABLE BondLotHistory ADD COLUMN earningsBackfills TEXT NOT NULL DEFAULT '[]';
ALTER TABLE BondLotHistory ADD COLUMN earningsComplete BOOLEAN NOT NULL DEFAULT 1;
ALTER TABLE BondLotHistory ADD COLUMN earningsHistoryThroughFrame INTEGER;

CREATE TABLE BondEarnings (
  accountId TEXT NOT NULL,
  programType TEXT NOT NULL,
  bondLotId INTEGER NOT NULL,
  frameId INTEGER NOT NULL,
  bonds INTEGER,
  isFlexible BOOLEAN,
  displacedMicrogons TEXT,
  earningsMicrogons TEXT,
  earningsDestination TEXT NOT NULL,
  payoutBlockNumber INTEGER NOT NULL,
  payoutBlockHash TEXT NOT NULL,
  PRIMARY KEY (accountId, programType, bondLotId, frameId)
);

ALTER TABLE VaultRevenueEvents ADD COLUMN frameId INTEGER;
DROP INDEX idxVaultRevenueEventsBlockIdentity;
CREATE UNIQUE INDEX idxVaultRevenueEventsBlockIdentity
ON VaultRevenueEvents (blockNumber, source, COALESCE(frameId, -1));

-- Draft vault creation uses the full ARGN investment and asks for no ARGNOT.
-- Keep funding choices for installations already in progress or completed.
UPDATE Config
SET value = json_set(
  value,
  '$.capitalForSecuritizationPct', 100,
  '$.capitalForTreasuryPct', 0,
  '$.baseMicronotCommitment', '0n'
)
WHERE key = 'vaultingRules'
  AND json_valid(value)
  AND COALESCE(
    (SELECT value FROM Config WHERE key = 'vaultingSetupStatus'),
    '"None"'
  ) IN ('"None"', '"Checklist"');
