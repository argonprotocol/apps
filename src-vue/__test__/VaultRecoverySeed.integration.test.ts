import Fs from 'node:fs';
import Path from 'node:path';
import { AccountActivityKind, type BlockWatch } from '@argonprotocol/apps-core';
import { describe, expect, it } from 'vitest';
import { VaultHistory } from '../lib/recovery/MyVault.ts';
import { FinancialHistoryImporter } from '../lib/recovery/index.ts';
import { CapturedHistoryReader } from './helpers/CapturedHistoryReader.ts';
import { createTestDb } from './helpers/db.ts';
import { runRecoveryLifecycle } from './helpers/RecoveryLifecycleRunner.ts';

const seedPath =
  process.env.RECOVERY_SEED_PATH ?? Path.resolve(import.meta.dirname, '../../indexer/seeds/mainnet-activity-v2.db');
const runWithSeed = Fs.existsSync(seedPath) ? describe : describe.skip;

runWithSeed('Vault recovery seed corpus', () => {
  it('recovers every supported indexed vault history and remains stable after restart', async () => {
    const reader = new CapturedHistoryReader(seedPath);
    const recoveryFailures: string[] = [];
    let recoveredCapitalCount = 0;
    let recoveredRevenueCount = 0;

    try {
      const accountIds = reader.findVaultOwners(116);
      expect(accountIds.length).toBeGreaterThan(0);

      for (const accountId of accountIds) {
        const blocks = reader.findActivityBlocks(accountId, {
          activityMask: AccountActivityKind.VaultPosition | AccountActivityKind.VaultRevenue,
        });
        const db = await createTestDb();

        try {
          const results: Awaited<ReturnType<FinancialHistoryImporter['importBlocks']>>[] = [];
          const recovered = await runRecoveryLifecycle({
            name: `Vault history for ${accountId}`,
            recover: async () => {
              const importer = new FinancialHistoryImporter({
                blockWatch: reader as unknown as BlockWatch,
                argonBonds: { importHistoryBlock: async () => undefined },
                vaultHistory: new VaultHistory(Promise.resolve(db), accountId),
                enabledDomains: ['vaulting'],
              });
              results.push(await importer.importBlocks(blocks));
            },
            readDurableState: async () => ({
              capital: await db.vaultCapitalHistoryTable.fetchAllByWallet(accountId),
              revenue: await db.vaultRevenueEventsTable.fetchAll(),
            }),
          });
          const errors = results.flatMap(result => Object.values(result.domainErrors));
          if (errors.length) {
            recoveryFailures.push(...new Set(errors.map(error => `${accountId}: ${error}`)));
            continue;
          }

          expect(
            results.map(result => result.importedBlockCount),
            accountId,
          ).toEqual([blocks.length, blocks.length]);
          recoveredCapitalCount += recovered.capital.length;
          recoveredRevenueCount += recovered.revenue.length;
        } finally {
          await db.close();
        }
      }

      expect(recoveryFailures).toEqual([]);
      expect(recoveredCapitalCount).toBeGreaterThan(0);
      expect(recoveredRevenueCount).toBeGreaterThan(0);
    } finally {
      reader.close();
    }
  });
});
