import * as Vue from 'vue';
import { BitcoinNetwork } from '@argonprotocol/bitcoin';
import { UnitOfMeasurement } from '@argonprotocol/apps-core';
import type { IBitcoinLockCouponStatus } from '@argonprotocol/apps-router';
import { TxResult, type IBitcoinLock } from '@argonprotocol/mainchain';
import { ApiPromise } from '@polkadot/api';
import { MockProvider } from '@polkadot/rpc-provider/mock';
import { TypeRegistry } from '@polkadot/types';
import type { u128, u64, Vec } from '@polkadot/types-codec';
import type { ITuple } from '@polkadot/types-codec/types';
import { fn, mocked, spyOn } from 'storybook/test';
import { createScenarioVault } from './createScenarioVault.ts';
import { setupAppScenario } from './setupAppScenario.ts';
import { TopTab } from '../../src-vue/interfaces/IConfig.ts';
import {
  BitcoinLockStatus,
  type IBitcoinLockRecord,
  type IRatchet,
} from '../../src-vue/interfaces/IBitcoinLockRecord.ts';
import { BitcoinUtxoStatus, type IBitcoinUtxoRecord } from '../../src-vue/interfaces/IBitcoinUtxoRecord.ts';
import type {
  IBitcoinLockProcessingDetails,
  IBitcoinLockSummary,
} from '../../src-vue/interfaces/IBitcoinLockSummary.ts';
import {
  ExtrinsicType,
  TransactionStatus,
  type ITransactionRecord,
} from '../../src-vue/interfaces/ITransactionRecord.ts';
import BitcoinLocks, {
  type IBitcoinRatchetMetadata,
  type IBitcoinRatchetPreview,
} from '../../src-vue/lib/BitcoinLocks.ts';
import BitcoinMempool from '../../src-vue/lib/BitcoinMempool.ts';
import BitcoinUtxoTracking from '../../src-vue/lib/BitcoinUtxoTracking.ts';
import type { IExternalBitcoinLock } from '../../src-vue/lib/MyVault.ts';
import { TransactionInfo } from '../../src-vue/lib/TransactionInfo.ts';
import { getBitcoinLockCoupons, getBitcoinLocks } from '../../src-vue/stores/bitcoin.ts';
import { getCurrency } from '../../src-vue/stores/currency.ts';
import { useFinancials } from '../../src-vue/stores/financials.ts';
import { getMainchainClient } from '../../src-vue/stores/mainchain.ts';
import { getMyVault, getVaults } from '../../src-vue/stores/vaults.ts';
import { getWalletKeys } from '../../src-vue/stores/wallets.ts';
import { useVaultingStats } from '../../src-vue/stores/vaultingStats.ts';

export type BitcoinOverlayScenario = ReturnType<typeof setupBitcoinOverlayScenario>;

const scenarioRegistry = new TypeRegistry();
const scenarioMainchainClient = new ApiPromise({
  provider: new MockProvider(scenarioRegistry),
  noInitWarn: true,
});
void scenarioMainchainClient.isReady.catch(() => undefined);
Object.defineProperties(scenarioMainchainClient, {
  query: {
    value: {
      bitcoinLocks: {
        microgonPerBtcHistory: fn(async () =>
          scenarioRegistry.createType<Vec<ITuple<[u64, u128]>>>('Vec<(u64,u128)>', [[10_000, 6_800_000_000n]]),
        ),
      },
      ticks: { currentTick: fn(async () => scenarioRegistry.createType('u64', 10_001)) },
    },
  },
  consts: {
    value: { bitcoinLocks: { maxBtcPriceTickAge: scenarioRegistry.createType('u32', 100) } },
  },
  tx: {
    value: { bitcoinLocks: {} },
  },
});

export function setupBitcoinOverlayScenario() {
  const scenarioStartedAt = new Date('2026-08-17T14:00:00.000Z').getTime();
  const pendingResolvers = new Set<VoidFunction>();
  const cleanupTasks = new Set<VoidFunction>();
  mocked(BitcoinLocks.getFeeRates).mockRestore?.();
  const getFeeRates = spyOn(BitcoinLocks, 'getFeeRates').mockResolvedValue({
    fast: { feeRate: 3n, estimatedMinutes: 10 },
    medium: { feeRate: 1n, estimatedMinutes: 30 },
    slow: { feeRate: 1n, estimatedMinutes: 60 },
  });
  cleanupTasks.add(() => getFeeRates.mockRestore());
  const { config, wallets } = setupAppScenario({
    selectedTab: TopTab.BitcoinLocks,
    config: {
      hasExtensionTreasury: true,
      hasExtensionOperations: true,
      upstreamOperator: {
        name: 'Atlas Operator',
        vaultId: 7,
      },
    },
  });
  // The controller already owns the base scenario's intentionally pending load; only this workflow needs config ready.
  config.isLoadedPromise = Promise.resolve();

  const vault = createScenarioVault({
    vaultId: 7,
    availableBitcoinSpace: fn(() => 2_000_000_000n),
    calculateBitcoinFee: fn(() => 4_500_000n),
  });
  const lock = createBitcoinLock();
  const fundingRecord = createBitcoinUtxo({
    id: 201,
    lockUtxoId: lock.utxoId!,
    status: BitcoinUtxoStatus.FundingUtxo,
    satoshis: lock.satoshis,
  });
  lock.fundingUtxoRecordId = fundingRecord.id;
  lock.fundingUtxoRecord = fundingRecord;

  const locks = Vue.reactive<IBitcoinLockRecord[]>([lock]);
  const lockProcessing = Vue.reactive<IBitcoinLockProcessingDetails>({
    progressPct: 38,
    confirmations: 1,
    expectedConfirmations: 4,
    receivedSatoshis: lock.satoshis,
    isInvalidAmount: false,
  });
  const releaseProcessing = Vue.reactive({
    progressPct: 52,
    confirmations: 2,
    expectedConfirmations: 6,
    releaseError: '',
  });
  const releaseLifecycle = Vue.reactive({
    progressPct: 52,
    confirmations: 2,
    expectedConfirmations: 6,
    error: '',
  });
  const ratchetPreview = Vue.ref<IBitcoinRatchetPreview>({
    additionalLiquidityToMint: 72_000_000n,
    availableVaultFunds: 1_400_000_000n,
    burnAmount: 0n,
    canRatchet: true,
    currentLiquidityPromised: lock.liquidityPromised,
    newLiquidityPromised: lock.liquidityPromised + 72_000_000n,
    ratchetingFee: 1_250_000n,
    requiredVaultFunds: 950_000_000n,
    securitizationToAdd: 0n,
    shortfall: 0n,
    vaultId: lock.vaultId,
  });
  const pendingRatchet = Vue.shallowRef<TransactionInfo<IBitcoinRatchetMetadata>>();
  const releaseVaultWaitProgress = Vue.ref(0);
  const orphanTransactions = new Map<number, TransactionInfo>();
  const mismatchAcceptTransactions = new Map<number, TransactionInfo>();
  const utxoTracking = new BitcoinUtxoTracking({
    dbPromise: new Promise(() => undefined),
    getBitcoinNetwork: () => BitcoinNetwork.Bitcoin,
    getOracleBitcoinBlockHeight: () => 250_020,
    getConfig: () => undefined,
    getMainchainClient: () => new Promise(() => undefined),
    mempool: new BitcoinMempool(),
  });

  function replaceUtxoRecords(records: IBitcoinUtxoRecord[]) {
    utxoTracking.data = Vue.reactive({
      utxosByLockUtxoId: { [lock.utxoId!]: records },
      utxosByKey: {},
      utxosById: Object.fromEntries(records.map(record => [record.id, record])),
    });

    const acceptedFunding = records.find(record => record.status === BitcoinUtxoStatus.FundingUtxo);
    lock.fundingUtxoRecordId = acceptedFunding?.id ?? null;
    lock.fundingUtxoRecord = acceptedFunding;
  }

  replaceUtxoRecords([fundingRecord]);
  utxoTracking.getReleaseLifecycleProgress = fn(() => releaseLifecycle);

  const bitcoinLocks: BitcoinLocks = Object.assign(Object.create(BitcoinLocks.prototype) as BitcoinLocks, {
    data: Vue.reactive({
      pendingLocks: [],
      locksByUtxoId: { [lock.utxoId!]: lock },
      mismatchErrorsByLockUtxoId: {},
      oracleBitcoinBlockHeight: 250_020,
      bitcoinNetwork: BitcoinNetwork.Bitcoin,
      isReconciliationPending: false,
    }),
    orphanReleases: {
      getTransactionInfo: fn((_lockUtxoId: number, record: IBitcoinUtxoRecord) => orphanTransactions.get(record.id)),
      estimatedCandidateReturnArgonTxFee: fn(async () => 125_000n),
      getOrphanReturnFeeQuote: fn(async () => ({
        canAfford: true,
        availableBalance: 25_000_000n,
        txFee: 125_000n,
      })),
      requestOrphanReturn: fn(async () =>
        createScenarioTransactionInfo({
          extrinsicType: ExtrinsicType.BitcoinOrphanedUtxoRelease,
          metadata: {
            releaseKind: 'Orphan',
            utxoId: lock.utxoId!,
            utxoRecordId: fundingRecord.id,
            utxoRef: { txid: fundingRecord.txid, vout: fundingRecord.vout },
          },
          onCleanup: task => cleanupTasks.add(task),
        }),
      ),
    },
    utxoTracking,
    load: fn(async () => undefined),
    getAllLocks: fn(() => locks),
    getLockByUtxoId: fn((utxoId: number) => locks.find(candidate => candidate.utxoId === utxoId)),
    createLockSummary: fn((record: IBitcoinLockRecord) => createBitcoinLockSummary(record)),
    getTable: fn(async () => ({
      getUtxoIdByUuid: fn(async (uuid: string) => locks.find(candidate => candidate.uuid === uuid)?.utxoId),
      getByUtxoId: fn(async (utxoId: number) => locks.find(candidate => candidate.utxoId === utxoId)),
    })),
    getLockProcessingDetails: fn(() => lockProcessing),
    getLockProcessingError: fn((record: IBitcoinLockRecord) => record.blockExtrinsicErrorJson?.message ?? ''),
    getReleaseProcessingDetails: fn(() => releaseProcessing),
    getReleaseLifecycleProgress: fn(() => releaseLifecycle),
    getLatestMismatchAcceptTxInfo: fn(() => Array.from(mismatchAcceptTransactions.values()).at(-1)),
    getMismatchAcceptTxInfo: fn((_record: IBitcoinLockRecord, candidate: Pick<IBitcoinUtxoRecord, 'id'>) =>
      mismatchAcceptTransactions.get(candidate.id),
    ),
    getLockSatoshiAllowedVariance: fn(() => 0),
    getPendingRatchetTxInfo: fn(() => pendingRatchet.value),
    getRatchetPreview: fn(async () => ratchetPreview.value),
    ratchet: fn(async () =>
      createScenarioTransactionInfo<IBitcoinRatchetMetadata>({
        extrinsicType: ExtrinsicType.BitcoinRatchet,
        metadata: { utxoId: lock.utxoId! },
        onCleanup: task => cleanupTasks.add(task),
      }),
    ),
    getLockableBitcoinCapacity: fn(async () => ({
      availableLiquidityMicrogons: 2_000_000_000n,
      availableSatoshis: 29_411_764n,
      vaultCapacitySatoshis: 29_411_764n,
    })),
    minimumSatoshiPerLock: fn(async () => 100_000n),
    satoshisForArgonLiquidity: fn(async (microgons: bigint) => (microgons * 100_000_000n) / 6_800_000_000n),
    argonLiquidityForSatoshis: fn((satoshis: bigint) => (satoshis * 6_800_000_000n) / 100_000_000n),
    initializeLock: fn(async () => undefined),
    getInitializeFeeEstimate: fn(async () => ({
      canAfford: true,
      requiredWalletBalanceMicrogons: 2_125_000n,
      securityFee: 2_000_000n,
      txFeePlusTip: 125_000n,
    })),
    calculateBitcoinNetworkFee: fn(async () => 18_000n),
    requestBitcoinRelease: fn(async () => undefined),
    estimatedReleaseArgonTxFee: fn(async () => 125_000n),
    formatP2wshAddress: fn((scriptHex: string) => BitcoinLocks.formatP2wshAddress(scriptHex, BitcoinNetwork.Bitcoin)),
    verifyExpirationTime: fn(() => scenarioStartedAt + 24 * 60 * 60 * 1_000),
    isFundingWindowExpired: fn(
      (record: IBitcoinLockRecord) => bitcoinLocks.verifyExpirationTime(record) <= scenarioStartedAt,
    ),
    unlockDeadlineTime: fn(() => scenarioStartedAt + 24 * 60 * 60 * 1_000),
    getFundingWindowProgress: fn(() => 45),
    getRequestReleaseByVaultProgress: fn(() => releaseVaultWaitProgress.value),
    getCosignDeadlineProgress: fn(() => 65),
    getLockTermProgress: fn(() => 58),
    getMintPercent: fn(() => 64),
    acknowledgeExpiredWaitingForFunding: fn(async () => undefined),
    acknowledgeFailed: fn(async () => undefined),
  });
  mocked(getBitcoinLocks).mockReturnValue(bitcoinLocks);

  function setFeeWaiver(remainingFeeCreditMicrogons = 20_400_000n) {
    Object.assign(vault, {
      terms: { ...vault.terms, bitcoinBaseFee: 2_000_000n },
      calculateBitcoinFee: fn(() => 22_400_000n),
    });

    const coupon: IBitcoinLockCouponStatus = {
      status: 'Open',
      originalFeeCreditMicrogons: 68_000_000n,
      usedFeeCreditMicrogons: 68_000_000n - remainingFeeCreditMicrogons,
      pendingFeeCreditMicrogons: 0n,
      remainingFeeCreditMicrogons,
      expiresAt: new Date(scenarioStartedAt + 7 * 24 * 60 * 60 * 1_000),
      coupon: {
        id: 1,
        userId: 1,
        sequence: 1,
        offerCode: 'synthetic-fee-waiver',
        vaultId: vault.vaultId,
        maxSatoshis: 100_000_000n,
        estimatedGiftUsd: 68,
        btcPctFee: 3.4,
        feeCreditMicrogons: 68_000_000n,
        expiresAfterTicks: 7,
        expirationTick: 10_100,
        accountId: liquidLockingWallet.address,
        createdAt: new Date(scenarioStartedAt - 24 * 60 * 60 * 1_000),
        updatedAt: new Date(scenarioStartedAt),
      },
    };
    const bitcoinLockCoupons = Vue.reactive({
      currentCoupon: coupon,
      refresh: fn(async () => undefined),
    }) as unknown as ReturnType<typeof getBitcoinLockCoupons>;
    mocked(getBitcoinLockCoupons).mockReturnValue(bitcoinLockCoupons);
    return coupon;
  }

  const financials = useFinancials();
  Object.assign(financials, {
    refreshVaults: fn(async () => undefined),
    vaultsIsLoaded: true,
    vaultsActiveRecords: [vault],
    bitcoinLockPerformanceByUuid: {},
    isHistoryRecoveryInProgress: false,
  });

  const currency = getCurrency();
  Object.assign(currency, {
    isLoaded: true,
    recordsByKey: {
      [UnitOfMeasurement.ARGN]: { key: UnitOfMeasurement.ARGN, symbol: '₳', name: 'Argon' },
      [UnitOfMeasurement.USD]: { key: UnitOfMeasurement.USD, symbol: '$', name: 'Dollar' },
    },
  });
  currency.fetchMainchainRates = fn(async () => ({
    [UnitOfMeasurement.ARGNOT]: 14_000_000n,
    [UnitOfMeasurement.USD]: 1_000_000n,
    [UnitOfMeasurement.BTC]: 6_800_000_000n,
  }));

  const liquidLockingWallet = Vue.reactive({
    address: '5SyntheticLiquidLockingWallet',
    availableMicrogons: 3_000_000_000n,
    availableMicronots: 0n,
    reservedMicrogons: 0n,
    reservedMicronots: 0n,
    totalMicrogons: 3_000_000_000n,
    totalMicronots: 0n,
    otherTokens: [],
    fetchErrorMsg: '',
  });
  Object.assign(wallets, { liquidLockingWallet });
  mocked(getWalletKeys, { partial: true }).mockReturnValue({
    defaultArgonAddress: '5SyntheticInternalWallet',
    liquidLockingAddress: liquidLockingWallet.address,
    vaultingAddress: '5SyntheticVaultingWallet',
  });

  const myVault = getMyVault();
  myVault.data.createdVault = vault;
  myVault.data.metadata = { id: vault.vaultId } as NonNullable<typeof myVault.data.metadata>;
  Object.assign(myVault, {
    getBitcoinReleaseRequestTxInfo: fn(() => undefined),
    getTxInfoByType: fn(() => undefined),
  });

  mocked(getVaults, { partial: true }).mockReturnValue({
    operatorNamesByVaultId: { [vault.vaultId]: 'Atlas Operator' },
    vaultsById: { [vault.vaultId]: vault },
    fetchAndCalculateRedemptionAmount: fn(async () => 825_000_000n),
    load: fn(async () => undefined),
  });
  mocked(useVaultingStats, { partial: true }).mockReturnValue({ bitcoinAPR: 8.4 });
  mocked(getMainchainClient).mockResolvedValue(scenarioMainchainClient);

  return {
    bitcoinLocks,
    config,
    financials,
    fundingRecord,
    liquidLockingWallet,
    lock,
    locks,
    lockProcessing,
    mismatchAcceptTransactions,
    myVault,
    orphanTransactions,
    pendingRatchet,
    ratchetPreview,
    releaseLifecycle,
    releaseProcessing,
    releaseVaultWaitProgress,
    replaceUtxoRecords,
    scenarioStartedAt,
    setFeeWaiver,
    vault,
    defer() {
      let resolve!: VoidFunction;
      const promise = new Promise<void>(resolvePromise => {
        resolve = resolvePromise;
      });
      pendingResolvers.add(resolve);
      return { promise, resolve };
    },
    cleanup() {
      for (const resolve of pendingResolvers) resolve();
      pendingResolvers.clear();
      for (const cleanup of cleanupTasks) cleanup();
      cleanupTasks.clear();
    },
    createTransactionInfo<Metadata>(
      options: Omit<Parameters<typeof createScenarioTransactionInfo<Metadata>>[0], 'onCleanup'>,
    ) {
      return createScenarioTransactionInfo<Metadata>({
        ...options,
        onCleanup: task => cleanupTasks.add(task),
      });
    },
  };
}

function createBitcoinLock(overrides: Partial<IBitcoinLockRecord> = {}): IBitcoinLockRecord {
  const timestamp = new Date('2026-08-16T14:00:00.000Z');
  const ratchet: IRatchet = {
    mintAmount: 850_000_000n,
    mintPending: 300_000_000n,
    liquidityPromised: 850_000_000n,
    lockedTargetPrice: 6_800_000_000n,
    securityFee: 4_500_000n,
    txFee: 125_000n,
    burned: 0n,
    blockHeight: 18_500,
    oracleBitcoinBlockHeight: 250_000,
  };
  const lockDetails: IBitcoinLock = {
    utxoId: 101,
    p2wshScriptHashHex: `0020${'11'.repeat(32)}`,
    vaultId: 7,
    isFlexible: false,
    lockedTargetPrice: 6_800_000_000n,
    liquidityPromised: 850_000_000n,
    ownerAccount: '5SyntheticLiquidLockingWallet',
    securitizationRatio: 1,
    satoshis: 12_500_000n,
    vaultPubkey: `02${'22'.repeat(32)}`,
    securityFees: 4_500_000n,
    couponFeesPaid: 0n,
    vaultClaimPubkey: `02${'33'.repeat(32)}`,
    ownerPubkey: `02${'44'.repeat(32)}`,
    vaultXpubSources: { parentFingerprint: new Uint8Array(4), cosignHdIndex: 0, claimHdIndex: 0 },
    vaultClaimHeight: 250_100,
    openClaimHeight: 250_200,
    createdAtHeight: 250_000,
    isFunded: true,
    createdAtArgonBlock: 18_500,
    fundHoldExtensionsByBitcoinExpirationHeight: {},
  };

  return {
    uuid: 'synthetic-bitcoin-overlay-lock',
    utxoId: 101,
    status: BitcoinLockStatus.LockedAndMinted,
    satoshis: 12_500_000n,
    liquidityPromised: 850_000_000n,
    lockedTargetPrice: 6_800_000_000n,
    ratchets: [ratchet],
    cosignVersion: 'v1',
    lockDetails,
    fundingUtxoRecordId: null,
    network: String(BitcoinNetwork.Bitcoin),
    hdPath: "m/84'/0'/0'/0/4",
    vaultId: 7,
    createdAt: timestamp,
    updatedAt: timestamp,
    ...overrides,
  };
}

export function createBitcoinUtxo(
  overrides: Partial<IBitcoinUtxoRecord> & Pick<IBitcoinUtxoRecord, 'id' | 'lockUtxoId' | 'status'>,
): IBitcoinUtxoRecord {
  const timestamp = new Date('2026-08-16T14:10:00.000Z');
  return {
    txid: `synthetic-bitcoin-utxo-${overrides.id}`,
    vout: 0,
    satoshis: 12_500_000n,
    network: String(BitcoinNetwork.Bitcoin),
    firstSeenAt: timestamp,
    firstSeenOnArgonAt: timestamp,
    firstSeenBitcoinHeight: 250_010,
    firstSeenOracleHeight: 250_010,
    createdAt: timestamp,
    updatedAt: timestamp,
    ...overrides,
  };
}

export function createExternalBitcoinLock(overrides: Partial<IExternalBitcoinLock> = {}): IExternalBitcoinLock {
  const local = createBitcoinLock();
  return {
    utxoId: 801,
    satoshis: 25_000_000n,
    liquidityPromised: 1_700_000_000n,
    isPending: false,
    isReleasing: false,
    lockDetails: { ...local.lockDetails, utxoId: 801, ownerAccount: '5SyntheticExternalOwner' },
    ...overrides,
  };
}

function createBitcoinLockSummary(lock: IBitcoinLockRecord): IBitcoinLockSummary {
  return {
    uuid: lock.uuid,
    utxoId: lock.utxoId,
    status: lock.status,
    statusDetails: {
      hasObservedFundingSignal: false,
      showMismatchAccept: false,
      showFundingMismatch: false,
      showReadyForBitcoin: false,
      isFundingSeenInMempoolOnly: false,
    },
    lockProcessingDetails: { progressPct: 0, confirmations: 0, expectedConfirmations: 0 },
    lockProcessingError: '',
    satoshis: lock.satoshis,
    valueOfBtc: 875_000_000n,
    totalLiquidity: lock.liquidityPromised,
    pendingLiquidity: 300_000_000n,
    receivedLiquidity: 550_000_000n,
    valueBeyondLiquidity: 25_000_000n,
    startingCapital: lock.liquidityPromised,
    endingCapital: 910_000_000n,
    ratchetPercent: 7.2,
    totalReturn: 10.4,
    securityFees: 4_500_000n,
    transactionFees: 125_000n,
    totalFees: 4_625_000n,
    unlockAmount: 825_000_000n,
    createdAt: lock.createdAt,
    record: lock,
  };
}

function createScenarioTransactionInfo<Metadata>(options: {
  extrinsicType: ExtrinsicType;
  metadata: Metadata;
  status?: TransactionStatus;
  error?: Error;
  progress?: { progressPct: number; confirmations: number; expectedConfirmations: number };
  onCleanup?: (cleanup: VoidFunction) => void;
}): TransactionInfo<Metadata> {
  const status = options.status ?? (options.error ? TransactionStatus.Error : TransactionStatus.InBlock);
  const isIncluded = [TransactionStatus.InBlock, TransactionStatus.Finalized].includes(status);
  const isFinalized = status === TransactionStatus.Finalized;
  const tx: ITransactionRecord<Metadata> = {
    id: 991,
    status,
    extrinsicHash: '0xsynthetic',
    extrinsicMethodJson: {},
    extrinsicType: options.extrinsicType,
    metadataJson: options.metadata,
    accountAddress: '5SyntheticLiquidLockingWallet',
    submittedAtTime: new Date('2026-08-16T14:20:00.000Z'),
    submittedAtBlockHeight: 18_510,
    submissionErrorJson: undefined,
    txTip: 0n,
    txFeePlusTip: 125_000n,
    blockHeight: isIncluded ? 18_511 : undefined,
    blockHash: isIncluded ? '0xsyntheticblock' : undefined,
    blockTime: isIncluded ? new Date('2026-08-16T14:21:00.000Z') : undefined,
    blockExtrinsicIndex: isIncluded ? 1 : undefined,
    blockExtrinsicEventsJson: [],
    blockExtrinsicErrorJson: undefined,
    finalizedHeadHeight: 18_512,
    finalizedHeadTime: new Date('2026-08-16T14:22:00.000Z'),
    isFinalized,
    createdAt: new Date('2026-08-16T14:20:00.000Z'),
    updatedAt: new Date('2026-08-16T14:22:00.000Z'),
  };
  const txResult = new TxResult(scenarioMainchainClient, {
    accountAddress: tx.accountAddress,
    method: tx.extrinsicMethodJson,
    nonce: 0,
    signedHash: tx.extrinsicHash,
    submittedTime: tx.submittedAtTime,
    submittedAtBlockNumber: tx.submittedAtBlockHeight,
  });
  txResult.isBroadcast = true;
  if (options.error) txResult.submissionError = options.error;

  const info = new TransactionInfo<Metadata>({ tx, txResult });
  const progress = options.progress;
  if (progress) {
    spyOn(info, 'subscribeToProgress').mockImplementation(callback => {
      void callback({ ...progress, progressMessage: '', isMaxed: false });
      return () => undefined;
    });
  }
  const finalize = () => {
    txResult.blockHash ??= new Uint8Array([1, 2, 3, 4]);
    txResult.blockNumber ??= 18_511;
    txResult.extrinsicIndex ??= 1;
    void txResult.setFinalized();
  };
  if (isFinalized) {
    finalize();
  } else {
    options.onCleanup?.(finalize);
  }
  return info;
}
