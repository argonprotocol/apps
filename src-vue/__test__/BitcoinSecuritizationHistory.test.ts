import { describe, expect, it } from 'vitest';

import type { IBitcoinSecuritizationTerm } from '../interfaces/IBitcoinSecuritizationTerm.ts';
import { BitcoinSecuritizationHistoryTable } from '../lib/db/BitcoinSecuritizationHistoryTable.ts';
import { createTestDb } from './helpers/db.ts';
import { createCurrentLock, historyBlock } from './helpers/bitcoin.ts';

const ownerAccount = '5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY';

describe('Bitcoin securitization history', () => {
  it('records finalized Lock terms as they change', async () => {
    const db = await createTestDb();
    const table = db.bitcoinSecuritizationHistoryTable;

    await table.recordFinalizedSecuritization({
      ownerAccount,
      block: historyBlock(159),
      extrinsicIndex: 2,
      lock: createCurrentLock({ securityFees: 20n, couponFeesPaid: 5n }),
      origin: 'created',
    });
    await table.recordFinalizedSecuritization({
      ownerAccount,
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

    await table.recordFinalizedSecuritization({
      ownerAccount,
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
    utxoId: 7,
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
