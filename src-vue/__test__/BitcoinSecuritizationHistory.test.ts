import { describe, expect, it } from 'vitest';

import type { IBitcoinSecuritizationTerm } from '../interfaces/IBitcoinSecuritizationTerm.ts';
import { recordFinalizedSecuritization } from '../lib/BitcoinSecuritizationTerms.ts';
import { BitcoinSecuritizationHistoryTable } from '../lib/db/BitcoinSecuritizationHistoryTable.ts';
import { createTestDb } from './helpers/db.ts';
import { createCurrentLock, historyBlock } from './helpers/bitcoin.ts';

const ownerAccount = '5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY';

describe('Bitcoin securitization history', () => {
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
