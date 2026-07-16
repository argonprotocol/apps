import { describe, expect, it } from 'vitest';
import { readdir, readFile } from 'node:fs/promises';
import Path from 'node:path';
import { JsonExt } from '@argonprotocol/apps-core';
import { TestSqliteDb } from './helpers/db.ts';

const MIGRATIONS_DIR = Path.resolve(__dirname, '../../src-tauri/migrations');

describe('26-financial-positions migration', () => {
  it('upgrades representative financial history and preserves its identities', async () => {
    const db = new TestSqliteDb(':memory:');

    try {
      const migrationDirs = (await readdir(MIGRATIONS_DIR)).sort();
      for (const migrationDir of migrationDirs.filter(x => x < '26-financial-positions')) {
        const migrationSql = await readFile(Path.join(MIGRATIONS_DIR, migrationDir, 'up.sql'), 'utf8');
        await db.exec(migrationSql);
      }

      await db.run(
        `INSERT INTO Frames (
          id, firstTick, firstBlockNumber, lastBlockNumber,
          microgonToArgonot, progress, isProcessed
        ) VALUES (?, ?, ?, ?, ?, ?, ?), (?, ?, ?, ?, ?, ?, ?), (?, ?, ?, ?, ?, ?, ?)`,
        [
          8,
          800,
          80,
          89,
          JsonExt.stringify([4_000_000n]),
          100,
          1,
          11,
          1_000,
          100,
          199,
          JsonExt.stringify([1_000_000n, 2_000_000n]),
          100,
          1,
          12,
          2_000,
          200,
          299,
          JsonExt.stringify([8_000_000n]),
          100,
          1,
        ],
      );
      await db.run(
        `INSERT INTO VaultRevenueEvents (amount, source, blockNumber, blockHash)
         VALUES (?, ?, ?, ?), (?, ?, ?, ?)`,
        ['10', 'vaultCollect', 100, '0xvault', '20', 'vaultCollect', 100, '0xvault'],
      );
      await db.run(
        `INSERT INTO WalletTransfers (
          walletAddress, walletName, amount, currency, otherParty, transferType, isInternal,
          extrinsicIndex, microgonsForArgonot, microgonsForUsd, blockNumber, blockHash
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?), (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          '5default',
          'defaultArgon',
          '10',
          'argon',
          null,
          'faucet',
          0,
          1,
          '0',
          '1000000',
          100,
          '0xwallet',
          '5default',
          'defaultArgon',
          '10',
          'argon',
          null,
          'faucet',
          0,
          1,
          '0',
          '1000000',
          100,
          '0xwallet',
        ],
      );
      await db.run(
        `INSERT INTO WalletLedger (
          walletAddress, walletName, availableMicrogons, reservedMicrogons, availableMicronots,
          reservedMicronots, microgonChange, micronotChange, microgonsForUsd, microgonsForArgonot,
          inboundTransfersJson, extrinsicEventsJson, blockNumber, blockHash, isFinalized
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ['5default', 'defaultArgon', '20', '0', '0', '0', '10', '0', '1000000', '0', '[]', '[]', 101, '0xorphan', 0],
      );
      await db.run(
        `INSERT INTO WalletTransfers (
          walletAddress, walletName, amount, currency, otherParty, transferType, isInternal,
          extrinsicIndex, microgonsForArgonot, microgonsForUsd, blockNumber, blockHash
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ['5default', 'defaultArgon', '10', 'argon', '5outside', 'transfer', 0, 1, '0', '1000000', 101, '0xorphan'],
      );
      await db.run(
        `INSERT INTO StableSwapSyncState (walletAddress, startBlockNumber, lastScannedBlockNumber)
         VALUES (?, ?, ?)`,
        ['0xwallet', 10, 20],
      );
      await db.run(
        `INSERT INTO Cohorts (
          id, progress, seatCountWon, transactionFeesTotal, micronotsStakedPerSeat,
          microgonsBidPerSeat, microgonsToBeMinedPerSeat, micronotsToBeMinedPerSeat
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?), (?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          8, 0, 1, 0, 1_000_000, 5_000_000, 1_000_000, 1_000_000, 12, 0, 1, 0, 1_000_000, 5_000_000, 1_000_000,
          1_000_000,
        ],
      );

      const migrationSql = await readFile(Path.join(MIGRATIONS_DIR, '26-financial-positions', 'up.sql'), 'utf8');
      await db.exec(migrationSql);

      const cohort = await db.get<{ argonotPriceAtBid: string }>('SELECT argonotPriceAtBid FROM Cohorts WHERE id = ?', [
        12,
      ]);
      expect(BigInt(cohort.argonotPriceAtBid)).toBe(2_000_000n);

      const firstCohort = await db.get<{ argonotPriceAtBid: string }>(
        'SELECT argonotPriceAtBid FROM Cohorts WHERE id = ?',
        [8],
      );
      expect(BigInt(firstCohort.argonotPriceAtBid)).toBe(4_000_000n);

      await expect(
        db.get<{ isPurchaseBasisIntact: number }>(
          'SELECT isPurchaseBasisIntact FROM StableSwapSyncState WHERE walletAddress = ?',
          ['0xwallet'],
        ),
      ).resolves.toEqual({ isPurchaseBasisIntact: 0 });
      await expect(db.get<{ count: number }>('SELECT COUNT(*) AS count FROM VaultRevenueEvents')).resolves.toEqual({
        count: 1,
      });
      await expect(db.get<{ count: number }>('SELECT COUNT(*) AS count FROM WalletTransfers')).resolves.toEqual({
        count: 1,
      });
      await expect(
        db.run(
          `INSERT INTO VaultRevenueEvents (amount, source, blockNumber, blockHash, extrinsicIndex)
           VALUES (?, ?, ?, ?, ?)`,
          ['30', 'vaultCollect', 100, '0xvault', 2],
        ),
      ).rejects.toThrow();
      await expect(
        db.run(
          `INSERT INTO WalletTransfers (
            walletAddress, walletName, amount, currency, otherParty, transferType, isInternal,
            extrinsicIndex, microgonsForArgonot, microgonsForUsd, blockNumber, blockHash
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          ['5default', 'defaultArgon', '10', 'argon', null, 'faucet', 0, 1, '0', '1000000', 100, '0xwallet'],
        ),
      ).rejects.toThrow();

      const cohortFrameIndexes = await db.all<{ name: string }[]>('PRAGMA index_list(CohortFrames)');
      const stableSwapIndexes = await db.all<{ name: string }[]>('PRAGMA index_list(StableSwapPurchases)');
      expect(cohortFrameIndexes.map(index => index.name)).toContain('idxCohortFramesCohortId');
      expect(stableSwapIndexes.map(index => index.name)).toContain('idxStableSwapPurchasesMissingProofs');
    } finally {
      await db.close();
    }
  });
});
