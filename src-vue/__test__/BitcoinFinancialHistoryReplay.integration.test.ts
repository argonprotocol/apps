import Fs from 'node:fs';
import Path from 'node:path';
import {
  AccountActivityKind,
  BitcoinLock,
  type BlockWatch,
  Currency,
  type MainchainClients,
} from '@argonprotocol/apps-core';
import { getClient, hexToU8a } from '@argonprotocol/mainchain';
import { afterAll, describe, expect, it } from 'vitest';
import type { Db } from '../lib/Db.ts';
import type { WalletKeys } from '../lib/WalletKeys.ts';
import { BitcoinLockStatus } from '../lib/db/BitcoinLocksTable.ts';
import { BitcoinUtxoStatus } from '../lib/db/BitcoinUtxosTable.ts';
import { BitcoinLockRecovery } from '../lib/recovery/BitcoinLocks.ts';
import { VaultHistory } from '../lib/recovery/MyVault.ts';
import { FinancialHistoryImporter } from '../lib/recovery/index.ts';
import { createStore } from './helpers/bitcoin.ts';
import { createTestDb } from './helpers/db.ts';
import { runRecoveryLifecycle } from './helpers/RecoveryLifecycleRunner.ts';
import { CapturedHistoryReader } from './helpers/CapturedHistoryReader.ts';

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
        const legacyFundingBlock = await corpusReader.getHeader(591_620);
        const legacyFundingApi = await corpusReader.getApi(legacyFundingBlock);
        const legacyLock = await BitcoinLock.get(legacyFundingApi, 45);
        expect(await legacyLock?.getFundingUtxoRef(legacyFundingApi)).toEqual({
          txid: '0x4e8e026cdfc456579fc90e80d68b4b82266193813d97454ed4e98ca534d24b1a',
          vout: 27,
        });
        expect(await legacyLock?.findPendingMints(legacyFundingApi)).toEqual([771_378_259n]);

        const accountIds = corpusReader.findBitcoinOwners(130);
        expect(accountIds.length).toBeGreaterThan(0);
        let migratedActiveLockCount = 0;
        let recoveredLockCount = 0;
        const recoveryFailures: string[] = [];

        for (const accountId of accountIds) {
          const blocks = corpusReader
            .findActivityBlocks(accountId, {
              activityMask: AccountActivityKind.BitcoinLock | AccountActivityKind.BitcoinMint,
            })
            .filter(block => block.specVersion >= 130);
          const utxoIds = corpusReader.findBitcoinLockIds(accountId);
          const latestBlock = await corpusReader.getHeader(corpusReader.latestBlockNumber);
          const latestApi = await corpusReader.getApi(latestBlock);
          const currentLocks = (await Promise.all(utxoIds.map(utxoId => BitcoinLock.get(latestApi, utxoId)))).filter(
            lock => lock !== undefined,
          );
          const historicalLocks = new Map<
            number,
            { firstBlockNumber: number; lock: NonNullable<Awaited<ReturnType<typeof BitcoinLock.get>>> }
          >();
          for (const utxoId of utxoIds) {
            for (const indexedBlock of blocks) {
              const block = await corpusReader.getHeader(indexedBlock);
              const api = await corpusReader.getApi(block);
              const lock = await BitcoinLock.get(api, utxoId);
              if (!lock) continue;

              historicalLocks.set(utxoId, { firstBlockNumber: block.blockNumber, lock });
              break;
            }
          }

          const derivedLocks = [...historicalLocks.values()].sort((left, right) => {
            return left.firstBlockNumber - right.firstBlockNumber || left.lock.utxoId - right.lock.utxoId;
          });
          const db = await createTestDb();

          try {
            const { blocks, recovered, results } = await replayBitcoinAccount({
              accountId,
              blockWatch: corpusReader as unknown as BlockWatch,
              currentLocks,
              db,
              derivedLocks,
              reader: corpusReader,
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

            for (const currentLock of currentLocks) {
              const lock = recovered.locks.find(record => record.utxoId === currentLock.utxoId);
              expect(lock, `Active Bitcoin lock ${currentLock.utxoId}`).toMatchObject({
                liquidityPromised: currentLock.liquidityPromised,
                lockedTargetPrice: currentLock.lockedTargetPrice,
                lockDetails: { isFlexible: currentLock.isFlexible },
              });
              if (currentLock.createdAtArgonBlock === 0) {
                migratedActiveLockCount += 1;
                expect(lock?.ratchets[0]?.blockHeight, `Migrated Bitcoin lock ${currentLock.utxoId}`).toBeGreaterThan(
                  0,
                );
              }
            }
            if (accountId === '5Cz3PZVcLitGyqc1Su4KYcvseoLhn93pUHtXDNBLx5aoKsF5') {
              expect(recovered.utxos).toContainEqual(
                expect.objectContaining({
                  lockUtxoId: 45,
                  txid: '0x4e8e026cdfc456579fc90e80d68b4b82266193813d97454ed4e98ca534d24b1a',
                  vout: 27,
                  satoshis: 1_057_558n,
                  status: BitcoinUtxoStatus.FundingUtxo,
                }),
              );
              expect(recovered.locks.find(lock => lock.utxoId === 45)?.ratchets).toContainEqual(
                expect.objectContaining({ mintAmount: 771_378_259n, mintPending: 0n }),
              );
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
  currentLocks: NonNullable<Awaited<ReturnType<typeof BitcoinLock.get>>>[];
  db: Db;
  derivedLocks: {
    firstBlockNumber: number;
    lock: NonNullable<Awaited<ReturnType<typeof BitcoinLock.get>>>;
  }[];
  reader: CapturedHistoryReader;
}) {
  const { accountId, blockWatch, currentLocks, db, derivedLocks, reader } = args;
  const blocks = reader
    .findActivityBlocks(accountId, {
      activityMask: AccountActivityKind.BitcoinLock | AccountActivityKind.BitcoinMint,
    })
    .filter(block => block.specVersion >= 130);

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
      for (const persisted of await db.bitcoinLocksTable.fetchAll()) {
        if (persisted.utxoId !== undefined) bitcoinLocks.data.locksByUtxoId[persisted.utxoId] = persisted;
      }
      await bitcoinLocks.utxoTracking.load();

      const releaseRecovery = {
        findConfirmedRecoveredRelease: async () => undefined,
      };
      const recovery = new BitcoinLockRecovery({
        ...releaseRecovery,
        walletKeys,
        blockWatch,
        currency,
        getLocksByUtxoId: () => bitcoinLocks.data.locksByUtxoId,
        getPendingLocks: () => bitcoinLocks.data.pendingLocks,
        waitForLockIdle: async () => undefined,
        onHistoryRecoveryComplete: () => undefined,
        utxoTracking: bitcoinLocks.utxoTracking,
        dbPromise: Promise.resolve(db),
        insertPending: details =>
          db.bitcoinLocksTable.insertPending({
            ...details,
            status: BitcoinLockStatus.LockIsProcessingOnArgon,
            cosignVersion: 'v1',
            network: 'Bitcoin',
          }),
        getTable: async () => db.bitcoinLocksTable,
        getDerivedPubkey: async (vaultId, hdIndex) => {
          const lock = derivedLocks.filter(candidate => candidate.lock.vaultId === vaultId)[hdIndex]?.lock;
          if (!lock) throw new Error(`Seed has no Bitcoin key for vault ${vaultId} index ${hdIndex}`);

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

      const importer = new FinancialHistoryImporter({
        blockWatch,
        argonBonds: { importHistoryBlock: async () => undefined },
        vaultHistory: new VaultHistory(Promise.resolve(db), accountId),
        bitcoinLockRecovery: recovery,
        enabledDomains: ['bitcoin'],
      });
      const result = await importer.importBlocks(blocks);
      results.push(result);
      await recovery.commitHistoryReplay(!result.domainErrors.bitcoin);
    },
    readDurableState: async () => {
      const vaultIds = new Set(derivedLocks.map(({ lock }) => lock.vaultId));
      const hdKeys = await Promise.all(
        [...vaultIds].map(scopeKey => {
          return db.walletHdKeysTable.fetchByScope({ keyRole: 'bitcoinLock', scopeKey: scopeKey.toString() });
        }),
      );
      return {
        locks: (await db.bitcoinLocksTable.fetchAll()).map(({ updatedAt: _updatedAt, ...lock }) => lock),
        utxos: (await db.bitcoinUtxosTable.fetchAll()).map(({ updatedAt: _updatedAt, ...utxo }) => utxo),
        hdKeys: hdKeys.flat(),
      };
    },
  });
  return { blocks, recovered, results };
}
