import * as Vue from 'vue';
import { bigIntMin, BondLot, type IBitcoinLock, Vault } from '@argonprotocol/apps-core';
import type { IMemberInvite } from '@argonprotocol/apps-router';

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
} from '../../src-vue/lib/OperationalAccount.ts';
import { getArgonBonds } from '../../src-vue/stores/argonBonds.ts';
import { getBitcoinLocks } from '../../src-vue/stores/bitcoin.ts';
import { getMainchainClient } from '../../src-vue/stores/mainchain.ts';
import { getServerApiClient } from '../../src-vue/stores/server.ts';
import { getTransactionTracker } from '../../src-vue/stores/transactions.ts';
import { getMyVault } from '../../src-vue/stores/vaults.ts';
import type { TransactionInfo } from '../../src-vue/lib/TransactionInfo.ts';
import { createScenarioVault } from './createScenarioVault.ts';
import { setupAppScenario } from './setupAppScenario.ts';

export function setupOperationalProfileScenario(state: 'draft' | 'loadError' | 'settings') {
  const { controller } = setupAppScenario({ selectedTab: TopTab.Onboarding });

  if (state === 'settings') {
    controller.operatorName = 'AtlasOperator';
    const client = {
      tx: {
        bitcoinLocks: { setFlexible: fn() },
        treasury: { setBondLotFlexible: fn() },
        vaults: {},
      },
    } as unknown as Awaited<ReturnType<typeof getMainchainClient>>;
    mocked(getMainchainClient).mockResolvedValue(client);
    mocked(loadOperationalAccount).mockResolvedValue({} as Awaited<ReturnType<typeof loadOperationalAccount>>);
    mocked(getOperationalProfileName).mockReturnValue('AtlasOperator');
    return;
  }

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

  mocked(loadOperationalAccount).mockResolvedValue({} as Awaited<ReturnType<typeof loadOperationalAccount>>);
  mocked(getOperationalProfileName).mockReturnValue('AtlasOperator');
  mocked(getMainchainClient).mockImplementation(async () => {
    if (state === 'loadError') throw new Error('The operational profile could not be loaded.');
    return {} as Awaited<ReturnType<typeof getMainchainClient>>;
  });
}

export function setupFlexibleAssetsScenario(
  state:
    | 'empty'
    | 'loading'
    | 'eligible'
    | 'partiallyDisplaced'
    | 'fullyDisplaced'
    | 'displacementUnavailable'
    | 'progress'
    | 'progressError',
) {
  setupAppScenario({ selectedTab: TopTab.Onboarding });

  if (state === 'empty') return;

  const currentMyVault = getMyVault();
  const createdVault = createScenarioVault({
    securitizationLocked: 1_662_500_000n,
    flexibleSecuritizationLocked: 950_000_000n,
  });
  if (state === 'partiallyDisplaced') createdVault.securitization = 1_282_500_000n;
  if (state === 'fullyDisplaced') createdVault.securitization = 712_500_000n;
  if (state === 'displacementUnavailable') createdVault.flexibleSecuritizationLocked = 0n;
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
    { lockId: 81, securitizedSatoshis: 12_500_000n, securitizationCoverageMicrogons: 475_000_000n, isFlexible: false },
    { lockId: 82, securitizedSatoshis: 25_000_000n, securitizationCoverageMicrogons: 950_000_000n, isFlexible: true },
    { lockId: 83, securitizedSatoshis: 6_250_000n, securitizationCoverageMicrogons: 237_500_000n, isFlexible: false },
  ] satisfies Pick<IBitcoinLock, 'lockId' | 'securitizedSatoshis' | 'securitizationCoverageMicrogons' | 'isFlexible'>[];
  mocked(getMainchainClient).mockResolvedValue({} as Awaited<ReturnType<typeof getMainchainClient>>);
  mocked(getBitcoinLocks).mockReturnValue({
    getAllLocks: fn(() => []),
    getEligibleFlexibleLocks: fn(async () => locks),
  } as unknown as ReturnType<typeof getBitcoinLocks>);
  mocked(getArgonBonds).mockReturnValue({
    refreshVault: fn(async () => undefined),
    getVaultBonds: fn(() => ({ bondLots: bonds })),
    getFlexibleBondDisplacementPercent: fn(() => {
      if (state === 'displacementUnavailable') return;
      if (state === 'partiallyDisplaced') return 50;
      if (state === 'fullyDisplaced') return 100;
      return 0;
    }),
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
            bitcoinChanges: [{ lockId: 81, isBackfill: true }],
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
  state:
    | 'vaultRequired'
    | 'loading'
    | 'loadError'
    | 'currentRuntime'
    | 'onboardingInactive'
    | 'bitcoinSpaceRequired'
    | 'insufficientBitcoinWaiver'
    | 'insufficientBondCapacity'
    | 'setupProgress'
    | 'creating'
    | 'createError',
) {
  const { config, controller } = setupAppScenario({ selectedTab: TopTab.Onboarding });
  if (state === 'vaultRequired') return;

  const currentMyVault = getMyVault();
  const createdVault = createScenarioVault({
    terms: {
      bitcoinAnnualPercentRate: BigNumber(0.034),
      bitcoinBaseFee: 2_000_000n,
    },
  });
  mocked(getMyVault).mockReturnValue({
    ...currentMyVault,
    data: Vue.shallowReactive({ ...currentMyVault.data, createdVault }),
    createdVault,
    vaultId: createdVault.vaultId,
    load: fn(async () => undefined),
    ensureVaultDelegateReady: fn(async () => {
      if (state === 'setupProgress') return createInviteSetupTransaction();
    }),
  } as unknown as ReturnType<typeof getMyVault>);

  if (state !== 'loading' && state !== 'loadError') {
    const getVault = spyOn(Vault, 'get').mockResolvedValue(createdVault);
    const client = {
      tx: {
        bitcoinLocks: {
          setFlexible: fn(),
        },
        treasury: { setBondLotFlexible: fn() },
        operationalAccounts: { setName: fn() },
      },
    } as unknown as Awaited<ReturnType<typeof getMainchainClient>>;
    mocked(getMainchainClient).mockResolvedValue(client);
    mocked(loadOperationalAccount).mockResolvedValue({} as Awaited<ReturnType<typeof loadOperationalAccount>>);
    mocked(getOperationalProfileName).mockReturnValue(
      state === 'onboardingInactive' ? 'Atlas Operator' : 'AtlasOperator',
    );
    mocked(getArgonBonds, { partial: true }).mockReturnValue({
      availableBondSpace: fn(() => (state === 'insufficientBondCapacity' ? 100_000_000n : 300_000_000n)),
    });
    let availableLiquidityMicrogons = 2_000_000_000n;
    if (state === 'bitcoinSpaceRequired') {
      availableLiquidityMicrogons = 500_000n;
    } else if (state === 'insufficientBitcoinWaiver') {
      availableLiquidityMicrogons = 300_000_000n;
    }
    mocked(getBitcoinLocks, { partial: true }).mockReturnValue({
      getLockableBitcoinCapacity: fn(async () => ({
        availableSatoshis: 29_411_764n,
        availableLiquidityMicrogons,
        vaultCapacitySatoshis: 29_411_764n,
        vaultCapacityLiquidityMicrogons: availableLiquidityMicrogons,
      })),
    });
    controller.rewardConfig.treasuryMinimumBonds = 200_000_000n;

    if (state === 'setupProgress' || state === 'creating' || state === 'createError') {
      config.serverDetails.ipAddress = '127.0.0.1';
      mocked(getServerApiClient, { partial: true }).mockReturnValue({
        createInvite: fn(() => {
          if (state === 'creating') return new Promise<IMemberInvite>(() => undefined);
          if (state === 'createError') return Promise.reject(new Error('The invite service is unavailable.'));
          return new Promise<IMemberInvite>(() => undefined);
        }),
      });
    }

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
  return new BondLot(
    id,
    {
      owner: '5SyntheticVaultingWallet',
      program: {
        type: 'Vault',
        value: { vaultId: 7, sharingPercent: new BigNumber(1), bonusPercent: new BigNumber(0.02) },
      },
      bonds: 20 + id - 70,
      createdFrameId: 10_000,
      participatedFrames: 12,
      lastFrameEarningsFrameId: 10_011,
      lastFrameEarnings: 50_000n,
      cumulativeEarnings: 600_000n,
      lockedFrameTerms: null,
      releaseFrameId: null,
      releaseReason: null,
      isFlexible,
    },
    '5SyntheticVaultingWallet',
  );
}

function createInviteSetupTransaction(): TransactionInfo {
  const subscribeToProgress: TransactionInfo['subscribeToProgress'] = callback => {
    queueMicrotask(() =>
      callback({
        progressPct: 54,
        progressMessage: 'Waiting for Argon finalization…',
        confirmations: 1,
        expectedConfirmations: 4,
        isMaxed: false,
      }),
    );
    return fn();
  };

  return {
    subscribeToProgress,
    txResult: { waitForInFirstBlock: new Promise(() => undefined) },
  } as unknown as TransactionInfo;
}
