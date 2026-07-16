import { describe, expect, it, vi } from 'vitest';
import { createTestDb } from './helpers/db.ts';

describe('WalletTransfersTable', () => {
  it('reuses custody queries until the transfer revision changes', async () => {
    const db = await createTestDb();

    try {
      const select = vi.spyOn(db, 'select');
      await Promise.all([
        db.walletTransfersTable.fetchArgonotCustodyBoundaries('5miner'),
        db.walletTransfersTable.fetchArgonotCustodyBoundaries('5miner'),
      ]);

      expect(select).toHaveBeenCalledOnce();

      await db.walletTransfersTable.insert({
        walletAddress: '5miner',
        walletName: 'miningBot',
        amount: 1n,
        currency: 'argon',
        otherParty: '5default',
        transferType: 'transfer',
        isInternal: true,
        extrinsicIndex: 0,
        microgonsForArgonot: 2n,
        microgonsForUsd: 2n,
        blockNumber: 1,
        blockHash: '0xargon',
        blockTime: new Date('2026-07-15T00:00:00Z'),
      });
      select.mockClear();
      await db.walletTransfersTable.fetchArgonotCustodyBoundaries('5miner');
      expect(select).not.toHaveBeenCalled();

      const argonotTransfer = {
        walletAddress: '5miner',
        walletName: 'miningBot',
        amount: -1n,
        currency: 'argonot',
        otherParty: '5default',
        transferType: 'transfer',
        isInternal: true,
        extrinsicIndex: 0,
        microgonsForArgonot: 2n,
        microgonsForUsd: 2n,
        blockNumber: 1,
        blockHash: '0xblock',
        blockTime: new Date('2026-07-15T00:00:00Z'),
      } as const;
      await db.walletTransfersTable.insert(argonotTransfer);
      select.mockClear();

      await expect(db.walletTransfersTable.fetchArgonotCustodyBoundaries('5miner')).resolves.toHaveLength(1);
      expect(select).toHaveBeenCalledOnce();

      const revision = db.walletTransfersTable.revision;
      select.mockClear();
      await expect(db.walletTransfersTable.insert(argonotTransfer)).resolves.toBeUndefined();
      expect(db.walletTransfersTable.revision).toBe(revision);
      select.mockClear();
      await db.walletTransfersTable.fetchArgonotCustodyBoundaries('5miner');
      expect(select).not.toHaveBeenCalled();

      await expect(
        db.walletTransfersTable.insert({
          ...argonotTransfer,
          microgonsForArgonot: 3n,
          microgonsForUsd: 4n,
        }),
      ).resolves.toMatchObject({ microgonsForArgonot: 3n, microgonsForUsd: 4n });
      await expect(db.walletTransfersTable.fetchArgonotCustodyBoundaries('5miner')).resolves.toEqual([
        expect.objectContaining({ microgonsForArgonot: 3n, microgonsForUsd: 4n }),
      ]);
    } finally {
      await db.close();
    }
  });
});
