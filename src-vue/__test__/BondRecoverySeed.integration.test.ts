import Fs from 'node:fs';
import Path from 'node:path';
import {
  AccountActivityKind,
  type ArgonQueryClient,
  type BlockWatch,
  Currency,
  type MainchainClients,
  MiningFrames,
  NetworkConfig,
  readEventField,
} from '@argonprotocol/apps-core';
import { getClient } from '@argonprotocol/mainchain';
import { afterAll, describe, expect, it } from 'vitest';
import { ArgonBonds } from '../lib/ArgonBonds.ts';
import { TransactionTracker } from '../lib/TransactionTracker.ts';
import type { WalletKeys } from '../lib/WalletKeys.ts';
import { VaultHistory } from '../lib/recovery/MyVault.ts';
import { FinancialHistoryImporter } from '../lib/recovery/index.ts';
import { CapturedHistoryReader } from './helpers/CapturedHistoryReader.ts';
import { createTestDb } from './helpers/db.ts';
import { runRecoveryLifecycle } from './helpers/RecoveryLifecycleRunner.ts';

const seedPath =
  process.env.RECOVERY_SEED_PATH ?? Path.resolve(import.meta.dirname, '../../indexer/seeds/mainnet-activity-v2.db');
const runWithSeed = Fs.existsSync(seedPath) ? describe : describe.skip;
const recordingClient =
  process.env.RECOVERY_SEED_CAPTURE === '1' ? await getClient('https://rpc.argon.network') : undefined;

afterAll(async () => recordingClient?.disconnect());

runWithSeed('Bond recovery seed corpus', () => {
  it('recovers every event-backed bond and retains active pre-event Vault lots after restart', async () => {
    const previousNetwork = NetworkConfig.networkName;
    NetworkConfig.setNetwork('mainnet');

    const reader = new CapturedHistoryReader(seedPath, recordingClient);
    const db = await createTestDb();

    try {
      const accountIds = await reader.findBondOwners(151);
      expect(accountIds.length).toBeGreaterThan(0);

      const activityBlocksByAccount = new Map(
        accountIds.map(accountId => [
          accountId,
          reader.findActivityBlocks(accountId, { activityMask: AccountActivityKind.BondPosition }),
        ]),
      );
      const capturedLifecycleEvents: {
        accountId: string;
        bondLotId: number;
        blockNumber: number;
        blockHash: string;
        method: 'BondLotPurchased' | 'BondLotReleased';
      }[] = [];

      for (const [accountId, blocks] of activityBlocksByAccount) {
        for (const indexedBlock of blocks) {
          const block = await reader.getHeader(indexedBlock);
          const { events } = await reader.getEventsWithSpec(block);
          for (const { event } of events) {
            if (
              event.section !== 'treasury' ||
              (event.method !== 'BondLotPurchased' && event.method !== 'BondLotReleased') ||
              readEventField(event, 'accountId')?.toString() !== accountId
            ) {
              continue;
            }

            const bondLotId = Number(readEventField(event, 'bondLotId')?.toString());
            if (!Number.isSafeInteger(bondLotId)) continue;

            capturedLifecycleEvents.push({
              accountId,
              bondLotId,
              blockNumber: block.blockNumber,
              blockHash: block.blockHash,
              method: event.method,
            });
          }
        }
      }
      expect(capturedLifecycleEvents.length).toBeGreaterThan(0);

      const latestBlock = await reader.getHeader(reader.latestBlockNumber);
      const latestApi = (await reader.getApi(latestBlock)) as unknown as ArgonQueryClient;
      const miningFrames = new MiningFrames({} as MainchainClients, reader as unknown as BlockWatch);
      const earliestEventBackedBondFrame = miningFrames.earliestWithSpec(151);
      const currentLotsByAccount = new Map<string, Awaited<ReturnType<ArgonBonds['getOwnBondLots']>>>();
      const resultsByPhase: {
        importedBlockCount: number;
        expectedBlockCount: number;
        failures: string[];
      }[] = [];

      const recovered = await runRecoveryLifecycle({
        name: 'Mainnet bond histories',
        timeoutMs: 10 * 60_000,
        recover: async () => {
          let importedBlockCount = 0;
          let expectedBlockCount = 0;
          const failures: string[] = [];

          for (const accountId of accountIds) {
            const walletKeys = { defaultArgonAddress: accountId } as WalletKeys;
            const currency = new Currency({ events: { on: () => () => undefined } } as unknown as MainchainClients);
            const argonBonds = new ArgonBonds(
              Promise.resolve(db),
              { isLoadedPromise: Promise.resolve(), upstreamOperator: undefined },
              currency,
              miningFrames,
              walletKeys,
              new TransactionTracker(Promise.resolve(db), reader as unknown as BlockWatch),
            );
            const currentLots = await argonBonds.getOwnBondLots(latestApi);
            currentLotsByAccount.set(accountId, currentLots);
            argonBonds.data.bondLots = currentLots;

            for (const lot of currentLots) {
              await db.bondLotHistoryTable.recordObservation({
                lot,
                blockNumber: latestBlock.blockNumber,
                blockHash: latestBlock.blockHash,
              });
            }
            await argonBonds.refreshHistory();

            const blocks = activityBlocksByAccount.get(accountId) ?? [];
            const importer = new FinancialHistoryImporter({
              blockWatch: reader as unknown as BlockWatch,
              argonBonds,
              vaultHistory: new VaultHistory(Promise.resolve(db), accountId),
              enabledDomains: ['bonds'],
            });
            const result = await importer.importBlocks(blocks);
            importedBlockCount += result.importedBlockCount;
            expectedBlockCount += blocks.filter(block => block.specVersion >= 151).length;
            failures.push(
              ...Object.values(result.domainErrors)
                .filter(error => !error.includes('uses unsupported runtime spec'))
                .map(error => `${accountId}: ${error}`),
            );
          }

          resultsByPhase.push({ importedBlockCount, expectedBlockCount, failures });
        },
        readDurableState: async () => {
          const histories = await Promise.all(accountIds.map(accountId => db.bondLotHistoryTable.fetchAll(accountId)));
          return histories.flat().map(({ createdAt: _createdAt, updatedAt: _updatedAt, ...record }) => record);
        },
      });

      expect(resultsByPhase.flatMap(({ failures }) => failures)).toEqual([]);
      for (const result of resultsByPhase) {
        expect(result.importedBlockCount).toBe(result.expectedBlockCount);
      }

      const currentLots = [...currentLotsByAccount.values()].flat();
      const migratedVaultLots = currentLots.filter(lot => {
        return lot.programType === 'Vault' && lot.createdFrame < earliestEventBackedBondFrame;
      });
      expect(migratedVaultLots.length).toBeGreaterThan(0);
      expect(recovered.some(record => record.programType === 'Vault')).toBe(true);
      expect(recovered.some(record => record.programType === 'Argonot')).toBe(true);

      for (const event of capturedLifecycleEvents) {
        const record = recovered.find(candidate => {
          return candidate.accountId === event.accountId && candidate.bondLotId === event.bondLotId;
        });
        expect(record, `${event.method} for bond lot ${event.bondLotId} at block ${event.blockNumber}`).toBeDefined();

        if (event.method === 'BondLotPurchased') {
          expect(record?.purchaseBlockNumber).toBe(event.blockNumber);
          expect(record?.purchaseBlockHash).toBe(event.blockHash);
        } else {
          expect(record?.releaseBlockNumber).toBe(event.blockNumber);
          expect(record?.releaseBlockHash).toBe(event.blockHash);
        }
      }

      for (const lot of currentLots) {
        const record = recovered.find(candidate => {
          return (
            candidate.accountId === lot.accountId &&
            candidate.programType === lot.programType &&
            candidate.bondLotId === lot.id
          );
        });
        expect(record, `${lot.programType} bond lot ${lot.id} for ${lot.accountId}`).toBeDefined();

        if (lot.programType === 'Vault' && lot.createdFrame < earliestEventBackedBondFrame) {
          expect(record?.purchaseBlockHash, `Migrated Vault bond lot ${lot.id}`).toBeNull();
        } else {
          expect(record?.purchaseBlockHash, `${lot.programType} bond lot ${lot.id}`).toBeDefined();
        }
      }
    } finally {
      reader.close();
      await db.close();
      NetworkConfig.networkName = previousNetwork;
    }
  });
});
