import * as Vue from 'vue';
import { BondLot, MICROGONS_PER_ARGON, MICRONOTS_PER_ARGONOT } from '@argonprotocol/apps-core';
import { fn, mocked } from 'storybook/test';
import type { IBondFinancialPosition } from '../../src-vue/interfaces/IFinancialPosition.ts';
import { TopTab } from '../../src-vue/interfaces/IConfig.ts';
import { getArgonBonds } from '../../src-vue/stores/argonBonds.ts';
import { useFinancials } from '../../src-vue/stores/financials.ts';
import { getMiningFrames } from '../../src-vue/stores/mainchain.ts';
import { getVaults } from '../../src-vue/stores/vaults.ts';
import { setupAppScenario } from './setupAppScenario.ts';

const microgonsPerArgon = BigInt(MICROGONS_PER_ARGON);
const micronotsPerArgonot = BigInt(MICRONOTS_PER_ARGONOT);

export function setupBondPortfolioScenario(programType: BondLot['programType']) {
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
      investedCost,
      currentValue: investedCost + BigInt(index + 1) * 1_500_000n,
      paidIncome: bondLot.lifetimeEarnings,
    };
  });

  setupAppScenario({ selectedTab });

  mocked(getArgonBonds).mockReturnValue({
    data: Vue.reactive({ isLoaded: true, bondLots: lots, vaultId: 7 }),
    bondTotals: BondLot.getTotals(lots),
    load: fn(async () => undefined),
    subscribeGlobal: fn(async () => undefined),
    subscribeVault: fn(async () => fn()),
  } as unknown as ReturnType<typeof getArgonBonds>);
  mocked(getMiningFrames, { partial: true }).mockReturnValue({
    getFrameDate: fn((frameId: number) => new Date(Date.UTC(2026, 7, 15, 12 + (frameId - 10_000), 0, 0))),
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
          returnSummary: { paidIncome: 23_810_000n, percent: 8.42 },
        },
        ARGNOT: {
          currentValue: programType === 'Argonot' ? 2_184_000_000n : 0n,
          returnSummary: { paidIncome: 23_810_000n, percent: 11.76 },
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

function createBondLot(
  overrides: Partial<ConstructorParameters<typeof BondLot>[0]> &
    Pick<ConstructorParameters<typeof BondLot>[0], 'id' | 'programType' | 'bonds'>,
) {
  return new BondLot({
    accountId: '5SyntheticBondOwner',
    createdFrame: 10_000 + overrides.id - 40,
    participatedFrames: 24,
    lastEarningsFrame: 10_004,
    lastEarnings: 95_000n,
    lifetimeEarnings: 0n,
    lifetimeBondedFrameMicrogons: BigInt(overrides.bonds) * microgonsPerArgon * 24n,
    bonusPercent: 2,
    releaseFrame: null,
    isReleasing: false,
    isFlexible: overrides.id % 2 === 0,
    isOwn: true,
    canRelease: true,
    ...overrides,
  });
}
