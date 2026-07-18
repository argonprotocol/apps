import { describe, expect, it, vi } from 'vitest';
import { createTestDb } from './helpers/db.ts';

describe('WalletTransfersTable', () => {
  it('preserves recovered provenance when a later observation omits it', async () => {
    const db = await createTestDb();
    const blockTime = new Date('2026-07-15T00:00:00Z');
    const transfer = {
      walletAddress: '5default',
      walletName: 'defaultArgon',
      amount: 1n,
      currency: 'argon' as const,
      otherParty: '5other',
      tokenGatewayCommitmentHash: '0xcommitment',
      transferType: 'tokenGateway' as const,
      isInternal: false,
      extrinsicIndex: 0,
      microgonsForArgonot: 2n,
      microgonsForUsd: 2n,
      blockNumber: 1,
      blockHash: '0xblock',
      blockTime,
    };

    try {
      await db.walletTransfersTable.insert(transfer);

      await expect(
        db.walletTransfersTable.insert({
          ...transfer,
          blockTime: undefined,
          tokenGatewayCommitmentHash: undefined,
        }),
      ).resolves.toBeUndefined();
      await expect(db.walletTransfersTable.fetchAll()).resolves.toEqual([
        expect.objectContaining({ blockTime, tokenGatewayCommitmentHash: '0xcommitment' }),
      ]);
    } finally {
      await db.close();
    }
  });

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

  it('loads only external flows inside the owned-wallet boundary', async () => {
    const db = await createTestDb();
    const baseTransfer = {
      walletName: 'defaultArgon',
      currency: 'argon' as const,
      transferType: 'transfer' as const,
      extrinsicIndex: 0,
      microgonsForArgonot: 2n,
      microgonsForUsd: 2n,
      blockTime: new Date('2026-07-15T00:00:00Z'),
    };

    try {
      await db.walletTransfersTable.insert({
        ...baseTransfer,
        walletAddress: '5default',
        otherParty: '5outside',
        amount: 100n,
        isInternal: false,
        blockNumber: 10,
        blockHash: '0xexternal',
      });
      await db.walletTransfersTable.insert({
        ...baseTransfer,
        walletAddress: '5default',
        otherParty: '5miner',
        amount: -50n,
        isInternal: true,
        blockNumber: 11,
        blockHash: '0xinternal',
      });
      await db.walletTransfersTable.insert({
        ...baseTransfer,
        walletAddress: '5unowned',
        otherParty: '5outside',
        amount: 75n,
        isInternal: false,
        blockNumber: 12,
        blockHash: '0xunowned',
      });

      await expect(
        db.walletTransfersTable.fetchExternalFlows({
          walletAddresses: ['5default', '5miner'],
          afterBlock: 0,
          throughBlock: 12,
        }),
      ).resolves.toEqual([expect.objectContaining({ blockNumber: 10, amount: 100n, isInternal: false })]);
    } finally {
      await db.close();
    }
  });
});
