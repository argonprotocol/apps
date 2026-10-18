import { describe, expect, it } from 'vitest';

import type { IBitcoinSecuritizationTerm } from '../interfaces/IBitcoinSecuritizationTerm.ts';
import { recordFinalizedSecuritization } from '../lib/BitcoinSecuritizationTerms.ts';
import { BitcoinSecuritizationHistoryTable } from '../lib/db/BitcoinSecuritizationHistoryTable.ts';
import { createTestDb } from './helpers/db.ts';
import { createCurrentLock, createStore, historyBlock } from './helpers/bitcoin.ts';
import type { WalletKeys } from '../lib/WalletKeys.ts';
import { BitcoinLockStatus } from '../lib/db/BitcoinLocksTable.ts';

const ownerAccount = '5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY';

describe('Bitcoin securitization history', () => {
  it('repairs a missing opening term without replacing newer live capital', async () => {
    const db = await createTestDb();
    try {
      const table = db.bitcoinSecuritizationHistoryTable;
      const store = createStore({ db, walletKeys: { defaultArgonAddress: ownerAccount } as WalletKeys });
      const current = createCurrentLock({ securityFees: 30n, securitizationTick: 400 });
      const pending = await db.bitcoinLocksTable.insertPending({
        uuid: 'repaired-opening',
        vaultId: current.vaultId,
        status: BitcoinLockStatus.LockPendingFunding,
        securitizedSatoshis: current.securitizedSatoshis,
        hdPath: 'synthetic-owner',
        cosignVersion: 'v1',
        network: 'testnet',
      });
      const lock = await db.bitcoinLocksTable.finalizePending({ uuid: pending.uuid, lock: current });
      await db.bitcoinLocksTable.updateFromCurrentLock(lock, current);
      store.data.locksByLockId[current.lockId] = lock;

      // The app first observed a resecuritization; recovery has the earlier creation too.
      await recordFinalizedSecuritization(table, {
        block: historyBlock(200),
        extrinsicIndex: 2,
        lock: createCurrentLock({ securityFees: 20n }),
        origin: 'resecuritized',
      });
      const recoveredUnit = {
        lockId: current.lockId,
        lock: { ...lock, securitizationTick: 200 },
        utxos: [],
        releases: [],
        fissions: [],
        hdKeys: [],
        securitizationTerms: [
          createTerm({
            startTick: 159,
            securitizationCoverageMicrogons: current.securitizationCoverageMicrogons,
            cumulativeNetSecurityFee: 10n,
            addedNetSecurityFee: 10n,
            endTick: 200,
            endBlockNumber: 200,
            endBlockHash: '0x200',
            endExtrinsicIndex: 2,
            endReason: 'resecuritized',
          }),
          createTerm({
            termIndex: 1,
            origin: 'resecuritized',
            startTick: 200,
            startBlockNumber: 200,
            startBlockHash: '0x200',
            securitizationCoverageMicrogons: current.securitizationCoverageMicrogons,
            cumulativeNetSecurityFee: 20n,
            addedNetSecurityFee: 10n,
          }),
        ],
      };
      await recordFinalizedSecuritization(table, {
        block: historyBlock(400),
        extrinsicIndex: 2,
        lock: current,
        origin: 'resecuritized',
      });
      await store.applyRecoveredHistory(recoveredUnit, 300);
      const newer = (await table.getPublishedSnapshot(ownerAccount))!;
      expect(newer.asOfBlock).toBe(400);
      expect(newer.terms.map(term => [term.termIndex, term.startTick, term.endTick, term.addedNetSecurityFee])).toEqual(
        [
          [0, 159, 200, 10n],
          [1, 200, 400, 10n],
          [2, 400, undefined, 10n],
        ],
      );
      expect((await db.bitcoinLocksTable.getByLockId(current.lockId))?.securitizationTick).toBe(400);

      // An incremental replay can be seeded with published terms beyond its recovered block.
      await store.applyRecoveredHistory({ ...recoveredUnit, securitizationTerms: newer.terms }, 300);
      expect((await table.getPublishedSnapshot(ownerAccount))?.terms).toEqual(newer.terms);
    } finally {
      await db.close();
    }
  });

  it('records finalized Lock terms as they change', async () => {
    const db = await createTestDb();
    const table = db.bitcoinSecuritizationHistoryTable;
    await recordFinalizedSecuritization(table, {
      block: historyBlock(159),
      extrinsicIndex: 2,
      lock: createCurrentLock({ securityFees: 20n, couponFeesPaid: 5n }),
      origin: 'created',
    });
    await recordFinalizedSecuritization(table, {
      block: historyBlock(200),
      extrinsicIndex: 3,
      lock: createCurrentLock({
        securitizedSatoshis: 20_000n,
        securitizationCoverageMicrogons: 20_000n,
        securityFees: 32n,
        couponFeesPaid: 7n,
      }),
      origin: 'resecuritized',
    });

    expect((await table.getPublishedSnapshot(ownerAccount))?.terms).toEqual([
      expect.objectContaining({
        termIndex: 0,
        origin: 'created',
        cumulativeNetSecurityFee: 15n,
        addedNetSecurityFee: 15n,
        endBlockNumber: 200,
        endExtrinsicIndex: 3,
        endReason: 'resecuritized',
      }),
      expect.objectContaining({
        termIndex: 1,
        origin: 'resecuritized',
        cumulativeNetSecurityFee: 25n,
        addedNetSecurityFee: 10n,
        startBlockNumber: 200,
        startExtrinsicIndex: 3,
      }),
    ]);

    await recordFinalizedSecuritization(table, {
      block: historyBlock(200),
      extrinsicIndex: 3,
      lock: createCurrentLock({
        securitizedSatoshis: 20_000n,
        securitizationCoverageMicrogons: 20_000n,
        securityFees: 32n,
        couponFeesPaid: 7n,
      }),
      origin: 'resecuritized',
    });

    expect((await table.getPublishedSnapshot(ownerAccount))?.terms).toHaveLength(2);
  });

  it('continues reduced securitization after a partial release without reallocating its fee', async () => {
    const db = await createTestDb();
    const table = db.bitcoinSecuritizationHistoryTable;
    await recordFinalizedSecuritization(table, {
      block: historyBlock(159),
      extrinsicIndex: 2,
      lock: createCurrentLock({
        securitizedSatoshis: 10_000n,
        fissionedSatoshis: 6_000n,
        securityFees: 20n,
        couponFeesPaid: 5n,
      }),
      origin: 'created',
    });
    await recordFinalizedSecuritization(table, {
      block: historyBlock(220),
      extrinsicIndex: 4,
      lock: createCurrentLock({
        securitizedSatoshis: 8_000n,
        securitizationCoverageMicrogons: 8_000n,
        fundedSatoshis: 8_000n,
        fissionedSatoshis: 6_000n,
        securityFees: 20n,
        couponFeesPaid: 5n,
      }),
      origin: 'partial-release',
    });

    expect((await table.getPublishedSnapshot(ownerAccount))?.terms).toEqual([
      expect.objectContaining({
        termIndex: 0,
        securitizedSatoshis: 10_000n,
        cumulativeNetSecurityFee: 15n,
        addedNetSecurityFee: 15n,
        endBlockNumber: 220,
        endReason: 'partial-release',
      }),
      expect.objectContaining({
        termIndex: 1,
        origin: 'partial-release',
        securitizedSatoshis: 8_000n,
        securitizationCoverageMicrogons: 8_000n,
        cumulativeNetSecurityFee: 15n,
        addedNetSecurityFee: 0n,
        startBlockNumber: 220,
      }),
    ]);
  });

  it('does not create a partial-release term when the securitized amount is unchanged', async () => {
    const db = await createTestDb();
    const table = db.bitcoinSecuritizationHistoryTable;
    const lock = createCurrentLock({
      securitizedSatoshis: 10_000n,
      fundedSatoshis: 12_000n,
      fissionedSatoshis: 6_000n,
      securityFees: 20n,
      couponFeesPaid: 5n,
    });

    await recordFinalizedSecuritization(table, {
      block: historyBlock(159),
      extrinsicIndex: 2,
      lock,
      origin: 'created',
    });
    await recordFinalizedSecuritization(table, {
      block: historyBlock(220),
      extrinsicIndex: 4,
      lock: createCurrentLock({ ...lock, fundedSatoshis: 10_000n }),
      origin: 'partial-release',
    });

    expect((await table.getPublishedSnapshot(ownerAccount))?.terms).toEqual([
      expect.objectContaining({
        termIndex: 0,
        origin: 'created',
        securitizedSatoshis: 10_000n,
      }),
    ]);
    expect((await table.getPublishedSnapshot(ownerAccount))?.terms[0].endReason).toBeUndefined();
  });

  it('preserves published history across a failed rebuild, stale replay, and restart', async () => {
    const db = await createTestDb();
    const table = db.bitcoinSecuritizationHistoryTable;

    const initial = await table.createSnapshot(ownerAccount, 200, [createTerm({ cumulativeNetSecurityFee: 100n })]);
    await table.publishSnapshot(initial);

    await expect(
      table.createSnapshot(ownerAccount, 250, [
        createTerm({ cumulativeNetSecurityFee: 120n }),
        createTerm({ cumulativeNetSecurityFee: 120n }),
      ]),
    ).rejects.toThrow();

    expect((await table.getPublishedSnapshot(ownerAccount))?.terms).toEqual([
      expect.objectContaining({
        origin: 'created',
        startTick: 500,
        securitizationCoverageMicrogons: 1_000n,
        cumulativeNetSecurityFee: 100n,
      }),
    ]);

    const replay = await table.createSnapshot(ownerAccount, 250, [createTerm({ cumulativeNetSecurityFee: 120n })]);
    const live = await table.createSnapshot(ownerAccount, 300, [
      createTerm({ cumulativeNetSecurityFee: 130n, addedNetSecurityFee: 30n }),
    ]);
    await table.publishSnapshot(live);

    await expect(table.publishSnapshot(replay)).rejects.toThrow('newer securitization history');

    const restartedTable = new BitcoinSecuritizationHistoryTable(db);
    expect((await restartedTable.getPublishedSnapshot(ownerAccount))?.terms).toEqual([
      expect.objectContaining({ cumulativeNetSecurityFee: 130n, addedNetSecurityFee: 30n }),
    ]);
  });

  it('does not rewrite an identical published snapshot', async () => {
    const db = await createTestDb();
    const table = db.bitcoinSecuritizationHistoryTable;
    const terms = [createTerm({ cumulativeNetSecurityFee: 100n })];
    const initial = await table.createSnapshot(ownerAccount, 200, terms);
    await table.publishSnapshot(initial);

    const repeated = await table.createSnapshot(ownerAccount, 200, terms);
    await table.publishSnapshot(repeated);

    expect(repeated.snapshotId).toBe(initial.snapshotId);
    await expect(
      db.select(`SELECT snapshotId FROM BitcoinSecuritizationHistory WHERE ownerAccount = ?`, [ownerAccount]),
    ).resolves.toEqual([{ snapshotId: initial.snapshotId }]);
  });
});

function createTerm(overrides: Partial<IBitcoinSecuritizationTerm> = {}): IBitcoinSecuritizationTerm {
  return {
    lockId: 7,
    termIndex: 0,
    origin: 'created',
    startTick: 500,
    startBlockNumber: 159,
    startBlockHash: '0x159',
    startExtrinsicIndex: 2,
    securitizedSatoshis: 10_000n,
    securitizationCoverageMicrogons: 1_000n,
    cumulativeNetSecurityFee: 100n,
    addedNetSecurityFee: 100n,
    ...overrides,
  };
}
