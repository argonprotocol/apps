import { getOfflineRegistry, type PalletTreasuryBondLot } from '@argonprotocol/mainchain';
import { describe, expect, it, vi } from 'vitest';
import { ArgonBonds } from '../lib/ArgonBonds.ts';
import { ArgonBondsFinancials } from '../lib/financials/ArgonBonds.ts';
import { createTestDb } from './helpers/db.ts';
import { createHistoricalEventData } from '../../indexer/__test__/helpers/historicalEvents.ts';
import { BondLot, Currency } from '@argonprotocol/apps-core';
import type { WalletForArgon } from '../lib/WalletForArgon.ts';
import { encodeAddress } from '@polkadot/util-crypto';
import { bigintCodec, numberCodec, optionCodec } from '../../core/__test__/helpers/codecs.ts';

const registry = getOfflineRegistry();
const accountId = encodeAddress(new Uint8Array(32).fill(0x22));

describe('ArgonBonds', () => {
  it('restores bond purchase and automatic release from index-selected blocks', async () => {
    const db = await createTestDb();
    const lot = registry.createType<PalletTreasuryBondLot>('PalletTreasuryBondLot', {
      owner: accountId,
      program: { Vault: { vaultId: 4, sharingPercent: 0, bonusPercent: 0 } },
      bonds: 10,
      createdFrameId: 3,
      participatedFrames: 0,
      lastFrameEarningsFrameId: null,
      lastFrameEarnings: null,
      cumulativeEarnings: 0,
      releaseFrameId: null,
      releaseReason: null,
    });
    const block = {
      blockNumber: 100,
      blockHash: '0x100',
      blockTime: new Date('2026-07-01T12:00:00Z').getTime(),
      isFinalized: true,
    };
    const api = {
      runtimeVersion: { specVersion: numberCodec(156) },
      query: {
        treasury: {
          bondLotById: vi.fn(async () => optionCodec(lot)),
        },
      },
    };
    const parent = { ...block, blockNumber: 109, blockHash: '0x109' };
    const blockWatch = {
      getApi: vi.fn(async () => api),
      getParentHeader: vi.fn(async () => parent),
    };
    const currency = new Currency({ events: { on: vi.fn() } } as any);
    const argonBonds = new ArgonBonds(
      Promise.resolve(db),
      { isLoadedPromise: Promise.resolve(), upstreamOperator: undefined },
      currency,
      { blockWatch } as any,
      { defaultArgonAddress: accountId } as any,
      {} as any,
    );
    const data = createHistoricalEventData(156, 'treasury', 'BondLotPurchased', {
      programId: { Vault: { vaultId: 4 } },
      bondLotId: 7,
      accountId,
      bonds: 10,
    });

    await argonBonds.importHistoryBlock(block as any, [
      {
        event: { section: 'treasury', method: 'BondLotPurchased', data },
        phase: { isApplyExtrinsic: true, asApplyExtrinsic: numberCodec(2) },
      } as any,
    ]);
    const releaseBlock = { ...block, blockNumber: 110, blockHash: '0x110' };
    await argonBonds.importHistoryBlock(releaseBlock as any, [
      {
        event: {
          section: 'treasury',
          method: 'BondLotReleased',
          data: createHistoricalEventData(156, 'treasury', 'BondLotReleased', {
            frameId: 12,
            programId: { Vault: { vaultId: 4 } },
            bondLotId: 7,
            accountId,
            bonds: 10,
          }),
        },
        phase: { isApplyExtrinsic: false },
      } as any,
    ]);

    const [record] = await db.bondLotHistoryTable.fetchAll(accountId);
    expect(record).toMatchObject({
      bondLotId: 7,
      purchaseBlockNumber: 100,
      purchaseBlockHash: '0x100',
      purchaseExtrinsicIndex: 2,
      releaseBlockNumber: 110,
      releaseBlockHash: '0x110',
      releaseParentHash: '0x109',
      nativePrincipal: 10_000_000n,
    });
  });

  it('rejects bond positions when Treasury holds do not match their principal', async () => {
    const lot = registry.createType<PalletTreasuryBondLot>('PalletTreasuryBondLot', {
      owner: accountId,
      program: { Vault: { vaultId: 4, sharingPercent: 0, bonusPercent: 0 } },
      bonds: 10,
      createdFrameId: 3,
      participatedFrames: 0,
      lastFrameEarningsFrameId: null,
      lastFrameEarnings: null,
      cumulativeEarnings: 0,
      releaseFrameId: null,
      releaseReason: null,
    });
    const currency = new Currency({ events: { on: vi.fn() } } as any);
    const argonBonds = new ArgonBonds(
      Promise.resolve({} as any),
      { isLoadedPromise: Promise.resolve(), upstreamOperator: undefined },
      currency,
      { getFrameDate: () => new Date('2026-07-01T00:00:00Z') } as any,
      { defaultArgonAddress: accountId } as any,
      {} as any,
    );
    argonBonds.data.bondLots = [BondLot.fromRuntime(7, lot, accountId)];
    argonBonds.data.isLoaded = true;
    const account = {
      address: accountId,
      wallet: { address: accountId } as WalletForArgon,
      availableMicrogons: 10_000_000n,
      reservedMicrogons: 0n,
      availableMicronots: 0n,
      reservedMicronots: 0n,
      microgonHolds: [
        {
          id: { isTreasury: true },
          amount: bigintCodec(9_000_000n),
        },
      ],
      micronotHolds: [],
    };

    await expect(
      new ArgonBondsFinancials(argonBonds).loadPositions({
        account: account as any,
        hasConfirmedBondHistoryCoverage: true,
      }),
    ).rejects.toThrow(`ARGN Treasury holds do not match live bond principal for ${accountId}`);
  });
});
