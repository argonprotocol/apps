import BigNumber from 'bignumber.js';
import * as Vue from 'vue';
import {
  BondLot,
  MICROGONS_PER_ARGON,
  NetworkConfig,
  TreasuryBonds,
  type IFrameBondLot,
  type IVaultStats,
} from '@argonprotocol/apps-core';
import type { CurrentRuntimeQueries, RuntimeQueryResult } from '@argonprotocol/runtime-client';
import type { IMemberInvite } from '@argonprotocol/apps-router';
import { fn, mocked } from 'storybook/test';
import { BitcoinLockStatus, type IBitcoinLockRecord } from '../../src-vue/interfaces/IBitcoinLockRecord.ts';
import { TopTab, VaultingSetupStatus } from '../../src-vue/interfaces/IConfig.ts';
import { ArgonBonds } from '../../src-vue/lib/ArgonBonds.ts';
import type { IVaultArgonBondState } from '../../src-vue/lib/ArgonBonds.ts';
import type { IExternalBitcoinLock } from '../../src-vue/lib/MyVault.ts';
import type { IVaultRecord } from '../../src-vue/lib/db/VaultsTable.ts';
import { ArgonBondsFinancials } from '../../src-vue/lib/financials/ArgonBonds.ts';
import { getArgonBonds } from '../../src-vue/stores/argonBonds.ts';
import { getBitcoinLocks } from '../../src-vue/stores/bitcoin.ts';
import { getCurrency } from '../../src-vue/stores/currency.ts';
import { useCertificationController } from '../../src-vue/stores/certificationController.ts';
import { useFinancials } from '../../src-vue/stores/financials.ts';
import { getMainchainClient, getMiningFrames } from '../../src-vue/stores/mainchain.ts';
import { useVaultingAssetBreakdown } from '../../src-vue/stores/vaultingAssetBreakdown.ts';
import { getMyVault, getVaults } from '../../src-vue/stores/vaults.ts';
import { createScenarioVault } from './createScenarioVault.ts';
import { setupAppScenario } from './setupAppScenario.ts';

const microgonsPerArgon = BigInt(MICROGONS_PER_ARGON);
const currentFrameId = 10_004;
const onboardingMemberAccount = '5SyntheticOnboardingMember';
export const onboardingMemberInvite = {
  id: 1,
  name: 'Northstar Member',
  fromName: 'Atlas Operator',
  inviteCode: 'synthetic-onboarding-member',
  defaultAccountId: onboardingMemberAccount,
  createdAt: new Date('2026-08-01T16:00:00.000Z'),
} satisfies IMemberInvite;

export function setupVaultingPortfolioScenario() {
  setupAppScenario({
    selectedTab: TopTab.Vaulting,
    config: {
      vaultingSetupStatus: VaultingSetupStatus.Finished,
      isServerAdded: true,
      isServerInstalled: true,
      hasSavedVaultingRules: true,
      hasExtensionOperations: true,
    },
  });

  useCertificationController().setOperationalInvites([onboardingMemberInvite]);

  const currency = getCurrency();
  currency.microgonsPer.BTC = 12_000n * microgonsPerArgon;
  mocked(getCurrency, { partial: true }).mockReturnValue(
    Object.assign(currency, {
      fetchMicrogonsInCirculation: fn(async () => 10_000_000_000n),
      fetchMicronotsInCirculation: fn(async () => 5_000_000_000n),
    }),
  );

  const createdVault = createScenarioVault({
    securitization: 2_400n * microgonsPerArgon,
    securitizationTarget: 2_400n * microgonsPerArgon,
    securitizationLocked: 2_400n * microgonsPerArgon,
    securitizationPendingActivation: 0n,
    securitizedSatoshis: 23_700_000n,
  });
  const localLocks = [
    createLock(1, BitcoinLockStatus.LockFunded, 13_100_000n, 800n * microgonsPerArgon),
    createLock(2, BitcoinLockStatus.Releasing, 4_500_000n, 450n * microgonsPerArgon),
    createLock(3, BitcoinLockStatus.LockPendingFunding, 3_200_000n, 300n * microgonsPerArgon),
    createLock(4, BitcoinLockStatus.LockFunded, 2_400_000n, 250n * microgonsPerArgon, true),
  ];
  const externalLocks: Record<number, IExternalBitcoinLock> = {
    2_101: createExternalLock(2_101, 3_700_000n, 400n * microgonsPerArgon, false, onboardingMemberAccount),
    2_102: createExternalLock(2_102, 1_900_000n, 200n * microgonsPerArgon, true),
  };
  const operatorBond = createBondLot({ id: 71, accountId: createdVault.operatorAccountId, bonds: 560 });
  const externalBond = createBondLot({
    id: 72,
    accountId: onboardingMemberAccount,
    bonds: 310,
    createdFrame: currentFrameId - 5,
    lifetimeEarnings: 18n * microgonsPerArgon,
  });
  const pendingBond = createBondLot({ id: 73, accountId: '5SyntheticPendingBondOwner', bonds: 170 });
  const bondLots = [operatorBond, externalBond, pendingBond];
  const currentFrameBondLots = [createFrameBondLot(operatorBond, true), createFrameBondLot(externalBond, false)];
  const vaultBondState: IVaultArgonBondState = {
    bondLots,
    regularBonds: 1_040,
    flexibleBonds: 0,
    displacedFlexibleBonds: 0,
    lockedFrameTerms: null,
    reservedBondSpace: 0,
    replacementBonds: 0,
    minimumPurchaseBonds: 100,
    isAtBondLotLimit: false,
    currentFrame: {
      frameId: currentFrameId,
      vaultBonds: 870,
      flexibleBondsEligible: 0,
      bondLots: currentFrameBondLots,
    },
    isLoaded: true,
  };

  const frameCapital = {
    frameId: currentFrameId,
    totalActiveBonds: 8_400n,
    totalSecuritization: 8_400n * microgonsPerArgon,
    targetSecuritization: 10_000n * microgonsPerArgon,
    vaultSecuritizationPositions: {
      [createdVault.vaultId]: {
        operatorAccountId: createdVault.operatorAccountId,
        securitization: createdVault.securitization,
        activatedSecuritization: 2_400n * microgonsPerArgon,
        bitcoinLockedMicrogons: 2_844n * microgonsPerArgon,
        argonotSecuritizationInMicrogons: 0n,
        activeBondMicrogons: 870n * microgonsPerArgon,
      },
    },
  } satisfies NonNullable<RuntimeQueryResult<CurrentRuntimeQueries['treasury']['currentFrameVaultCapital']>>;
  const fullBidPool = 6_000n * microgonsPerArgon;
  const vaultRewardRate = BigNumber(0.51);
  const revenuePotential = TreasuryBonds.vaultRevenuePotential({
    position: frameCapital.vaultSecuritizationPositions[createdVault.vaultId],
    frameCapital,
    fullBidPool,
    percentForVaultPool: vaultRewardRate,
  });

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
  const vaultStats: IVaultStats = {
    openedTick: createdVault.openedTick,
    baseline: {
      feeRevenue: 0n,
      satoshis: 0n,
      bitcoinLocks: 0,
      microgonLiquidityRealized: 0n,
    },
    changesByFrame: [3, 2, 1].map((framesAgo, index) => ({
      frameId: currentFrameId - framesAgo,
      bitcoinFeeRevenue: 1n * microgonsPerArgon,
      bitcoinFeeCouponValueUsed: 0n,
      satoshisAdded: 0n,
      bitcoinLocksCreated: 0,
      microgonLiquidityAdded: 0n,
      securitization: createdVault.securitization,
      securitizationActivated: createdVault.securitization,
      treasuryPool: {
        externalCapital: 310n * microgonsPerArgon,
        vaultCapital: 560n * microgonsPerArgon,
        totalEarnings: BigInt(index + 4) * microgonsPerArgon,
        vaultEarnings: BigInt(index + 4) * microgonsPerArgon,
      },
      uncollectedEarnings: 0n,
    })),
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
    data: Vue.reactive({ financialRevision: 1 }),
    load: fn(async () => undefined),
    getAllLocks: fn(() => localLocks),
    getUtxosForLock: fn(() => []),
    getDisplayLiquidityPromised: fn((lock: IBitcoinLockRecord) => lock.securitizationCoverageMicrogons ?? 0n),
    isSecuritizationHoldExpired: fn(() => false),
    isInactiveForVaultDisplay: fn(() => false),
    isLockFunded: fn((lock: IBitcoinLockRecord) => lock.status === BitcoinLockStatus.LockFunded),
    isReleaseStatus: fn((lock: IBitcoinLockRecord) =>
      [BitcoinLockStatus.Releasing, BitcoinLockStatus.Released].includes(lock.status),
    ),
    utxoTracking: {
      getUtxosForLock: fn(() => []),
      getObservedFundingUtxos: fn(() => []),
      getUnresolvedOrphanRecords: fn(() => []),
      getAllOrphanLifecycleUtxos: fn(() => []),
    },
  } as unknown as ReturnType<typeof getBitcoinLocks>);

  mocked(getArgonBonds).mockReturnValue({
    data: Vue.reactive({
      bondLots: [operatorBond],
      bondHistory: [],
      dailyEarnings: vaultStats.changesByFrame.map(frame => ({
        accountId: operatorBond.owner,
        programType: 'Vault',
        bondLotId: operatorBond.id,
        frameId: frame.frameId,
        earningsMicrogons: 1n * microgonsPerArgon,
        earningsDestination: 'Owner',
        payoutBlockNumber: frame.frameId * 10,
        payoutBlockHash: `0x${frame.frameId.toString(16)}`,
      })),
      financialRevision: 0,
      isLoaded: true,
      vaultId: createdVault.vaultId,
      currentFrameId,
      frameCapital,
      fullBidPool,
      vaultRewardRate,
      averageMicrogonsPerArgonot: 2_000_000n,
      distributableBidPool: 600n * microgonsPerArgon,
      totalActiveBonds: 8_400,
      vaultsById: { [createdVault.vaultId]: vaultBondState },
    }),
    bondTotals: BondLot.getTotals(bondLots),
    getEarningsHistory: ArgonBonds.prototype.getEarningsHistory,
    argonotSecuritizationTarget: fn(({ securitizationMicrogons }) =>
      TreasuryBonds.getVaultArgonotSecuritizationTarget({
        securitizationMicrogons,
        averageMicrogonsPerArgonot: 2_000_000n,
      }),
    ),
    vaultRevenuePotential: fn(() => revenuePotential),
    getVaultBondCapacityMicrogons: fn(() => 2_400n * microgonsPerArgon),
    availableBondSpace: fn(() => 1_360n * microgonsPerArgon),
    subscribeGlobal: fn(async () => undefined),
    refreshVault: fn(async () => undefined),
  } as unknown as ReturnType<typeof getArgonBonds>);

  mocked(useVaultingAssetBreakdown).mockReturnValue(
    Vue.reactive({
      securityMicrogons: 2_400n * microgonsPerArgon,
      securityMicronots: 0n,
      securityMicrogonsPending: 0n,
      securityMicrogonsActivated: 2_400n * microgonsPerArgon,
      securityMicrogonsActivatedPct: 100,
      treasuryBondCapacityMicrogons: 2_400n * microgonsPerArgon,
      treasuryBondCapacityUsedMicrogons: 1_040n * microgonsPerArgon,
      treasuryBondCapacityUsedPct: 43.33,
      treasuryBondPurchaseCapacityBonds: 2_400,
      revenueCapturedPct: revenuePotential.capturedPercent,
    }) as unknown as ReturnType<typeof useVaultingAssetBreakdown>,
  );

  mocked(useFinancials).mockReturnValue(
    Vue.reactive({
      financialPositionAggregate: {
        groupSummaries: {
          vaulting: { state: 'ready', returnSummary: { percent: 12.64, paidIncome: 182_300_000n } },
        },
      },
      getBondFinancialPosition: (bondLot: BondLot) => {
        if (!bondLot.isOwn) return;
        const [position] = new ArgonBondsFinancials({} as never).createFinancialPositions({
          bondLots: [bondLot],
          frameDates: new Map([
            [bondLot.createdFrameId, new Date(Date.UTC(2026, 7, 15 - (currentFrameId - bondLot.createdFrameId), 12))],
          ]),
        });
        return position;
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
    getFrameDate: fn((frameId: number) => new Date(Date.UTC(2026, 7, 15 - (currentFrameId - frameId), 12))),
    getTickStart: fn(getTickStart),
    getTickEnd: fn((frameId: number) => getTickStart(frameId) + NetworkConfig.rewardTicksPerFrame - 1),
    getCurrentFrameProgress: fn(() => 43),
    getFrameRewardTicksRemaining: fn(() => Math.round(NetworkConfig.rewardTicksPerFrame * 0.57)),
    onFrameId: fn(() => ({ unsubscribe: fn() })),
    onTick: fn(() => ({ unsubscribe: fn() })),
  } as unknown as ReturnType<typeof getMiningFrames>);

  mocked(getMainchainClient).mockResolvedValue(createMainchainClient(frameCapital));
}

function createLock(
  id: number,
  status: BitcoinLockStatus,
  satoshis: bigint,
  securitizationCoverageMicrogons: bigint,
  isHistoryRecoveryPending = false,
): IBitcoinLockRecord {
  const createdAt = new Date(Date.UTC(2026, 7, 15 - id, 14, 0, 0));
  return {
    uuid: `synthetic-vault-lock-${id}`,
    lockId: 2_000 + id,
    status,
    securitizedSatoshis: satoshis,
    microgonsAtTargetPerBtc: 6_800n * microgonsPerArgon,
    securitizationCoverageMicrogons,
    securityFees: 0n,
    couponFeesPaid: 0n,
    fundHoldExtensionsByBitcoinExpirationHeight: {},
    fundedSatoshis: status === BitcoinLockStatus.LockPendingFunding ? 0n : satoshis,
    fundingUtxoIds: [],
    cosignVersion: 'v1',
    network: 'regtest',
    hdPath: `m/84'/1'/0'/0/${id}`,
    vaultId: 7,
    isHistoryRecoveryPending,
    createdAt,
    updatedAt: createdAt,
  };
}

function createExternalLock(
  lockId: number,
  satoshis: bigint,
  securitizationCoverageMicrogons: bigint,
  isPending = false,
  ownerAccount = '5SyntheticExternalBitcoinOwner',
): IExternalBitcoinLock {
  return {
    lockId,
    satoshis,
    securitizationCoverageMicrogons,
    isPending,
    isReleasing: false,
    lockDetails: { ownerAccount } as IExternalBitcoinLock['lockDetails'],
  };
}

function createBondLot({
  id,
  accountId,
  bonds,
  createdFrame = currentFrameId,
  lifetimeEarnings = 0n,
}: {
  id: number;
  accountId: string;
  bonds: number;
  createdFrame?: number;
  lifetimeEarnings?: bigint;
}) {
  return new BondLot(
    id,
    {
      owner: accountId,
      program: {
        type: 'Vault',
        value: { vaultId: 7, sharingPercent: new BigNumber(0.2), bonusPercent: new BigNumber(0) },
      },
      bonds,
      createdFrameId: createdFrame,
      participatedFrames: currentFrameId - createdFrame + 1,
      lastFrameEarningsFrameId: null,
      lastFrameEarnings: 0n,
      cumulativeEarnings: lifetimeEarnings,
      lockedFrameTerms: null,
      releaseFrameId: null,
      releaseReason: null,
      isFlexible: false,
    },
    '5SyntheticVaultOperator',
  );
}

function createFrameBondLot(details: BondLot, isOperator: boolean): IFrameBondLot {
  return {
    id: `lot:${details.id}`,
    accountId: details.owner,
    bonds: details.bonds,
    eligibleMicrogons: BigInt(details.bonds) * microgonsPerArgon,
    isOperator,
    details,
  };
}

function createMainchainClient(
  frameCapital: NonNullable<RuntimeQueryResult<CurrentRuntimeQueries['treasury']['currentFrameVaultCapital']>>,
): Awaited<ReturnType<typeof getMainchainClient>> {
  return {
    consts: {
      treasury: {
        palletId: '0x0102030405060708',
        percentForTreasuryReserves: BigNumber(0.03),
        percentForArgonBondPool: BigNumber(0.1),
        percentForVaultPool: BigNumber(0.51),
      },
    },
    registry: {
      createType: () => ({ toU8a: () => new Uint8Array(32) }),
    },
    query: {
      priceIndex: { historicArgonotAverageByFrame: async () => ({ [currentFrameId - 1]: 2_000_000n }) },
      system: {
        account: async () => ({ data: { free: 4_800n * microgonsPerArgon } }),
      },
      treasury: {
        currentFrameVaultCapital: async () => frameCapital,
      },
    },
  } as unknown as Awaited<ReturnType<typeof getMainchainClient>>;
}
