import { readFileSync } from 'node:fs';
import Path from 'node:path';
import { describe, expect, it } from 'vitest';
import { FlowSession } from '../FlowSession.ts';
import { CapturedDatabaseScenario } from '../local-mainnet/CapturedDatabaseScenario.ts';
import { LocalMainnet } from '../local-mainnet/LocalMainnet.ts';
import { loadRuntimeMigrationManifest } from '../local-mainnet/manifest.ts';

const manifestPath = process.env.ARGON_RUNTIME_MIGRATION_MANIFEST?.trim();
const wasmPath = process.env.ARGON_RUNTIME_MIGRATION_WASM?.trim();
const hasMigrationArtifacts = Boolean(manifestPath && wasmPath);

describe.skipIf(!hasMigrationArtifacts)('production-derived local mainnet upgrade', () => {
  it(
    'loads the migrated account and preserves its durable state across an app restart',
    async () => {
      const manifest = loadRuntimeMigrationManifest(manifestPath!);
      const runDirectory =
        process.env.ARGON_RUNTIME_MIGRATION_RUN_DIRECTORY?.trim() || `${manifestPath}.captured-database-run`;
      const mainnet = await LocalMainnet.start({
        manifest,
        runDirectory,
      });

      try {
        const deployment = await mainnet.deployRuntime(readFileSync(wasmPath!));
        expect(deployment.upgradeBlock.includedTransactionHashes).toContain(deployment.upgradeTransactionHash);
        expect(deployment.upgradeBlock.events).toEqual(expect.arrayContaining(['system.CodeUpdated', 'sudo.Sudid']));
        expect(deployment.upgradeBlock.metadataSpecVersion).toBe(manifest.archive.deployedSpecVersion);
        expect(deployment.migrationBlock.runtimeSpecVersion).toBe(manifest.candidate.expectedSpecVersion);
        expect(deployment.candidateBlock.runtimeSpecVersion).toBe(manifest.candidate.expectedSpecVersion);
        expect(deployment.indexer).toMatchObject({
          checkpoint: {
            blockNumber: deployment.candidateBlock.number,
            blockHash: deployment.candidateBlock.hash,
          },
          blocks: [
            {
              blockNumber: manifest.archive.blockNumber,
              blockHash: manifest.archive.blockHash,
              specVersion: manifest.archive.deployedSpecVersion,
            },
            {
              blockNumber: mainnet.deployedBlock.number,
              blockHash: mainnet.deployedBlock.hash,
              specVersion: manifest.archive.deployedSpecVersion,
            },
            {
              blockNumber: deployment.upgradeBlock.number,
              blockHash: deployment.upgradeBlock.hash,
              specVersion: manifest.archive.deployedSpecVersion,
            },
            {
              blockNumber: deployment.migrationBlock.number,
              blockHash: deployment.migrationBlock.hash,
              specVersion: manifest.candidate.expectedSpecVersion,
            },
            {
              blockNumber: deployment.candidateBlock.number,
              blockHash: deployment.candidateBlock.hash,
              specVersion: manifest.candidate.expectedSpecVersion,
            },
          ],
        });
        expect(deployment.indexer.runtimeMetadataSpecVersions).toEqual(
          expect.arrayContaining([manifest.archive.deployedSpecVersion, manifest.candidate.expectedSpecVersion]),
        );

        const result = await CapturedDatabaseScenario.run({
          manifest,
          mainnet,
          appsDirectory: process.cwd(),
          runDirectory: Path.join(runDirectory, 'captured-database'),
        });
        const expectedFissionIds = result.before.migratableBitcoinLockIds;
        const expectedVisibleFissionIds = [
          ...new Set([
            ...result.before.migratableFundedBitcoinLockIds,
            ...result.before.migratableReleasedBitcoinLockIds,
          ]),
        ];

        expect(result.before.latestMigration).toBeLessThan(34);
        expect(expectedFissionIds.length).toBeGreaterThan(0);
        expect(result.before.migratableReleasedBitcoinLockIds.length).toBeGreaterThan(0);
        expect(result.afterMigration).toMatchObject({
          latestMigration: 34,
          quickCheck: 'ok',
          walletIdentitySha256: result.before.walletIdentitySha256,
          fundedBitcoinLockIds: result.before.migratableFundedBitcoinLockIds,
          fundingBitcoinUtxoLockIds: expectedFissionIds,
          migratedBitcoinFissionIds: expectedFissionIds,
        });
        expect(result.afterRestart).toEqual(result.afterMigration);

        const readOnlySession = await mainnet.launchApp(
          {
            appsDirectory: process.cwd(),
            instanceName: result.instanceName,
            appLogsMode: 'quiet',
            sourceInstancePackagePath: result.instancePackagePath,
          },
          FlowSession.start,
        );
        const historyRecovery = await readOnlySession.recoverAccountHistory(deployment.candidateBlock.number);
        await readOnlySession.run('App.flow.accountReview', {
          expectedDefaultArgonAddress: manifest.capturedDatabase.defaultArgonAccountId,
          expectedBitcoinLiquidIds: expectedVisibleFissionIds,
          expectedArchivedBitcoinLiquidIds: result.before.migratableReleasedBitcoinLockIds,
          expectsConfiguredServer: result.before.readonlyAccount.configuredServer,
          expectsOperations: result.before.readonlyAccount.operations,
          expectsUpstream: result.before.readonlyAccount.upstream,
          expectsVault: result.before.readonlyAccount.vault,
          expectsBondFinancials: true,
        });
        expect(historyRecovery).toMatchObject({
          accountId: manifest.capturedDatabase.defaultArgonAccountId,
          throughBlock: deployment.candidateBlock.number,
          walletHistory: { asOfBlock: deployment.candidateBlock.number },
          financialHistory: { asOfBlock: deployment.candidateBlock.number },
        });
        await mainnet.closeApp();
      } finally {
        await mainnet.close();
      }
    },
    15 * 60_000,
  );
});
