import { getOfflineRegistry, type PalletTreasuryBondLot } from '@argonprotocol/mainchain';
import { BondLot } from '@argonprotocol/apps-core';
import { describe, expect, it } from 'vitest';
import { createTestDb } from './helpers/db.ts';

const accountId = getOfflineRegistry()
  .createType('AccountId32', `0x${'11'.repeat(32)}`)
  .toString();

describe('BondLotHistoryTable', () => {
  it('enriches a first observation with finalized purchase and release provenance', async () => {
    const db = await createTestDb();
    const lot = createBondLot({
      id: 7,
      bonds: 10,
      program: 'Argonot',
      releaseFrame: 20,
      cumulativeEarnings: 4_000_000n,
    });

    await db.bondLotHistoryTable.recordObservation({
      lot,
      blockNumber: 100,
      blockHash: '0xobserved',
    });
    await db.bondLotHistoryTable.recordObservation({
      lot,
      blockNumber: 90,
      blockHash: '0xpurchased',
      purchase: {
        blockTime: new Date('2026-07-01T12:00:00Z'),
        extrinsicIndex: 2,
        entryArgonotRateMicrogons: 2_000_000n,
      },
    });
    await db.bondLotHistoryTable.recordRelease({
      lot,
      parentBlockNumber: 119,
      parentBlockHash: '0xparent',
      release: {
        blockNumber: 120,
        blockHash: '0xreleased',
        blockTime: new Date('2026-07-10T12:00:00Z'),
        extrinsicIndex: 3,
        closingArgonotRateMicrogons: 3_000_000n,
      },
    });

    const records = await db.bondLotHistoryTable.fetchAll(accountId);
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      firstObservedBlockNumber: 100,
      firstObservedBlockHash: '0xobserved',
      purchaseBlockNumber: 90,
      purchaseBlockHash: '0xpurchased',
      purchaseExtrinsicIndex: 2,
      entryArgonotRateMicrogons: 2_000_000n,
      releaseFrame: 20,
      releaseBlockNumber: 120,
      releaseBlockHash: '0xreleased',
      releaseParentHash: '0xparent',
      releaseExtrinsicIndex: 3,
      nativePrincipal: 10_000_000n,
      cumulativeEarningsMicrogons: 4_000_000n,
      closingArgonotRateMicrogons: 3_000_000n,
    });
    expect(records[0].purchaseBlockTime).toEqual(new Date('2026-07-01T12:00:00Z'));
    expect(records[0].releaseBlockTime).toEqual(new Date('2026-07-10T12:00:00Z'));
    expect(records.filter(record => record.releaseBlockHash)).toHaveLength(1);
    await expect(db.bondLotHistoryTable.fetchAll('5different')).resolves.toEqual([]);
  });

  it('keeps the first finalized terminal facts across repeated recovery', async () => {
    const db = await createTestDb();
    const lot = createBondLot({ id: 8, bonds: 5, program: 'Vault', releaseFrame: 12 });
    const release = {
      blockNumber: 50,
      blockHash: '0xrelease',
      blockTime: new Date('2026-07-12T12:00:00Z'),
    };

    await db.bondLotHistoryTable.recordRelease({
      lot,
      parentBlockNumber: 49,
      parentBlockHash: '0xparent',
      release,
    });
    await db.bondLotHistoryTable.recordRelease({
      lot,
      parentBlockNumber: 59,
      parentBlockHash: '0xdifferent-parent',
      release: { ...release, blockNumber: 60, blockHash: '0xdifferent-release' },
    });

    const records = await db.bondLotHistoryTable.fetchAll(accountId);

    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      nativePrincipal: 5_000_000n,
      releaseFrame: 12,
      releaseBlockNumber: 50,
      releaseBlockHash: '0xrelease',
      releaseParentHash: '0xparent',
    });
  });
});

function createBondLot(args: {
  id: number;
  bonds: number;
  program: 'Vault' | 'Argonot';
  releaseFrame: number;
  cumulativeEarnings?: bigint;
}): BondLot {
  const program =
    args.program === 'Vault' ? { Vault: { vaultId: 4, sharingPercent: 0, bonusPercent: 0 } } : { Argonot: null };
  const codec = getOfflineRegistry().createType<PalletTreasuryBondLot>('PalletTreasuryBondLot', {
    owner: accountId,
    program,
    bonds: args.bonds,
    createdFrameId: 3,
    participatedFrames: 9,
    lastFrameEarningsFrameId: 11,
    lastFrameEarnings: 1_000_000n,
    cumulativeEarnings: args.cumulativeEarnings ?? 0n,
    releaseFrameId: args.releaseFrame,
    releaseReason: 'UserLiquidation',
  });
  return BondLot.fromRuntime(args.id, codec, accountId);
}
