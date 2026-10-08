import BigNumber from 'bignumber.js';
import * as Vue from 'vue';
import { BondLot, MICROGONS_PER_ARGON, MICRONOTS_PER_ARGONOT, type Vault } from '@argonprotocol/apps-core';
import { fn, mocked } from 'storybook/test';
import { TopTab } from '../../src-vue/interfaces/IConfig.ts';
import { OperationalStepId } from '../../src-vue/stores/certificationController.ts';
import { ExtrinsicType, TransactionStatus } from '../../src-vue/lib/db/TransactionsTable.ts';
import { getArgonBonds, getBondTransactionOperations } from '../../src-vue/stores/argonBonds.ts';
import { useFinancials } from '../../src-vue/stores/financials.ts';
import { getMainchainClient } from '../../src-vue/stores/mainchain.ts';
import { getTransactionTracker } from '../../src-vue/stores/transactions.ts';
import { useVaultingStats } from '../../src-vue/stores/vaultingStats.ts';
import { getVaults } from '../../src-vue/stores/vaults.ts';
import { getCurrency } from '../../src-vue/stores/currency.ts';
import { ArgonBonds } from '../../src-vue/lib/ArgonBonds.ts';
import { createScenarioVault } from './createScenarioVault.ts';
import { setupAppScenario } from './setupAppScenario.ts';

type BondPurchaseState =
  | 'loading'
  | 'loadError'
  | 'ready'
  | 'available'
  | 'walletLimited'
  | 'selection'
  | 'ownerFlexibleSelection'
  | 'ownerFlexible'
  | 'ownerFlexibleOverCapacity'
  | 'ownerFlexibleCertificationPending'
  | 'ownerFlexibleCertificationComplete'
  | 'ownerFlexibleNoCapacity'
  | 'ownerFlexibleReserved'
  | 'ownerFlexibleWithdrawal'
  | 'noUpstream'
  | 'ownedNoCapacity'
  | 'belowMinimum'
  | 'lotLimit'
  | 'withdrawalLimited';
type StakePurchaseState = 'loadError' | 'ready' | 'walletLimited' | 'progress' | 'progressError' | 'complete';

export function setupBondPurchaseScenario(state: BondPurchaseState) {
  const ownerFlexible = state.startsWith('ownerFlexible');
  const selectingVault = state === 'selection' || state === 'ownerFlexibleSelection';
  let myVaultId: number | undefined;
  if (selectingVault || state === 'ownedNoCapacity') myVaultId = 12;
  else if (ownerFlexible) myVaultId = 1;

  const hasAvailableBondSpace =
    ['available', 'walletLimited', 'belowMinimum', 'lotLimit', 'withdrawalLimited'].includes(state) ||
    (ownerFlexible && state !== 'ownerFlexibleNoCapacity');
  const { controller, wallets } = setupAppScenario({
    selectedTab: TopTab.ArgonBonds,
    config:
      selectingVault || (hasAvailableBondSpace && !ownerFlexible)
        ? { upstreamOperator: { name: 'Atlas', vaultId: 7 } }
        : undefined,
    myVaultId,
  });
  controller.isLoadedPromise = Promise.resolve();
  controller.hasLoadedInitialOperationalProgress = state !== 'ownerFlexibleCertificationPending';
  if (hasAvailableBondSpace) {
    wallets.defaultArgonWallet.availableMicrogons =
      (state === 'walletLimited' ? 260n : state === 'belowMinimum' ? 80n : 2_000n) * BigInt(MICROGONS_PER_ARGON);
  }
  if (
    state === 'ownerFlexibleOverCapacity' ||
    state === 'ownerFlexibleCertificationPending' ||
    state === 'ownerFlexibleCertificationComplete'
  ) {
    controller.rewardConfig.treasuryMinimumBonds = 300n * BigInt(MICROGONS_PER_ARGON);
  }
  if (state === 'ownerFlexibleCertificationComplete') {
    controller.isCertificationStepComplete = fn(stepId => stepId === OperationalStepId.AcquireArgonBonds);
  }
  let vaults: Vault[] = [];
  if (selectingVault) {
    vaults = [
      createScenarioVault({ vaultId: 7, operatorAccountId: '5AtlasVaultOperator' }),
      createScenarioVault({ vaultId: 12, operatorAccountId: '5NorthstarVaultOperator' }),
    ];
  } else if (state === 'noUpstream') {
    vaults = [
      createScenarioVault({ vaultId: 21, operatorAccountId: '5UnrelatedVaultOperator1' }),
      createScenarioVault({ vaultId: 22, operatorAccountId: '5UnrelatedVaultOperator2' }),
    ];
  } else if (state === 'ownedNoCapacity') {
    vaults = [createScenarioVault({ vaultId: 12, operatorAccountId: '5OwnedVaultOperator' })];
  } else if (ownerFlexible) {
    vaults = [createScenarioVault({ vaultId: 1, operatorAccountId: '5OwnedVaultOperator' })];
  } else if (hasAvailableBondSpace) {
    vaults = [
      createScenarioVault({
        securitizationLocked: 1_052_698_425n,
        securitizedSatoshis: 1_408_910n,
        ratioAdjustedSatoshis: 1_408_910n,
      }),
    ];
  }
  if (state === 'selection') vaults[0].bondProfitSharing = new BigNumber(0.25);
  let refresh = fn(async () => undefined);
  if (state === 'loading') {
    refresh = fn(() => new Promise<void>(() => undefined));
  } else if (state === 'loadError') {
    refresh = fn(async () => {
      throw new Error('The vault index did not respond.');
    });
  }

  mocked(getArgonBonds).mockReturnValue({
    data: Vue.reactive({
      isLoaded: true,
      bondLots: [],
      vaultsById: Object.fromEntries(
        vaults.map(vault => [
          vault.vaultId,
          {
            minimumPurchaseBonds: 100,
            isAtBondLotLimit: state === 'lotLimit',
            flexibleBonds:
              ownerFlexible && vault.vaultId !== 7 ? (state === 'ownerFlexibleNoCapacity' ? 2_168 : 1_900) : 0,
          },
        ]),
      ),
    }),
    bondTotals: BondLot.getTotals([]),
    refreshBondLots: fn(async () => undefined),
    subscribeGlobal: fn(async () => undefined),
    subscribeVault: fn(async () => fn()),
    refreshVault: fn(async () => undefined),
    availableBondSpace: fn(vault => {
      if (state === 'ownedNoCapacity') return 0n;
      if (ownerFlexible && vault.vaultId !== 7) return 2_168n * BigInt(MICROGONS_PER_ARGON);
      if (state === 'lotLimit') return 0n;
      if (state === 'withdrawalLimited') return 300_000_000n;
      if (hasAvailableBondSpace) return 1_026_000_000n;
      return vault.vaultId === 7 ? 120_000_000n : 80_000_000n;
    }),
    availableBondSpaceWithoutFlexibleDisplacement: fn(() =>
      state === 'ownedNoCapacity' || state === 'ownerFlexibleNoCapacity' ? 0n : 268n * BigInt(MICROGONS_PER_ARGON),
    ),
  } as unknown as ReturnType<typeof getArgonBonds>);
  if (state === 'ownerFlexibleReserved' || state === 'ownerFlexibleWithdrawal') {
    wallets.defaultArgonWallet.availableMicrogons = 5_000_000_000n;
    const vault = vaults[0];
    vault.securitization = 2_400_000_000n;
    vault.securitizationTarget = vault.securitization;
    if (state === 'ownerFlexibleWithdrawal') {
      vault.securitizationTarget -= 500_000_000n;
      vault.securitizationReleaseSchedule.set(1_000, {
        lockedCommitments: 0n,
        relockableCommitments: 0n,
        argonWithdrawals: 500_000_000n,
        argonotWithdrawals: 0n,
      });
    }
    const bonds = getArgonBonds();
    Object.assign(bonds.data.vaultsById[vault.vaultId], {
      isLoaded: true,
      regularBonds: 100,
      flexibleBonds: 200,
      reservedBondSpace: 300,
      replacementBonds: 0,
    });
    bonds.getVaultBondCapacityMicrogons = vault => vault.bondCapacityMicrogons(getCurrency().priceIndex);
    bonds.availableBondSpace = ArgonBonds.prototype.availableBondSpace;
    bonds.availableBondSpaceWithoutFlexibleDisplacement =
      ArgonBonds.prototype.availableBondSpaceWithoutFlexibleDisplacement;
  }
  mocked(getBondTransactionOperations).mockReturnValue({
    bondBuy: {
      load: fn(async () => undefined),
      getPendingForVault: fn(() => undefined),
    },
  } as unknown as ReturnType<typeof getBondTransactionOperations>);
  mocked(getVaults, { partial: true }).mockReturnValue({
    load: fn(async () => undefined),
    subscribeToVault: fn<ReturnType<typeof getVaults>['subscribeToVault']>(async (vaultId, callback) => {
      callback(vaults.find(vault => vault.vaultId === vaultId)!);
      return fn();
    }),
    operatorNamesByVaultId: Vue.reactive({
      1: 'Market Vault',
      7: 'Atlas',
      12: 'Northstar',
      21: 'Unrelated One',
      22: 'Unrelated Two',
    }),
    currentState: Vue.reactive({ isLoaded: true, isLoading: false, error: '', statsRevision: 0 }),
    vaultsById: Object.fromEntries(vaults.map(vault => [vault.vaultId, vault])),
    calculateArgonBondsApr: fn(vaultId => (vaultId === 7 ? 14.8 : 11.2)),
  });
  mocked(useFinancials).mockReturnValue(
    Vue.reactive({
      refreshVaults: refresh,
      vaultsActiveRecords: vaults,
    }) as unknown as ReturnType<typeof useFinancials>,
  );
  mocked(getMainchainClient).mockResolvedValue({
    consts: { treasury: { minimumArgonsPerContributor: 100_000_000n } },
  } as unknown as Awaited<ReturnType<typeof getMainchainClient>>);
}

export function setupStakePurchaseScenario(state: StakePurchaseState) {
  const { wallets } = setupAppScenario({ selectedTab: TopTab.ArgonotStaking });
  const unitsPerStake = BigInt(MICRONOTS_PER_ARGONOT);
  wallets.defaultArgonWallet.availableMicronots =
    state === 'walletLimited' ? 25n * unitsPerStake : 1_000n * unitsPerStake;

  mocked(getArgonBonds).mockReturnValue({
    data: Vue.reactive({ isLoaded: true, bondLots: [] }),
    bondTotals: BondLot.getTotals([]),
    refreshBondLots: fn(async () => undefined),
  } as unknown as ReturnType<typeof getArgonBonds>);
  mocked(useVaultingStats).mockReturnValue(
    Vue.reactive({ argonotStakingAPR: 14.8 }) as ReturnType<typeof useVaultingStats>,
  );

  const loadError = state === 'loadError';
  mocked(getMainchainClient).mockImplementation(async () => {
    if (loadError) throw new Error('The stake market could not be refreshed.');

    return {
      query: {
        ownership: { totalIssuance: fn(async () => 10_000n * unitsPerStake) },
        treasury: {
          totalActiveArgonotBonds: fn(async () => 1_000),
          argonotBondLots: fn(async () => [{ bondLotId: 1, bonds: 125 }]),
        },
      },
      consts: {
        treasury: {
          maxActiveArgonotBondLots: 100,
          minimumArgonsPerContributor: unitsPerStake,
          maxArgonotBondedPercentOfCirculation: new BigNumber(0.5),
        },
      },
      tx: { treasury: { buyArgonotBonds: fn() } },
    } as unknown as Awaited<ReturnType<typeof getMainchainClient>>;
  });

  let pendingTx: ReturnType<typeof createStakePurchaseTransaction> | undefined;
  if (state === 'progress' || state === 'progressError' || state === 'complete') {
    pendingTx = createStakePurchaseTransaction(state, unitsPerStake);
  }
  mocked(getBondTransactionOperations).mockReturnValue({
    stakeBuy: {
      load: fn(async () => undefined),
      getPendingPurchase: fn(() => pendingTx),
      submit: fn(async () => {
        throw new Error('Stake purchases are disabled in this fixed preview.');
      }),
    },
  } as unknown as ReturnType<typeof getBondTransactionOperations>);
  mocked(getTransactionTracker).mockReturnValue({
    data: { txInfos: pendingTx ? [pendingTx] : [], txInfosByType: {} },
    load: fn(async () => undefined),
    pendingBlockTxInfosAtLoad: [],
    findLatestTxInfo: fn(() => pendingTx),
  } as unknown as ReturnType<typeof getTransactionTracker>);
}

function createStakePurchaseTransaction(state: 'progress' | 'progressError' | 'complete', unitsPerStake: bigint) {
  return {
    tx: {
      accountAddress: '5SyntheticInternalWallet',
      submissionErrorJson: null,
      blockExtrinsicErrorJson: null,
      extrinsicType: ExtrinsicType.TreasuryBuyArgonotBonds,
      metadataJson: { bondPurchaseMicronots: 200n * unitsPerStake },
      status: TransactionStatus.Submitted,
    },
    txResult: {},
    subscribeToProgress: fn((callback: (progress: object, error?: Error) => void) => {
      queueMicrotask(() => {
        if (state === 'progressError') {
          callback({ progressPct: 43, confirmations: 1, expectedConfirmations: 3 }, new Error('Transaction dropped.'));
          return;
        }

        callback({
          progressPct: state === 'complete' ? 100 : 43,
          confirmations: state === 'complete' ? 3 : 1,
          expectedConfirmations: 3,
        });
      });
      return fn();
    }),
  };
}
