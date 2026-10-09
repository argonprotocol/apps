import { type FrameSystemEventRecord, getOfflineRegistry } from '@argonprotocol/mainchain';
import {
  toPlain,
  getBundledMetadata,
  type HistoricalQueryRecord,
  type LiveQueryRecord,
} from '@argonprotocol/runtime-client';
import { Metadata, TypeRegistry } from '@polkadot/types';
import { describe, expect, it, vi } from 'vitest';
import BigNumber from 'bignumber.js';
import { ArgonBonds } from '../lib/ArgonBonds.ts';
import { BondBuy } from '../lib/txs/Bond.buy.ts';
import { ArgonBondsFinancials } from '../lib/financials/ArgonBonds.ts';
import { calculatePositionReturn } from '../lib/financials/index.ts';
import { createTestDb, createTestDbAtMigration } from './helpers/db.ts';
import {
  BondLot,
  createDeferred,
  Currency,
  type IBlockHeaderInfo,
  type MiningFrames,
  type RuntimeSystemEventRecord,
  MICROGONS_PER_ARGON,
  TreasuryBonds,
  Vault,
} from '@argonprotocol/apps-core';
import type { WalletForArgon } from '../lib/WalletForArgon.ts';
import { encodeAddress } from '@polkadot/util-crypto';
import { numberCodec } from '../../core/__test__/helpers/codecs.ts';
import { TransactionStatus } from '../lib/db/TransactionsTable.ts';
import { SyncStateKeys } from '../lib/db/SyncStateTable.ts';
import { createScenarioVault } from '../../.storybook/scenarios/createScenarioVault.ts';
import { createPinia, setActivePinia } from 'pinia';
import { reactive } from 'vue';
import { Currency as AppCurrency } from '../lib/Currency.ts';
import * as vaultStore from '../stores/vaults.ts';
import * as bondStore from '../stores/argonBonds.ts';
import * as currencyStore from '../stores/currency.ts';
import { allocateBitcoinVaultSpace, useVaultingAssetBreakdown } from '../stores/vaultingAssetBreakdown.ts';

const registry = getOfflineRegistry();
const deployedRegistry = new TypeRegistry();
deployedRegistry.setMetadata(
  new Metadata(deployedRegistry, Object.entries(getBundledMetadata()).find(([key]) => key.endsWith('-159'))![1]),
);
const accountId = encodeAddress(new Uint8Array(32).fill(0x22));

describe('ArgonBonds', () => {
  it('compares current Bitcoin backing at market prices and updates after funding', () => {
    setActivePinia(createPinia());
    const oneArgon = BigInt(MICROGONS_PER_ARGON);
    const vault = reactive(
      createScenarioVault({
        totalSatoshis: 100_000_000n,
        securitization: 100n * oneArgon,
        securitizationTarget: 100n * oneArgon,
        securitizationLocked: 25n * oneArgon,
      }),
    );
    const currency = reactive(new AppCurrency({ events: { on: vi.fn() } } as any, {} as any));
    currency.priceIndex.btcUsdPrice = BigNumber(104);
    currency.priceIndex.argonUsdPrice = BigNumber(1.05);
    currency.priceIndex.argonUsdTargetPrice = BigNumber(1);
    currency.microgonsPer = { ...currency.microgonsPer, BTC: 104n * oneArgon };
    const vaultAccessor = vi
      .spyOn(vaultStore, 'getMyVault')
      .mockReturnValue(reactive({ createdVault: vault }) as ReturnType<typeof vaultStore.getMyVault>);
    const bondAccessor = vi.spyOn(bondStore, 'getArgonBonds').mockReturnValue({} as ArgonBonds);
    const currencyAccessor = vi.spyOn(currencyStore, 'getCurrency').mockReturnValue(currency as AppCurrency);

    try {
      const breakdown = useVaultingAssetBreakdown();
      // Target-price display conversion is 104 ARGN; actual Bitcoin backing is below 100 ARGN.
      expect(breakdown.bitcoinLockedValueMicrogons).toBe(104n * oneArgon);
      expect(breakdown.bitcoinUndersecuritized).toBe(false);
      expect(breakdown.bitcoinRequiredSecuritizationMicrogons).toBe(99_047_619n);
      expect(breakdown.bitcoinFundingShortfallMicrogons).toBe(0n);

      currency.priceIndex.argonUsdPrice = BigNumber(1);
      expect(breakdown.bitcoinUndersecuritized).toBe(true);
      expect(breakdown.bitcoinFundingShortfallMicrogons).toBe(4n * oneArgon);
      vault.securitization = 104n * oneArgon;
      vault.securitizationTarget = 104n * oneArgon;
      expect(breakdown.bitcoinUndersecuritized).toBe(false);
      expect(breakdown.bitcoinFundingShortfallMicrogons).toBe(0n);

      currency.priceIndex.btcUsdPrice = BigNumber(105.039999);
      expect(breakdown.bitcoinUndersecuritized).toBe(false);
      currency.priceIndex.btcUsdPrice = BigNumber(105.04);
      expect(breakdown.bitcoinUndersecuritized).toBe(true);

      vault.totalSatoshis = 0n;
      expect(breakdown.bitcoinRequiredSecuritizationMicrogons).toBe(0n);
      expect(breakdown.bitcoinUndersecuritized).toBe(false);
      currency.priceIndex.argonUsdPrice = BigNumber(0);
      expect(breakdown.bitcoinRequiredSecuritizationMicrogons).toBeUndefined();
      expect(breakdown.bitcoinUndersecuritized).toBe(false);
    } finally {
      useVaultingAssetBreakdown().$dispose();
      vaultAccessor.mockRestore();
      bondAccessor.mockRestore();
      currencyAccessor.mockRestore();
    }
  });

  it('keeps liquids and fills the remaining Bitcoin chart space with the largest locks first', () => {
    const currency = new Currency({ events: { on: vi.fn() } } as any);
    currency.priceIndex.btcUsdPrice = BigNumber(1_000);
    currency.priceIndex.argonUsdPrice = BigNumber(1);
    const oneArgon = BigInt(MICROGONS_PER_ARGON);
    const liquid = {
      fundedSatoshis: 25_000_000n,
      fissionedSatoshis: 25_000_000n,
      securitizationCoverageMicrogons: 50n * oneArgon,
      securitizationRatio: 2,
    };
    const lock = { lockId: 5, fundedSatoshis: 100_000_000n, fissionedSatoshis: 0n };
    const otherLock = { lockId: 3, fundedSatoshis: 50_000_000n, fissionedSatoshis: 0n };
    const locks = [otherLock, liquid, lock];

    const allocations = allocateBitcoinVaultSpace(locks, 875n * oneArgon, currency.priceIndex);
    expect(allocations.get(liquid)).toEqual({
      allocatedMicrogons: 100n * oneArgon,
      requiredMicrogons: 100n * oneArgon,
    });
    expect(allocations.get(lock)).toEqual({
      allocatedMicrogons: 775n * oneArgon,
      requiredMicrogons: 1_000n * oneArgon,
    });
    expect(allocations.get(otherLock)).toEqual({
      allocatedMicrogons: 0n,
      requiredMicrogons: 500n * oneArgon,
    });
    expect([...allocations.values()].reduce((sum, { allocatedMicrogons }) => sum + allocatedMicrogons, 0n)).toBe(
      875n * oneArgon,
    );

    // With more funding, locks stop at their Bitcoin value and leave genuinely unused space.
    const funded = allocateBitcoinVaultSpace(locks, 2_000n * oneArgon, currency.priceIndex);
    expect(funded.get(liquid)?.allocatedMicrogons).toBe(100n * oneArgon);
    expect(funded.get(lock)?.allocatedMicrogons).toBe(1_000n * oneArgon);
    expect(funded.get(otherLock)?.allocatedMicrogons).toBe(500n * oneArgon);

    // Once the largest lock fits, the next one gets only the space still available.
    const partlyFull = allocateBitcoinVaultSpace(locks, 1_200n * oneArgon, currency.priceIndex);
    expect(partlyFull.get(lock)?.allocatedMicrogons).toBe(1_000n * oneArgon);
    expect(partlyFull.get(otherLock)?.allocatedMicrogons).toBe(100n * oneArgon);

    // Keep all liquids visible even when their combined collateral exceeds held funding.
    const anotherLiquid = { ...liquid, securitizationCoverageMicrogons: 20n * oneArgon };
    const full = allocateBitcoinVaultSpace([...locks, anotherLiquid], 70n * oneArgon, currency.priceIndex);
    expect(full.get(liquid)).toEqual({ allocatedMicrogons: 50n * oneArgon, requiredMicrogons: 100n * oneArgon });
    expect(full.get(anotherLiquid)).toEqual({ allocatedMicrogons: 20n * oneArgon, requiredMicrogons: 40n * oneArgon });
    expect(full.get(lock)?.allocatedMicrogons).toBe(0n);
    expect(full.get(otherLock)?.allocatedMicrogons).toBe(0n);

    // Equal-sized locks retain their selection when refreshed records arrive in another order.
    const equalLock = { ...otherLock, lockId: 7 };
    const tied = allocateBitcoinVaultSpace([equalLock, otherLock], 300n * oneArgon, currency.priceIndex);
    const reordered = allocateBitcoinVaultSpace([otherLock, equalLock], 300n * oneArgon, currency.priceIndex);
    expect(tied.get(otherLock)?.allocatedMicrogons).toBe(300n * oneArgon);
    expect(tied.get(equalLock)?.allocatedMicrogons).toBe(0n);
    expect(reordered.get(otherLock)).toEqual(tied.get(otherLock));
    expect(reordered.get(equalLock)).toEqual(tied.get(equalLock));
  });

  it('keeps owner purchases within bond space not occupied by flexible bonds', () => {
    const bonds = new ArgonBonds(
      Promise.resolve({} as any),
      { isLoadedPromise: Promise.resolve(), upstreamOperator: undefined },
      new Currency({ events: { on: vi.fn() } } as any),
      {} as any,
      { defaultArgonAddress: accountId } as any,
    );
    const oneArgon = BigInt(MICROGONS_PER_ARGON);
    const vault = createScenarioVault({ vaultId: 4, securitization: 2_168n * oneArgon });
    const state = bonds.getVaultBonds(4);
    state.isLoaded = true;
    state.flexibleBonds = 1_900;

    expect(bonds.availableBondSpace(vault)).toBe(2_168n * oneArgon);
    expect(bonds.availableBondSpaceWithoutFlexibleDisplacement(vault)).toBe(268n * oneArgon);

    state.regularBonds = 300;
    expect(bonds.availableBondSpace(vault)).toBe(1_868n * oneArgon);
    expect(bonds.availableBondSpaceWithoutFlexibleDisplacement(vault)).toBe(0n);

    state.flexibleBonds = 0;
    expect(bonds.availableBondSpaceWithoutFlexibleDisplacement(vault)).toBe(1_868n * oneArgon);

    // Reservations and pending withdrawals limit admission, but do not also
    // displace flexible bonds. Compare the limits instead of subtracting both.
    vault.securitization = 2_400n * oneArgon;
    state.regularBonds = 100;
    state.flexibleBonds = 200;
    state.reservedBondSpace = 300;
    expect(bonds.availableBondSpace(vault)).toBe(2_000n * oneArgon);
    expect(bonds.availableBondSpaceWithoutFlexibleDisplacement(vault)).toBe(2_000n * oneArgon);

    vault.securitizationReleaseSchedule.set(1_000, {
      lockedCommitments: 0n,
      relockableCommitments: 0n,
      argonWithdrawals: 500n * oneArgon,
      argonotWithdrawals: 0n,
    });
    expect(bonds.availableBondSpaceWithoutFlexibleDisplacement(vault)).toBe(1_800n * oneArgon);

    vault.securitizationReleaseSchedule.clear();
    state.reservedBondSpace = 0;
    expect(bonds.availableBondSpaceWithoutFlexibleDisplacement(vault)).toBe(2_100n * oneArgon);
  });

  it('publishes recovered history after an in-flight finalized publication', async () => {
    const db = await createTestDb();
    const lotCodec = createRuntimeBondLot({
      owner: accountId,
      program: { Vault: { vaultId: 4, sharingPercent: 0, bonusPercent: 0 } },
      bonds: 10,
      createdFrameId: 3,
      participatedFrames: 0,
      lastFrameEarningsFrameId: null,
      lastFrameEarnings: null,
      cumulativeEarnings: 0,
      isFlexible: true,
      releaseFrameId: 7,
      releaseReason: 'UserLiquidation',
    });
    const lot = BondLot.fromRuntime(7, lotCodec, accountId);
    const currentClient = {} as Parameters<typeof TreasuryBonds.getBondLotsByAccount>[0];
    const purchasedLot = BondLot.fromRuntime(
      8,
      { ...lotCodec, bonds: 20, releaseFrameId: null, releaseReason: null },
      accountId,
    );
    await db.bondLotHistoryTable.recordObservation({ lot, blockNumber: 100, blockHash: '0x100' });
    const publisherStarted = createDeferred<void>(false);
    const resumePublisher = createDeferred<void>(false);
    const block = {
      blockNumber: 101,
      blockHash: '0x101',
      blockTime: new Date('2026-07-01T12:00:00Z').getTime(),
    };
    const bonds = new ArgonBonds(
      Promise.resolve(db),
      { isLoadedPromise: Promise.resolve(), upstreamOperator: undefined },
      new Currency({ events: { on: vi.fn() } } as any),
      {
        blockWatch: {
          getCurrentApi: vi.fn(async () => {
            publisherStarted.resolve();
            await resumePublisher.promise;
            return {};
          }),
          getApi: vi.fn(async () => ({ query: { treasury: { bondLotById: vi.fn(async () => lotCodec) } } })),
        },
      } as any,
      { defaultArgonAddress: accountId } as any,
    );
    vi.spyOn(bonds, 'load').mockResolvedValue();
    const getBondLots = vi
      .spyOn(TreasuryBonds, 'getBondLotsByAccount')
      .mockImplementation(async client => (client === currentClient ? [lot, purchasedLot] : [lot]));
    try {
      const finalized = bonds.recordBondReleaseRequest(lot, block as any);
      await publisherStarted.promise;
      await bonds.refreshBondLots(currentClient);
      expect(bonds.data.bondLots.map(lot => lot.id)).toEqual([7, 8]);
      await bonds.importHistoryBlock({ ...block, blockNumber: 102, blockHash: '0x102' } as any, [
        {
          event: {
            section: 'treasury',
            method: 'BondLotBackfillChanged',
            data: { vaultId: 4, bondLotId: 7, isBackfill: true },
          },
          phase: { type: 'ApplyExtrinsic', value: 2 },
        } as any,
      ]);
      const recovered = bonds.publishRecoveredHistory();
      resumePublisher.resolve();
      await Promise.all([finalized, recovered]);

      expect(bonds.data.bondHistory[0]).toMatchObject({
        releaseFrame: 7,
        flexibilityHistory: [expect.objectContaining({ blockNumber: 102, isFlexible: true })],
      });
      expect(bonds.data.bondHistory).toEqual(await db.bondLotHistoryTable.fetchAll(accountId));
      expect(bonds.data.bondLots.map(lot => lot.id)).toEqual([7, 8]);
    } finally {
      getBondLots.mockRestore();
    }
  });

  it('adds flexibility history to existing bond records without losing their financial basis', async () => {
    const { db, migrateToLatest } = await createTestDbAtMigration(33);
    const lot = BondLot.fromRuntime(
      7,
      createRuntimeBondLot({
        owner: accountId,
        program: { Vault: { vaultId: 4, sharingPercent: 0, bonusPercent: 0 } },
        bonds: 10,
        createdFrameId: 3,
        participatedFrames: 2,
        lastFrameEarningsFrameId: 4,
        lastFrameEarnings: 1_000_000n,
        cumulativeEarnings: 2_000_000n,
        isFlexible: true,
        releaseFrameId: null,
        releaseReason: null,
      }),
      accountId,
    );
    await db.execute(
      `INSERT INTO BondLotHistory
      (accountId, programType, bondLotId, vaultId, nativeAsset, nativePrincipal, createdFrame, firstObservedBlockNumber, firstObservedBlockHash)
      VALUES (?, 'Vault', ?, ?, 'ARGN', ?, ?, 100, '0x100')`,
      [lot.owner, lot.id, lot.vaultId, lot.bondMicrogons.toString(), lot.createdFrameId],
    );

    await migrateToLatest();

    const [history] = await db.bondLotHistoryTable.fetchAll(accountId);
    expect(history).toMatchObject({
      firstObservedBlockNumber: 100,
      nativePrincipal: lot.bondMicrogons,
      flexibilityHistory: [],
      flexibilityHistoryComplete: false,
    });
    const transition = {
      isFlexible: true,
      cumulativeEarningsMicrogons: lot.cumulativeEarnings,
      source: 'flexibility-change',
      blockNumber: 110,
      blockHash: '0x110',
      blockTime: new Date('2026-07-02T12:00:00Z'),
    } as const;
    await db.bondLotHistoryTable.recordFlexibility(lot, transition);
    await db.bondLotHistoryTable.recordFlexibility(lot, transition);
    expect((await db.bondLotHistoryTable.fetchAll(accountId))[0]?.flexibilityHistory).toHaveLength(1);
  });

  it('keeps live admission and displacement current across consumer cleanup without changing frozen participation', async () => {
    const runtimeVault = registry.createType('ArgonPrimitivesVault', {
      operatorAccountId: accountId,
      securitization: 1_000_000_000n,
      securitizationTarget: 400_000_000n,
      committedMicrogons: 100_000_000n,
      securitizationReleaseSchedule: { 1000: { argonWithdrawals: 600_000_000n } },
    });
    const vault = Vault.fromRuntime(4, toPlain(runtimeVault) as any, 60_000, {
      vaults: { securitizationExitNoticeBlocks: 52_560 },
    } as any);
    let currentBondState = registry.createType('PalletTreasuryVaultBondState', {
      regularBonds: 100,
      flexibleBonds: 900,
      displacedFlexibleBonds: 0,
      lockedFrameTerms: { flexibleBonds: 900, displacedFlexibleBonds: 0 },
    });
    let totalLots = 2;
    let vaultUnavailable = true;
    let retryVaultReads = 0;
    const lots = new Map([
      [
        1,
        toPlain(
          registry.createType('PalletTreasuryBondLot', {
            owner: accountId,
            bonds: 100,
            program: { Vault: { vaultId: 4 } },
          }),
        ),
      ],
      [
        2,
        toPlain(
          registry.createType('PalletTreasuryBondLot', {
            owner: accountId,
            bonds: 900,
            isFlexible: true,
            program: { Vault: { vaultId: 4 } },
            lockedFrameTerms: { bonds: 900, isFlexible: true },
          }),
        ),
      ],
    ]);
    const client = {
      registry,
      consts: {
        treasury: {
          palletId: '0x61722f7472656173',
          percentForVaultPool: new BigNumber(0.51),
          percentForArgonBondPool: new BigNumber(0.49),
          minimumArgonsPerContributor: 100_000_000n,
          maxArgonBondLots: 4,
        },
      },
      query: {
        system: { account: async () => ({ data: { free: 9_000_000_000n } }) },
        priceIndex: { historicArgonotAverageByFrame: async () => ({ 9: 2_000_000n }) },
        treasury: {
          bondLotsByVault: async (vaultId: number) => {
            if (vaultId === 7) {
              retryVaultReads += 1;
              if (vaultUnavailable) throw new Error('vault unavailable');
              return toPlain(registry.createType('PalletTreasuryVaultBondState'));
            }
            return toPlain(currentBondState);
          },
          totalArgonBondLots: async () => totalLots,
          bondLotIdsByVault: {
            keys: async (vaultId: number) => (vaultId === 4 ? [...lots.keys()].map(id => ({ args: [4, id] })) : []),
          },
          bondLotIdsByAccount: { keys: async () => [...lots.keys()].map(id => ({ args: [accountId, id] })) },
          bondLotById: { multi: async (ids: number[]) => ids.map(id => lots.get(id)) },
          currentFrameVaultCapital: async () =>
            toPlain(
              registry.createType('PalletTreasuryFrameVaultCapital', {
                frameId: 10,
                totalActiveBonds: 1000,
                targetSecuritization: 10_000_000_000n,
                totalSecuritization: 1_000_000_000n,
                vaultSecuritizationPositions: {
                  4: {
                    operatorAccountId: accountId,
                    securitization: 1_000_000_000n,
                    activatedSecuritization: 1_000_000_000n,
                    bitcoinLockedMicrogons: 1_000_000_000n,
                    activeBondMicrogons: 1_000_000_000n,
                    upstreamParticipation: 10n ** 18n,
                  },
                },
              }),
            ),
        },
      },
    };
    let onBestBlocks: ((blocks: IBlockHeaderInfo[]) => void) | undefined;
    let hasMarketEvent = true;
    let marketEvent = { section: 'vaults', method: 'VaultModified', data: { vaultId: 4 } };
    const olderEvents = createDeferred<void>(false);
    const olderSnapshotRead = createDeferred<void>(false);
    let olderClient = client;
    const argonBonds = new ArgonBonds(
      Promise.resolve({} as any),
      { isLoadedPromise: Promise.resolve(), upstreamOperator: undefined },
      new Currency({ events: { on: vi.fn() } } as any),
      {
        blockWatch: {
          events: {
            on: (name: string, listener: typeof onBestBlocks) => {
              if (name === 'best-blocks') onBestBlocks = listener;
              return () => undefined;
            },
          },
          start: async () => undefined,
          bestBlockHeader: { frameId: 10 },
          getApi: async (block: IBlockHeaderInfo) => {
            if (block.blockHash !== '0x103a') return client;
            olderSnapshotRead.resolve();
            return olderClient;
          },
          getEvents: async (block: IBlockHeaderInfo) => {
            if (block.blockHash === '0x103a') await olderEvents.promise;
            return hasMarketEvent ? [{ event: marketEvent }] : [];
          },
        },
      } as any,
      { defaultArgonAddress: accountId } as any,
    );
    await argonBonds.subscribeGlobal(client as any);
    await argonBonds.subscribeVault({ vaultId: 4, operatorAddress: accountId }, client as any);
    // The published trailing total is 10,000 ARGN over ten days. Its daily
    // baseline earns 10% of the 51% vault pool, regardless of the live balance.
    expect(argonBonds.vaultRevenuePotential(4, 10_000_000_000n / 10n)?.maximumEarnings).toBe(51_000_000n);
    let argonotSecuritization = toPlain(
      registry.createType('ArgonPrimitivesVaultVaultArgonotSecuritization', {
        heldMicronots: 400_000_000n,
        committedMicronots: 300_000_000n,
        encumberedMicronots: 100_000_000n,
      }),
    ) as NonNullable<LiveQueryRecord<'vaults', 'argonotSecuritizationByVaultId'>>;
    expect(argonBonds.argonotRewardBacking({ vault, argonotSecuritization })).toEqual({
      totalMicronots: 1_000_000_000n,
      additionalMicronots: 600_000_000n,
      withdrawalCancellationMicronots: 0n,
    });
    argonotSecuritization = { ...argonotSecuritization, heldMicronots: 1_000_000_000n };
    vault.securitizationReleaseSchedule.set(1000, {
      ...vault.securitizationReleaseSchedule.get(1000)!,
      argonotWithdrawals: 200_000_000n,
    });
    expect(argonBonds.argonotRewardBacking({ vault, argonotSecuritization })).toEqual({
      totalMicronots: 1_000_000_000n,
      additionalMicronots: 0n,
      withdrawalCancellationMicronots: 200_000_000n,
    });
    expect(argonBonds.vaultRevenuePotential(4)?.capturedPercent).toBeCloseTo(25.84, 2);
    expect(
      argonBonds.argonotRewardBacking({ vault, argonotSecuritization, securitizationMicrogons: 400_000_000n })
        ?.totalMicronots,
    ).toBe(1_000_000_000n);
    argonBonds.data.averageMicrogonsPerArgonot = undefined;
    expect(argonBonds.argonotRewardBacking({ vault, argonotSecuritization })).toBeUndefined();
    const staleCleanup = await argonBonds.subscribeVault({ vaultId: 4, operatorAddress: accountId }, client as any);
    const purchaseCleanup = await argonBonds.subscribeVault({ vaultId: 4, operatorAddress: accountId }, client as any);
    staleCleanup();
    purchaseCleanup();
    const retryCleanup = await argonBonds
      .subscribeVault({ vaultId: 7, operatorAddress: accountId }, client as any)
      .catch(() => undefined);
    expect(argonBonds.getVaultBonds(7).isLoaded).toBe(false);
    vaultUnavailable = false;
    hasMarketEvent = false;
    onBestBlocks!([{ blockNumber: 100, blockHash: '0x100', frameId: 10 } as IBlockHeaderInfo]);
    await vi.waitFor(() => expect(argonBonds.getVaultBonds(7).isLoaded).toBe(true));
    retryCleanup!();

    // A failed refresh retains last valid state, but cancelling the subscription
    // also cancels its retry intent.
    vaultUnavailable = true;
    const cancelledCleanup = await argonBonds.subscribeVault({ vaultId: 7, operatorAddress: accountId }, client as any);
    expect(argonBonds.getVaultBonds(7).isLoaded).toBe(true);
    cancelledCleanup();
    const readsBeforeCleanup = retryVaultReads;
    onBestBlocks!([{ blockNumber: 100, blockHash: '0x100b', frameId: 10 } as IBlockHeaderInfo]);
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(retryVaultReads).toBe(readsBeforeCleanup);
    hasMarketEvent = true;
    expect(argonBonds.availableBondSpace(vault)).toBe(300_000_000n);
    expect(argonBonds.getVaultBonds(4).minimumPurchaseBonds).toBe(100);
    expect(argonBonds.getFlexibleBondDisplacementPercent(4)).toBe(0);

    // Cancellation restores room; a regular purchase then displaces flexible
    // holdings immediately while their already-frozen payout remains unchanged.
    vault.securitizationReleaseSchedule.clear();
    vault.securitizationTarget = vault.securitization;
    expect(argonBonds.availableBondSpace(vault)).toBe(900_000_000n);
    lots.set(
      3,
      toPlain(
        registry.createType('PalletTreasuryBondLot', {
          owner: accountId,
          bonds: 900,
          program: { Vault: { vaultId: 4 } },
          lockedFrameTerms: { bonds: 0, isFlexible: false },
        }),
      ),
    );
    totalLots = 3;
    currentBondState = registry.createType('PalletTreasuryVaultBondState', {
      regularBonds: 1000,
      flexibleBonds: 900,
      displacedFlexibleBonds: 900,
      lockedFrameTerms: { flexibleBonds: 900, displacedFlexibleBonds: 0 },
    });
    await argonBonds.refreshVault({ vaultId: 4, operatorAddress: accountId }, client as any);
    expect(argonBonds.getFlexibleBondDisplacementPercent(4)).toBe(100);
    expect(argonBonds.getVaultBonds(4).currentFrame.flexibleBondsEligible).toBe(900);
    expect(argonBonds.getVaultBonds(4).currentFrame.vaultBonds).toBe(1000);

    // Closing the purchase overlays must leave the dashboard subscription alive.
    // A capital change refreshes current displacement without a new frame.
    vault.securitization = 2_000_000_000n;
    currentBondState = registry.createType('PalletTreasuryVaultBondState', {
      regularBonds: 1000,
      flexibleBonds: 900,
      displacedFlexibleBonds: 0,
      lockedFrameTerms: { flexibleBonds: 900, displacedFlexibleBonds: 0 },
    });
    onBestBlocks!([{ blockNumber: 101, blockHash: '0x101', frameId: 10 } as IBlockHeaderInfo]);
    await vi.waitFor(() => expect(argonBonds.getFlexibleBondDisplacementPercent(4)).toBe(0));
    expect(argonBonds.availableBondSpace(vault)).toBe(1_000_000_000n);
    expect(argonBonds.getVaultBonds(7).isLoaded).toBe(true);

    totalLots = 4;
    marketEvent = { section: 'treasury', method: 'BondLotPurchased', data: { vaultId: 7 } };
    onBestBlocks!([{ blockNumber: 102, blockHash: '0x102', frameId: 10 } as IBlockHeaderInfo]);
    await vi.waitFor(() => expect(argonBonds.availableBondSpace(vault)).toBe(0n));

    // The next best notification can arrive while an older block's events are
    // still loading. A same-height replacement must win for both market and lots.
    argonBonds.data.isLoaded = true;
    await argonBonds.refreshBondLots(client as any);
    const olderLots = new Map(lots);
    const olderBondState = currentBondState;
    olderClient = {
      ...client,
      query: {
        ...client.query,
        treasury: {
          ...client.query.treasury,
          bondLotsByVault: async () => toPlain(olderBondState),
          totalArgonBondLots: async () => 4,
          bondLotIdsByVault: { keys: async () => [...olderLots.keys()].map(id => ({ args: [4, id] })) },
          bondLotIdsByAccount: { keys: async () => [...olderLots.keys()].map(id => ({ args: [accountId, id] })) },
          bondLotById: { multi: async (ids: number[]) => ids.map(id => olderLots.get(id)) },
        },
      },
    };
    onBestBlocks!([{ blockNumber: 103, blockHash: '0x103a', frameId: 10 } as IBlockHeaderInfo]);
    lots.delete(3);
    totalLots = 2;
    currentBondState = registry.createType('PalletTreasuryVaultBondState', {
      regularBonds: 100,
      flexibleBonds: 900,
      displacedFlexibleBonds: 0,
      lockedFrameTerms: { flexibleBonds: 900, displacedFlexibleBonds: 0 },
    });
    onBestBlocks!([{ blockNumber: 103, blockHash: '0x103b', frameId: 10 } as IBlockHeaderInfo]);
    await vi.waitFor(() => expect(argonBonds.availableBondSpace(vault)).toBe(1_900_000_000n));
    expect(argonBonds.data.bondLots.map(lot => lot.id)).toEqual([1, 2]);
    olderEvents.resolve();
    await olderSnapshotRead.promise;
    await new Promise(resolve => setTimeout(resolve, 0));
    expect.soft(argonBonds.availableBondSpace(vault)).toBe(1_900_000_000n);
    expect.soft(argonBonds.data.bondLots.map(lot => lot.id)).toEqual([1, 2]);
  });

  it.each([
    ['deployed', deployedRegistry],
    ['candidate', registry],
  ] as const)(
    'shares frame reads across vaults without losing newer state or retries on %s',
    async (runtime, codecs) => {
      const olderRead = createDeferred<void>(false);
      let failFrameRead = false;
      const clients = [10, 20, 30, 40].map(bonds => ({
        registry: codecs,
        consts: {
          treasury: {
            palletId: '0x61722f7472656173',
            minimumArgonsPerContributor: 1_000_000n,
            ...(runtime === 'candidate'
              ? {
                  maxArgonBondLots: 10,
                  percentForVaultPool: new BigNumber(0.51),
                  percentForArgonBondPool: new BigNumber(0.49),
                }
              : { maxTreasuryContributors: 10, percentForTreasuryReserves: new BigNumber(0.1) }),
          },
        },
        query: {
          system: { account: vi.fn(async () => ({ data: { free: BigInt(bonds) * 1_000_000n } })) },
          priceIndex: { historicArgonotAverageByFrame: vi.fn(async () => ({ 9: 2_000_000n })) },
          treasury: {
            currentFrameVaultCapital: vi.fn(async () => {
              if (bonds === 20) await olderRead.promise;
              if (failFrameRead) throw new Error('frame temporarily unavailable');
              return toPlain(
                codecs.createType('PalletTreasuryFrameVaultCapital', {
                  frameId: 10,
                  totalActiveBonds: bonds * 2,
                  targetSecuritization: 2n * BigInt(bonds) * 1_000_000n,
                  totalSecuritization: 2n * BigInt(bonds) * 1_000_000n,
                  vaultSecuritizationPositions: Object.fromEntries(
                    [4, 7].map(vaultId => [
                      vaultId,
                      {
                        operatorAccountId: accountId,
                        securitization: BigInt(bonds) * 1_000_000n,
                        activatedSecuritization: BigInt(bonds) * 1_000_000n,
                        bitcoinLockedMicrogons: BigInt(bonds) * 1_000_000n,
                        activeBondMicrogons: BigInt(bonds) * 1_000_000n,
                        argonotSecuritizationInMicrogons: 2n * BigInt(bonds) * 1_000_000n,
                        upstreamParticipation: 500_000_000_000_000_000n,
                      },
                    ]),
                  ),
                  vaults: Object.fromEntries(
                    [4, 7].map(vaultId => [
                      vaultId,
                      {
                        eligibleBonds: bonds,
                        regularBondAllocations: [{ bondLotId: vaultId, prorata: 10n ** 18n }],
                      },
                    ]),
                  ),
                }),
              );
            }),
            bondLotsByVault: async (vaultId: number) =>
              toPlain(
                codecs.createType('PalletTreasuryVaultBondState', {
                  regularBonds: bonds,
                  regularBondLots: [{ bondLotId: vaultId, bonds }],
                }),
              ),
            totalArgonBondLots: async () => 2,
            bondLotIdsByVault: { keys: async (vaultId: number) => [{ args: [vaultId, vaultId] }] },
            bondLotIdsByAccount: { keys: async () => [4, 7].map(id => ({ args: [accountId, id] })) },
            bondLotById: {
              multi: async (ids: number[]) =>
                ids.map(id =>
                  toPlain(
                    codecs.createType('PalletTreasuryBondLot', {
                      owner: accountId,
                      program: { Vault: { vaultId: id } },
                      bonds,
                    }),
                  ),
                ),
            },
          },
        },
      }));
      let currentClient = clients[0];
      let onBestBlocks!: (blocks: IBlockHeaderInfo[]) => void;
      const argonBonds = new ArgonBonds(
        Promise.resolve({} as any),
        { isLoadedPromise: Promise.resolve(), upstreamOperator: undefined },
        new Currency({ events: { on: vi.fn() } } as any),
        {
          blockWatch: {
            events: {
              on: (name: string, listener: typeof onBestBlocks) => {
                if (name === 'best-blocks') onBestBlocks = listener;
                return () => undefined;
              },
            },
            start: async () => undefined,
            bestBlockHeader: { frameId: 10 },
            getCurrentApi: async () => currentClient,
            getApi: async () => currentClient,
            getEvents: async () => [],
          },
        } as any,
        { defaultArgonAddress: accountId } as any,
      );
      await argonBonds.subscribeGlobal(currentClient as any);
      for (const vaultId of [4, 7])
        await argonBonds.subscribeVault({ vaultId, operatorAddress: accountId }, currentClient as any);
      argonBonds.data.isLoaded = true;
      currentClient.query.treasury.currentFrameVaultCapital.mockClear();
      currentClient.query.priceIndex.historicArgonotAverageByFrame.mockClear();
      currentClient.query.system.account.mockClear();
      await argonBonds.refreshActiveState();

      expect(currentClient.query.treasury.currentFrameVaultCapital).toHaveBeenCalledTimes(1);
      expect(currentClient.query.priceIndex.historicArgonotAverageByFrame).toHaveBeenCalledTimes(
        runtime === 'candidate' ? 1 : 0,
      );
      // The market balance refresh is independent of the vault reward inputs.
      expect(currentClient.query.system.account).toHaveBeenCalledTimes(runtime === 'candidate' ? 2 : 1);
      expect(argonBonds.data.totalActiveBonds).toBe(20);
      if (runtime === 'candidate') {
        expect(argonBonds.vaultRevenuePotential(4)).toMatchObject({
          actualEarnings: 1_300_000n,
          maximumEarnings: 2_550_000n,
          upstreamParticipationPercent: 50,
        });
      } else {
        expect(argonBonds.vaultRevenuePotential(4)).toBeUndefined();
        expect(argonBonds.data.frameCapital).toBeNull();
      }
      for (const vaultId of [4, 7]) {
        const vault = argonBonds.getVaultBonds(vaultId);
        expect(vault.currentFrame.vaultBonds).toBe(10);
        expect(vault.currentFrame.bondLots.map(({ lot, eligibleMicrogons }) => [lot.id, eligibleMicrogons])).toEqual([
          [vaultId, 10_000_000n],
        ]);
      }

      currentClient = clients[1];
      const oldRefresh = argonBonds.refreshActiveState();
      await vi.waitFor(() => expect(clients[1].query.treasury.currentFrameVaultCapital).toHaveBeenCalledTimes(1));
      currentClient = clients[2];
      await argonBonds.refreshActiveState();
      olderRead.resolve();
      await oldRefresh;
      expect(argonBonds.data.totalActiveBonds).toBe(60);
      for (const vaultId of [4, 7]) {
        expect(argonBonds.getVaultBonds(vaultId)).toMatchObject({ regularBonds: 30, currentFrame: { vaultBonds: 30 } });
      }

      // A shared-read failure must preserve both loaded vaults and leave both
      // subscribed for an event-neutral next-block retry.
      failFrameRead = true;
      await expect(argonBonds.refreshActiveState()).rejects.toThrow('frame temporarily unavailable');
      for (const vaultId of [4, 7]) {
        expect(argonBonds.getVaultBonds(vaultId)).toMatchObject({ isLoaded: true, currentFrame: { vaultBonds: 30 } });
      }
      failFrameRead = false;
      currentClient = clients[3];
      onBestBlocks([{ blockNumber: 104, blockHash: '0x104', frameId: 10 } as IBlockHeaderInfo]);
      await vi.waitFor(() => {
        for (const vaultId of [4, 7]) expect(argonBonds.getVaultBonds(vaultId).currentFrame.vaultBonds).toBe(40);
      });
      expect(argonBonds.data.totalActiveBonds).toBe(80);
      expect(currentClient.query.treasury.currentFrameVaultCapital).toHaveBeenCalledTimes(1);
    },
  );

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
    const currentClient = {};
    const blockWatch = {
      bestBlockHeader: { frameId: 4 },
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
    );
    argonBonds.data.isLoaded = true;
    argonBonds.data.bondLots = [finalizedLot, bestChainLot];

    await argonBonds.refreshActiveState();

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
      isFlexible: true,
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
      bestBlockHeader: { ...parent, frameId: 12 },
      finalizedBlockHeader: parent,
      start: vi.fn(async () => undefined),
      events: {
        on: vi.fn((eventName: string, listener: (blocks: any[]) => void) => {
          if (eventName === 'finalized') finalizedListener = listener;
          return () => undefined;
        }),
      },
      getApi: vi.fn(async () => api),
      getCurrentApi: vi.fn(async () => api),
      getHeader: vi.fn(async () => ({ ...block, blockNumber: 110, blockHash: '0x110', parentHash: '0x109' })),
      getParentHeader: vi.fn(async () => parent),
      getEvents: vi.fn(async () => finalizedEvents),
    };
    const currency = { isLoadedPromise: Promise.resolve(), fetchMainchainRatesAtBlock: vi.fn() };
    const argonBonds = new ArgonBonds(
      Promise.resolve(db),
      { isLoadedPromise: Promise.resolve(), upstreamOperator: undefined },
      currency as any,
      { load: vi.fn(async () => undefined), blockWatch } as any,
      { defaultArgonAddress: accountId } as any,
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
    await argonBonds.publishRecoveredHistory();
    await db.syncStateTable.upsert(SyncStateKeys.BondHistory, {
      accountId,
      blockNumber: 109,
      blockHash: '0x109',
    });
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
    const getBondLots = vi.spyOn(TreasuryBonds, 'getBondLotsByAccount').mockResolvedValue([]);
    await argonBonds.load();
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
      expect((await db.bondLotHistoryTable.fetchAll(accountId))[0]?.flexibilityHistory).toEqual([
        expect.objectContaining({
          isFlexible: true,
          source: 'purchase',
          blockNumber: 100,
        }),
        expect.objectContaining({
          isFlexible: false,
          source: 'release',
          blockNumber: 110,
        }),
      ]);
    });
    getBondLots.mockRestore();
  });

  it('publishes a failed release as closed when the finalized Treasury hold was removed', async () => {
    const db = await createTestDb();
    const codec = createRuntimeBondLot({
      owner: accountId,
      program: { Argonot: null },
      bonds: 20,
      createdFrameId: 3,
      participatedFrames: 1,
      lastFrameEarningsFrameId: 4,
      lastFrameEarnings: 0n,
      cumulativeEarnings: 0n,
      releaseFrameId: 6,
      releaseReason: 'UserLiquidation',
    });
    const lot = BondLot.fromRuntime(68, codec, accountId);
    await db.syncStateTable.upsert(SyncStateKeys.BondHistory, { accountId, blockNumber: 99, blockHash: '0x99' });
    const parent = { blockNumber: 99, blockHash: '0x99', isFinalized: true };
    const block = {
      blockNumber: 100,
      blockHash: '0x100',
      parentHash: '0x99',
      blockTime: Date.parse('2026-07-02T00:00:00Z'),
      isFinalized: true,
    };
    const blockWatch = {
      bestBlockHeader: { ...block, frameId: 6 },
      finalizedBlockHeader: block,
      start: vi.fn(async () => undefined),
      events: { on: vi.fn(() => () => undefined) },
      getHeader: vi.fn(async () => block),
      getParentHeader: vi.fn(async () => parent),
      getApi: vi.fn(async (header: typeof block) => ({
        query: {
          treasury: { bondLotById: vi.fn(async () => codec) },
          ownership: {
            holds: vi.fn(async () =>
              header.blockNumber === 99 ? [{ id: { type: 'Treasury' }, amount: 20_000_000n }] : [],
            ),
          },
        },
      })),
      getCurrentApi: vi.fn(async () => ({})),
      getEvents: vi.fn(async () => [
        {
          event: {
            section: 'treasury',
            method: 'CouldNotReleaseBondLot',
            data: { bondLotId: 68, accountId, amount: 20_000_000n },
          },
          phase: { type: 'Initialization' },
        },
      ]),
    };
    const getBondLots = vi.spyOn(TreasuryBonds, 'getBondLotsByAccount').mockResolvedValue([lot]);
    const bonds = new ArgonBonds(
      Promise.resolve(db),
      { isLoadedPromise: Promise.resolve(), upstreamOperator: undefined },
      {
        isLoadedPromise: Promise.resolve(),
        fetchMainchainRatesAtBlock: vi.fn(async () => ({ ARGNOT: 1_000_000n })),
      } as any,
      { load: vi.fn(async () => undefined), blockWatch } as any,
      { defaultArgonAddress: accountId } as any,
    );
    await bonds.load();
    await vi.waitFor(async () => {
      expect((await db.bondLotHistoryTable.fetchAll(accountId))[0]?.releaseBlockNumber).toBe(100);
      expect(bonds.data.bondLots).toEqual([]);
    });
    expect(bonds.data.historyError).toBeUndefined();
    getBondLots.mockRestore();
  });

  it('recovers a failed release only when its Treasury hold actually left custody, including after restart', async () => {
    const db = await createTestDb();
    const releasedCodec = createRuntimeBondLot({
      owner: accountId,
      program: { Argonot: null },
      bonds: 20,
      createdFrameId: 3,
      participatedFrames: 2,
      lastFrameEarningsFrameId: 4,
      lastFrameEarnings: 1_000_000n,
      cumulativeEarnings: 2_000_000n,
      releaseFrameId: 6,
      releaseReason: 'UserLiquidation',
    });
    const retainedCodec = createRuntimeBondLot({
      owner: accountId,
      program: { Argonot: null },
      bonds: 30,
      createdFrameId: 4,
      participatedFrames: 1,
      lastFrameEarningsFrameId: 5,
      lastFrameEarnings: 0n,
      cumulativeEarnings: 0n,
      releaseFrameId: 7,
      releaseReason: 'UserLiquidation',
    });
    const releasedLot = BondLot.fromRuntime(68, releasedCodec, accountId);
    const retainedLot = BondLot.fromRuntime(69, retainedCodec, accountId);
    for (const lot of [releasedLot, retainedLot]) {
      await db.bondLotHistoryTable.recordObservation({
        lot,
        blockNumber: 90,
        blockHash: '0x90',
        purchase: {
          blockTime: new Date('2026-07-01T00:00:00Z'),
          entryArgonotRateMicrogons: 1_000_000n,
        },
      });
    }
    const blockTime = new Date('2026-07-02T00:00:00Z').getTime();
    const headers = [99, 100, 101].map(blockNumber => ({
      blockNumber,
      blockHash: `0x${blockNumber}`,
      blockTime,
      isFinalized: true,
    }));
    const blockWatch = {
      getApi: vi.fn(async (header: { blockNumber: number }) => ({
        query: {
          treasury: {
            bondLotById: vi.fn(async (id: number) => (id === 68 ? releasedCodec : retainedCodec)),
          },
          ownership: {
            holds: vi.fn(async () => [
              {
                id: { type: 'Treasury' },
                amount: header.blockNumber === 99 ? 50_000_000n : 30_000_000n,
              },
            ]),
          },
        },
      })),
      getParentHeader: vi.fn(async (header: { blockNumber: number }) => headers[header.blockNumber - 100]),
    };
    const currency = {
      fetchMainchainRatesAtBlock: vi.fn(async () => ({ ARGNOT: 1_000_000n })),
    };
    const miningFrames = {
      blockWatch,
      getFrameDate: () => new Date('2026-07-01T00:00:00Z'),
    };
    const argonBonds = new ArgonBonds(
      Promise.resolve(db),
      { isLoadedPromise: Promise.resolve(), upstreamOperator: undefined },
      currency as any,
      miningFrames as any,
      { defaultArgonAddress: accountId } as any,
    );
    argonBonds.data.bondLots = [releasedLot, retainedLot];
    for (const [index, lot] of [releasedLot, retainedLot].entries()) {
      await argonBonds.importHistoryBlock(headers[index + 1] as any, [
        {
          event: {
            section: 'treasury',
            method: 'CouldNotReleaseBondLot',
            data: {
              frameId: 6 + index,
              programId: { type: 'Argonot' },
              bondLotId: lot.id,
              accountId,
              amount: lot.principalMicronots,
              dispatchError: { type: 'ConsumerRemaining' },
            },
          },
          phase: { type: 'Initialization' },
        } as any,
      ]);
    }
    await argonBonds.publishRecoveredHistory();

    const records = await db.bondLotHistoryTable.fetchAll(accountId);
    expect(records.find(record => record.bondLotId === 68)).toMatchObject({
      releaseBlockNumber: 100,
      releaseBlockHash: '0x100',
      closingArgonotRateMicrogons: 1_000_000n,
      cumulativeEarningsMicrogons: 2_000_000n,
    });
    expect(records.find(record => record.bondLotId === 69)?.releaseBlockNumber).toBeUndefined();
    expect(argonBonds.data.bondLots.map(lot => lot.id)).toEqual([69]);

    const restarted = new ArgonBonds(
      Promise.resolve(db),
      { isLoadedPromise: Promise.resolve(), upstreamOperator: undefined },
      currency as any,
      miningFrames as any,
      { defaultArgonAddress: accountId } as any,
    );
    restarted.data.bondLots = [releasedLot, retainedLot];
    await restarted.refreshHistory();
    expect(restarted.data.bondLots.map(lot => lot.id)).toEqual([69]);
    const positions = await new ArgonBondsFinancials(restarted).loadPositions({
      account: {
        address: accountId,
        wallet: { address: accountId } as WalletForArgon,
        availableMicrogons: 0n,
        reservedMicrogons: 0n,
        availableMicronots: 20_000_000n,
        reservedMicronots: 0n,
        microgonHolds: [],
        micronotHolds: [{ id: { type: 'Treasury' }, amount: 30_000_000n }],
      } as any,
    });
    expect(positions).toEqual([
      expect.objectContaining({ id: `bond:${accountId}:argonot:69`, lifecycle: 'releasing' }),
      expect.objectContaining({
        id: `bond:${accountId}:argonot:68`,
        lifecycle: 'completed',
        investedCost: 20_000_000n,
        settledPrincipalValue: 20_000_000n,
        paidIncome: 2_000_000n,
      }),
    ]);
    expect(calculatePositionReturn(positions.filter(position => position.lifecycle === 'completed'))).toMatchObject({
      availability: 'available',
      returnAmount: 2_000_000n,
      percent: 10,
    });
  });

  it('recovers a failed release alongside a successful release when both holds leave custody', async () => {
    const db = await createTestDb();
    const failedCodec = createRuntimeBondLot({
      owner: accountId,
      program: { Argonot: null },
      bonds: 20,
      createdFrameId: 3,
      participatedFrames: 1,
      lastFrameEarningsFrameId: 4,
      lastFrameEarnings: 0n,
      cumulativeEarnings: 0n,
      releaseFrameId: 6,
      releaseReason: 'UserLiquidation',
    });
    const successfulCodec = createRuntimeBondLot({
      owner: accountId,
      program: { Argonot: null },
      bonds: 30,
      createdFrameId: 3,
      participatedFrames: 1,
      lastFrameEarningsFrameId: 4,
      lastFrameEarnings: 0n,
      cumulativeEarnings: 0n,
      releaseFrameId: 6,
      releaseReason: 'UserLiquidation',
    });
    const failedLot = BondLot.fromRuntime(68, failedCodec, accountId);
    const parent = {
      blockNumber: 99,
      blockHash: '0x99',
      blockTime: Date.parse('2026-07-01T00:00:00Z'),
      isFinalized: true,
    };
    const block = {
      blockNumber: 100,
      blockHash: '0x100',
      blockTime: Date.parse('2026-07-02T00:00:00Z'),
      isFinalized: true,
    };
    const blockWatch = {
      getParentHeader: vi.fn(async () => parent),
      getApi: vi.fn(async (header: typeof block) => ({
        query: {
          treasury: { bondLotById: vi.fn(async (id: number) => (id === 68 ? failedCodec : successfulCodec)) },
          ownership: {
            holds: vi.fn(async () =>
              header.blockNumber === 99 ? [{ id: { type: 'Treasury' }, amount: 50_000_000n }] : [],
            ),
          },
        },
      })),
    };
    const miningFrames = { blockWatch, getFrameDate: () => new Date('2026-07-01T00:00:00Z') };
    const argonBonds = new ArgonBonds(
      Promise.resolve(db),
      { isLoadedPromise: Promise.resolve(), upstreamOperator: undefined },
      { fetchMainchainRatesAtBlock: vi.fn(async () => ({ ARGNOT: 1_000_000n })) } as any,
      miningFrames as any,
      { defaultArgonAddress: accountId } as any,
    );
    argonBonds.data.bondLots = [failedLot];
    await argonBonds.importHistoryBlock(block as any, [
      {
        event: {
          section: 'treasury',
          method: 'BondLotReleased',
          data: { frameId: 6, programId: { type: 'Argonot' }, bondLotId: 69, accountId, bonds: 30 },
        },
        phase: { type: 'Initialization' },
      } as any,
      {
        event: {
          section: 'treasury',
          method: 'CouldNotReleaseBondLot',
          data: {
            frameId: 6,
            programId: { type: 'Argonot' },
            bondLotId: 68,
            accountId,
            amount: 20_000_000n,
            dispatchError: { type: 'ConsumerRemaining' },
          },
        },
        phase: { type: 'Initialization' },
      } as any,
    ]);
    await argonBonds.publishRecoveredHistory();

    const records = await db.bondLotHistoryTable.fetchAll(accountId);
    expect(records.map(record => [record.bondLotId, record.releaseBlockNumber])).toEqual([
      [68, 100],
      [69, 100],
    ]);
    expect(argonBonds.data.bondLots).toEqual([]);
    await expect(
      new ArgonBondsFinancials(argonBonds).loadPositions({
        account: {
          address: accountId,
          wallet: { address: accountId } as WalletForArgon,
          microgonHolds: [],
          micronotHolds: [],
        } as any,
      }),
    ).resolves.toEqual([
      expect.objectContaining({ id: `bond:${accountId}:argonot:68`, lifecycle: 'completed' }),
      expect.objectContaining({ id: `bond:${accountId}:argonot:69`, lifecycle: 'completed' }),
    ]);
  });

  it('replays missed finalized bond events from the durable cursor after restart', async () => {
    const db = await createTestDb();
    const lotCodec = createRuntimeBondLot({
      owner: accountId,
      program: { Vault: { vaultId: 4, sharingPercent: 0, bonusPercent: 0 } },
      bonds: 10,
      createdFrameId: 3,
      participatedFrames: 0,
      lastFrameEarningsFrameId: null,
      lastFrameEarnings: null,
      cumulativeEarnings: 0,
      isFlexible: true,
      releaseFrameId: null,
      releaseReason: null,
    });
    const lot = BondLot.fromRuntime(7, lotCodec, accountId);
    await db.bondLotHistoryTable.recordObservation({ lot, blockNumber: 100, blockHash: '0x100' });
    await db.bondLotHistoryTable.confirmFlexibilityHistory(accountId);
    await db.syncStateTable.upsert(SyncStateKeys.BondHistory, {
      accountId,
      blockNumber: 100,
      blockHash: '0x100',
    });

    const eventsAt101 = createDeferred<FrameSystemEventRecord[]>(false);
    const eventsAt103 = createDeferred<FrameSystemEventRecord[]>(false);
    const refreshedLots = createDeferred<BondLot[]>(false);
    let onFinalized: ((blocks: { blockNumber: number }[]) => void) | undefined;
    const blockWatch = {
      bestBlockHeader: { blockNumber: 102, blockHash: '0x102', frameId: 4 },
      finalizedBlockHeader: { blockNumber: 102, blockHash: '0x102', frameId: 4 },
      start: vi.fn(async () => undefined),
      events: {
        on: vi.fn((name: string, listener: (blocks: { blockNumber: number }[]) => void) => {
          if (name === 'finalized') onFinalized = listener;
          return () => undefined;
        }),
      },
      getHeader: vi.fn(async (blockNumber: number) => ({
        blockNumber,
        blockHash: `0x${blockNumber}`,
        parentHash: `0x${blockNumber - 1}`,
        blockTime: new Date('2026-07-02T12:00:00Z').getTime(),
        isFinalized: true,
      })),
      getApi: vi.fn(async () => ({ query: { treasury: { bondLotById: vi.fn(async () => lotCodec) } } })),
      getCurrentApi: vi.fn(async () => ({})),
      getEvents: vi.fn(async (block: { blockNumber: number }) => {
        if (block.blockNumber === 101) return eventsAt101.promise;
        if (block.blockNumber === 103) return eventsAt103.promise;
        if (block.blockNumber === 104) {
          return [
            {
              event: {
                section: 'treasury',
                method: 'BondLotFlexibilityChanged',
                data: { bondLotId: 7, isFlexible: false },
              },
              phase: { type: 'ApplyExtrinsic', value: 1 },
            },
          ];
        }
        return [];
      }),
    };
    const getBondLots = vi
      .spyOn(TreasuryBonds, 'getBondLotsByAccount')
      .mockResolvedValueOnce([lot])
      .mockImplementation(() => refreshedLots.promise);
    const argonBonds = new ArgonBonds(
      Promise.resolve(db),
      { isLoadedPromise: Promise.resolve(), upstreamOperator: undefined },
      { isLoadedPromise: Promise.resolve(), fetchMainchainRatesAtBlock: vi.fn() } as any,
      { load: vi.fn(async () => undefined), blockWatch } as any,
      { defaultArgonAddress: accountId } as any,
    );

    await argonBonds.load();
    expect(argonBonds.data.bondLots).toEqual([lot]);
    expect(argonBonds.data.historyCoveragePending).toBe(true);
    const initialRevision = argonBonds.data.financialRevision;
    eventsAt101.resolve([
      {
        event: { section: 'treasury', method: 'BondLotFlexibilityChanged', data: { bondLotId: 7, isFlexible: true } },
        phase: { type: 'ApplyExtrinsic', value: 1 },
      } as any,
    ]);

    await vi.waitFor(() => expect(getBondLots).toHaveBeenCalledTimes(2));
    expect(argonBonds.data.bondHistory[0]?.flexibilityHistory).toEqual([]);
    expect(argonBonds.data.financialRevision).toBe(initialRevision);
    refreshedLots.resolve([lot]);

    await vi.waitFor(async () => {
      expect(await db.syncStateTable.get(SyncStateKeys.BondHistory)).toMatchObject({ blockNumber: 102 });
      expect(argonBonds.data.historyCoveragePending).toBe(false);
      expect(argonBonds.data.bondHistory[0]?.flexibilityHistory).toEqual([
        expect.objectContaining({ isFlexible: true, blockNumber: 101 }),
      ]);
    });

    const financialRevision = argonBonds.data.financialRevision;
    blockWatch.finalizedBlockHeader = { blockNumber: 103, blockHash: '0x103', frameId: 4 };
    expect(onFinalized).toBeDefined();
    onFinalized?.([{ blockNumber: 103 }]);
    expect(argonBonds.data.historyCoveragePending).toBe(false);
    eventsAt103.resolve([]);
    await vi.waitFor(async () => {
      expect(await db.syncStateTable.get(SyncStateKeys.BondHistory)).toMatchObject({ blockNumber: 103 });
      expect(argonBonds.data.historyCoveragePending).toBe(false);
      expect(argonBonds.data.financialRevision).toBe(financialRevision);
    });

    blockWatch.getCurrentApi.mockRejectedValueOnce(new Error('offline'));
    blockWatch.finalizedBlockHeader = { blockNumber: 104, blockHash: '0x104', frameId: 4 };
    onFinalized?.([{ blockNumber: 104 }]);
    await vi.waitFor(() => expect(argonBonds.data.historyError).toContain('offline'));
    expect(argonBonds.data.bondHistory[0]?.flexibilityHistory).toHaveLength(1);

    // A user retry republishes the already-committed block without waiting for another finality event.
    await argonBonds.retryHistory();
    expect(argonBonds.data.historyError).toBeUndefined();
    expect(argonBonds.data.bondHistory[0]?.flexibilityHistory).toHaveLength(2);

    blockWatch.finalizedBlockHeader = { blockNumber: 105, blockHash: '0x105', frameId: 4 };
    onFinalized?.([{ blockNumber: 105 }]);
    await vi.waitFor(async () => {
      expect(await db.syncStateTable.get(SyncStateKeys.BondHistory)).toMatchObject({ blockNumber: 105 });
      expect(argonBonds.data.historyError).toBeUndefined();
      expect(argonBonds.data.bondHistory[0]?.flexibilityHistory).toHaveLength(2);
    });
    getBondLots.mockRestore();
  });

  it('retains one bond investment through recovered pre-flexibility-name transitions', async () => {
    const db = await createTestDb();
    const lotCodec = createRuntimeBondLot({
      owner: accountId,
      program: { Vault: { vaultId: 4, sharingPercent: 0, bonusPercent: 0 } },
      bonds: 10,
      createdFrameId: 3,
      participatedFrames: 2,
      lastFrameEarningsFrameId: 4,
      lastFrameEarnings: 1_000_000n,
      cumulativeEarnings: 2_000_000n,
      isFlexible: true,
      releaseFrameId: null,
      releaseReason: null,
    });
    const block = {
      blockNumber: 110,
      blockHash: '0x110',
      blockTime: new Date('2026-07-02T12:00:00Z').getTime(),
      isFinalized: true,
    };
    const argonBonds = new ArgonBonds(
      Promise.resolve(db),
      { isLoadedPromise: Promise.resolve(), upstreamOperator: undefined },
      new Currency({ events: { on: vi.fn() } } as any),
      {
        blockWatch: {
          getApi: vi.fn(async () => ({ query: { treasury: { bondLotById: vi.fn(async () => lotCodec) } } })),
        },
      } as any,
      { defaultArgonAddress: accountId } as any,
    );
    const event = {
      event: {
        section: 'treasury',
        method: 'BondLotBackfillChanged',
        data: { vaultId: 4, bondLotId: 7, isBackfill: true },
      },
      phase: { type: 'ApplyExtrinsic', value: 2 },
    } as any;

    await argonBonds.importHistoryBlock(block as any, [event]);
    await argonBonds.importHistoryBlock(block as any, [event]);
    expect(await db.bondLotHistoryTable.fetchAll(accountId)).toEqual([]);
    await argonBonds.publishRecoveredHistory();

    const history = await db.bondLotHistoryTable.fetchAll(accountId);
    const transitions = history[0]?.flexibilityHistory;
    expect(transitions).toEqual([
      expect.objectContaining({
        isFlexible: true,
        source: 'flexibility-change',
        blockNumber: 110,
        blockTime: new Date(block.blockTime),
      }),
    ]);
    const positions = new ArgonBondsFinancials(argonBonds).createFinancialPositions({
      bondLots: [BondLot.fromRuntime(7, lotCodec, accountId)],
      historyRecords: history,
      frameDates: new Map([[3, new Date('2026-07-01T12:00:00Z')]]),
    });
    expect(positions).toEqual([
      expect.objectContaining({
        lifecycle: 'active',
        startedAt: new Date('2026-07-01T12:00:00Z'),
        investedCost: 10_000_000n,
        paidIncome: 2_000_000n,
      }),
    ]);
    expect(calculatePositionReturn(positions)).toMatchObject({
      availability: 'unavailable',
      paidIncome: 2_000_000n,
    });
  });

  it('retains each flexibility change when a lot changes repeatedly in one extrinsic', async () => {
    const db = await createTestDb();
    const lotCodec = createRuntimeBondLot({
      owner: accountId,
      program: { Vault: { vaultId: 4, sharingPercent: 0, bonusPercent: 0 } },
      bonds: 10,
      createdFrameId: 3,
      participatedFrames: 0,
      lastFrameEarningsFrameId: null,
      lastFrameEarnings: null,
      cumulativeEarnings: 0,
      isFlexible: true,
      releaseFrameId: null,
      releaseReason: null,
    });
    const block = {
      blockNumber: 110,
      blockHash: '0x110',
      blockTime: new Date('2026-07-02T12:00:00Z').getTime(),
      isFinalized: true,
    };
    const argonBonds = new ArgonBonds(
      Promise.resolve(db),
      { isLoadedPromise: Promise.resolve(), upstreamOperator: undefined },
      new Currency({ events: { on: vi.fn() } } as any),
      {
        blockWatch: {
          getApi: vi.fn(async () => ({ query: { treasury: { bondLotById: vi.fn(async () => lotCodec) } } })),
        },
      } as any,
      { defaultArgonAddress: accountId } as any,
    );
    await argonBonds.importHistoryBlock(block as any, [
      {
        event: { section: 'treasury', method: 'BondLotFlexibilityChanged', data: { bondLotId: 7, isFlexible: true } },
        phase: { type: 'ApplyExtrinsic', value: 2 },
      } as any,
      {
        event: { section: 'treasury', method: 'BondLotFlexibilityChanged', data: { bondLotId: 7, isFlexible: false } },
        phase: { type: 'ApplyExtrinsic', value: 2 },
      } as any,
      {
        event: { section: 'treasury', method: 'BondLotFlexibilityChanged', data: { bondLotId: 7, isFlexible: true } },
        phase: { type: 'ApplyExtrinsic', value: 2 },
      } as any,
    ]);
    expect(await db.bondLotHistoryTable.fetchAll(accountId)).toEqual([]);
    await argonBonds.publishRecoveredHistory();

    const [history] = await db.bondLotHistoryTable.fetchAll(accountId);
    expect(history.flexibilityHistory).toEqual([
      expect.objectContaining({ isFlexible: true, extrinsicIndex: 2, eventIndex: 0 }),
      expect.objectContaining({ isFlexible: false, extrinsicIndex: 2, eventIndex: 1 }),
      expect.objectContaining({ isFlexible: true, extrinsicIndex: 2, eventIndex: 2 }),
    ]);
    expect(history.flexibilityHistoryComplete).toBe(true);
  });

  it.each([
    { specVersion: 156, changes: [] },
    { specVersion: 157, changes: [true] },
    { specVersion: 157, changes: [true, false, true] },
    { specVersion: 158, changes: [] },
    { specVersion: 158, changes: [true] },
    { specVersion: 158, changes: [true, false] },
    { specVersion: 159, changes: [true, false, true] },
    { specVersion: 160, changes: [true] },
  ])(
    'keeps live and recovered purchase history equal for spec $specVersion with changes $changes',
    async ({ specVersion, changes }) => {
      const liveDb = await createTestDb();
      const recoveredDb = await createTestDb();
      const block: IBlockHeaderInfo = {
        blockNumber: 100,
        blockHash: '0x100',
        parentHash: '0x99',
        blockTime: new Date('2026-07-02T12:00:00Z').getTime(),
        isFinalized: true,
        author: accountId,
        tick: 100,
        frameId: 3,
      };
      const { isFlexible: _, ...ordinaryLot } = createRuntimeBondLot({
        owner: accountId,
        program: { Vault: { vaultId: 4, sharingPercent: 0, bonusPercent: 0 } },
        bonds: 10,
        createdFrameId: 3,
        participatedFrames: 0,
        lastFrameEarningsFrameId: null,
        lastFrameEarnings: null,
        cumulativeEarnings: 0,
        isFlexible: false,
        releaseFrameId: null,
        releaseReason: null,
      });
      // Specs 157, 158 and 159 create ordinary lots. A setter emits only when
      // it changes the value, so the first post-purchase event must enable it.
      // Storage is the final state of the block, after all those events.
      const finalFlexibility = changes.at(-1) ?? false;
      const storedLot = {
        ...ordinaryLot,
        ...(specVersion === 157 ? { isBackfill: finalFlexibility } : {}),
        ...(specVersion >= 158 ? { isFlexible: finalFlexibility } : {}),
      } satisfies NonNullable<HistoricalQueryRecord<'treasury', 'bondLotById'>>;
      const events: RuntimeSystemEventRecord[] = [
        {
          event: {
            section: 'treasury',
            method: 'BondLotPurchased',
            data: { accountId, bondLotId: 7, bonds: 10, programId: { type: 'Vault', value: { vaultId: 4 } } },
          },
          phase: { type: 'ApplyExtrinsic', value: 2 },
          topics: [],
        },
        ...changes.map(
          (isFlexible): RuntimeSystemEventRecord => ({
            event:
              specVersion === 157
                ? {
                    section: 'treasury',
                    method: 'BondLotBackfillChanged',
                    data: { vaultId: 4, bondLotId: 7, isBackfill: isFlexible },
                  }
                : {
                    section: 'treasury',
                    method: 'BondLotFlexibilityChanged',
                    data: { vaultId: 4, bondLotId: 7, isFlexible },
                  },
            phase: { type: 'ApplyExtrinsic', value: 2 },
            topics: [],
          }),
        ),
      ];
      let currentLot =
        specVersion === 160
          ? (toPlain(
              registry.createType('PalletTreasuryBondLot', {
                ...ordinaryLot,
                program: { Vault: { vaultId: 4, sharingPercent: 0, bonusPercent: 0 } },
                isFlexible: finalFlexibility,
                lockedFrameTerms: null,
              }),
            ) as NonNullable<LiveQueryRecord<'treasury', 'bondLotById'>>)
          : { ...ordinaryLot, isFlexible: finalFlexibility };
      const api = {
        query: {
          treasury: {
            bondLotIdsByAccount: { keys: async () => [{ args: [accountId, 7] }] },
            bondLotById: Object.assign(async () => currentLot, { multi: async () => [currentLot] }),
          },
        },
      };
      const miningFrames = {
        load: async () => undefined,
        blockWatch: {
          bestBlockHeader: block,
          finalizedBlockHeader: block,
          start: async () => undefined,
          events: { on: () => () => undefined },
          getHeader: async () => block,
          getApi: async () => api,
          getCurrentApi: async () => api,
          getEvents: async () => events,
        },
      } as unknown as MiningFrames;
      const currency = new Currency({ events: { on: vi.fn() } } as any);
      currency.isLoadedPromise = Promise.resolve();
      const createBonds = (db: typeof liveDb) =>
        new ArgonBonds(
          Promise.resolve(db),
          { isLoadedPromise: Promise.resolve(), upstreamOperator: undefined },
          currency,
          miningFrames,
          { defaultArgonAddress: accountId } as any,
        );
      await liveDb.syncStateTable.upsert(SyncStateKeys.BondHistory, {
        accountId,
        blockNumber: 99,
        blockHash: '0x99',
      });
      const live = createBonds(liveDb);
      await live.load();
      await live.recordFinalizedTransaction(block.blockNumber);
      await recoveredDb.syncStateTable.upsert(SyncStateKeys.BondHistory, {
        accountId,
        blockNumber: 100,
        blockHash: '0x100',
      });
      const recovered = createBonds(recoveredDb);
      await recovered.load();
      const revisionBeforeRecovery = recovered.data.financialRevision;
      await recovered.importHistoryBlock(block, events);
      expect(await recoveredDb.bondLotHistoryTable.fetchAll(accountId)).toEqual(recovered.data.bondHistory);
      expect(recovered.data.bondHistory[0]?.purchaseBlockNumber).toBeUndefined();
      expect(recovered.data.bondLots).toEqual(live.data.bondLots);
      await recovered.publishRecoveredHistory();
      expect(recovered.data.financialRevision).toBeGreaterThan(revisionBeforeRecovery);

      const [liveHistory] = await liveDb.bondLotHistoryTable.fetchAll(accountId);
      const [recoveredHistory] = await recoveredDb.bondLotHistoryTable.fetchAll(accountId);
      const { createdAt: _liveCreated, updatedAt: _liveUpdated, ...liveRecord } = liveHistory;
      const { createdAt: _recoveredCreated, updatedAt: _recoveredUpdated, ...recoveredRecord } = recoveredHistory;
      expect(liveRecord).toEqual(recoveredRecord);
      expect(liveHistory).toMatchObject({
        nativePrincipal: 10_000_000n,
        purchaseBlockNumber: 100,
        purchaseExtrinsicIndex: 2,
        flexibilityHistoryComplete: true,
        flexibilityHistory: changes.map((isFlexible, index) => ({
          isFlexible,
          source: 'flexibility-change',
          eventIndex: index + 1,
        })),
      });
      expect(live.getEarningsHistory(7)).toMatchObject({ lifetimeEarnings: 0n, isComplete: true });
      expect(recovered.getEarningsHistory(7)).toMatchObject({ lifetimeEarnings: 0n, isComplete: true });
      const positions = new ArgonBondsFinancials(live).createFinancialPositions({
        bondLots: live.data.bondLots,
        historyRecords: live.data.bondHistory,
        completedFrame: block.frameId! - 1,
        frameDates: new Map([[3, new Date(block.blockTime)]]),
      });
      expect(positions).toEqual(
        new ArgonBondsFinancials(recovered).createFinancialPositions({
          bondLots: recovered.data.bondLots,
          historyRecords: recovered.data.bondHistory,
          completedFrame: block.frameId! - 1,
          frameDates: new Map([[3, new Date(block.blockTime)]]),
        }),
      );
      expect(positions.at(-1)).toMatchObject({
        lifecycle: 'active',
        investedCost: 10_000_000n,
        paidIncome: 0n,
        returnIsComplete: true,
        startedAt: new Date(block.blockTime),
      });

      expect(positions).toHaveLength(1);
      if (changes.includes(true)) {
        const [missingPayout] = new ArgonBondsFinancials(live).createFinancialPositions({
          bondLots: live.data.bondLots,
          historyRecords: live.data.bondHistory,
          completedFrame: block.frameId!,
          frameDates: new Map([[3, new Date(block.blockTime)]]),
        });
        expect(missingPayout.returnIsComplete).toBe(false);
      }

      const restarted = createBonds(liveDb);
      await restarted.load();
      await restarted.recordFinalizedTransaction(block.blockNumber);
      expect(restarted.data.bondHistory).toEqual([{ ...liveHistory, updatedAt: expect.any(Date) }]);
      expect(restarted.getEarningsHistory(7)).toMatchObject({ lifetimeEarnings: 0n, isComplete: true });
      currentLot = {
        ...currentLot,
        cumulativeEarnings: 1_000_000n,
        participatedFrames: 1,
        lastFrameEarningsFrameId: 4,
        lastFrameEarnings: 1_000_000n,
      };
      await restarted.refreshBondLots(await miningFrames.blockWatch.getCurrentApi());
      const newerLot = BondLot.fromRuntime(
        7,
        {
          ...currentLot,
          isFlexible: currentLot.isFlexible ?? ('isBackfill' in currentLot ? (currentLot.isBackfill ?? false) : false),
        },
        accountId,
      );
      const revisionBeforeBackfill = restarted.data.financialRevision;
      await restarted.importHistoryBlock(block, events);
      await restarted.publishRecoveredHistory();
      expect(restarted.data.bondHistory[0]?.flexibilityHistory).toEqual(liveHistory.flexibilityHistory);
      expect(restarted.data.bondLots).toEqual([newerLot]);
      expect(restarted.data.financialRevision).toBeGreaterThan(revisionBeforeBackfill);
      expect(restarted.needsHistoryRepair).toBe(false);
      expect(restarted.data.historyCoveragePending).toBe(false);
    },
  );

  it('recovers a finalized purchase after local reconciliation fails and the app restarts', async () => {
    const db = await createTestDb();
    const lotCodec = createRuntimeBondLot({
      owner: accountId,
      program: { Vault: { vaultId: 4, sharingPercent: 0, bonusPercent: 0 } },
      bonds: 10,
      createdFrameId: 3,
      participatedFrames: 0,
      lastFrameEarningsFrameId: null,
      lastFrameEarnings: null,
      cumulativeEarnings: 0,
      isFlexible: false,
      releaseFrameId: null,
      releaseReason: null,
    });
    const lot = BondLot.fromRuntime(7, lotCodec, accountId);
    let failedReads = 4;
    const blockWatch = {
      bestBlockHeader: { blockNumber: 100, blockHash: '0x100', frameId: 4 },
      finalizedBlockHeader: { blockNumber: 100, blockHash: '0x100', frameId: 4 },
      start: vi.fn(async () => undefined),
      events: { on: vi.fn(() => () => undefined) },
      getHeader: vi.fn(async (blockNumber: number) => ({
        blockNumber,
        blockHash: `0x${blockNumber}`,
        parentHash: `0x${blockNumber - 1}`,
        blockTime: new Date('2026-07-02T12:00:00Z').getTime(),
        isFinalized: true,
      })),
      getApi: vi.fn(async () => ({ query: { treasury: { bondLotById: vi.fn(async () => lotCodec) } } })),
      getCurrentApi: vi.fn(async () => ({})),
      getEvents: vi.fn(async ({ blockNumber }: { blockNumber: number }) => {
        if (blockNumber !== 99) return [];
        if (failedReads-- > 0) throw new Error('archive temporarily unavailable');
        return [
          {
            event: { section: 'treasury', method: 'BondLotPurchased', data: { accountId, bondLotId: 7 } },
            phase: { type: 'ApplyExtrinsic', value: 2 },
          },
        ];
      }),
    };
    const createBonds = () =>
      new ArgonBonds(
        Promise.resolve(db),
        { isLoadedPromise: Promise.resolve(), upstreamOperator: undefined },
        { isLoadedPromise: Promise.resolve(), fetchMainchainRatesAtBlock: vi.fn() } as any,
        { load: vi.fn(async () => undefined), blockWatch } as any,
        { defaultArgonAddress: accountId } as any,
      );
    const getBondLots = vi.spyOn(TreasuryBonds, 'getBondLotsByAccount').mockResolvedValue([lot]);
    const first = createBonds();
    await first.load();
    await vi.waitFor(() => expect(first.data.historyError).toContain('archive temporarily unavailable'));
    expect(first.data.bondHistory[0]?.purchaseBlockNumber).toBeUndefined();

    const finalized = createDeferred<void>(false);
    const tracker = {
      ensureStoredEvents: vi.fn(async () => {
        throw new Error('receipt temporarily unavailable');
      }),
    };
    new BondBuy(first, { defaultArgonAddress: accountId } as any, tracker as any).resume({
      hasPendingPostProcessing: false,
      createPostProcessor: () => finalized,
      tx: { accountAddress: accountId, blockHeight: 99, status: TransactionStatus.InBlock },
      txResult: { waitForFinalizedBlock: Promise.resolve() },
    } as any);
    await expect(finalized.promise).resolves.toBeUndefined();
    expect((await db.syncStateTable.get(SyncStateKeys.BondHistory))?.blockNumber).toBe(98);

    const restarted = createBonds();
    await restarted.load();
    await vi.waitFor(() => expect(restarted.data.historyError).toContain('archive temporarily unavailable'));
    const revisionBeforeReceipt = restarted.data.financialRevision;
    const receiptProcessed = createDeferred<void>(false);
    new BondBuy(
      restarted,
      { defaultArgonAddress: accountId } as any,
      { ensureStoredEvents: vi.fn(async () => undefined) } as any,
    ).resume({
      hasPendingPostProcessing: false,
      createPostProcessor: () => receiptProcessed,
      tx: { accountAddress: accountId, blockHeight: 99, status: TransactionStatus.InBlock },
      txResult: {
        waitForFinalizedBlock: Promise.resolve(),
        events: [{ section: 'treasury', method: 'BondLotPurchased', data: { accountId, bondLotId: 7 } }],
      },
    } as any);
    await expect(receiptProcessed.promise).resolves.toBeUndefined();
    expect(restarted.data.bondHistory[0]?.purchaseBlockNumber).toBe(99);
    expect(restarted.data.financialRevision).toBeGreaterThan(revisionBeforeReceipt);
    await vi.waitFor(() => expect(failedReads).toBe(0));

    const afterAnotherRestart = createBonds();
    await afterAnotherRestart.load();
    await vi.waitFor(async () => {
      expect((await db.syncStateTable.get(SyncStateKeys.BondHistory))?.blockNumber).toBe(100);
      expect(afterAnotherRestart.data.bondHistory[0]?.purchaseBlockNumber).toBe(99);
    });
    expect(await db.bondLotHistoryTable.fetchAll(accountId)).toHaveLength(1);
    expect(afterAnotherRestart.data.historyError).toBeUndefined();
    getBondLots.mockRestore();
  });

  it('replays a release schedule without overwriting later observed earnings', async () => {
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
    const bonds = new ArgonBonds(
      Promise.resolve(db),
      { isLoadedPromise: Promise.resolve(), upstreamOperator: undefined },
      new Currency({ events: { on: vi.fn() } } as any),
      {
        blockWatch: {
          getApi: vi.fn(async () => ({
            query: { treasury: { bondLotById: vi.fn(async () => releasingCodec) } },
          })),
        },
      } as any,
      { defaultArgonAddress: accountId } as any,
    );
    const events = [
      {
        event: {
          section: 'treasury',
          method: 'BondLotReleaseScheduled',
          data: { accountId, bondLotId: 7 },
        },
        phase: { type: 'ApplyExtrinsic', value: 2 },
      },
    ] as any;

    await bonds.importHistoryBlock(block as any, events);
    await bonds.publishRecoveredHistory();
    expect((await db.bondLotHistoryTable.fetchAll(accountId))[0]).toMatchObject({
      releaseFrame: 7,
      releaseReason: 'UserLiquidation',
    });

    const laterLot = BondLot.fromRuntime(
      7,
      createRuntimeBondLot({
        owner: accountId,
        program: { Argonot: null },
        bonds: 10,
        createdFrameId: 3,
        participatedFrames: 3,
        lastFrameEarningsFrameId: 5,
        lastFrameEarnings: 2_000_000n,
        cumulativeEarnings: 4_000_000n,
        releaseFrameId: 7,
        releaseReason: 'UserLiquidation',
      }),
      accountId,
    );
    await db.bondLotHistoryTable.recordObservation({ lot: laterLot, blockNumber: 150, blockHash: '0x150' });
    await bonds.importHistoryBlock(block as any, events);
    await bonds.publishRecoveredHistory();
    expect((await db.bondLotHistoryTable.fetchAll(accountId))[0]).toMatchObject({
      releaseFrame: 7,
      releaseReason: 'UserLiquidation',
      cumulativeEarningsMicrogons: 4_000_000n,
    });
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
    );
    argonBonds.data.bondLots = [BondLot.fromRuntime(7, lot, accountId)];
    argonBonds.data.isLoaded = true;
    const getOwnBondLots = vi.spyOn(argonBonds, 'getOwnBondLots');
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
      }),
    ).rejects.toThrow(`ARGN Treasury holds do not match live bond principal for ${accountId}`);
    expect(getOwnBondLots).not.toHaveBeenCalled();
  });

  it('requires release evidence before removing overdue stakes from the balance sheet', async () => {
    const db = await createTestDb();
    const activeLot = createRuntimeBondLot({
      owner: accountId,
      program: { Argonot: null },
      bonds: 20,
      createdFrameId: 4,
      participatedFrames: 2,
      lastFrameEarningsFrameId: 5,
      lastFrameEarnings: 1_000_000n,
      cumulativeEarnings: 2_000_000n,
      releaseFrameId: null,
      releaseReason: null,
    });
    const releasedLot = createRuntimeBondLot({
      owner: accountId,
      program: { Argonot: null },
      bonds: 25,
      createdFrameId: 3,
      participatedFrames: 2,
      lastFrameEarningsFrameId: 4,
      lastFrameEarnings: 1_000_000n,
      cumulativeEarnings: 2_000_000n,
      releaseFrameId: 6,
      releaseReason: 'UserLiquidation',
    });
    const releasingLot = createRuntimeBondLot({
      owner: accountId,
      program: { Argonot: null },
      bonds: 30,
      createdFrameId: 5,
      participatedFrames: 1,
      lastFrameEarningsFrameId: 6,
      lastFrameEarnings: 1_000_000n,
      cumulativeEarnings: 1_000_000n,
      releaseFrameId: 8,
      releaseReason: 'UserLiquidation',
    });
    const argonBonds = new ArgonBonds(
      Promise.resolve(db),
      { isLoadedPromise: Promise.resolve(), upstreamOperator: undefined },
      new Currency({ events: { on: vi.fn() } } as any),
      { getFrameDate: () => new Date('2026-07-01T00:00:00Z') } as any,
      { defaultArgonAddress: accountId } as any,
    );
    argonBonds.data.currentFrameId = 7;
    argonBonds.data.bondLots = [
      BondLot.fromRuntime(8, activeLot, accountId),
      BondLot.fromRuntime(9, releasedLot, accountId),
      BondLot.fromRuntime(10, releasingLot, accountId),
    ];
    argonBonds.data.isLoaded = true;

    const missingHoldAccount = {
      address: accountId,
      wallet: { address: accountId } as WalletForArgon,
      availableMicrogons: 0n,
      reservedMicrogons: 0n,
      availableMicronots: 25_000_000n,
      reservedMicronots: 0n,
      microgonHolds: [],
      micronotHolds: [{ id: { type: 'Treasury' }, amount: 50_000_000n }],
    } as any;
    await expect(new ArgonBondsFinancials(argonBonds).loadPositions({ account: missingHoldAccount })).rejects.toThrow(
      'an overdue release has no verified close event or hold transition',
    );

    const failedReleasePositions = await new ArgonBondsFinancials(argonBonds).loadPositions({
      account: {
        address: accountId,
        wallet: { address: accountId } as WalletForArgon,
        availableMicrogons: 0n,
        reservedMicrogons: 0n,
        availableMicronots: 0n,
        reservedMicronots: 0n,
        microgonHolds: [],
        micronotHolds: [{ id: { type: 'Treasury' }, amount: 75_000_000n }],
      } as any,
    });
    expect(failedReleasePositions).toEqual([
      expect.objectContaining({ id: `bond:${accountId}:argonot:8`, lifecycle: 'active' }),
      expect.objectContaining({ id: `bond:${accountId}:argonot:9`, lifecycle: 'releasing' }),
      expect.objectContaining({ id: `bond:${accountId}:argonot:10`, lifecycle: 'releasing' }),
    ]);

    const ghost = argonBonds.data.bondLots.find(lot => lot.id === 9)!;
    await db.bondLotHistoryTable.recordObservation({
      lot: ghost,
      blockNumber: 100,
      blockHash: '0x100',
      purchase: {
        blockTime: new Date('2026-07-01T00:00:00Z'),
        entryArgonotRateMicrogons: 1_000_000n,
      },
    });
    await db.bondLotHistoryTable.recordRelease({
      lot: ghost,
      parentBlockNumber: 109,
      parentBlockHash: '0x109',
      release: {
        blockNumber: 110,
        blockHash: '0x110',
        blockTime: new Date('2026-07-02T00:00:00Z'),
        closingArgonotRateMicrogons: 1_000_000n,
      },
    });
    await argonBonds.refreshHistory();
    expect(argonBonds.data.bondLots.map(lot => lot.id)).toEqual([8, 10]);

    const positions = await new ArgonBondsFinancials(argonBonds).loadPositions({ account: missingHoldAccount });
    expect(positions).toEqual([
      expect.objectContaining({ id: `bond:${accountId}:argonot:8`, lifecycle: 'active' }),
      expect.objectContaining({ id: `bond:${accountId}:argonot:10`, lifecycle: 'releasing' }),
      expect.objectContaining({ id: `bond:${accountId}:argonot:9`, lifecycle: 'completed' }),
    ]);

    const secondOverdueLot = createRuntimeBondLot({
      owner: accountId,
      program: { Argonot: null },
      bonds: 35,
      createdFrameId: 3,
      participatedFrames: 2,
      lastFrameEarningsFrameId: 4,
      lastFrameEarnings: 1_000_000n,
      cumulativeEarnings: 2_000_000n,
      releaseFrameId: 6,
      releaseReason: 'UserLiquidation',
    });
    argonBonds.data.bondLots.push(BondLot.fromRuntime(11, secondOverdueLot, accountId));
    const heldAccount = {
      ...missingHoldAccount,
      micronotHolds: [{ id: { type: 'Treasury' }, amount: 85_000_000n }],
    };
    const heldPositions = await new ArgonBondsFinancials(argonBonds).loadPositions({ account: heldAccount });
    expect(heldPositions).toContainEqual(
      expect.objectContaining({ id: `bond:${accountId}:argonot:11`, lifecycle: 'releasing' }),
    );
    await expect(new ArgonBondsFinancials(argonBonds).loadPositions({ account: missingHoldAccount })).rejects.toThrow(
      'an overdue release has no verified close event or hold transition',
    );
  });
});

function createRuntimeBondLot(value: unknown): NonNullable<LiveQueryRecord<'treasury', 'bondLotById'>> {
  return toPlain(deployedRegistry.createType('PalletTreasuryBondLot', value)) as NonNullable<
    LiveQueryRecord<'treasury', 'bondLotById'>
  >;
}
