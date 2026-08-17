import * as Vue from 'vue';
import { bigIntMin, BondLot } from '@argonprotocol/apps-core';
import { Vault } from '@argonprotocol/mainchain';
import BigNumber from 'bignumber.js';
import { fn, mocked, spyOn } from 'storybook/test';
import { TopTab } from '../../src-vue/interfaces/IConfig.ts';
import { ExtrinsicType, TransactionStatus } from '../../src-vue/lib/db/TransactionsTable.ts';
import {
  buildOperationalActivationRewardClaimTx,
  buildOperationalRewardsClaimTx,
  getOperationalProfileName,
  getOperationalRewardsClaimAvailability,
  loadOperationalAccount,
  usesOperationalProfileNameRuntime,
} from '../../src-vue/lib/OperationalAccount.ts';
import { getArgonBonds } from '../../src-vue/stores/argonBonds.ts';
import { getBitcoinLocks } from '../../src-vue/stores/bitcoin.ts';
import { getMainchainClient } from '../../src-vue/stores/mainchain.ts';
import { getTransactionTracker } from '../../src-vue/stores/transactions.ts';
import { getMyVault } from '../../src-vue/stores/vaults.ts';
import { createScenarioVault } from './createScenarioVault.ts';
import { setupAppScenario } from './setupAppScenario.ts';

export function setupOperationalProfileScenario(state: 'draft' | 'vaultRequired' | 'loadError') {
  setupAppScenario({ selectedTab: TopTab.Onboarding });

  if (state === 'loadError') {
    const currentMyVault = getMyVault();
    const createdVault = createScenarioVault();
    mocked(getMyVault).mockReturnValue({
      ...currentMyVault,
      data: Vue.shallowReactive({ ...currentMyVault.data, createdVault }),
      createdVault,
      vaultId: createdVault.vaultId,
    } as unknown as ReturnType<typeof getMyVault>);
  }

  mocked(usesOperationalProfileNameRuntime).mockReturnValue(state === 'draft');
  mocked(loadOperationalAccount).mockResolvedValue({} as Awaited<ReturnType<typeof loadOperationalAccount>>);
  mocked(getOperationalProfileName).mockReturnValue('AtlasOperator');
  mocked(getMainchainClient).mockImplementation(async () => {
    if (state === 'loadError') throw new Error('The operational profile could not be loaded.');
    return {} as Awaited<ReturnType<typeof getMainchainClient>>;
  });
}

export function setupFlexibleAssetsScenario(state: 'empty' | 'loading' | 'eligible' | 'progress' | 'progressError') {
  setupAppScenario({ selectedTab: TopTab.Onboarding });

  if (state === 'empty') return;

  const currentMyVault = getMyVault();
  const createdVault = createScenarioVault();
  mocked(getMyVault).mockReturnValue({
    ...currentMyVault,
    data: Vue.shallowReactive({ ...currentMyVault.data, createdVault }),
    createdVault,
    vaultId: createdVault.vaultId,
    load: fn(async () => undefined),
  } as unknown as ReturnType<typeof getMyVault>);

  if (state === 'loading') {
    mocked(getMainchainClient).mockReturnValue(new Promise(() => undefined));
    return;
  }

  const bonds = [createFlexibleBond(71, false), createFlexibleBond(72, true), createFlexibleBond(73, false)];
  const locks = [
    { utxoId: 81, satoshis: 12_500_000n, liquidityPromised: 475_000_000n, isFlexible: false },
    { utxoId: 82, satoshis: 25_000_000n, liquidityPromised: 950_000_000n, isFlexible: true },
    { utxoId: 83, satoshis: 6_250_000n, liquidityPromised: 237_500_000n, isFlexible: false },
  ];
  mocked(getMainchainClient).mockResolvedValue({} as Awaited<ReturnType<typeof getMainchainClient>>);
  mocked(getBitcoinLocks).mockReturnValue({
    getAllLocks: fn(() => []),
    getEligibleFlexibleLocks: fn(async () => locks),
  } as unknown as ReturnType<typeof getBitcoinLocks>);
  mocked(getArgonBonds).mockReturnValue({
    refreshVault: fn(async () => undefined),
    getVaultBonds: fn(() => ({ bondLots: bonds })),
  } as unknown as ReturnType<typeof getArgonBonds>);

  if (state === 'progress' || state === 'progressError') {
    mocked(getTransactionTracker).mockReturnValue({
      load: fn(async () => undefined),
      findLatestTxInfo: fn(() => ({
        tx: {
          accountAddress: '5SyntheticVaultingWallet',
          extrinsicType: ExtrinsicType.VaultSetFlexibleAssets,
          status: TransactionStatus.Submitted,
          metadataJson: {
            bitcoinChanges: [{ utxoId: 81, isBackfill: true }],
            bondChanges: [{ bondLotId: 71, isBackfill: true }],
          },
        },
        subscribeToProgress: fn((callback: (progress: object, error?: Error) => void) => {
          queueMicrotask(() =>
            callback(
              { progressPct: 54, progressMessage: 'Waiting for Argon finalization…' },
              state === 'progressError' ? new Error('The transaction was retracted.') : undefined,
            ),
          );
          return fn();
        }),
      })),
    } as unknown as ReturnType<typeof getTransactionTracker>);
  }
}

export function setupMemberInviteScenario(
  state: 'vaultRequired' | 'loading' | 'loadError' | 'currentRuntime' | 'previousRuntime',
) {
  const { controller } = setupAppScenario({ selectedTab: TopTab.Onboarding });
  if (state === 'vaultRequired') return;

  const currentMyVault = getMyVault();
  const createdVault = createScenarioVault({
    terms: {
      bitcoinAnnualPercentRate: BigNumber(0.034),
      bitcoinBaseFee: 2_000_000n,
      treasuryProfitSharing: BigNumber(0.2),
    },
  });
  mocked(getMyVault).mockReturnValue({
    ...currentMyVault,
    data: Vue.shallowReactive({ ...currentMyVault.data, createdVault }),
    createdVault,
    vaultId: createdVault.vaultId,
  } as unknown as ReturnType<typeof getMyVault>);

  if (state === 'currentRuntime' || state === 'previousRuntime') {
    const getVault = spyOn(Vault, 'get').mockResolvedValue(createdVault);
    const client = {
      tx: {
        bitcoinLocks: {
          setFlexible: fn(),
          ...(state === 'previousRuntime' ? { initializeFor: fn() } : {}),
        },
        treasury: { setBondLotFlexible: fn() },
        vaults: { setName: fn() },
      },
    } as unknown as Awaited<ReturnType<typeof getMainchainClient>>;
    mocked(getMainchainClient).mockResolvedValue(client);
    mocked(getArgonBonds, { partial: true }).mockReturnValue({
      availableBondSpace: fn(() => 0n),
    });
    mocked(getBitcoinLocks, { partial: true }).mockReturnValue({
      getLockableBitcoinCapacity: fn(async () => ({
        availableSatoshis: 29_411_764n,
        availableLiquidityMicrogons: 2_000_000_000n,
        vaultCapacitySatoshis: 29_411_764n,
        vaultCapacityLiquidityMicrogons: 2_000_000_000n,
      })),
    });
    controller.rewardConfig.treasuryMinimumBonds = 200_000_000n;
    return () => getVault.mockRestore();
  }

  mocked(getMainchainClient).mockImplementation(() => {
    if (state === 'loading') return new Promise(() => undefined);
    return Promise.reject(new Error('The vault capacity could not be loaded.'));
  });
}

export function setupOperationalRewardsScenario(
  state: 'activationReady' | 'congratulations' | 'claim' | 'treasuryLimited' | 'runtimeUnavailable',
) {
  const { config, controller, wallets } = setupAppScenario({ selectedTab: TopTab.Onboarding });
  wallets.defaultArgonWallet.availableMicrogons = 25_000_000n;
  config.setCertificationDetails({ hasSavedMnemonic: true });
  controller.chainProgress = {
    ...controller.chainProgress,
    hasOperationalAccount: true,
    hasVault: state === 'activationReady',
    hasUniswapTransfer: state === 'activationReady',
    hasTreasuryUniswapTransfer: true,
    hasTreasuryBondParticipation: true,
    hasFirstMiningSeat: state === 'activationReady',
    hasSecondMiningSeat: state === 'activationReady',
    hasBitcoinLock: true,
    availableAccessCodes: 2,
    rewardsEarnedAmount: 8_500_000_000n,
    rewardsCollectedAmount: 2_000_000_000n,
    isUpgradedToOperations: true,
    isOperational: state !== 'activationReady',
  };

  const pendingRewards = 6_500_000_000n;
  const treasuryReserves = state === 'treasuryLimited' ? 2_250_000_000n : 20_000_000_000n;
  mocked(getOperationalRewardsClaimAvailability).mockResolvedValue({
    pendingRewards,
    treasuryReserves,
    claimableNow: bigIntMin(treasuryReserves, pendingRewards),
    minimumClaimAmount: 1_000_000n,
    canClaimRewards: state !== 'runtimeUnavailable',
  });
  mocked(buildOperationalRewardsClaimTx).mockResolvedValue({
    paymentInfo: fn(async () => ({ partialFee: { toBigInt: () => 125_000n } })),
  } as unknown as Awaited<ReturnType<typeof buildOperationalRewardsClaimTx>>);
  mocked(buildOperationalActivationRewardClaimTx).mockResolvedValue({
    paymentInfo: fn(async () => ({ partialFee: { toBigInt: () => 125_000n } })),
  } as unknown as Awaited<ReturnType<typeof buildOperationalActivationRewardClaimTx>>);
}

function createFlexibleBond(id: number, isFlexible: boolean) {
  return new BondLot({
    id,
    programType: 'Vault',
    accountId: '5SyntheticVaultingWallet',
    vaultId: 7,
    bonds: 20 + id - 70,
    createdFrame: 10_000,
    participatedFrames: 12,
    lastEarningsFrame: 10_011,
    lastEarnings: 50_000n,
    lifetimeEarnings: 600_000n,
    lifetimeBondedFrameMicrogons: 240_000_000n,
    bonusPercent: 2,
    releaseFrame: null,
    isReleasing: false,
    isFlexible,
    isOwn: true,
    canRelease: true,
  });
}
