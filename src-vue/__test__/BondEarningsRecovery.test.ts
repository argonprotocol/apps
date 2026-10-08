import BigNumber from 'bignumber.js';
import { reactive, watch } from 'vue';
import { describe, expect, it, vi } from 'vitest';
import { getOfflineRegistry, type PalletTreasuryBondLot } from '@argonprotocol/mainchain';
import {
  BondLot,
  type IBlockHeaderInfo,
  type MiningFrames,
  type RuntimeSystemEventRecord,
} from '@argonprotocol/apps-core';
import { Metadata, TypeRegistry, type Option } from '@polkadot/types';
import { getBundledMetadata, runtimeClient } from '@argonprotocol/runtime-client';
import { ArgonBonds } from '../lib/ArgonBonds.ts';
import { ArgonBondsFinancials } from '../lib/financials/ArgonBonds.ts';
import { VaultFinancials } from '../lib/financials/MyVault.ts';
import { calculatePositionReturn } from '../lib/financials/index.ts';
import { VaultHistory } from '../lib/recovery/MyVault.ts';
import { createTestDb } from './helpers/db.ts';

const registry = getOfflineRegistry();
const owner = registry.createType('AccountId32', `0x${'22'.repeat(32)}`).toString();
const block: IBlockHeaderInfo = {
  blockNumber: 150,
  blockHash: '0x150',
  parentHash: '0x149',
  blockTime: Date.UTC(2026, 6, 1),
  isFinalized: true,
  tick: 150,
  frameId: 10,
  author: owner,
};
const backfill: RuntimeSystemEventRecord = {
  event: {
    section: 'treasury',
    method: 'BondLotEarningsBackfilled',
    data: { bondLotId: 7, addedFrames: 2, addedEarnings: 2_000_000n },
  },
  phase: { type: 'ApplyExtrinsic', value: 1 },
  topics: [],
};

function storedLot(earnings: bigint, releaseFrameId: number | null = null) {
  return registry.createType<Option<PalletTreasuryBondLot>>('Option<PalletTreasuryBondLot>', {
    owner,
    program: { Vault: { vaultId: 4, sharingPercent: 0, bonusPercent: 0 } },
    bonds: 10,
    createdFrameId: 3,
    participatedFrames: 3,
    cumulativeEarnings: earnings,
    lastFrameEarningsFrameId: 9,
    lastFrameEarnings: 1_000_000n,
    releaseFrameId,
    releaseReason: releaseFrameId === null ? null : 'UserLiquidation',
    isFlexible: true,
    lockedFrameTerms: null,
  });
}

describe('native bond earnings recovery', () => {
  it('publishes backfill attribution atomically, preserves newer metrics, and retries after restart without duplicating income', async () => {
    const db = await createTestDb();
    const deployed = new TypeRegistry();
    const metadata = Object.entries(getBundledMetadata()).find(([key]) => key.endsWith('-159'))![1];
    deployed.setMetadata(new Metadata(deployed, metadata));
    const deployedLot = deployed.createType('Option<PalletTreasuryBondLot>', {
      owner,
      program: { Vault: { vaultId: 4, sharingPercent: 0, bonusPercent: 0 } },
      bonds: 10,
      createdFrameId: 6,
      participatedFrames: 0,
      cumulativeEarnings: 0,
      lastFrameEarningsFrameId: null,
      lastFrameEarnings: null,
      isFlexible: true,
      releaseReason: null,
      releaseFrameId: null,
    });
    const deployedCapital = {
      vaults: {
        4: {
          regularBondAllocations: [],
          flexibleBondsEligible: 10,
          flexibleProrata: 500_000_000_000_000_000n,
          eligibleBonds: 10,
        },
      },
    };
    const candidateCapital = {
      totalActiveBonds: 10,
      targetSecuritization: 100_000_000n,
      totalSecuritization: 100_000_000n,
      vaultSecuritizationPositions: {},
    };
    const candidateLots = [0n, 1_000_000n, 3_000_000n, 4_000_000n].map((earnings, index) =>
      registry.createType<Option<PalletTreasuryBondLot>>('Option<PalletTreasuryBondLot>', {
        ...Object.fromEntries(storedLot(earnings).unwrap()),
        createdFrameId: 6,
        participatedFrames: index,
        lastFrameEarningsFrameId: [null, 8, 8, 9][index],
        lastFrameEarnings: index === 0 ? null : 1_000_000n,
      }),
    );
    // Frame 7 pays the vault on 159. The upgrade seeds frame 8 without paying;
    // 160 pays frames 8 and 9 to the owner, with a separate metrics backfill between them.
    const snapshots = new Map(
      [
        { height: 100, frameId: 7, lot: deployedLot, capital: deployedCapital },
        { height: 125, frameId: 8, lot: deployedLot, capital: deployedCapital },
        { height: 149, frameId: 8, lot: candidateLots[0], capital: candidateCapital },
        { height: 150, frameId: 9, lot: candidateLots[1], capital: candidateCapital },
        { height: 175, frameId: 9, lot: candidateLots[2], capital: candidateCapital },
        { height: 200, frameId: 10, lot: candidateLots[3], capital: candidateCapital },
      ].map(({ height, frameId, lot, capital }) => {
        const source = lot.registry;
        const api = runtimeClient({
          query: {
            treasury: {
              bondLotIdsByAccount: { keys: async () => [{ args: [owner, 7] }] },
              bondLotById: Object.assign(async () => lot, { multi: async () => [lot] }),
              currentFrameVaultCapital: async () =>
                source.createType('Option<PalletTreasuryFrameVaultCapital>', { ...capital, frameId }),
              currentFrameArgonotBondParticipants: async () =>
                source.createType('Option<PalletTreasuryFrameArgonotBondParticipants>', null),
              bondLotsByVault: async () =>
                source.createType('PalletTreasuryVaultBondState', {
                  regularBondLots: [],
                  regularBonds: 0,
                  flexibleBonds: 10,
                  displacedFlexibleBonds: 0,
                  reservedBondSpace: 0,
                  lockedFrameTerms: null,
                }),
            },
            vaults: {
              revenuePerFrameByVault: async () =>
                deployed.createType('Vec<PalletVaultsVaultFrameRevenue>', [
                  { frameId: 7, treasuryTotalEarnings: 4_000_000n, treasuryVaultEarnings: 2_000_000n },
                ]),
            },
          },
        });
        return [height, api] as const;
      }),
    );
    const events = new Map<number, RuntimeSystemEventRecord[]>(
      [125, 150, 200].map((height, index) => [
        height,
        [
          {
            event: {
              section: 'treasury',
              method: 'FrameEarningsDistributed',
              data: {
                frameId: index + 7,
                bidPoolDistributed: height === 125 ? 4_000_000n : 1_000_000n,
                treasuryReserves: 0n,
                participatingVaults: 1,
                ...(height === 125
                  ? {}
                  : {
                      argonBondPoolDistributed: 1_000_000n,
                      stakePoolDistributed: 0n,
                      vaultPoolDistributed: 0n,
                      burned: 0n,
                    }),
              },
            },
            phase: { type: 'Initialization' },
            topics: [],
          },
        ],
      ]),
    );
    const backfillBlock = { ...block, blockNumber: 175, blockHash: '0x175', frameId: 9 };
    const earningsBackfill: RuntimeSystemEventRecord = {
      ...backfill,
      event: {
        section: 'treasury',
        method: 'BondLotEarningsBackfilled',
        data: { bondLotId: 7, addedFrames: 1, addedEarnings: 2_000_000n },
      },
    };
    const current = snapshots.get(200)!;
    const chainWatch = {
      getHeader: async (height: number) => ({ ...block, blockNumber: height, blockHash: `0x${height}` }),
      getApi: async (header: IBlockHeaderInfo) => {
        const height = [...snapshots.keys()].filter(value => value <= header.blockNumber).at(-1)!;
        return snapshots.get(height)!;
      },
      getEvents: async (header: IBlockHeaderInfo) => events.get(header.blockNumber) ?? [],
      getCurrentApi: async () => current,
    };
    const miningFrames = {
      blockWatch: chainWatch,
      frames: [
        { frameId: 8, firstBlockNumber: 125, firstBlockSpecVersion: 159 },
        { frameId: 9, firstBlockNumber: 150, firstBlockSpecVersion: 160 },
        { frameId: 10, firstBlockNumber: 200, firstBlockSpecVersion: 160 },
      ],
      getFrameStart: async (frameId: number) => ({
        api: snapshots.get(
          new Map([
            [7, 100],
            [8, 125],
            [9, 150],
          ]).get(frameId)!,
        )!,
      }),
    } as unknown as MiningFrames;
    const createDomain = () => {
      const domain = new ArgonBonds(
        Promise.resolve(db),
        { isLoadedPromise: Promise.resolve(), upstreamOperator: undefined },
        { fetchMainchainRatesAtBlock: vi.fn() } as any,
        miningFrames,
        { defaultArgonAddress: owner } as any,
      );
      domain.data = reactive(domain.data) as ArgonBonds['data'];
      domain.data.currentFrameId = 10;
      return domain;
    };
    // 159 paid flexible yield to the vault without updating this lot's counters.
    const deployedSnapshot = (await BondLot.get(snapshots.get(125) as any, 7, owner))!;
    await db.bondLotHistoryTable.recordObservation({
      lot: deployedSnapshot,
      blockNumber: 125,
      blockHash: '0x125',
    });
    const imported = createDomain();
    imported.data.bondLots = [deployedSnapshot];
    await imported.refreshHistory();
    expect(imported.data.bondHistory[0]).toMatchObject({
      cumulativeEarningsMicrogons: 0n,
      participatedFrames: 0,
      flexibilityHistoryComplete: false,
    });
    expect(imported.getEarningsHistory(7).isComplete).toBe(false);

    const newerLot = (await BondLot.get(current as any, 7, owner))!;
    await db.bondLotHistoryTable.recordObservation({
      lot: newerLot,
      blockNumber: 200,
      blockHash: '0x200',
    });
    // The purchase frame was already scanned; missing daily history starts at frame 7.
    await db.bondLotHistoryTable.recordEarningsCoverage(owner, 6, 6);
    const domain = createDomain();
    domain.data.bondLots = [newerLot];
    domain.data.isLoaded = true;
    await domain.refreshHistory();
    let visiblePosition = new ArgonBondsFinancials(domain).createFinancialPositions({
      bondLots: domain.data.bondLots,
      historyRecords: domain.data.bondHistory,
      dailyEarnings: domain.data.dailyEarnings,
      completedFrame: 9,
      frameDates: new Map([[6, new Date(block.blockTime)]]),
    })[0];
    // Current Owner metrics do not prove that earlier vault-paid flexible income was recovered.
    expect(domain.data.bondHistory[0].earningsDestination).toBe('Owner');
    expect(domain.getEarningsHistory(7).isComplete).toBe(false);
    expect(visiblePosition).toMatchObject({ paidIncome: 4_000_000n, returnIsComplete: false });
    const stopObserver = watch(
      () => domain.data.financialRevision,
      () => {
        visiblePosition = new ArgonBondsFinancials(domain).createFinancialPositions({
          bondLots: domain.data.bondLots,
          historyRecords: domain.data.bondHistory,
          dailyEarnings: domain.data.dailyEarnings,
          completedFrame: 9,
          frameDates: new Map([[6, new Date(block.blockTime)]]),
        })[0];
      },
      { flush: 'sync' },
    );
    const visibleBefore = visiblePosition;
    const before = domain.data.bondHistory;
    const revision = domain.data.financialRevision;
    await domain.importHistoryBlock(backfillBlock, [earningsBackfill]);
    await domain.recoverDailyEarnings(200, 0);
    await db.execute(`
      CREATE TEMP TRIGGER FailBondBackfill
      BEFORE UPDATE OF earningsBackfills ON BondLotHistory
      WHEN NEW.earningsBackfills <> OLD.earningsBackfills
      BEGIN
        SELECT RAISE(ABORT, 'disk temporarily unavailable');
      END;
    `);
    await expect(domain.publishRecoveredHistory()).rejects.toThrow('disk temporarily unavailable');
    expect(domain.data.bondHistory).toBe(before);
    expect(visiblePosition).toEqual(visibleBefore);
    expect(domain.data.bondLots).toEqual([newerLot]);
    expect(domain.data.dailyEarnings).toEqual([]);
    expect(await db.bondEarningsTable.fetchAll(owner)).toEqual([]);
    expect(domain.data.bondHistory[0].earningsHistoryThroughFrame).toBe(6);
    expect((await db.bondLotHistoryTable.fetchAll(owner))[0].earningsBackfills).toEqual([]);
    await db.execute('DROP TRIGGER FailBondBackfill');
    await domain.publishRecoveredHistory();
    expect(domain.data.financialRevision).toBeGreaterThan(revision);
    expect(visiblePosition).toMatchObject({
      currentValue: 10_000_000n,
      paidIncome: 4_000_000n,
      returnIsComplete: true,
    });
    stopObserver();
    expect(domain.data.bondHistory[0]).toMatchObject({
      cumulativeEarningsMicrogons: 4_000_000n,
      lastObservedBlockNumber: 200,
      earningsBackfills: [{ addedEarnings: 2_000_000n }],
    });
    expect(domain.data.dailyEarnings).toEqual([
      expect.objectContaining({ frameId: 7, earningsMicrogons: 2_000_000n, earningsDestination: 'Vault' }),
      expect.objectContaining({ frameId: 8, earningsMicrogons: 1_000_000n, earningsDestination: 'Owner' }),
      expect.objectContaining({ frameId: 9, earningsMicrogons: 1_000_000n, earningsDestination: 'Owner' }),
    ]);
    expect(domain.getEarningsHistory(7)).toMatchObject({
      lifetimeEarnings: 4_000_000n,
      vaultEarnings: 2_000_000n,
      isComplete: true,
    });
    const restarted = createDomain();
    restarted.data.bondLots = [newerLot];
    restarted.data.isLoaded = true;
    await restarted.refreshHistory();
    await restarted.importHistoryBlock(backfillBlock, [earningsBackfill]);
    await restarted.recoverDailyEarnings(200, 0);
    await restarted.publishRecoveredHistory();
    const [position] = new ArgonBondsFinancials(restarted).createFinancialPositions({
      bondLots: restarted.data.bondLots,
      historyRecords: restarted.data.bondHistory,
      dailyEarnings: restarted.data.dailyEarnings,
      completedFrame: 9,
      frameDates: new Map([[6, new Date(block.blockTime)]]),
    });
    expect(restarted.data.bondHistory[0].earningsBackfills).toHaveLength(1);
    expect(restarted.data.dailyEarnings).toEqual(domain.data.dailyEarnings);
    expect(position).toMatchObject({ currentValue: 10_000_000n, paidIncome: 4_000_000n, returnIsComplete: true });
  });

  it.each([false, true])(
    'retains metrics and attribution for a deleted lot, with same-block payout = %s',
    async payout => {
      const db = await createTestDb();
      const parent = runtimeClient({ query: { treasury: { bondLotById: async () => storedLot(1_000_000n) } } });
      const current = runtimeClient({
        query: {
          treasury: {
            bondLotById: async () =>
              registry.createType<Option<PalletTreasuryBondLot>>('Option<PalletTreasuryBondLot>', null),
          },
        },
      });
      const domain = new ArgonBonds(
        Promise.resolve(db),
        { isLoadedPromise: Promise.resolve(), upstreamOperator: undefined },
        { fetchMainchainRatesAtBlock: vi.fn() } as any,
        {
          blockWatch: {
            getHeader: async () => ({ ...block, blockNumber: 149, blockHash: '0x149' }),
            getParentHeader: async () => ({ ...block, blockNumber: 149, blockHash: '0x149' }),
            getApi: async (header: IBlockHeaderInfo) => (header.blockNumber === 149 ? parent : current),
          },
        } as unknown as MiningFrames,
        { defaultArgonAddress: owner } as any,
      );
      const events: RuntimeSystemEventRecord[] = [
        backfill,
        {
          ...backfill,
          event: {
            section: 'treasury',
            method: 'BondLotEarningsBackfilled',
            data: { bondLotId: 7, addedFrames: 1, addedEarnings: 500_000n },
          },
        },
        {
          event: {
            section: 'treasury',
            method: 'BondLotReleased',
            data: {
              frameId: 10,
              programId: { type: 'Vault', value: { vaultId: 4 } },
              accountId: owner,
              bondLotId: 7,
              bonds: 10,
            },
          },
          phase: { type: 'ApplyExtrinsic', value: 2 },
          topics: [],
        },
      ];
      if (payout)
        events.unshift({
          event: {
            section: 'treasury',
            method: 'FrameEarningsDistributed',
            data: {
              frameId: 9,
              bidPoolDistributed: 0n,
              stakePoolDistributed: 0n,
              argonBondPoolDistributed: 0n,
              vaultPoolDistributed: 0n,
              burned: 0n,
              treasuryReserves: 0n,
              participatingVaults: 0,
            },
          },
          phase: { type: 'Initialization' },
          topics: [],
        });
      await domain.importHistoryBlock(block, events);
      await domain.publishRecoveredHistory();
      expect(domain.data.bondHistory[0]).toMatchObject({
        releaseBlockNumber: 150,
        cumulativeEarningsMicrogons: 3_500_000n,
        earningsComplete: !payout,
        earningsBackfills: [{ addedEarnings: 2_000_000n }, { addedEarnings: 500_000n }],
      });
      const [position] = new ArgonBondsFinancials(domain).createFinancialPositions({
        historyRecords: domain.data.bondHistory,
        frameDates: new Map([[3, new Date(block.blockTime)]]),
      });
      expect(position).toMatchObject({ lifecycle: 'completed', paidIncome: 3_500_000n, returnIsComplete: false });
    },
  );

  it('persists native earnings attribution when a release schedule is the first observed history', async () => {
    const db = await createTestDb();
    const client = runtimeClient({ query: { treasury: { bondLotById: async () => storedLot(1_000_000n, 12) } } });
    const domain = new ArgonBonds(
      Promise.resolve(db),
      { isLoadedPromise: Promise.resolve(), upstreamOperator: undefined },
      { fetchMainchainRatesAtBlock: vi.fn() } as any,
      { blockWatch: { getApi: async () => client } } as unknown as MiningFrames,
      { defaultArgonAddress: owner } as any,
    );
    await domain.importHistoryBlock(block, [
      {
        event: {
          section: 'treasury',
          method: 'BondLotReleaseScheduled',
          data: {
            programId: { type: 'Vault', value: { vaultId: 4 } },
            accountId: owner,
            bondLotId: 7,
            bonds: 10,
            releaseFrameId: 12,
            reason: { type: 'UserLiquidation' },
          },
        },
        phase: { type: 'ApplyExtrinsic', value: 1 },
        topics: [],
      },
    ]);
    await domain.publishRecoveredHistory();
    expect((await db.bondLotHistoryTable.fetchAll(owner))[0]).toMatchObject({
      earningsDestination: 'Owner',
      cumulativeEarningsMicrogons: 1_000_000n,
      lastObservedBlockNumber: 150,
      releaseFrame: 12,
      releaseReason: 'UserLiquidation',
    });
  });
});

it('keeps frozen displacement, zero payouts and missing payouts distinct across finalized ingestion, recovery and restart', async () => {
  const db = await createTestDb();
  const { SyncStateKeys } = await import('../lib/db/SyncStateTable.ts');
  const parent = { ...block, blockNumber: 149, blockHash: '0x149', frameId: 9 };
  const payoutEvent = {
    event: {
      section: 'treasury',
      method: 'FrameEarningsDistributed',
      data: {
        frameId: 9,
        bidPoolDistributed: 1_000_000n,
        stakePoolDistributed: 0n,
        argonBondPoolDistributed: 1_000_000n,
        vaultPoolDistributed: 0n,
        burned: 0n,
        treasuryReserves: 0n,
        participatingVaults: 1,
      },
    },
    phase: { type: 'Initialization' },
    topics: [],
  } satisfies RuntimeSystemEventRecord;
  const flexible = registry.createType<Option<PalletTreasuryBondLot>>('Option<PalletTreasuryBondLot>', {
    ...Object.fromEntries(storedLot(4_000_000n).unwrap()),
    lastFrameEarningsFrameId: 8,
    lockedFrameTerms: { bonds: 1, isFlexible: true },
  });
  const deleted = registry.createType<Option<PalletTreasuryBondLot>>('Option<PalletTreasuryBondLot>', {
    ...Object.fromEntries(storedLot(2_000_000n).unwrap()),
    bonds: 2,
    isFlexible: false,
    releaseFrameId: 10,
    releaseReason: 'UserLiquidation',
    lockedFrameTerms: { bonds: 2, isFlexible: false },
  });
  const stake = registry.createType<Option<PalletTreasuryBondLot>>('Option<PalletTreasuryBondLot>', {
    ...Object.fromEntries(storedLot(0n).unwrap()),
    program: { Argonot: null },
    bonds: 6,
    isFlexible: false,
    lastFrameEarningsFrameId: 8,
    lastFrameEarnings: 0n,
  });
  const paidStake = registry.createType<Option<PalletTreasuryBondLot>>('Option<PalletTreasuryBondLot>', {
    ...Object.fromEntries(stake.unwrap()),
    lastFrameEarningsFrameId: 9,
    participatedFrames: 1,
  });
  const snapshot = (lots: Map<number, ReturnType<typeof storedLot>>, earningFrame: number) =>
    runtimeClient({
      query: {
        treasury: {
          bondLotIdsByAccount: { keys: async () => [...lots.keys()].map(id => ({ args: [owner, id] })) },
          bondLotById: Object.assign(
            async (id: number) =>
              lots.get(id) ?? registry.createType<Option<PalletTreasuryBondLot>>('Option<PalletTreasuryBondLot>', null),
            {
              multi: async (ids: number[]) =>
                ids.map(
                  id =>
                    lots.get(id) ??
                    registry.createType<Option<PalletTreasuryBondLot>>('Option<PalletTreasuryBondLot>', null),
                ),
            },
          ),
          currentFrameVaultCapital: async () =>
            registry.createType('Option<PalletTreasuryFrameVaultCapital>', {
              frameId: earningFrame,
              totalActiveBonds: 4,
              targetSecuritization: 100_000_000n,
              totalSecuritization: 100_000_000n,
              vaultSecuritizationPositions: {},
            }),
          currentFrameArgonotBondParticipants: async () =>
            registry.createType('Option<PalletTreasuryFrameArgonotBondParticipants>', {
              frameId: earningFrame,
              totalBonds: 2,
              bondLots: [{ bondLotId: 9, bonds: 2 }],
            }),
          bondLotsByVault: async () =>
            registry.createType('PalletTreasuryVaultBondState', {
              regularBonds: 100,
              flexibleBonds: 100,
              displacedFlexibleBonds: 0,
              reservedBondSpace: 0,
              lockedFrameTerms: { flexibleBonds: 3, displacedFlexibleBonds: 1 },
            }),
        },
      },
    });
  const before = snapshot(
    new Map([
      [7, flexible],
      [8, deleted],
      [9, stake],
    ]),
    9,
  );
  const paid = snapshot(
    new Map([
      [7, storedLot(5_000_000n)],
      [9, paidStake],
    ]),
    10,
  );
  const newer = snapshot(
    new Map([
      [7, storedLot(9_000_000n)],
      [9, paidStake],
    ]),
    11,
  );
  const blockWatch = {
    bestBlockHeader: parent,
    finalizedBlockHeader: parent,
    start: async () => undefined,
    events: { on: () => () => undefined },
    getHeader: async (height: number) => (height === 149 ? parent : block),
    getEvents: async (_header: IBlockHeaderInfo) => [payoutEvent],
    getApi: async (header: IBlockHeaderInfo) => (header.blockNumber === 150 ? paid : before),
    getCurrentApi: async () => newer,
  };
  const miningFrames = {
    blockWatch,
    load: async () => undefined,
    frames: [
      { frameId: 10, firstBlockNumber: 150, firstBlockSpecVersion: 160 },
      { frameId: 11, firstBlockNumber: 151, firstBlockSpecVersion: 160 },
    ],
    getFrameStart: async (frameId: number) => ({ api: frameId === 10 ? paid : before }),
  } as unknown as MiningFrames;
  const createDomain = () => {
    const domain = new ArgonBonds(
      Promise.resolve(db),
      { isLoadedPromise: Promise.resolve(), upstreamOperator: undefined },
      { isLoadedPromise: Promise.resolve(), fetchMainchainRatesAtBlock: vi.fn() } as any,
      miningFrames,
      { defaultArgonAddress: owner } as any,
    );
    domain.data = reactive(domain.data) as ArgonBonds['data'];
    return domain;
  };
  await db.syncStateTable.upsert(SyncStateKeys.BondHistory, { accountId: owner, blockNumber: 149, blockHash: '0x149' });
  await db.bondLotHistoryTable.recordObservation({
    lot: (await BondLot.get(newer as any, 7))!,
    blockNumber: 200,
    blockHash: '0x200',
  });
  await db.bondEarningsTable.upsert({
    accountId: owner,
    programType: 'Vault',
    bondLotId: 7,
    frameId: 8,
    bonds: 10,
    isFlexible: true,
    displacedMicrogons: 0n,
    earningsMicrogons: 3_000_000n,
    earningsDestination: 'Owner',
    payoutBlockNumber: 100,
    payoutBlockHash: '0x100',
  });
  const previousRows = await db.bondEarningsTable.fetchAll(owner);
  const domain = createDomain();
  await domain.load();
  let visible = domain.data.dailyEarnings;
  let visibleStakeHistory = domain.getEarningsHistory(9);
  const stop = watch(
    () => domain.data.financialRevision,
    () => {
      visible = domain.data.dailyEarnings;
      visibleStakeHistory = domain.getEarningsHistory(9);
    },
    { flush: 'sync' },
  );
  await db.execute(`CREATE TEMP TRIGGER FailDailyEarnings BEFORE INSERT ON BondEarnings
    BEGIN SELECT RAISE(ABORT, 'disk temporarily unavailable'); END`);
  blockWatch.finalizedBlockHeader = { ...block, frameId: 10 };
  await expect(domain.recordFinalizedTransaction(150)).rejects.toThrow('disk temporarily unavailable');
  expect(visible).toEqual(previousRows);
  expect(await db.bondEarningsTable.fetchAll(owner)).toEqual(previousRows);
  expect((await db.syncStateTable.get(SyncStateKeys.BondHistory))?.blockNumber).toBe(149);
  expect(domain.data.bondHistory.find(x => x.bondLotId === 7)?.cumulativeEarningsMicrogons).toBe(9_000_000n);
  await db.execute('DROP TRIGGER FailDailyEarnings');
  await domain.retryHistory();
  expect(visible).toEqual([
    previousRows[0],
    expect.objectContaining({
      bondLotId: 7,
      frameId: 9,
      bonds: 1,
      displacedMicrogons: 333_334n,
      earningsMicrogons: 1_000_000n,
    }),
    expect.objectContaining({ bondLotId: 8, bonds: 2, displacedMicrogons: 0n }),
    expect.objectContaining({ bondLotId: 9, bonds: 2, displacedMicrogons: 0n, earningsMicrogons: 0n }),
  ]);
  expect(visible.find(x => x.bondLotId === 8)?.earningsMicrogons == null).toBe(true);
  expect((await db.syncStateTable.get(SyncStateKeys.BondHistory))?.blockNumber).toBe(150);
  expect(domain.data.historyError).toBeUndefined();
  expect(domain.getEarningsHistory(7)).toMatchObject({ lifetimeEarnings: 9_000_000n, isComplete: false });
  expect(domain.getEarningsHistory(9)).toMatchObject({ lifetimeEarnings: 0n, isComplete: true });

  // Best-head counters can advance before this payout enters finalized daily history.
  const nextStake = registry.createType<Option<PalletTreasuryBondLot>>('Option<PalletTreasuryBondLot>', {
    ...Object.fromEntries(paidStake.unwrap()),
    participatedFrames: 2,
    cumulativeEarnings: 1_000_000n,
    lastFrameEarningsFrameId: 10,
    lastFrameEarnings: 1_000_000n,
  });
  const live = snapshot(
    new Map([
      [7, storedLot(9_000_000n)],
      [9, nextStake],
    ]),
    11,
  );
  domain.data.currentFrameId = 11;
  await domain.refreshBondLots(live as any);
  expect(visibleStakeHistory).toMatchObject({ lifetimeEarnings: 0n, isComplete: true });
  expect(visible.filter(record => record.bondLotId === 9)).toHaveLength(1);
  const positions = new ArgonBondsFinancials(domain).createFinancialPositions({
    bondLots: domain.data.bondLots,
    historyRecords: domain.data.bondHistory,
    dailyEarnings: domain.data.dailyEarnings,
    completedFrame: 10,
    frameDates: new Map([[3, new Date(block.blockTime)]]),
  });
  expect(positions.find(position => position.bondLot?.id === 9)?.paidIncome).toBe(1_000_000n);

  const nextBlock = { ...block, blockNumber: 151, blockHash: '0x151', parentHash: '0x150', frameId: 11 };
  const nextPayout = {
    ...payoutEvent,
    event: {
      ...payoutEvent.event,
      data: {
        ...payoutEvent.event.data,
        frameId: 10,
        stakePoolDistributed: 1_000_000n,
        bidPoolDistributed: 2_000_000n,
      },
    },
  } satisfies RuntimeSystemEventRecord;
  blockWatch.getHeader = async height => {
    if (height === 149) return parent;
    return height === 151 ? nextBlock : block;
  };
  blockWatch.getEvents = async header => [header.blockNumber === 151 ? nextPayout : payoutEvent];
  blockWatch.getApi = async header => {
    if (header.blockNumber === 151) return live;
    return header.blockNumber === 150 ? paid : before;
  };
  blockWatch.getCurrentApi = async () => live;
  blockWatch.finalizedBlockHeader = nextBlock;
  await domain.recordFinalizedTransaction(151);
  expect(visibleStakeHistory).toMatchObject({ lifetimeEarnings: 1_000_000n, isComplete: true });
  expect(visible.filter(record => record.bondLotId === 9)).toEqual([
    expect.objectContaining({ frameId: 9, earningsMicrogons: 0n }),
    expect.objectContaining({ frameId: 10, earningsMicrogons: 1_000_000n }),
  ]);
  stop();
  const durable = await db.bondEarningsTable.fetchAll(owner);
  const restarted = createDomain();
  await restarted.load();
  restarted.beginHistoryReplay();
  await restarted.recoverDailyEarnings(151, 0);
  await restarted.publishRecoveredHistory();
  expect(restarted.data.dailyEarnings).toEqual(durable);
  expect(restarted.data.bondHistory.find(x => x.bondLotId === 7)?.cumulativeEarningsMicrogons).toBe(9_000_000n);
});

it('recovers the actual deployed-runtime flexible payout, including dust and lots deleted before recovery', async () => {
  const deployed = new TypeRegistry();
  const metadata = Object.entries(getBundledMetadata()).find(([key]) => key.endsWith('-159'))![1];
  deployed.setMetadata(new Metadata(deployed, metadata));
  const lots = new Map(
    [7, 8].map(id => [
      id,
      deployed.createType('Option<PalletTreasuryBondLot>', {
        owner,
        program: { Vault: { vaultId: 4, sharingPercent: 0, bonusPercent: 0 } },
        bonds: id - 6,
        createdFrameId: 3,
        participatedFrames: 0,
        cumulativeEarnings: 0,
        lastFrameEarningsFrameId: null,
        lastFrameEarnings: null,
        isFlexible: true,
        releaseReason: null,
        releaseFrameId: null,
      }),
    ]),
  );
  const frameCapital = deployed.createType('Option<PalletTreasuryFrameVaultCapital>', {
    frameId: 9,
    vaults: {
      4: {
        regularBondAllocations: [],
        flexibleBondsEligible: 2,
        flexibleProrata: 500_000_000_000_000_000n,
        eligibleBonds: 2,
      },
    },
  });
  const api = (hasLots: boolean) =>
    runtimeClient({
      query: {
        treasury: {
          bondLotIdsByAccount: {
            keys: async () => (hasLots ? [...lots.keys()].map(id => ({ args: [owner, id] })) : []),
          },
          bondLotById: Object.assign(async (id: number) => lots.get(id), {
            multi: async (ids: number[]) => ids.map(id => lots.get(id)),
          }),
          currentFrameVaultCapital: async () => frameCapital,
          currentFrameArgonotBondParticipants: async () =>
            deployed.createType('Option<PalletTreasuryFrameArgonotBondParticipants>', null),
          bondLotsByVault: async () =>
            deployed.createType('PalletTreasuryVaultBondState', {
              regularBondLots: [],
              flexibleBonds: 3,
              reservedBondSpace: 0,
            }),
        },
        vaults: {
          revenuePerFrameByVault: async () =>
            deployed.createType('Vec<PalletVaultsVaultFrameRevenue>', [
              { frameId: 9, treasuryTotalEarnings: 11n, treasuryVaultEarnings: 5n },
            ]),
        },
      },
    });
  const start = api(true);
  const payout = api(false);
  const db = await createTestDb();
  const events: RuntimeSystemEventRecord[] = [
    {
      event: {
        section: 'treasury',
        method: 'FrameEarningsDistributed',
        data: {
          frameId: 9,
          bidPoolDistributed: 11n,
          treasuryReserves: 0n,
          participatingVaults: 1,
        },
      },
      phase: { type: 'Initialization' },
      topics: [],
    },
  ];
  const domain = new ArgonBonds(
    Promise.resolve(db),
    { isLoadedPromise: Promise.resolve(), upstreamOperator: undefined },
    { fetchMainchainRatesAtBlock: vi.fn() } as any,
    {
      frames: Array.from({ length: 8 }, (_, i) => ({
        frameId: i + 3,
        firstBlockNumber: 101 + i * 7,
        firstBlockSpecVersion: 159,
      })),
      getFrameStart: async () => ({ api: start }),
      blockWatch: {
        getHeader: async (height: number) => ({ ...block, blockNumber: height }),
        getApi: async (header: IBlockHeaderInfo) => (header.blockNumber === 150 ? payout : start),
        getEvents: async () => events,
      },
    } as unknown as MiningFrames,
    { defaultArgonAddress: owner } as any,
  );
  // Both lots have already left current storage; lifecycle recovery supplies their historical identity.
  for (const id of lots.keys()) {
    await domain.importHistoryBlock({ ...block, blockNumber: 100 }, [
      {
        event: {
          section: 'treasury',
          method: 'BondLotPurchased',
          data: { programId: { type: 'Vault', value: { vaultId: 4 } }, accountId: owner, bondLotId: id, bonds: id - 6 },
        },
        phase: { type: 'ApplyExtrinsic', value: 1 },
        topics: [],
      },
    ]);
  }
  await domain.recoverDailyEarnings(150, 0);
  await domain.publishRecoveredHistory();
  expect(domain.data.dailyEarnings).toEqual([
    expect.objectContaining({
      bondLotId: 7,
      earningsMicrogons: 2n,
      earningsDestination: 'Vault',
      bonds: 1,
      displacedMicrogons: 333_334n,
    }),
    expect.objectContaining({
      bondLotId: 8,
      earningsMicrogons: 3n,
      earningsDestination: 'Vault',
      bonds: 2,
      displacedMicrogons: 666_667n,
    }),
  ]);
  // Recovery must retain attribution after both lots have left current storage.
  for (const id of lots.keys()) {
    await domain.importHistoryBlock(
      { ...block, blockNumber: 151, blockHash: '0x151', blockTime: block.blockTime + 86_400_000 },
      [
        {
          event: {
            section: 'treasury',
            method: 'BondLotReleased',
            data: {
              frameId: 10,
              programId: { type: 'Vault', value: { vaultId: 4 } },
              accountId: owner,
              bondLotId: id,
              bonds: id - 6,
            },
          },
          phase: { type: 'ApplyExtrinsic', value: 1 },
          topics: [],
        },
      ],
    );
  }
  await domain.publishRecoveredHistory();
  domain.data.isLoaded = true;
  domain.data.currentFrameId = 10;
  const bondPositions = new ArgonBondsFinancials(domain).createFinancialPositions({
    historyRecords: domain.data.bondHistory,
    dailyEarnings: domain.data.dailyEarnings,
    frameDates: new Map([[3, new Date(block.blockTime)]]),
  });
  expect(bondPositions).toEqual([
    expect.objectContaining({
      lifecycle: 'completed',
      currentValue: 0n,
      paidIncome: 2n,
      settledPrincipalValue: 1_000_000n,
    }),
    expect.objectContaining({
      lifecycle: 'completed',
      currentValue: 0n,
      paidIncome: 3n,
      settledPrincipalValue: 2_000_000n,
    }),
  ]);
  const vaultHistory = new VaultHistory(Promise.resolve(db), owner);
  await vaultHistory.importBlock(
    { ...block, blockNumber: 90, blockHash: '0x90' },
    [
      {
        event: {
          section: 'vaults',
          method: 'VaultCreated',
          data: {
            vaultId: 4,
            operatorAccountId: owner,
            securitization: 100_000_000n,
            securitizationRatio: new BigNumber(1),
          },
        },
        phase: { type: 'ApplyExtrinsic', value: 1 },
        topics: [],
      },
    ],
    159,
  );
  const burnEvents: RuntimeSystemEventRecord[] = [9, 10].map(frameId => ({
    event: { section: 'vaults', method: 'VaultRevenueUncollected', data: { vaultId: 4, frameId, amount: 5n } },
    phase: { type: 'Initialization' },
    topics: [],
  }));
  const expired = { ...block, blockNumber: 160, blockHash: '0x160' };
  for (let height = 150; height <= 160; height += 1) {
    await vaultHistory.recordFinalizedRevenue(
      { ...block, blockNumber: height },
      height === 160 ? burnEvents : [],
      4,
      159,
    );
  }
  await vaultHistory.importBlock(expired, burnEvents, 159);
  await vaultHistory.recordFinalizedRevenue(
    { ...block, blockNumber: 161, blockHash: '0x161' },
    [
      {
        event: { section: 'vaults', method: 'VaultCollected', data: { vaultId: 4, revenue: 6n } },
        phase: { type: 'ApplyExtrinsic', value: 1 },
        topics: [],
      },
    ],
    4,
    159,
  );
  const restartedHistory = new VaultHistory(Promise.resolve(db), owner);
  const recovered = await restartedHistory.loadPositionHistory();
  expect(recovered.revenue.map(({ source, frameId, amount }) => ({ source, frameId, amount }))).toEqual([
    { source: 'vaultBurn', frameId: 9, amount: 5n },
    { source: 'vaultBurn', frameId: 10, amount: 5n },
    { source: 'vaultCollect', frameId: undefined, amount: 6n },
  ]);
  const vaultSource = new VaultFinancials({ vaults: { operatorNamesByVaultId: {} } } as any, domain.data);
  const [vaultPosition] = vaultSource.createFinancialPositions({
    liveVault: { vaultId: 4, securitization: 100_000_000n, isClosed: false } as any,
    account: {
      microgonHolds: [{ id: { type: 'Vaults', value: { type: 'EnterVault' } }, amount: 100_000_000n }],
      micronotHolds: [],
    } as any,
    capitalHistory: recovered.capital,
    revenueHistory: recovered.revenue,
    revenueCoverage: recovered.revenueCoverage,
  });
  // The vault missed collection, so the lost bond income offsets its own six
  // microgons of collected income. Custody and total account profit stay exact.
  expect(vaultPosition).toMatchObject({
    currentValue: 100_000_000n,
    investedCost: 100_000_000n,
    paidIncome: 6n,
    performanceEndingCapital: 100_000_001n,
  });
  expect(calculatePositionReturn([...bondPositions, vaultPosition]).returnAmount).toBe(6n);
});
