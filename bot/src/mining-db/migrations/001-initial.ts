import type { ISqliteMigration } from '@argonprotocol/apps-core';

export const InitialMiningMigration: ISqliteMigration = db => {
  db.exec(`
    CREATE TABLE MiningFrames (
      id INTEGER PRIMARY KEY,
      firstTick INTEGER NOT NULL,
      rewardTicksRemaining INTEGER NOT NULL,
      firstBlockNumber INTEGER NOT NULL,
      lastBlockNumber INTEGER NOT NULL,
      microgonToUsd TEXT NOT NULL,
      microgonToBtc TEXT NOT NULL,
      microgonToArgonot TEXT NOT NULL,
      allMinersCount INTEGER NOT NULL DEFAULT 0,
      seatCountActive INTEGER NOT NULL DEFAULT 0,
      seatCostTotalFramed TEXT NOT NULL DEFAULT '0',
      blocksMinedTotal INTEGER NOT NULL DEFAULT 0,
      micronotsMinedTotal TEXT NOT NULL DEFAULT '0',
      microgonsMinedTotal TEXT NOT NULL DEFAULT '0',
      microgonsMintedTotal TEXT NOT NULL DEFAULT '0',
      microgonFeesCollectedTotal TEXT NOT NULL DEFAULT '0',
      accruedMicrogonProfits TEXT NOT NULL DEFAULT '0',
      accruedMicronotProfits TEXT NOT NULL DEFAULT '0',
      progress REAL NOT NULL,
      isProcessed INTEGER NOT NULL DEFAULT 0,
      updatedAt TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE MiningCohorts (
      id INTEGER PRIMARY KEY,
      progress REAL NOT NULL DEFAULT 0,
      transactionFeesTotal TEXT NOT NULL,
      micronotsStakedPerSeat TEXT NOT NULL,
      microgonsBidPerSeat TEXT NOT NULL,
      seatCountWon INTEGER NOT NULL,
      microgonsToBeMinedPerSeat TEXT NOT NULL,
      micronotsToBeMinedPerSeat TEXT NOT NULL,
      argonotPriceAtBid TEXT NOT NULL DEFAULT '0',
      closingArgonotPrice TEXT NOT NULL DEFAULT '0',
      updatedAt TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE MiningCohortFrames (
      frameId INTEGER NOT NULL,
      cohortId INTEGER NOT NULL,
      blocksMinedTotal INTEGER NOT NULL,
      micronotsMinedTotal TEXT NOT NULL,
      microgonsMinedTotal TEXT NOT NULL,
      microgonsMintedTotal TEXT NOT NULL,
      microgonFeesCollectedTotal TEXT NOT NULL,
      updatedAt TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (frameId, cohortId)
    );

    CREATE INDEX idx_mining_frames_processed ON MiningFrames (isProcessed, id DESC);
    CREATE INDEX idx_mining_cohorts_seats ON MiningCohorts (seatCountWon, id);
    CREATE INDEX idx_mining_cohort_frames_cohort ON MiningCohortFrames (cohortId);
  `);
};
