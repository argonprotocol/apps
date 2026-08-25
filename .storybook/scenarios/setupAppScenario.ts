import * as Vue from 'vue';
import { BondLot, defaultMicrogonsPer, UnitOfMeasurement } from '@argonprotocol/apps-core';
import { PriceIndex } from '@argonprotocol/mainchain';
import BigNumber from 'bignumber.js';
import { createPinia, setActivePinia } from 'pinia';
import { fn, mocked } from 'storybook/test';
import {
  MiningSetupStatus,
  OnboardingSetupStatus,
  TopTab,
  VaultingSetupStatus,
  type IConfig,
} from '../../src-vue/interfaces/IConfig.ts';
import { Config } from '../../src-vue/lib/Config.ts';
import { Currency } from '../../src-vue/lib/Currency.ts';
import { calculatePositionReturn, reduceFinancialPositions } from '../../src-vue/lib/financials/index.ts';
import { GlobalCouncil } from '../../src-vue/lib/GlobalCouncil.ts';
import { MintingAuthorities } from '../../src-vue/lib/MintingAuthorities.ts';
import { getOperationalRewardConfig } from '../../src-vue/lib/OperationalAccount.ts';
import { defaultWalletData, type IWalletData, WalletType } from '../../src-vue/lib/Wallet.ts';
import { WalletForArgon } from '../../src-vue/lib/WalletForArgon.ts';
import { WalletForBitcoin } from '../../src-vue/lib/WalletForBitcoin.ts';
import { getArgonBonds } from '../../src-vue/stores/argonBonds.ts';
import { useBasics } from '../../src-vue/stores/basics.ts';
import { getBitcoinLockCoupons, getBitcoinLocks } from '../../src-vue/stores/bitcoin.ts';
import { getBot } from '../../src-vue/stores/bot.ts';
import { useCertificationController } from '../../src-vue/stores/certificationController.ts';
import { getConfig } from '../../src-vue/stores/config.ts';
import { getCurrency } from '../../src-vue/stores/currency.ts';
import { useFinancials } from '../../src-vue/stores/financials.ts';
import { getDbPromise } from '../../src-vue/stores/helpers/dbPromise.ts';
import {
  getBiddingCalculator,
  getBiddingCalculatorData,
  getMainchainClient,
  getMiningFrames,
  getVaultCalculator,
} from '../../src-vue/stores/mainchain.ts';
import { useMiningAssetBreakdown } from '../../src-vue/stores/miningAssetBreakdown.ts';
import { useMiningStats } from '../../src-vue/stores/miningStats.ts';
import { getMyMiningSeats } from '../../src-vue/stores/myMiningSeats.ts';
import { useTour } from '../../src-vue/stores/tour.ts';
import { getTransactionTracker } from '../../src-vue/stores/transactions.ts';
import { useVaultingAssetBreakdown } from '../../src-vue/stores/vaultingAssetBreakdown.ts';
import { useVaultingStats } from '../../src-vue/stores/vaultingStats.ts';
import {
  getCrosschainHistory,
  getKnownCrosschainSourceIdentities,
  getMyVault,
  getVaults,
} from '../../src-vue/stores/vaults.ts';
import { getWalletKeys, useWallets } from '../../src-vue/stores/wallets.ts';

type ScenarioOptions = {
  selectedTab: TopTab;
  config?: Partial<ReturnType<typeof getConfig>>;
};

export function setupAppScenario({ selectedTab, config: configOverrides = {} }: ScenarioOptions) {
  setActivePinia(createPinia());
  mocked(getDbPromise, { partial: true }).mockReturnValue(Promise.resolve({}));

  const certificationDetails: NonNullable<IConfig['certificationDetails']> = {
    hasSavedMnemonic: false,
    showBonusTooltip: true,
    dismissedCompletionNoticeStepIds: [],
  };
  const setCertificationDetails = fn(
    (details: Partial<NonNullable<IConfig['certificationDetails']>>): NonNullable<IConfig['certificationDetails']> =>
      Object.assign(certificationDetails, details),
  );
  const config = Vue.reactive({
    isLoaded: true,
    isLoadedPromise: Promise.resolve(),
    selectedTab,
    hasExtensionOperations: true,
    hasExtensionTreasury: false,
    miningSetupStatus: MiningSetupStatus.None,
    vaultingSetupStatus: VaultingSetupStatus.None,
    onboardingSetupStatus: OnboardingSetupStatus.None,
    miningBotAccountPreviousHistory: null,
    hasSavedBiddingRules: false,
    hasSavedVaultingRules: false,
    isServerAdded: false,
    isServerInstalled: false,
    isServerInstalling: false,
    serverDetails: Config.getDefault('serverDetails') as IConfig['serverDetails'],
    certificationDetails,
    hasMiningSeats: false,
    biddingRules: Config.getDefault('biddingRules') as IConfig['biddingRules'],
    vaultingRules: Config.getDefault('vaultingRules') as IConfig['vaultingRules'],
    save: fn(async () => undefined),
    setCertificationDetails,
    ...configOverrides,
  });
  const defaultArgonWallet = Vue.reactive<IWalletData<WalletType.argon>>({
    ...defaultWalletData,
    type: WalletType.argon,
    address: '5SyntheticInternalWallet',
    otherTokens: [],
  });
  const miningBotWallet = Vue.reactive({
    ...defaultWalletData,
    type: WalletType.miningBot,
    address: '5SyntheticMiningWallet',
    otherTokens: [],
  });
  const defaultArgonDomainWallet = new WalletForArgon(WalletType.argon, defaultArgonWallet.address, getDbPromise());
  defaultArgonDomainWallet.data = defaultArgonWallet;
  const bitcoinWallet = new WalletForBitcoin(getBitcoinLocks, () => getWalletKeys().liquidLockingAddress);
  bitcoinWallet.data = Vue.reactive(bitcoinWallet.data);
  const wallets = Vue.reactive({
    isLoaded: true,
    ethereumWallets: {
      persistedWallets: [],
      length: 0,
    },
    totalMiningMicrogons: 0n,
    totalVaultingMicrogons: 0n,
    defaultArgonSpendableMicrogons: 0n,
    miningBidMicrogons: 0n,
    miningBidMicronots: 0n,
    miningSeatValue: 0n,
    miningSeatStakedMicronots: 0n,
    miningSeatMicrogons: 0n,
    miningSeatMicronots: 0n,
    defaultArgonWallet,
    miningBotWallet,
    argonWallets: Vue.markRaw({
      defaultArgonWallet: Vue.markRaw(defaultArgonDomainWallet),
    }),
    bitcoinWallet: Vue.markRaw(bitcoinWallet),
  });
  const myVaultData: ReturnType<typeof getMyVault>['data'] = {
    isReady: true,
    createdVault: null,
    metadata: null,
    stats: null,
    argonotCommitment: {
      committedMicronots: 0n,
      encumberedMicronots: 0n,
    },
    pendingCollectRevenue: 0n,
    pendingCosignUtxosById: new Map(),
    pendingOrphanCosignCount: 0,
    releasedExternalUtxoIds: new Set(),
    myPendingBitcoinCosignTxInfosByUtxoId: new Map(),
    nextCollectDueDate: 0,
    nextCosignDueDate: 0,
    expiringCollectAmount: 0n,
    currentFrameId: 0,
    pendingCollectTxInfo: null,
    externalLocks: {},
    pendingAllocateTxInfo: null,
  };

  mocked(getConfig, { partial: true }).mockReturnValue(config);
  mocked(getMainchainClient).mockReturnValue(new Promise(() => undefined));
  mocked(getOperationalRewardConfig).mockReturnValue(new Promise(() => undefined));
  mocked(getBitcoinLocks, { partial: true }).mockReturnValue({
    getAllLocks: fn(() => []),
    load: fn(async () => undefined),
  });
  mocked(getArgonBonds, { partial: true }).mockReturnValue({
    bondTotals: BondLot.getTotals([]),
    load: fn(async () => undefined),
  });
  mocked(getMyMiningSeats, { partial: true }).mockReturnValue({
    activeSeats: {
      seatCount: 0,
      microgonsBidTotal: 0n,
      micronotsStakedTotal: 0n,
      microgonsMinedTotal: 0n,
      micronotsMinedTotal: 0n,
      microgonsMintedTotal: 0n,
      microgonsToBeMined: 0n,
      microgonsToBeMinted: 0n,
      micronotsToBeMined: 0n,
      microgonValueRemaining: 0n,
    },
  });
  mocked(getTransactionTracker, { partial: true }).mockReturnValue({
    load: fn(async () => undefined),
    findLatestTxInfo: fn(() => undefined) as ReturnType<typeof getTransactionTracker>['findLatestTxInfo'],
  });
  mocked(getWalletKeys, { partial: true }).mockReturnValue({
    defaultArgonAddress: defaultArgonWallet.address,
    vaultingAddress: '5SyntheticVaultingWallet',
    liquidLockingAddress: '5SyntheticLiquidLockingWallet',
    exportDefaultArgonPrivateKey: fn(async () => `0x${'12'.repeat(32)}`),
    getMiningBotSubaccounts: fn(async () => ({})),
  });
  mocked(getBot, { partial: true }).mockReturnValue(
    Vue.reactive({
      isReady: false,
      isSyncing: false,
    }),
  );
  useBasics().overlayIsOpen = false;
  mocked(getBitcoinLockCoupons, { partial: true }).mockReturnValue(
    Vue.reactive({ currentCoupon: undefined, refresh: fn(async () => undefined) }),
  );
  mocked(getCurrency, { partial: true }).mockReturnValue(
    Object.assign(Object.create(Currency.prototype) as Currency, {
      _key: UnitOfMeasurement.USD,
      isLoaded: false,
      microgonsPer: { ...defaultMicrogonsPer },
      priceIndex: Object.assign(new PriceIndex(), {
        argonUsdPrice: BigNumber(1),
        argonUsdTargetPrice: BigNumber(1),
        argonotUsdPrice: BigNumber(14),
        btcUsdPrice: BigNumber(68_000),
      }),
      recordsByKey: {
        [UnitOfMeasurement.ARGN]: { key: UnitOfMeasurement.ARGN, symbol: '₳', name: 'Argon' },
        [UnitOfMeasurement.USD]: { key: UnitOfMeasurement.USD, symbol: '$', name: 'Dollar' },
        [UnitOfMeasurement.EUR]: { key: UnitOfMeasurement.EUR, symbol: '€', name: 'Euro' },
        [UnitOfMeasurement.GBP]: { key: UnitOfMeasurement.GBP, symbol: '£', name: 'Pound' },
        [UnitOfMeasurement.INR]: { key: UnitOfMeasurement.INR, symbol: '₹', name: 'Rupee' },
      },
      record: { key: UnitOfMeasurement.USD, symbol: '$', name: 'Dollar' },
      symbol: '$',
      load: fn(async () => undefined),
    }),
  );
  mocked(useFinancials, { partial: true }).mockReturnValue(
    Vue.reactive({
      savingsIsLoaded: false,
      savingsTotalValue: 0n,
      savingsTotalPending: 0n,
      liquidTotalSatoshis: 0n,
      financialPositionAggregate: Vue.shallowRef(reduceFinancialPositions([])),
      historyRecovery: Vue.ref({ state: 'ready' as const, recoveredBlockCount: 0 }),
      historyRecoveryByDomain: Vue.reactive({
        bitcoin: { state: 'ready' as const, recoveredBlockCount: 0 },
        bonds: { state: 'ready' as const, recoveredBlockCount: 0 },
        vaulting: { state: 'ready' as const, recoveredBlockCount: 0 },
      }),
      isHistoryRecoveryInProgress: Vue.ref(false),
      bondSummariesByAsset: Vue.shallowRef({
        ARGN: { currentValue: 0n, returnSummary: calculatePositionReturn([]) },
        ARGNOT: { currentValue: 0n, returnSummary: calculatePositionReturn([]) },
      }),
    }),
  );
  mocked(useMiningAssetBreakdown, { partial: true }).mockReturnValue(
    Vue.reactive({ auctionBidCount: 0, seatActiveCount: 0 }),
  );
  mocked(useVaultingAssetBreakdown, { partial: true }).mockReturnValue(
    Vue.reactive({ securityMicrogons: 0n, securityMicronots: 0n, totalVaultValue: 0n }),
  );
  mocked(useWallets, { partial: true }).mockReturnValue(wallets as unknown as ReturnType<typeof useWallets>);
  mocked(getBiddingCalculator, { partial: true }).mockReturnValue({
    averageAPY: 0,
    fastGrowthRewards: 0n,
    maximumBidAmount: 0n,
    maximumBidAtFastGrowthAPY: 0,
    maximumBidAtSlowGrowthAPY: 0,
    slowGrowthRewards: 0n,
    startingBidAmount: 0n,
    startingBidAtFastGrowthAPY: 0,
    startingBidAtSlowGrowthAPY: 0,
    load: fn(async () => undefined),
    onLoad: fn(() => ({ unsubscribe: fn() })),
    updateBiddingRules: fn(),
    calculateBidAmounts: fn(),
    runProjections: fn(() => ({
      estimatedSeats: 0,
      microgonRequirement: 0n,
      micronotRequirement: 0n,
      capitalCommitment: 0n,
    })),
    calculateTenDayYield: fn(() => 0),
  });
  mocked(getBiddingCalculatorData, { partial: true }).mockReturnValue({
    currentMicronotsForBid: 0n,
    maxPossibleMiningSeatCount: 0,
  });
  mocked(getVaultCalculator, { partial: true }).mockReturnValue({
    epochPoolCapitalTotal: 0n,
    epochPoolRewards: 0n,
    load: fn(async () => undefined),
    calculateBtcSpaceInMicrogons: fn(() => 0n),
    calculateExternalAPY: fn(() => 0),
    calculateExternalPoolCapital: fn(() => 0n),
    calculateExternalRevenue: fn(() => 0n),
    calculateInternalAPY: fn(() => 0),
    calculateInternalBtcRevenue: fn(() => 0n),
    calculateInternalPoolCapital: fn(() => 0n),
    calculateInternalRevenue: fn(() => 0n),
    calculatePercentOfTreasuryClaimed: fn(() => 0),
    calculateSecuritization: fn(() => 0n),
    calculateTotalPoolCapital: fn(() => 0n),
    calculateTotalPoolSpace: fn(() => 0n),
    personalBtcInMicrogons: fn(() => 0n),
  });
  mocked(getMiningFrames, { partial: true }).mockReturnValue({
    currentFrameId: 10_000,
    currentTick: 10_000,
    load: fn(async () => undefined),
    getFrameDate: fn((frameId: number) => new Date(Date.UTC(2026, 7, 15, frameId - 10_000, 0, 0))),
    onTick: fn(() => ({ unsubscribe: fn() })),
  });
  mocked(useMiningStats, { partial: true }).mockReturnValue({ update: fn(async () => undefined) });
  mocked(useVaultingStats, { partial: true }).mockReturnValue({ update: fn(async () => undefined) });
  mocked(getVaults, { partial: true }).mockReturnValue({
    load: fn(async () => undefined),
    operatorNamesByVaultId: Vue.reactive({}),
    vaultsById: {},
    updateRevenue: fn(async () => ({
      synchedToFrame: 0,
      argonotStakingByFrame: [],
      vaultsById: {},
    })),
  });
  const mintingAuthorities = new MintingAuthorities(
    getDbPromise(),
    getWalletKeys(),
    getMiningFrames(),
    getTransactionTracker(),
  );
  Object.assign(mintingAuthorities.data, {
    isReady: true,
  });
  const globalCouncil = new GlobalCouncil(getDbPromise(), getWalletKeys(), getMiningFrames());
  Object.assign(globalCouncil.data, {
    isReady: true,
  });
  mocked(getMyVault, { partial: true }).mockReturnValue({
    data: Vue.shallowReactive(myVaultData),
    createdVault: null,
    mintingAuthorities,
    globalCouncil,
    getCrosschainQueueTxInfos: fn(() => []),
    load: fn(async () => getVaults().load()),
  });
  mocked(getCrosschainHistory, { partial: true }).mockReturnValue({
    data: Vue.reactive({
      records: [],
      isSyncing: false,
      coverageComplete: true,
    }),
    refresh: fn(async () => undefined),
    hasSeenRecipient: fn(() => false),
    getSponsoredTransferValue: fn(() => 0n),
    getTransferTips: fn(() => 0n),
  });
  mocked(getKnownCrosschainSourceIdentities).mockReturnValue(new Map());
  mocked(useTour, { partial: true }).mockReturnValue({ registerPositionCheck: fn() });

  const controller = useCertificationController();
  controller.selectedTab = selectedTab;

  return { config, controller, wallets };
}
