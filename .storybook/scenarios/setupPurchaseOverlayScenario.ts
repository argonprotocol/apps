import * as Vue from 'vue';
import { BondLot, MICROGONS_PER_ARGON, MICRONOTS_PER_ARGONOT } from '@argonprotocol/apps-core';
import { fn, mocked } from 'storybook/test';
import { TopTab } from '../../src-vue/interfaces/IConfig.ts';
import { ExtrinsicType, TransactionStatus } from '../../src-vue/lib/db/TransactionsTable.ts';
import { getArgonBonds } from '../../src-vue/stores/argonBonds.ts';
import { useFinancials } from '../../src-vue/stores/financials.ts';
import { getMainchainClient } from '../../src-vue/stores/mainchain.ts';
import { getTransactionTracker } from '../../src-vue/stores/transactions.ts';
import { useVaultingStats } from '../../src-vue/stores/vaultingStats.ts';
import { getVaults } from '../../src-vue/stores/vaults.ts';
import { createScenarioVault } from './createScenarioVault.ts';
import { setupAppScenario } from './setupAppScenario.ts';

type BondPurchaseState =
  | 'loading'
  | 'loadError'
  | 'ready'
  | 'available'
  | 'walletLimited'
  | 'selection'
  | 'noUpstream'
  | 'ownedNoCapacity';
type StakePurchaseState = 'loadError' | 'ready' | 'walletLimited' | 'progress' | 'progressError' | 'complete';

export function setupBondPurchaseScenario(state: BondPurchaseState) {
  const { wallets } = setupAppScenario({
    selectedTab: TopTab.ArgonBonds,
    config: state === 'selection' ? { upstreamOperator: { name: 'Atlas', vaultId: 7 } } : undefined,
    myVaultId: state === 'selection' || state === 'ownedNoCapacity' ? 12 : undefined,
  });
  const hasAvailableBondSpace = state === 'available' || state === 'walletLimited';
  if (hasAvailableBondSpace) {
    wallets.defaultArgonWallet.availableMicrogons =
      (state === 'walletLimited' ? 26n : 2_000n) * BigInt(MICROGONS_PER_ARGON);
  }
  const vaults =
    state === 'selection'
      ? [
          createScenarioVault({ vaultId: 7, operatorAccountId: '5AtlasVaultOperator' }),
          createScenarioVault({ vaultId: 12, operatorAccountId: '5NorthstarVaultOperator' }),
        ]
      : state === 'noUpstream'
        ? [
            createScenarioVault({ vaultId: 21, operatorAccountId: '5UnrelatedVaultOperator1' }),
            createScenarioVault({ vaultId: 22, operatorAccountId: '5UnrelatedVaultOperator2' }),
          ]
        : state === 'ownedNoCapacity'
          ? [createScenarioVault({ vaultId: 12, operatorAccountId: '5OwnedVaultOperator' })]
          : hasAvailableBondSpace
            ? [
                createScenarioVault({
                  securitizationLocked: 1_052_698_425n,
                  securitizedSatoshis: 1_408_910n,
                  ratioAdjustedSatoshis: 1_408_910n,
                }),
              ]
            : [];
  let refresh = fn(async () => undefined);
  if (state === 'loading') {
    refresh = fn(() => new Promise<void>(() => undefined));
  } else if (state === 'loadError') {
    refresh = fn(async () => {
      throw new Error('The vault index did not respond.');
    });
  }

  mocked(getArgonBonds).mockReturnValue({
    data: Vue.reactive({ isLoaded: true, bondLots: [] }),
    bondTotals: BondLot.getTotals([]),
    refreshBondLots: fn(async () => undefined),
    subscribeGlobal: fn(async () => undefined),
    subscribeVault: fn(async () => fn()),
    availableBondSpace: fn(vault => {
      if (state === 'ownedNoCapacity') return 0n;
      if (hasAvailableBondSpace) return 1_026_000_000n;
      return vault.vaultId === 7 ? 120_000_000n : 80_000_000n;
    }),
  } as unknown as ReturnType<typeof getArgonBonds>);
  mocked(getVaults, { partial: true }).mockReturnValue({
    load: fn(async () => undefined),
    operatorNamesByVaultId: Vue.reactive({
      1: 'Market Vault',
      7: 'Atlas',
      12: 'Northstar',
      21: 'Unrelated One',
      22: 'Unrelated Two',
    }),
    currentState: Vue.reactive({ isLoaded: true, isLoading: false, error: '' }),
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
    consts: { treasury: { minimumArgonsPerContributor: { toBigInt: () => 1_000_000n } } },
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
          maxActiveArgonotBondLots: { toNumber: () => 100 },
          minimumArgonsPerContributor: { toBigInt: () => unitsPerStake },
          maxArgonotBondedPercentOfCirculation: { toNumber: () => 500_000 },
        },
      },
      tx: { treasury: { buyArgonotBonds: fn() } },
    } as unknown as Awaited<ReturnType<typeof getMainchainClient>>;
  });

  let pendingTx: ReturnType<typeof createStakePurchaseTransaction> | undefined;
  if (state === 'progress' || state === 'progressError' || state === 'complete') {
    pendingTx = createStakePurchaseTransaction(state, unitsPerStake);
  }
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
