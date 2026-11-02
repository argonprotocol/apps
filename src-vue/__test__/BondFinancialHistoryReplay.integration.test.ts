import { runtimeClient } from '@argonprotocol/runtime-client';
import { financialHistoryTest as it } from './FinancialHistoryReplay.ts';
import Fs from 'node:fs';
import Path from 'node:path';
import {
  AccountActivityKind,
  ACCOUNT_ACTIVITY_DEFINITION_VERSION,
  type ArgonCurrentQueryClient,
  type BlockWatch,
  Currency,
  type MainchainClients,
  MiningFrames,
  NetworkConfig,
} from '@argonprotocol/apps-core';
import { getClient } from '@argonprotocol/mainchain';
import { afterAll, describe, expect, vi } from 'vitest';
import { ArgonBonds } from '../lib/ArgonBonds.ts';
import type { WalletKeys } from '../lib/WalletKeys.ts';
import { VaultHistory } from '../lib/recovery/MyVault.ts';
import { restoreFinancialHistory } from '../lib/recovery/index.ts';
import * as indexerClient from '../lib/IndexerClient.ts';
import { ArgonBondsFinancials } from '../lib/financials/ArgonBonds.ts';
import { calculatePositionReturn } from '../lib/financials/index.ts';
import { CapturedHistoryReader } from './helpers/CapturedHistoryReader.ts';
import { createTestDb } from './helpers/db.ts';
import { runRecoveryLifecycle } from './helpers/RecoveryLifecycleRunner.ts';

const replayPath =
  process.env.FINANCIAL_HISTORY_REPLAY_PATH ??
  Path.resolve(import.meta.dirname, '../../indexer/seeds/mainnet-financial-history-replay.db');
const runWithReplay =
  process.env.FINANCIAL_HISTORY_REPLAY_CAPTURE === '1' || Fs.existsSync(replayPath) ? describe : describe.skip;
const recordingClient =
  process.env.FINANCIAL_HISTORY_REPLAY_CAPTURE === '1' ? await getClient('https://rpc.argon.network') : undefined;

afterAll(async () => recordingClient?.disconnect());

runWithReplay('Bond financial history replay corpus', { tags: ['no-argon-network'] }, () => {
  it('recovers every event-backed bond and retains active pre-event Vault lots after restart', async ({
    replayPath,
  }) => {
    const previousNetwork = NetworkConfig.networkName;
    NetworkConfig.setNetwork('mainnet');

    const reader = new CapturedHistoryReader(replayPath, recordingClient);
    const db = await createTestDb();
    const findActivity = vi
      .spyOn(indexerClient, 'findAddressActivity')
      .mockImplementation(async (address, filters) => ({
        asOfBlock: reader.latestBlockNumber,
        definitionVersion: ACCOUNT_ACTIVITY_DEFINITION_VERSION,
        blocks: reader.findActivityBlocks(address, filters),
        coverage: { fromBlock: 0, toBlock: reader.latestBlockNumber, gaps: [] },
      }));

    try {
      const accountIds = await reader.findBondOwners(151);
      expect(accountIds.length).toBeGreaterThan(0);

      const activityBlocksByAccount = new Map(
        accountIds.map(accountId => [
          accountId,
          reader
            .findActivityBlocks(accountId, { activityMask: AccountActivityKind.BondPosition })
            .filter(block => block.specVersion >= 151),
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
              event.data.accountId !== accountId
            ) {
              continue;
            }

            const bondLotId = event.data.bondLotId;
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
      const latestApi = runtimeClient((await reader.getApi(latestBlock)).raw);
      const blockWatch = Object.assign(reader, {
        finalizedBlockHeader: latestBlock,
        getCurrentApi: async () => latestApi,
        getEvents: async (block: Parameters<CapturedHistoryReader['getEventsWithSpec']>[0]) =>
          (await reader.getEventsWithSpec(block)).events,
      }) as unknown as BlockWatch;
      const miningFrames = new MiningFrames({} as MainchainClients, blockWatch);
      const earliestEventBackedBondFrame = miningFrames.earliestWithSpec(151);
      const currentLotsByAccount = new Map<string, Awaited<ReturnType<ArgonBonds['getOwnBondLots']>>>();
      const assetsWithVerifiedApy = new Set<string>();
      const resultsByPhase: {
        importedBlockCount: number;
        expectedBlockCount: number;
      }[] = [];

      const recovered = await runRecoveryLifecycle({
        name: 'Mainnet bond histories',
        timeoutMs: 10 * 60_000,
        recover: async () => {
          let importedBlockCount = 0;
          let expectedBlockCount = 0;

          for (const accountId of accountIds) {
            const walletKeys = { defaultArgonAddress: accountId } as WalletKeys;
            const currency = new Currency({ events: { on: () => () => undefined } } as unknown as MainchainClients);
            const argonBonds = new ArgonBonds(
              Promise.resolve(db),
              { isLoadedPromise: Promise.resolve(), upstreamOperator: undefined },
              currency,
              miningFrames,
              walletKeys,
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
            const result = await restoreFinancialHistory({
              db,
              blockWatch,
              accountId,
              argonBonds,
              vaultHistory: new VaultHistory(Promise.resolve(db), accountId),
              enabledDomains: ['bonds'],
              recoverMissingCheckpointsFor: ['bonds'],
              force: true,
            });
            expect(result.asOfBlock).toBe(latestBlock.blockNumber);
            expect(argonBonds.data.historyCoveragePending).toBe(false);
            const positions = new ArgonBondsFinancials(argonBonds).createFinancialPositions({
              bondLots: argonBonds.data.bondLots,
              historyRecords: argonBonds.data.bondHistory,
              dailyEarnings: argonBonds.data.dailyEarnings,
              completedFrame: (latestBlock.frameId ?? miningFrames.getForTick(latestBlock.tick)!) - 1,
              liveArgonotRateMicrogons: 1_000_000n,
              frameDates: new Map(miningFrames.frames.map(frame => [frame.frameId, new Date(frame.dateStart)])),
            });
            for (const history of argonBonds.data.bondHistory) {
              const throughFrame = Math.min(
                history.earningsHistoryThroughFrame ?? -1,
                (history.releaseFrame ?? Infinity) - 1,
              );
              if (
                throughFrame <= history.createdFrame ||
                !history.earningsComplete ||
                !history.flexibilityHistoryComplete
              )
                continue;
              let investedCost = history.nativePrincipal;
              if (history.nativeAsset === 'ARGNOT') {
                if (!history.entryArgonotRateMicrogons) continue;
                investedCost = (investedCost * history.entryArgonotRateMicrogons) / 1_000_000n;
              }
              if (investedCost <= 0n) continue;
              const earnings = argonBonds.data.dailyEarnings.filter(
                record => record.bondLotId === history.bondLotId && record.frameId <= throughFrame,
              );
              if (!earnings.length || earnings.some(record => record.earningsMicrogons == null)) continue;

              const position = positions.find(
                position => (position.bondLot?.id ?? position.history?.bondLotId) === history.bondLotId,
              );
              expect(position).toBeDefined();
              expect(position!.dailyReturns).not.toBeNull();
              expect(position!.dailyReturnPeriodDays).toBe(throughFrame - history.createdFrame);
              const summary = calculatePositionReturn([position!]);
              const logGrowth = earnings.reduce(
                (sum, day) => sum + Math.log1p(Number(day.earningsMicrogons!) / Number(investedCost)),
                0,
              );
              expect(Math.log1p(summary.apy! / 100)).toBeCloseTo(
                logGrowth * (365 / (throughFrame - history.createdFrame)),
              );
              assetsWithVerifiedApy.add(history.nativeAsset);
            }
            importedBlockCount += result.importedBlockCount;
            expectedBlockCount += blocks.length;
          }

          resultsByPhase.push({ importedBlockCount, expectedBlockCount });
        },
        readDurableState: async () => {
          const histories = await Promise.all(accountIds.map(accountId => db.bondLotHistoryTable.fetchAll(accountId)));
          return histories.flat().map(({ createdAt: _createdAt, updatedAt: _updatedAt, ...record }) => record);
        },
      });

      expect([...assetsWithVerifiedApy].sort()).toEqual(['ARGN', 'ARGNOT']);
      for (const result of resultsByPhase) {
        expect(result.importedBlockCount).toBe(result.expectedBlockCount);
      }

      const currentLots = [...currentLotsByAccount.values()].flat();
      const migratedVaultLots = currentLots.filter(lot => {
        return lot.programType === 'Vault' && lot.createdFrameId < earliestEventBackedBondFrame;
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
            candidate.accountId === lot.owner &&
            candidate.programType === lot.programType &&
            candidate.bondLotId === lot.id
          );
        });
        expect(record, `${lot.programType} bond lot ${lot.id} for ${lot.owner}`).toBeDefined();

        if (lot.programType === 'Vault' && lot.createdFrameId < earliestEventBackedBondFrame) {
          expect(record?.purchaseBlockHash, `Migrated Vault bond lot ${lot.id}`).toBeUndefined();
        } else {
          expect(record?.purchaseBlockHash, `${lot.programType} bond lot ${lot.id}`).toBeDefined();
        }
      }
    } finally {
      findActivity.mockRestore();
      reader.close();
      await db.close();
      NetworkConfig.networkName = previousNetwork;
    }
  });
});
