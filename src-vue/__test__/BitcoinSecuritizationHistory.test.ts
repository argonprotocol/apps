import { describe, expect, it } from 'vitest';

import type { IBitcoinSecuritizationTerm } from '../interfaces/IBitcoinSecuritizationTerm.ts';
import { BitcoinSecuritizationHistoryTable } from '../lib/db/BitcoinSecuritizationHistoryTable.ts';
import { createTestDb } from './helpers/db.ts';

const ownerAccount = '5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY';

describe('Bitcoin securitization history', () => {
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
