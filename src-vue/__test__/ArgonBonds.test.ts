import { type FrameSystemEventRecord, getOfflineRegistry } from '@argonprotocol/mainchain';
import { toPlain, type TreasuryBondLotByIdResult } from '@argonprotocol/runtime-client';
import { describe, expect, it, vi } from 'vitest';
import { ArgonBonds } from '../lib/ArgonBonds.ts';
import { ArgonBondsFinancials } from '../lib/financials/ArgonBonds.ts';
import { createTestDb } from './helpers/db.ts';
import { BondLot, createDeferred, Currency, TreasuryBonds } from '@argonprotocol/apps-core';
import type { WalletForArgon } from '../lib/WalletForArgon.ts';
import { encodeAddress } from '@polkadot/util-crypto';
import { numberCodec } from '../../core/__test__/helpers/codecs.ts';
import { ExtrinsicType } from '../lib/db/TransactionsTable.ts';

const registry = getOfflineRegistry();
const accountId = encodeAddress(new Uint8Array(32).fill(0x22));

describe('ArgonBonds', () => {
  it('keeps best-chain bond purchases visible during active-state recovery', async () => {
    const lotCodec = createRuntimeBondLot({
      owner: accountId,
      program: { Argonot: null },
      bonds: 20,
      createdFrameId: 4,
      participatedFrames: 0,
      lastFrameEarningsFrameId: null,
      lastFrameEarnings: null,
      cumulativeEarnings: 0,
      releaseFrameId: null,
      releaseReason: null,
    });
    const finalizedLot = BondLot.fromRuntime(7, lotCodec, accountId);
    const bestChainLot = BondLot.fromRuntime(8, lotCodec, accountId);
    const finalizedClient = {};
    const currentClient = {};
    const blockWatch = {
      getCurrentApi: vi.fn(async () => currentClient),
    };
    const getBondLots = vi.spyOn(TreasuryBonds, 'getBondLotsByAccount').mockImplementation(async client => {
      return client === currentClient ? [finalizedLot, bestChainLot] : [finalizedLot];
    });
    const argonBonds = new ArgonBonds(
      Promise.resolve({} as any),
      { isLoadedPromise: Promise.resolve(), upstreamOperator: undefined },
      new Currency({ events: { on: vi.fn() } } as any),
      { blockWatch } as any,
      { defaultArgonAddress: accountId } as any,
      {} as any,
    );
    argonBonds.data.isLoaded = true;
    argonBonds.data.bondLots = [finalizedLot, bestChainLot];

    await argonBonds.refreshActiveState({ client: finalizedClient as any, currentFrameId: 4 });

    expect(argonBonds.data.bondLots.map(lot => lot.id)).toEqual([7, 8]);
    getBondLots.mockRestore();
  });

  it('records automatic releases from finalized frame blocks', async () => {
    const db = await createTestDb();
    const lot = createRuntimeBondLot({
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
          bondLotById: vi.fn(async () => lot),
        },
      },
    };
    const parent = { ...block, blockNumber: 109, blockHash: '0x109' };
    let finalizedListener!: (blocks: any[]) => void;
    let finalizedEvents: FrameSystemEventRecord[] = [];
    const blockWatch = {
      events: {
        on: vi.fn((eventName: string, listener: (blocks: any[]) => void) => {
          if (eventName === 'finalized') finalizedListener = listener;
          return () => undefined;
        }),
      },
      getApi: vi.fn(async () => api),
      getParentHeader: vi.fn(async () => parent),
      getEvents: vi.fn(async () => finalizedEvents),
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
    const data = {
      programId: { type: 'Vault', value: { vaultId: 4 } },
      bondLotId: 7,
      accountId,
      bonds: 10,
    };

    await argonBonds.importHistoryBlock(block as any, [
      {
        event: { section: 'treasury', method: 'BondLotPurchased', data },
        phase: { type: 'ApplyExtrinsic', value: 2 },
      } as any,
    ]);
    const releaseBlock = { ...block, blockNumber: 110, blockHash: '0x110', isNewFrame: true };
    finalizedEvents = [
      {
        event: {
          section: 'treasury',
          method: 'BondLotReleased',
          data: {
            frameId: 12,
            programId: { type: 'Vault', value: { vaultId: 4 } },
            bondLotId: 7,
            accountId,
            bonds: 10,
          },
        },
        phase: { type: 'Initialization' },
      } as any,
    ];

    vi.spyOn(argonBonds, 'refreshVault').mockResolvedValue();
    await argonBonds.subscribeVault({ vaultId: 4, operatorAddress: accountId }, {} as any);
    finalizedListener([releaseBlock as any]);

    await vi.waitFor(async () => {
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
  });

  it('records a finalized liquidation without a progress subscriber', async () => {
    const db = await createTestDb();
    const activeCodec = createRuntimeBondLot({
      owner: accountId,
      program: { Argonot: null },
      bonds: 10,
      createdFrameId: 3,
      participatedFrames: 2,
      lastFrameEarningsFrameId: 4,
      lastFrameEarnings: 1_000_000n,
      cumulativeEarnings: 2_000_000n,
      releaseFrameId: null,
      releaseReason: null,
    });
    const releasingCodec = createRuntimeBondLot({
      owner: accountId,
      program: { Argonot: null },
      bonds: 10,
      createdFrameId: 3,
      participatedFrames: 2,
      lastFrameEarningsFrameId: 4,
      lastFrameEarnings: 1_000_000n,
      cumulativeEarnings: 2_000_000n,
      releaseFrameId: 7,
      releaseReason: 'UserLiquidation',
    });
    const activeLot = BondLot.fromRuntime(7, activeCodec, accountId);
    await db.bondLotHistoryTable.recordObservation({
      lot: activeLot,
      blockNumber: 90,
      blockHash: '0x90',
    });

    const block = {
      blockNumber: 100,
      blockHash: '0x100',
      blockTime: new Date('2026-07-01T12:00:00Z').getTime(),
      isFinalized: true,
    };
    const blockWatch = {
      getHeader: vi.fn(async () => block),
      getApi: vi.fn(async () => ({
        query: {
          treasury: {
            bondLotById: vi.fn(async () => releasingCodec),
          },
        },
      })),
    };
    const argonBonds = new ArgonBonds(
      Promise.resolve(db),
      { isLoadedPromise: Promise.resolve(), upstreamOperator: undefined },
      new Currency({ events: { on: vi.fn() } } as any),
      { blockWatch } as any,
      { defaultArgonAddress: accountId } as any,
      {} as any,
    );
    vi.spyOn(argonBonds, 'refreshBondLots').mockResolvedValue();
    const postProcessor = createDeferred<void>(false);
    const info = {
      isPostProcessed: true,
      createPostProcessor: vi.fn(() => postProcessor),
      tx: { blockHeight: 100 },
      txResult: { waitForFinalizedBlock: Promise.resolve(new Uint8Array()), blockNumber: 100 },
    };

    argonBonds.saveBondLiquidation(activeLot, info as any);
    await postProcessor.promise;

    expect(info.createPostProcessor).toHaveBeenCalledOnce();
    const [record] = await db.bondLotHistoryTable.fetchAll(accountId);
    expect(record).toMatchObject({
      releaseFrame: 7,
      releaseReason: 'UserLiquidation',
      cumulativeEarningsMicrogons: 2_000_000n,
    });
  });

  it('repairs missing purchase provenance from finalized local transactions without blocking load', async () => {
    const db = await createTestDb();
    const vaultCodec = createRuntimeBondLot({
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
    const argonotCodec = createRuntimeBondLot({
      owner: accountId,
      program: { Argonot: null },
      bonds: 20,
      createdFrameId: 4,
      participatedFrames: 0,
      lastFrameEarningsFrameId: null,
      lastFrameEarnings: null,
      cumulativeEarnings: 0,
      releaseFrameId: null,
      releaseReason: null,
    });
    const bondLots = [BondLot.fromRuntime(7, vaultCodec, accountId), BondLot.fromRuntime(8, argonotCodec, accountId)];
    const finalizedBlock = {
      blockNumber: 100,
      blockHash: '0x100',
      blockTime: new Date('2026-07-01T12:00:00Z').getTime(),
      isFinalized: true,
    };
    for (const bondLot of bondLots) {
      await db.bondLotHistoryTable.recordObservation({
        lot: bondLot,
        blockNumber: finalizedBlock.blockNumber,
        blockHash: finalizedBlock.blockHash,
      });
    }

    const transactionLoad = createDeferred<void>(false);
    const transactionTracker = {
      data: {
        txInfos: bondLots.map((bondLot, index) => ({
          tx: {
            extrinsicType:
              bondLot.programType === 'Argonot'
                ? ExtrinsicType.TreasuryBuyArgonotBonds
                : ExtrinsicType.TreasuryBuyBonds,
            accountAddress: accountId,
            isFinalized: true,
            blockHeight: finalizedBlock.blockNumber,
            blockHash: finalizedBlock.blockHash,
            blockTime: new Date(finalizedBlock.blockTime),
            blockExtrinsicIndex: index + 1,
          },
          txResult: {
            events: [
              {
                section: 'treasury',
                method: 'BondLotPurchased',
                data: {
                  programId:
                    bondLot.programType === 'Argonot'
                      ? { type: 'Argonot' }
                      : { type: 'Vault', value: { vaultId: bondLot.vaultId } },
                  bondLotId: bondLot.id,
                  accountId,
                  bonds: bondLot.bonds,
                },
              },
            ],
          },
        })),
      },
      load: vi.fn(() => transactionLoad.promise),
      ensureStoredEvents: vi.fn(async () => undefined),
    };
    const blockWatch = {
      finalizedBlockHeader: finalizedBlock,
      start: vi.fn(async () => undefined),
      events: { on: vi.fn(() => () => undefined) },
      getHeader: vi.fn(async () => finalizedBlock),
      getApi: vi.fn(async () => ({
        query: {
          treasury: {
            bondLotById: vi.fn(async (bondLotId: number) => {
              return bondLotId === 7 ? vaultCodec : argonotCodec;
            }),
          },
        },
      })),
    };
    const getBondLots = vi.spyOn(TreasuryBonds, 'getBondLotsByAccount').mockResolvedValue(bondLots);
    const argonBonds = new ArgonBonds(
      Promise.resolve(db),
      { isLoadedPromise: Promise.resolve(), upstreamOperator: undefined },
      {
        isLoadedPromise: Promise.resolve(),
        fetchMainchainRatesAtBlock: vi.fn(async () => ({ ARGNOT: 2_000_000n })),
      } as any,
      { load: vi.fn(async () => undefined), blockWatch } as any,
      { defaultArgonAddress: accountId } as any,
      transactionTracker as any,
    );

    await expect(argonBonds.load()).resolves.toBeUndefined();
    await vi.waitFor(() => expect(transactionTracker.load).toHaveBeenCalledOnce());
    expect(argonBonds.data.bondHistory.every(record => !record.purchaseBlockHash)).toBe(true);

    transactionLoad.resolve();
    await vi.waitFor(() => {
      expect(argonBonds.data.bondHistory).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ bondLotId: 7, purchaseBlockHash: '0x100', purchaseExtrinsicIndex: 1 }),
          expect.objectContaining({
            bondLotId: 8,
            purchaseBlockHash: '0x100',
            purchaseExtrinsicIndex: 2,
            entryArgonotRateMicrogons: 2_000_000n,
          }),
        ]),
      );
    });
    getBondLots.mockRestore();
  });

  it('rejects bond positions when Treasury holds do not match their principal', async () => {
    const lot = createRuntimeBondLot({
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
    vi.spyOn(argonBonds, 'getOwnBondLots').mockResolvedValue(argonBonds.data.bondLots);
    const account = {
      address: accountId,
      wallet: { address: accountId } as WalletForArgon,
      availableMicrogons: 10_000_000n,
      reservedMicrogons: 0n,
      availableMicronots: 0n,
      reservedMicronots: 0n,
      microgonHolds: [
        {
          id: { type: 'Treasury' },
          amount: 9_000_000n,
        },
      ],
      micronotHolds: [],
    };

    await expect(
      new ArgonBondsFinancials(argonBonds).loadPositions({
        account: account as any,
        clientAt: {} as any,
        hasConfirmedBondHistoryCoverage: true,
      }),
    ).rejects.toThrow(`ARGN Treasury holds do not match live bond principal for ${accountId}`);
  });
});

function createRuntimeBondLot(value: unknown): NonNullable<TreasuryBondLotByIdResult> {
  return toPlain(registry.createType('PalletTreasuryBondLot', value)) as NonNullable<TreasuryBondLotByIdResult>;
}
