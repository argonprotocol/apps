import Fs from 'node:fs';
import Path from 'node:path';
import { AccountActivityKind, type BlockWatch, Currency, type MainchainClients } from '@argonprotocol/apps-core';
import { getClient, hexToU8a, u8aEq } from '@argonprotocol/mainchain';
import { afterAll, describe, expect, it } from 'vitest';
import type { Db } from '../lib/Db.ts';
import type { WalletKeys } from '../lib/WalletKeys.ts';
import { BitcoinLockStatus } from '../lib/db/BitcoinLocksTable.ts';
import { BitcoinLockRecovery } from '../lib/recovery/BitcoinLocks.ts';
import { BitcoinFissions } from '../lib/BitcoinFissions.ts';
import { VaultHistory } from '../lib/recovery/MyVault.ts';
import { FinancialHistoryImporter, publishBitcoinHistoryReplay } from '../lib/recovery/index.ts';
import { createStore } from './helpers/bitcoin.ts';
import { createTestDb } from './helpers/db.ts';
import { runRecoveryLifecycle } from './helpers/RecoveryLifecycleRunner.ts';
import { CapturedHistoryReader } from './helpers/CapturedHistoryReader.ts';
import { getHistoricalBitcoinLock } from '../lib/recovery/BitcoinLockHistory.ts';

const replayPath =
  process.env.FINANCIAL_HISTORY_REPLAY_PATH ??
  Path.resolve(import.meta.dirname, '../../indexer/seeds/mainnet-financial-history-replay.db');
const runWithReplay = Fs.existsSync(replayPath) ? describe : describe.skip;
const recordingClient =
  process.env.FINANCIAL_HISTORY_REPLAY_CAPTURE === '1' ? await getClient('https://rpc.argon.network') : undefined;

afterAll(async () => recordingClient?.disconnect());

runWithReplay('Bitcoin financial history replay corpus', () => {
  it(
    'recovers every indexed Bitcoin history from current chain state and remains stable after restart',
    async () => {
      const corpusReader = new CapturedHistoryReader(replayPath, recordingClient);
      try {
        const accountIds = corpusReader.findBitcoinOwners(130);
        expect(accountIds.length).toBeGreaterThan(0);
        let migratedActiveLockCount = 0;
        let recoveredLockCount = 0;
        const recoveryFailures: string[] = [];
        const latestBlock = await corpusReader.getHeader(corpusReader.latestBlockNumber);
        const latestApi = await corpusReader.getApi(latestBlock);

        for (const accountId of accountIds) {
          const blocks = corpusReader
            .findActivityBlocks(accountId, {
              activityMask: AccountActivityKind.BitcoinLock | AccountActivityKind.BitcoinMint,
            })
            .filter(block => block.specVersion >= 130);
          const utxoIds = corpusReader.findBitcoinLockIds(accountId);
          const currentLocks = (
            await Promise.all(utxoIds.map(lockId => getHistoricalBitcoinLock(latestApi, lockId)))
          ).filter(lock => lock !== undefined);
          const historicalApis = await Promise.all(
            blocks.map(async indexedBlock => {
              const block = await corpusReader.getHeader(indexedBlock);
              return { block, api: await corpusReader.getApi(block) };
            }),
          );
          const historicalLocks = new Map<
            number,
            { firstBlockNumber: number; lock: NonNullable<Awaited<ReturnType<typeof getHistoricalBitcoinLock>>> }
          >();
          for (const lockId of utxoIds) {
            for (const { block, api } of historicalApis) {
              const lock = await getHistoricalBitcoinLock(api, lockId);
              if (!lock) continue;

              historicalLocks.set(lockId, { firstBlockNumber: block.blockNumber, lock });
              break;
            }
          }

          const derivedLocks = [...historicalLocks.values()].sort((left, right) => {
            return left.firstBlockNumber - right.firstBlockNumber || left.lock.utxoId - right.lock.utxoId;
          });
          const db = await createTestDb();

          try {
            const { recovered, results } = await replayBitcoinAccount({
              accountId,
              blockWatch: corpusReader as unknown as BlockWatch,
              blocks,
              currentLocks,
              db,
              derivedLocks,
            });
            const errors = results.flatMap(result => Object.values(result.domainErrors));
            if (utxoIds.includes(41)) {
              expect(
                currentLocks.some(lock => lock.utxoId === 41),
                'Current Bitcoin lock 41',
              ).toBe(true);
              expect(
                recovered.locks.some(lock => lock.lockId === 41),
                'Recovered Bitcoin lock 41',
              ).toBe(true);
              expect(errors, 'Active Bitcoin lock 41 replay').toEqual([]);
            }
            if (errors.length) {
              recoveryFailures.push(...new Set(errors.map(error => `${accountId}: ${error}`)));
              continue;
            }
            expect(
              results.map(result => result.importedBlockCount),
              accountId,
            ).toEqual([blocks.length, blocks.length]);

            for (const currentLock of currentLocks) {
              const lock = recovered.locks.find(record => record.lockId === currentLock.utxoId);
              const fission = recovered.fissions.find(record => record.lockId === currentLock.utxoId);
              expect(lock, `Active Bitcoin lock ${currentLock.utxoId}`).toMatchObject({
                isFlexible: currentLock.isFlexible,
                securitizedSatoshis: currentLock.securitizedSatoshis,
              });
              expect(fission, `Migrated Bitcoin Fission ${currentLock.utxoId}`).toMatchObject({
                liquidityPromised: currentLock.liquidityPromised,
                lockId: currentLock.utxoId,
              });
              if (currentLock.createdAtArgonBlock === 0) {
                migratedActiveLockCount += 1;
                expect(
                  fission?.ratchets[0]?.blockNumber,
                  `Migrated Bitcoin Fission ${currentLock.utxoId}`,
                ).toBeGreaterThan(0);
              }
            }
            for (const fission of recovered.fissions.filter(fission => fission.origin === 'lock-migration')) {
              expect(
                recovered.securitization?.terms.some(term => term.lockId === fission.lockId),
                `Migrated Bitcoin Fission ${fission.fissionId} securitization history`,
              ).toBe(true);
            }
            if (utxoIds.includes(112)) {
              expect(recovered.locks).toEqual([
                expect.objectContaining({
                  lockId: 112,
                  status: BitcoinLockStatus.LockFailedAcknowledged,
                  fundedSatoshis: 0n,
                }),
              ]);
              expect(recovered.fissions).toEqual([]);
            }
            if (utxoIds.includes(110)) {
              expect(recovered.fissions.find(record => record.lockId === 110)?.ratchets[0]).toMatchObject({
                securityFee: 144_528_009n,
                securityFeeCoupon: 144_528_009n,
              });
              expect(recovered.securitization?.terms.find(term => term.lockId === 110)).toMatchObject({
                securitizedSatoshis: 6_692_135n,
                cumulativeNetSecurityFee: 0n,
                addedNetSecurityFee: 0n,
              });
            }
            recoveredLockCount += recovered.locks.length;
          } finally {
            await db.close();
          }
        }
        expect(recoveryFailures).toEqual([]);
        expect(recoveredLockCount).toBeGreaterThan(0);
        expect(migratedActiveLockCount).toBeGreaterThan(0);
      } finally {
        corpusReader.close();
      }
    },
    recordingClient ? 15 * 60_000 : undefined,
  );
});

async function replayBitcoinAccount(args: {
  accountId: string;
  blockWatch: BlockWatch;
  blocks: ReturnType<CapturedHistoryReader['findActivityBlocks']>;
  currentLocks: NonNullable<Awaited<ReturnType<typeof getHistoricalBitcoinLock>>>[];
  db: Db;
  derivedLocks: {
    firstBlockNumber: number;
    lock: NonNullable<Awaited<ReturnType<typeof getHistoricalBitcoinLock>>>;
  }[];
}) {
  const { accountId, blockWatch, blocks, currentLocks, db, derivedLocks } = args;

  const walletKeys = {
    defaultArgonAddress: accountId,
    miningBotAddress: '',
    operationalAddress: '',
  } as WalletKeys;
  const currency = new Currency({ events: { on: () => () => undefined } } as unknown as MainchainClients);
  const results: Awaited<ReturnType<FinancialHistoryImporter['importBlocks']>>[] = [];
  const recovered = await runRecoveryLifecycle({
    name: `Bitcoin histories for ${accountId}`,
    timeoutMs: recordingClient ? 30_000 : undefined,
    recover: async () => {
      const bitcoinLocks = createStore({ blockWatch, db, walletKeys });
      const [persistedLocks, persistedUtxos] = await Promise.all([
        db.bitcoinLocksTable.fetchAll(),
        db.bitcoinUtxosTable.fetchAll(),
      ]);
      for (const persisted of persistedLocks) {
        if (persisted.lockId !== undefined) bitcoinLocks.data.locksByLockId[persisted.lockId] = persisted;
      }
      bitcoinLocks.utxoTracking.load(persistedUtxos);

      const releaseRecovery = {
        findConfirmedRecoveredRelease: async () => undefined,
      };
      const recovery = new BitcoinLockRecovery({
        ...releaseRecovery,
        walletKeys,
        blockWatch,
        currency,
        getLocksByLockId: () => bitcoinLocks.data.locksByLockId,
        getPendingLocks: () => bitcoinLocks.data.pendingLocks,
        getUnloadedCurrentLockIds: () => new Set(),
        waitForLockIdle: async () => undefined,
        onHistoryRecoveryComplete: () => undefined,
        utxoTracking: bitcoinLocks.utxoTracking,
        releases: bitcoinLocks.releases,
        dbPromise: Promise.resolve(db),
        insertPending: details =>
          db.bitcoinLocksTable.insertPending({
            uuid: details.uuid,
            securitizedSatoshis: details.securitizedSatoshis,
            vaultId: details.vaultId,
            hdPath: details.hdPath,
            status: BitcoinLockStatus.LockIsProcessingOnArgon,
            cosignVersion: 'v1',
            network: 'Bitcoin',
          }),
        getTable: async () => db.bitcoinLocksTable,
        findDerivedPubkeyForOwner: async (vaultId, ownerPubkey) => {
          const vaultLocks = derivedLocks.filter(candidate => candidate.lock.vaultId === vaultId);
          const hdIndex = vaultLocks.findIndex(candidate => u8aEq(hexToU8a(candidate.lock.ownerPubkey), ownerPubkey));
          const lock = vaultLocks[hdIndex]?.lock;
          if (!lock) return;

          return {
            address: `seed:${vaultId}:${hdIndex}`,
            hdIndex,
            hdPath: `m/seed/${vaultId}/${hdIndex}`,
            ownerBitcoinPubkey: hexToU8a(lock.ownerPubkey),
          };
        },
        getBitcoinNetwork: () => 'Bitcoin',
        trackDerivedBitcoinLockKey: async () => undefined,
      });
      for (const lock of currentLocks) {
        await recovery.recoverLock({
          lock,
          createdAtArgonBlockHeight: lock.createdAtArgonBlock,
          finalFee: 0n,
        });
      }
      await recovery.beginHistoryReplay({ lockScope: 'all' });
      const bitcoinFissions = new BitcoinFissions(Promise.resolve(db), accountId);
      await bitcoinFissions.recovery.beginHistoryReplay({ replace: true });

      const importer = new FinancialHistoryImporter({
        blockWatch,
        argonBonds: { importHistoryBlock: async () => undefined },
        vaultHistory: new VaultHistory(Promise.resolve(db), accountId),
        bitcoinLockRecovery: recovery,
        bitcoinFissionRecovery: bitcoinFissions.recovery,
        enabledDomains: ['bitcoin'],
      });
      const result = await importer.importBlocks(blocks);
      results.push(result);
      if (result.domainErrors.bitcoin) {
        await recovery.cancelHistoryReplay();
        bitcoinFissions.recovery.cancelHistoryReplay();
      } else {
        await publishBitcoinHistoryReplay({
          bitcoinLocks: {
            recovery,
            applyRecoveredHistory: bitcoinLocks.applyRecoveredHistory.bind(bitcoinLocks),
          },
          bitcoinFissions,
          asOfBlock: blocks.at(-1)?.blockNumber ?? 0,
        });
      }
    },
    readDurableState: async () => {
      const vaultIds = new Set(derivedLocks.map(({ lock }) => lock.vaultId));
      const hdKeys = await Promise.all(
        [...vaultIds].map(scopeKey => {
          return db.walletHdKeysTable.fetchByScope({ keyRole: 'bitcoinLock', scopeKey: scopeKey.toString() });
        }),
      );
      const [locks, fissions, securitization, utxos] = await Promise.all([
        db.bitcoinLocksTable.fetchAll(),
        db.bitcoinFissionsTable.fetchAll(accountId),
        db.bitcoinSecuritizationHistoryTable.getPublishedSnapshot(accountId),
        db.bitcoinUtxosTable.fetchAll(),
      ]);
      return {
        locks: locks.map(({ updatedAt: _updatedAt, ...lock }) => lock),
        fissions: fissions.map(({ updatedAt: _updatedAt, ...fission }) => fission),
        securitization,
        utxos: utxos.map(omitUpdatedAt),
        hdKeys: hdKeys.flat(),
      };
    },
  });
  return { recovered, results };
}

function omitUpdatedAt<T extends { updatedAt?: unknown }>({
  updatedAt: _updatedAt,
  ...record
}: T): Omit<T, 'updatedAt'> {
  return record;
}
