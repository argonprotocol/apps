import * as Vue from 'vue';
import { BondLot, MICROGONS_PER_ARGON, NetworkConfig, type IFrameBondLot } from '@argonprotocol/apps-core';
import { fn, mocked } from 'storybook/test';
import { BitcoinLockStatus, type IBitcoinLockRecord } from '../../src-vue/interfaces/IBitcoinLockRecord.ts';
import { TopTab, VaultingSetupStatus } from '../../src-vue/interfaces/IConfig.ts';
import type { IVaultArgonBondState } from '../../src-vue/lib/ArgonBonds.ts';
import type { IExternalBitcoinLock } from '../../src-vue/lib/MyVault.ts';
import type { IVaultRecord } from '../../src-vue/lib/db/VaultsTable.ts';
import { getArgonBonds } from '../../src-vue/stores/argonBonds.ts';
import { getBitcoinLocks } from '../../src-vue/stores/bitcoin.ts';
import { useFinancials } from '../../src-vue/stores/financials.ts';
import { getMainchainClient, getMiningFrames } from '../../src-vue/stores/mainchain.ts';
import { useVaultingAssetBreakdown } from '../../src-vue/stores/vaultingAssetBreakdown.ts';
import { getMyVault, getVaults } from '../../src-vue/stores/vaults.ts';
import { createScenarioVault } from './createScenarioVault.ts';
import { setupAppScenario } from './setupAppScenario.ts';

const microgonsPerArgon = BigInt(MICROGONS_PER_ARGON);
const currentFrameId = 10_004;

export function setupVaultingPortfolioScenario() {
  setupAppScenario({
    selectedTab: TopTab.Vaulting,
    config: {
      vaultingSetupStatus: VaultingSetupStatus.Finished,
      isServerAdded: true,
      isServerInstalled: true,
      hasSavedVaultingRules: true,
    },
  });

  const createdVault = createScenarioVault({
    securitization: 2_400n * microgonsPerArgon,
    securitizationLocked: 1_550n * microgonsPerArgon,
    securitizationPendingActivation: 150n * microgonsPerArgon,
    lockedSatoshis: 22_500_000,
    securitizedSatoshis: 22_500_000,
  });
  const localLocks = [
    createLock(1, BitcoinLockStatus.LockedAndMinted, 8_000_000n, 480n * microgonsPerArgon),
    createLock(2, BitcoinLockStatus.Releasing, 4_500_000n, 260n * microgonsPerArgon),
    createLock(3, BitcoinLockStatus.LockPendingFunding, 3_200_000n, 190n * microgonsPerArgon),
    createLock(4, BitcoinLockStatus.LockedAndMinted, 2_400_000n, 140n * microgonsPerArgon, true),
  ];
  const externalLocks: Record<number, IExternalBitcoinLock> = {
    2_101: createExternalLock(2_101, 3_700_000n, 220n * microgonsPerArgon),
    2_102: createExternalLock(2_102, 1_900_000n, 110n * microgonsPerArgon, true),
  };
  const operatorBond = createBondLot({ id: 71, accountId: createdVault.operatorAccountId, bonds: 560 });
  const externalBond = createBondLot({ id: 72, accountId: '5SyntheticExternalBondOwner', bonds: 310 });
  const pendingBond = createBondLot({ id: 73, accountId: '5SyntheticPendingBondOwner', bonds: 170 });
  const bondLots = [operatorBond, externalBond, pendingBond];
  const currentFrameBondLots = [createFrameBondLot(operatorBond, true), createFrameBondLot(externalBond, false)];
  const vaultBondState: IVaultArgonBondState = {
    bondLots,
    ordinaryBonds: 1_040,
    flexibleBonds: 0,
    reservedBondSpace: 0,
    currentFrame: {
      frameId: currentFrameId,
      vaultBonds: 1_040,
      bondLots: currentFrameBondLots,
    },
    isLoaded: true,
  };

  const baseMyVault = getMyVault();
  const metadata: IVaultRecord = {
    id: createdVault.vaultId,
    hdPath: "m/44'/354'/7'/0/0",
    createdAtBlockHeight: 18_500,
    operationalFeeMicrogons: 12n * microgonsPerArgon,
    isClosed: false,
    createdAt: new Date('2026-08-01T16:00:00.000Z'),
    updatedAt: new Date('2026-08-15T16:00:00.000Z'),
  };
  const vaultStats = {
    openedTick: createdVault.openedTick,
    baseline: {
      feeRevenue: 0n,
      satoshis: 0n,
      bitcoinLocks: 0,
      microgonLiquidityRealized: 0n,
    },
    changesByFrame: [],
  };
  const myVaultData = Vue.shallowReactive({
    ...baseMyVault.data,
    isReady: true,
    createdVault,
    metadata,
    stats: vaultStats,
    currentFrameId,
    externalLocks,
  });

  mocked(getMyVault).mockReturnValue({
    ...baseMyVault,
    data: myVaultData,
    createdVault,
    metadata,
    vaultId: createdVault.vaultId,
    walletKeys: { vaultingAddress: '5SyntheticVaultingWallet' },
    load: fn(async () => undefined),
    revenue: fn(() => ({ earnings: 86n * microgonsPerArgon })),
  } as unknown as ReturnType<typeof getMyVault>);

  const baseVaults = getVaults();
  mocked(getVaults).mockReturnValue({
    ...baseVaults,
    stats: Vue.reactive({
      synchedToFrame: currentFrameId,
      argonotStakingByFrame: [],
      vaultsById: { [createdVault.vaultId]: vaultStats },
    }),
  } as unknown as ReturnType<typeof getVaults>);

  mocked(getBitcoinLocks).mockReturnValue({
    load: fn(async () => undefined),
    getAllLocks: fn(() => localLocks),
    getDisplayLiquidityPromised: fn((lock: IBitcoinLockRecord) => lock.liquidityPromised),
    isInactiveForVaultDisplay: fn(() => false),
    isLockedStatus: fn((lock: IBitcoinLockRecord) =>
      [BitcoinLockStatus.LockedAndIsMinting, BitcoinLockStatus.LockedAndMinted].includes(lock.status),
    ),
    isReleaseStatus: fn((lock: IBitcoinLockRecord) =>
      [BitcoinLockStatus.Releasing, BitcoinLockStatus.Released].includes(lock.status),
    ),
  } as unknown as ReturnType<typeof getBitcoinLocks>);

  mocked(getArgonBonds).mockReturnValue({
    data: Vue.reactive({
      bondLots,
      bondHistory: [],
      isLoaded: true,
      vaultId: createdVault.vaultId,
      currentFrameId,
      distributableBidPool: 4_800n * microgonsPerArgon,
      totalActiveBonds: 8_400,
      vaultsById: { [createdVault.vaultId]: vaultBondState },
      capacityStatesByVault: {},
    }),
    bondTotals: BondLot.getTotals(bondLots),
    getVaultBondCapacityMicrogons: fn(() => 1_400n * microgonsPerArgon),
    availableBondSpace: fn(() => 360n * microgonsPerArgon),
    subscribeGlobal: fn(async () => undefined),
    refreshVault: fn(async () => undefined),
  } as unknown as ReturnType<typeof getArgonBonds>);

  mocked(useVaultingAssetBreakdown).mockReturnValue(
    Vue.reactive({
      securityMicrogons: 2_400n * microgonsPerArgon,
      securityMicronots: 0n,
      securityMicrogonsPending: 150n * microgonsPerArgon,
      securityMicrogonsActivated: 1_400n * microgonsPerArgon,
      securityMicrogonsActivatedPct: 58.33,
      treasuryBondCapacityMicrogons: 1_400n * microgonsPerArgon,
      treasuryBondCapacityUsedMicrogons: 1_040n * microgonsPerArgon,
      treasuryBondCapacityUsedPct: 74.29,
      treasuryBondPurchaseCapacityBonds: 1_400,
      revenueCapturedPct: 74.29,
      totalVaultValue: 3_428n * microgonsPerArgon,
    }) as unknown as ReturnType<typeof useVaultingAssetBreakdown>,
  );

  mocked(useFinancials).mockReturnValue(
    Vue.reactive({
      financialPositionAggregate: {
        groupSummaries: {
          vaulting: { returnSummary: { percent: 12.64 } },
        },
      },
    }) as unknown as ReturnType<typeof useFinancials>,
  );

  const frameStartTick = Math.floor(Date.UTC(2026, 7, 15, 12, 0, 0) / NetworkConfig.tickMillis);
  const getTickStart = (frameId: number) => {
    return frameStartTick - (currentFrameId - frameId) * NetworkConfig.rewardTicksPerFrame;
  };
  mocked(getMiningFrames).mockReturnValue({
    currentFrameId,
    currentTick: frameStartTick + 17,
    load: fn(async () => undefined),
    getTickStart: fn(getTickStart),
    getTickEnd: fn((frameId: number) => getTickStart(frameId) + NetworkConfig.rewardTicksPerFrame - 1),
    getCurrentFrameProgress: fn(() => 43),
    getFrameRewardTicksRemaining: fn(() => Math.round(NetworkConfig.rewardTicksPerFrame * 0.57)),
    onFrameId: fn(() => ({ unsubscribe: fn() })),
    onTick: fn(() => ({ unsubscribe: fn() })),
  } as unknown as ReturnType<typeof getMiningFrames>);

  mocked(getMainchainClient).mockResolvedValue(createMainchainClient());
}

function createLock(
  id: number,
  status: BitcoinLockStatus,
  satoshis: bigint,
  liquidityPromised: bigint,
  isHistoryRecoveryPending = false,
): IBitcoinLockRecord {
  const createdAt = new Date(Date.UTC(2026, 7, 15 - id, 14, 0, 0));
  return {
    uuid: `synthetic-vault-lock-${id}`,
    utxoId: 2_000 + id,
    status,
    satoshis,
    liquidityPromised,
    lockedTargetPrice: 6_800n * microgonsPerArgon,
    ratchets: [],
    cosignVersion: 'v1',
    lockDetails: {} as IBitcoinLockRecord['lockDetails'],
    fundingUtxoRecordId: null,
    network: 'regtest',
    hdPath: `m/84'/1'/0'/0/${id}`,
    vaultId: 7,
    isHistoryRecoveryPending,
    createdAt,
    updatedAt: createdAt,
  };
}

function createExternalLock(
  utxoId: number,
  satoshis: bigint,
  liquidityPromised: bigint,
  isPending = false,
): IExternalBitcoinLock {
  return {
    utxoId,
    satoshis,
    liquidityPromised,
    isPending,
    isReleasing: false,
    lockDetails: {} as IExternalBitcoinLock['lockDetails'],
  };
}

function createBondLot({ id, accountId, bonds }: { id: number; accountId: string; bonds: number }) {
  return new BondLot({
    id,
    programType: 'Vault',
    accountId,
    vaultId: 7,
    bonds,
    createdFrame: currentFrameId,
    participatedFrames: 1,
    lastEarningsFrame: null,
    lastEarnings: 0n,
    lifetimeEarnings: 0n,
    lifetimeBondedFrameMicrogons: BigInt(bonds) * microgonsPerArgon,
    sharingPercent: 20,
    bonusPercent: 0,
    releaseFrame: null,
    isReleasing: false,
    isFlexible: false,
    isOwn: accountId === '5SyntheticVaultOperator',
    canRelease: accountId === '5SyntheticVaultOperator',
  });
}

function createFrameBondLot(details: BondLot, isOperator: boolean): IFrameBondLot {
  return {
    id: `lot:${details.id}`,
    accountId: details.accountId,
    bonds: details.bonds,
    prorata: BigInt(details.bonds) * microgonsPerArgon,
    isOperator,
    details,
  };
}

function createMainchainClient(): Awaited<ReturnType<typeof getMainchainClient>> {
  const vaultCapital = new Map([
    [{ toNumber: () => 7 }, { eligibleBonds: { toNumber: () => 1_040 } }],
    [{ toNumber: () => 12 }, { eligibleBonds: { toNumber: () => 7_360 } }],
  ]);

  return {
    consts: {
      treasury: {
        palletId: { toU8a: () => new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]) },
        percentForTreasuryReserves: { toNumber: () => 20 },
      },
    },
    registry: {
      createType: () => ({ toU8a: () => new Uint8Array(32) }),
    },
    query: {
      system: {
        account: async () => ({ data: { free: { toBigInt: () => 4_800n * microgonsPerArgon } } }),
      },
      treasury: {
        currentFrameVaultCapital: async () => ({
          isNone: false,
          unwrap: () => ({ vaults: vaultCapital }),
        }),
      },
    },
  } as unknown as Awaited<ReturnType<typeof getMainchainClient>>;
}
