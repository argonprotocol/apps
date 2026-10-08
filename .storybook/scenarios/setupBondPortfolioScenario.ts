import BigNumber from 'bignumber.js';
import * as Vue from 'vue';
import { BondLot, MICROGONS_PER_ARGON, MICRONOTS_PER_ARGONOT } from '@argonprotocol/apps-core';
import { fn, mocked } from 'storybook/test';
import { calculatePositionReturn } from '../../src-vue/lib/financials/index.ts';
import type { IBondFinancialPosition } from '../../src-vue/interfaces/IFinancialPosition.ts';
import { TopTab } from '../../src-vue/interfaces/IConfig.ts';
import { getArgonBonds } from '../../src-vue/stores/argonBonds.ts';
import { useFinancials } from '../../src-vue/stores/financials.ts';
import { getMiningFrames } from '../../src-vue/stores/mainchain.ts';
import { getVaults } from '../../src-vue/stores/vaults.ts';
import { ArgonBonds } from '../../src-vue/lib/ArgonBonds.ts';
import type { IBondLotHistoryRecord } from '../../src-vue/lib/db/BondLotHistoryTable.ts';
import type { IBondEarningsRecord } from '../../src-vue/lib/db/BondEarningsTable.ts';
import { setupAppScenario } from './setupAppScenario.ts';

const microgonsPerArgon = BigInt(MICROGONS_PER_ARGON);
const micronotsPerArgonot = BigInt(MICRONOTS_PER_ARGONOT);

export function setupBondPortfolioScenario(
  programType: BondLot['programType'],
  flexibleBondDisplacementPercent = 0,
  historyComplete = true,
) {
  const selectedTab = programType === 'Vault' ? TopTab.ArgonBonds : TopTab.ArgonotStaking;
  const otherProgramType = programType === 'Vault' ? 'Argonot' : 'Vault';
  const lots = [
    createBondLot({ id: 41, programType, bonds: 12, vaultId: 7, lifetimeEarnings: 720_000n }),
    createBondLot({ id: 42, programType, bonds: 38, vaultId: 12, lifetimeEarnings: 4_200_000n }),
    createBondLot({
      id: 43,
      programType,
      bonds: 7,
      vaultId: 21,
      lifetimeEarnings: 310_000n,
      isReleasing: true,
      releaseFrame: 10_006,
    }),
    createBondLot({ id: 44, programType, bonds: 95, lifetimeEarnings: 18_900_000n }),
    createBondLot({ id: 90, programType: otherProgramType, bonds: 3, vaultId: 7 }),
  ];
  const visibleLots = lots.filter(lot => lot.programType === programType);
  const positions: IBondFinancialPosition[] = visibleLots.slice(0, 3).map((bondLot, index) => {
    const nativePrincipal =
      programType === 'Vault' ? BigInt(bondLot.bonds) * microgonsPerArgon : BigInt(bondLot.bonds) * micronotsPerArgonot;
    const investedCost = programType === 'Vault' ? nativePrincipal : nativePrincipal * 14n;

    return {
      id: `bond-${bondLot.id}`,
      kind: 'bond',
      group: 'bonds',
      label: `${programType} lot ${bondLot.id}`,
      lifecycle: bondLot.isReleasing ? 'releasing' : 'active',
      nativeAsset: bondLot.nativeAsset,
      nativePrincipal,
      bondLot,
      startedAt: new Date(Date.UTC(2026, 7, 15 + bondLot.createdFrameId - 10_005, 12)),
      investedCost,
      currentValue: investedCost + BigInt(index + 1) * 1_500_000n,
      paidIncome: bondLot.cumulativeEarnings + (bondLot.isFlexible ? 2_000_000n : 0n),
      returnIsComplete: historyComplete,
    };
  });
  const bondHistory: IBondLotHistoryRecord[] = visibleLots.map(lot => ({
    id: lot.id,
    accountId: lot.owner,
    programType: lot.programType,
    bondLotId: lot.id,
    vaultId: lot.vaultId,
    nativeAsset: lot.nativeAsset,
    nativePrincipal: BigInt(lot.bonds) * (programType === 'Vault' ? microgonsPerArgon : micronotsPerArgonot),
    createdFrame: lot.createdFrameId,
    firstObservedBlockNumber: 100,
    firstObservedBlockHash: `0x${'11'.repeat(32)}`,
    participatedFrames: 3,
    cumulativeEarningsMicrogons: lot.cumulativeEarnings,
    flexibilityHistory: [],
    flexibilityHistoryComplete: true,
    lastObservedBlockNumber: 202,
    earningsDestination: 'Owner',
    earningsBackfills: [],
    earningsComplete: historyComplete,
    earningsHistoryThroughFrame: 10_006,
    createdAt: new Date('2026-08-11T12:00:00Z'),
    updatedAt: new Date('2026-08-15T12:00:00Z'),
  }));
  const dailyEarnings: IBondEarningsRecord[] = visibleLots.flatMap(lot =>
    [lot.createdFrameId, lot.createdFrameId + 1, lot.createdFrameId + 2].map((frameId, index) => ({
      accountId: lot.owner,
      programType,
      bondLotId: lot.id,
      frameId,
      bonds: lot.bonds,
      isFlexible: lot.isFlexible,
      displacedMicrogons: index === 0 && lot.isFlexible ? 333_334n : 0n,
      earningsMicrogons: [lot.isFlexible ? 2_000_000n : 0n, 0n, lot.cumulativeEarnings][index],
      earningsDestination: index === 0 && lot.isFlexible ? 'Vault' : 'Owner',
      payoutBlockNumber: 200 + index,
      payoutBlockHash: `0x${String(index + 1).repeat(64)}`,
    })),
  );
  const data = Vue.reactive({
    bondHistory,
    dailyEarnings,
    currentFrameId: 10_007,
    isLoaded: true,
    historyError: undefined as string | undefined,
    bondLots: lots,
    vaultId: 7,
    vaultsById: {
      12: {
        bondLots: [lots[1]],
        regularBonds: 0,
        flexibleBonds: lots[1].bonds,
        displacedFlexibleBonds: 0,
        lockedFrameTerms: null,
        reservedBondSpace: 0,
        replacementBonds: 0,
        minimumPurchaseBonds: 100,
        isAtBondLotLimit: false,
        currentFrame: {
          frameId: 10_005,
          vaultBonds: 24,
          flexibleBondsEligible: 24,
          bondLots: [],
        },
        isLoaded: true,
      },
    },
  });

  setupAppScenario({ selectedTab, myVaultId: 7 });

  mocked(getArgonBonds).mockReturnValue({
    data,
    bondTotals: BondLot.getTotals(lots),
    getEarningsHistory: ArgonBonds.prototype.getEarningsHistory,
    getFlexibleBondDisplacementPercent: fn(() => flexibleBondDisplacementPercent),
    load: fn(async () => undefined),
    retryHistory: fn(async () => {
      data.historyError = undefined;
    }),
    subscribeGlobal: fn(async () => undefined),
    subscribeVault: fn(async () => fn()),
  } as unknown as ReturnType<typeof getArgonBonds>);
  mocked(getMiningFrames, { partial: true }).mockReturnValue({
    getFrameDate: fn((frameId: number) => new Date(Date.UTC(2026, 7, 15 + frameId - 10_005, 12))),
  });
  mocked(getVaults).mockReturnValue({
    operatorNamesByVaultId: { 7: 'Atlas', 12: 'Beacon' },
    vaultsById: {
      7: { vaultId: 7, operatorAccountId: '5AtlasOperator' },
      12: { vaultId: 12, operatorAccountId: '5BeaconOperator' },
      21: { vaultId: 21, operatorAccountId: '5UnnamedOperator' },
    },
    subscribeToVault: fn(async () => fn()),
  } as unknown as ReturnType<typeof getVaults>);
  mocked(useFinancials).mockReturnValue(
    Vue.reactive({
      savingsTotalReadyToUse: 250n * microgonsPerArgon,
      historyRecovery: { state: 'ready', recoveredBlockCount: 0 },
      historyRecoveryByDomain: {
        bitcoin: { state: 'ready', recoveredBlockCount: 0 },
        bonds: { state: 'ready', recoveredBlockCount: 0 },
        vaulting: { state: 'ready', recoveredBlockCount: 0 },
      },
      bondSummariesByAsset: {
        ARGN: {
          currentValue: programType === 'Vault' ? 153_400_000n : 0n,
          returnSummary: {
            paidIncome: 23_810_000n,
            availability: historyComplete ? 'available' : 'unavailable',
            percent: historyComplete ? 8.42 : undefined,
          },
        },
        ARGNOT: {
          currentValue: programType === 'Argonot' ? 2_184_000_000n : 0n,
          returnSummary: {
            paidIncome: 23_810_000n,
            availability: historyComplete ? 'available' : 'unavailable',
            percent: historyComplete ? 11.76 : undefined,
          },
        },
      },
      financialPositionAggregate: {
        groupSummaries: {
          bonds: { state: 'ready', positions },
        },
      },
    }) as unknown as ReturnType<typeof useFinancials>,
  );

  return { lots, positions };
}

export function setupBondArchiveScenario(programType: BondLot['programType'], archivedOnly = false) {
  const { positions } = setupBondPortfolioScenario(programType);
  const bonds = getArgonBonds();
  const index = positions.findIndex(position => position.kind === 'bond' && position.bondLot?.id === 42);
  const { bondLot, ...position } = positions[index] as IBondFinancialPosition;
  const history = bonds.data.bondHistory.find(record => record.bondLotId === bondLot!.id)!;
  Object.assign(history, {
    releaseFrame: 10_005,
    releaseBlockNumber: 203,
    releaseBlockHash: `0x${'44'.repeat(32)}`,
    releaseBlockTime: new Date('2026-08-15T12:00:00Z'),
  });
  const archivedPosition: IBondFinancialPosition = {
    ...position,
    history,
    lifecycle: 'completed',
    currentValue: 0n,
    paidIncome: position.paidIncome,
    settledPrincipalValue: position.investedCost,
    endedAt: history.releaseBlockTime,
  };
  positions.splice(index, 1, archivedPosition);
  const activeIds = new Set(positions.flatMap(entry => (entry.bondLot ? [entry.bondLot.id] : [])));
  bonds.data.bondLots = bonds.data.bondLots.filter(lot => activeIds.has(lot.id));
  for (const entry of positions) {
    if (entry.bondLot) entry.currentValue = entry.investedCost;
  }
  if (archivedOnly) {
    bonds.data.bondLots = [];
    positions.splice(0, positions.length, archivedPosition);
  }
  const summary = useFinancials().bondSummariesByAsset[archivedPosition.nativeAsset];
  summary.currentValue = positions.reduce((total, entry) => total + (entry.currentValue ?? 0n), 0n);
  summary.returnSummary = calculatePositionReturn(positions);
  return archivedPosition;
}

function createBondLot(
  overrides: Pick<BondLot, 'id' | 'programType' | 'bonds'> &
    Partial<Pick<BondLot, 'vaultId' | 'isReleasing'>> & { lifetimeEarnings?: bigint; releaseFrame?: number },
) {
  return new BondLot(
    overrides.id,
    {
      owner: '5SyntheticBondOwner',
      program:
        overrides.programType === 'Vault'
          ? {
              type: 'Vault',
              value: {
                vaultId: overrides.vaultId ?? 7,
                sharingPercent: new BigNumber(1),
                bonusPercent: new BigNumber(0.02),
              },
            }
          : { type: 'Argonot' },
      bonds: overrides.bonds,
      createdFrameId: 10_000 + overrides.id - 40,
      participatedFrames: 3,
      lastFrameEarningsFrameId: 10_004,
      lastFrameEarnings: 95_000n,
      cumulativeEarnings: overrides.lifetimeEarnings ?? 0n,
      lockedFrameTerms: null,
      releaseFrameId: overrides.releaseFrame ?? null,
      releaseReason: overrides.isReleasing ? { type: 'UserLiquidation' } : null,
      isFlexible: overrides.id % 2 === 0,
    },
    '5SyntheticBondOwner',
  );
}
