import * as Vue from 'vue';
import type { IBitcoinLockCouponStatus } from '@argonprotocol/apps-router';
import { fn, mocked } from 'storybook/test';
import { setupAppScenario } from './setupAppScenario.ts';
import { BitcoinLockStatus, type IBitcoinLockRecord } from '../../src-vue/interfaces/IBitcoinLockRecord.ts';
import type { IBitcoinLockSummary } from '../../src-vue/interfaces/IBitcoinLockSummary.ts';
import { BitcoinUtxoStatus, type IBitcoinUtxoRecord } from '../../src-vue/interfaces/IBitcoinUtxoRecord.ts';
import { TopTab } from '../../src-vue/interfaces/IConfig.ts';
import BitcoinLocks, {
  type IBitcoinMismatchViewState,
  type IBitcoinRatchetMetadata,
  type IBitcoinRatchetPreview,
} from '../../src-vue/lib/BitcoinLocks.ts';
import type { TransactionInfo } from '../../src-vue/lib/TransactionInfo.ts';
import { getBitcoinLockCoupons, getBitcoinLocks } from '../../src-vue/stores/bitcoin.ts';
import { getCurrency } from '../../src-vue/stores/currency.ts';
import { useFinancials } from '../../src-vue/stores/financials.ts';
import { getMainchainClient } from '../../src-vue/stores/mainchain.ts';
import { getWalletKeys } from '../../src-vue/stores/wallets.ts';

export function setupBitcoinPortfolioScenario(
  options: { atParRatchet?: boolean; feeWaiver?: boolean; pendingRatchet?: boolean } = {},
) {
  setupAppScenario({
    selectedTab: TopTab.BitcoinLocks,
    config: options.feeWaiver ? { upstreamOperator: { name: 'Atlas Operator', vaultId: 7 } } : undefined,
  });

  const summaries = [
    createSummary(1, BitcoinLockStatus.LockIsProcessingOnArgon, { progressPct: 34 }),
    createSummary(2, BitcoinLockStatus.LockFailed, {
      lockProcessingError: 'The Argon transaction was rejected before the lock was created.',
    }),
    createSummary(3, BitcoinLockStatus.LockPendingFunding, {
      statusDetails: { showReadyForBitcoin: true },
    }),
    createSummary(4, BitcoinLockStatus.LockPendingFunding, {
      statusDetails: { isFundingSeenInMempoolOnly: true, hasObservedFundingSignal: true },
      progressPct: 8,
    }),
    createSummary(5, BitcoinLockStatus.LockPendingFunding, {
      statusDetails: { showFundingMismatch: true, hasObservedFundingSignal: true },
      progressPct: 47,
    }),
    createSummary(6, BitcoinLockStatus.LockExpiredWaitingForFunding),
    createSummary(7, BitcoinLockStatus.LockFundingReadyToResume),
    createSummary(8, BitcoinLockStatus.LockedAndIsMinting, {
      pendingLiquidity: 85_000_000n,
      receivedLiquidity: 510_000_000n,
      ratchetPercent: options.atParRatchet ? 0 : 4.75,
    }),
    createSummary(9, BitcoinLockStatus.LockedAndMinted, {
      receivedLiquidity: 1_125_000_000n,
      ratchetPercent: -2.25,
      totalReturn: 13.4,
    }),
    createSummary(10, BitcoinLockStatus.LockedAndMinted, {
      isHistoryRecoveryPending: true,
    }),
  ];
  const releasing = [
    createSummary(11, BitcoinLockStatus.Releasing),
    createSummary(12, BitcoinLockStatus.Releasing),
    createSummary(13, BitcoinLockStatus.Releasing),
    createSummary(14, BitcoinLockStatus.Releasing),
  ];
  const archived = [
    createSummary(20, BitcoinLockStatus.Released, {
      removalReason: 'released',
      removalBlockTime: new Date('2026-08-08T16:00:00.000Z'),
    }),
    createSummary(21, BitcoinLockStatus.Released, {
      removalReason: 'spent',
      removalBlockTime: new Date('2026-07-29T16:00:00.000Z'),
      historicalTransactionFees: 44_000n,
    }),
  ];
  const fundingRecords = [
    createFundingRecord(releasing[0].record, BitcoinUtxoStatus.FundingUtxo),
    createFundingRecord(releasing[1].record, BitcoinUtxoStatus.ReleaseIsProcessingOnArgon, {
      releaseToDestinationAddress: '00141111111111111111111111111111111111111111',
      releaseBitcoinNetworkFee: 15_000n,
    }),
    createFundingRecord(releasing[2].record, BitcoinUtxoStatus.ReleaseIsProcessingOnArgon, {
      releaseToDestinationAddress: '00142222222222222222222222222222222222222222',
      releaseBitcoinNetworkFee: 16_000n,
      releaseCosignVaultSignature: new Uint8Array([1, 2, 3]),
      releaseCosignHeight: 250_011,
    }),
    createFundingRecord(releasing[3].record, BitcoinUtxoStatus.ReleaseIsProcessingOnBitcoin, {
      releaseToDestinationAddress: '00143333333333333333333333333333333333333333',
      releaseBitcoinNetworkFee: 17_000n,
      releaseCosignVaultSignature: new Uint8Array([4, 5, 6]),
      releaseCosignHeight: 250_012,
      releaseTxid: 'synthetic-bitcoin-release-14',
      releaseFirstSeenAt: new Date('2026-08-15T14:00:00.000Z'),
      releaseFirstSeenBitcoinHeight: 250_014,
      releaseFirstSeenOracleHeight: 250_012,
      releaseLastConfirmationCheckAt: new Date('2026-08-15T14:10:00.000Z'),
      releaseLastConfirmationCheckOracleHeight: 250_013,
    }),
    createFundingRecord(archived[0].record, BitcoinUtxoStatus.ReleaseComplete, {
      releaseToDestinationAddress: '00144444444444444444444444444444444444444444',
      releaseBitcoinNetworkFee: 18_000n,
      releaseCosignVaultSignature: new Uint8Array([7, 8, 9]),
      releaseCosignHeight: 250_013,
      releaseTxid: 'synthetic-bitcoin-release-20',
      releaseFirstSeenAt: new Date('2026-08-08T14:00:00.000Z'),
      releaseFirstSeenBitcoinHeight: 249_990,
      releaseFirstSeenOracleHeight: 249_988,
      releasedAtBitcoinHeight: 249_996,
    }),
  ];
  const orphans = [
    createOrphan(31, BitcoinUtxoStatus.Orphaned),
    createOrphan(32, BitcoinUtxoStatus.ReleaseIsProcessingOnArgon, {
      releaseCosignVaultSignature: new Uint8Array([1, 2, 3]),
    }),
    createOrphan(33, BitcoinUtxoStatus.ReleaseIsProcessingOnBitcoin, { releaseTxid: 'synthetic-return-tx' }),
    createOrphan(34, BitcoinUtxoStatus.Orphaned, { statusError: 'The vault signature expired before broadcast.' }),
    createOrphan(35, BitcoinUtxoStatus.ReleaseComplete),
  ];
  const displayRecords = [...summaries, ...releasing];
  const records = [...displayRecords, ...archived].map(summary => summary.record);
  const recordsByUtxoId = new Map(records.map(record => [record.utxoId, record]));
  const summariesByUuid = new Map([...displayRecords, ...archived].map(summary => [summary.uuid, summary]));
  const fundingRecordsByLockUtxoId = new Map(fundingRecords.map(record => [record.lockUtxoId, record]));
  const pendingRatchetProgressCallbacks = new Set<Parameters<TransactionInfo['subscribeToProgress']>[0]>();
  let isRatchetPending = options.pendingRatchet ?? false;
  const pendingRatchet: Pick<
    TransactionInfo,
    'getStatus' | 'isPostProcessed' | 'subscribeToProgress' | 'waitForPostProcessing'
  > = {
    getStatus: fn(() => ({
      progressPct: 50,
      confirmations: 2,
      expectedConfirmations: 4,
      error: undefined,
      isFinalized: false,
      isMaxed: false,
    })),
    get isPostProcessed() {
      return !isRatchetPending;
    },
    waitForPostProcessing: new Promise<void>(() => undefined),
    subscribeToProgress: fn(callback => {
      pendingRatchetProgressCallbacks.add(callback);
      return () => pendingRatchetProgressCallbacks.delete(callback);
    }),
  };
  const pendingRatchetTxInfo = Vue.shallowRef(isRatchetPending ? pendingRatchet : undefined);
  const ratchetSubmission = new Promise<TransactionInfo<IBitcoinRatchetMetadata>>(() => undefined);
  const ratchetPreview: IBitcoinRatchetPreview = {
    additionalLiquidityToMint: 72_000_000n,
    availableVaultFunds: 1_400_000_000n,
    burnAmount: 0n,
    canRatchet: true,
    currentLiquidityPromised: summaries[7].record.liquidityPromised,
    newLiquidityPromised: summaries[7].record.liquidityPromised + 72_000_000n,
    ratchetingFee: 1_250_000n,
    requiredVaultFunds: 950_000_000n,
    securitizationToAdd: 0n,
    shortfall: 0n,
    vaultId: summaries[7].record.vaultId,
  };

  const bitcoinLocks: BitcoinLocks = Object.assign(Object.create(BitcoinLocks.prototype), {
    data: Vue.reactive({ isReconciliationPending: false }),
    recovery: Vue.reactive({ hasPendingHistoryRecovery: false }),
    orphanReleases: { getTransactionInfo: fn(() => undefined) },
    utxoTracking: {
      getAllOrphanLifecycleUtxos: fn(() => orphans),
      getAcceptedFundingRecordForLock: fn((record: IBitcoinLockRecord) =>
        fundingRecordsByLockUtxoId.get(record.utxoId ?? -1),
      ),
      isReleaseCompleteStatus: fn((status: BitcoinUtxoStatus) =>
        [BitcoinUtxoStatus.ReleaseComplete, BitcoinUtxoStatus.ReleaseCompleteAcknowledged].includes(status),
      ),
    },
    load: fn(async () => undefined),
    getAllLocks: fn(() => records),
    getLockByUtxoId: fn((utxoId: number) => recordsByUtxoId.get(utxoId)),
    createLockSummary: fn((record: IBitcoinLockRecord) => summariesByUuid.get(record.uuid)!),
    verifyExpirationTime: fn(() => Date.UTC(2026, 7, 16, 16, 0, 0)),
    unlockDeadlineTime: fn(() => Date.UTC(2026, 11, 15, 16, 0, 0)),
    getPendingRatchetTxInfo: fn((record: IBitcoinLockRecord) =>
      record.utxoId === summaries[7].record.utxoId ? pendingRatchetTxInfo.value : undefined,
    ),
    getRatchetPreview: fn(async () => ratchetPreview),
    ratchet: fn(() => ratchetSubmission),
    getLatestMismatchAcceptTxInfo: fn(() => undefined),
    getReceivedFundingSatoshis: fn((record: IBitcoinLockRecord) => record.satoshis + 25_000n),
    getMismatchViewState: fn((record: IBitcoinLockRecord): IBitcoinMismatchViewState => {
      if (record.uuid !== 'synthetic-bitcoin-5') {
        return {
          phase: 'none',
          candidateCount: 0,
          isFundingExpired: false,
          candidates: [],
        };
      }

      const candidateRecord = createOrphan(45, BitcoinUtxoStatus.FundingCandidate);
      const nextCandidate = {
        record: candidateRecord,
        isNext: true,
        observedSatoshis: record.satoshis + 25_000n,
        differenceSatoshis: 25_000n,
        canAccept: true,
        canReturn: true,
      };

      return {
        phase: 'review',
        error: '',
        candidateCount: 1,
        isFundingExpired: false,
        nextCandidateId: candidateRecord.id,
        nextCandidate,
        candidates: [nextCandidate],
      };
    }),
    getReleaseLifecycleProgress: fn((record: IBitcoinUtxoRecord) =>
      record.status === BitcoinUtxoStatus.ReleaseIsProcessingOnBitcoin
        ? { progressPct: 61, confirmations: 2, expectedConfirmations: 6 }
        : { progressPct: 0, confirmations: -1, expectedConfirmations: 6 },
    ),
    acknowledgeExpiredWaitingForFunding: fn(async () => undefined),
    isLockedStatus: fn((record: IBitcoinLockRecord) =>
      [BitcoinLockStatus.LockedAndIsMinting, BitcoinLockStatus.LockedAndMinted].includes(record.status),
    ),
    isFinishedStatus: fn((record: IBitcoinLockRecord) => record.status === BitcoinLockStatus.Released),
  });

  mocked(getBitcoinLocks).mockReturnValue(bitcoinLocks as unknown as ReturnType<typeof getBitcoinLocks>);
  mocked(getMainchainClient).mockResolvedValue({
    query: {
      bitcoinLocks: {
        microgonPerBtcHistory: fn(async () => [[0, { toBigInt: () => 6_800_000_000n }]]),
      },
    },
  } as never);
  Object.assign(getCurrency(), { fetchMainchainRates: fn(async () => ({})) });
  Object.assign(getWalletKeys(), {
    getLiquidLockingKeypair: fn(async () => ({ address: '5SyntheticLiquidLockingWallet' }) as never),
  });
  const currentCoupon: IBitcoinLockCouponStatus | undefined = options.feeWaiver
    ? {
        status: 'Open',
        originalFeeCreditMicrogons: 68_000_000n,
        usedFeeCreditMicrogons: 40_800_000n,
        pendingFeeCreditMicrogons: 0n,
        remainingFeeCreditMicrogons: 27_200_000n,
        expiresAt: new Date(Date.now() + 2 * 60 * 60 * 1_000),
        coupon: {
          id: 1,
          userId: 1,
          sequence: 1,
          offerCode: 'synthetic-portfolio-fee-waiver',
          vaultId: 7,
          maxSatoshis: 100_000_000n,
          estimatedGiftUsd: 68,
          btcPctFee: 3.4,
          feeCreditMicrogons: 68_000_000n,
          expiresAfterTicks: 7,
          expirationTick: 10_100,
          createdAt: new Date('2026-08-15T16:00:00.000Z'),
          updatedAt: new Date('2026-08-16T16:00:00.000Z'),
        },
      }
    : undefined;
  mocked(getBitcoinLockCoupons, { partial: true }).mockReturnValue({
    currentCoupon,
    refresh: fn(async () => undefined),
  });
  mocked(useFinancials).mockReturnValue(
    Vue.reactive({
      liquidTotalSatoshis: displayRecords.reduce((total, summary) => total + summary.satoshis, 0n),
      liquidPerformanceReturn: 15.82,
      liquidHodlingReturn: 11.29,
      bitcoinLockDisplayRecords: displayRecords,
      liquidInvisibleRecords: archived,
      activeBitcoinLockCount: 2,
      isHistoryRecoveryInProgress: false,
      historyRecovery: { state: 'ready', recoveredBlockCount: 0 },
      bitcoinLockPerformanceByUuid: {
        [archived[0].uuid]: { profit: 81_000_000n, percent: 9.72 },
      },
    }) as unknown as ReturnType<typeof useFinancials>,
  );

  return {
    startPendingRatchet() {
      isRatchetPending = true;
      pendingRatchetTxInfo.value = pendingRatchet;
    },
    completePendingRatchet() {
      isRatchetPending = false;
      pendingRatchetTxInfo.value = undefined;
      for (const callback of pendingRatchetProgressCallbacks) {
        void callback({
          progressPct: 100,
          progressMessage: 'Finalized',
          confirmations: 4,
          expectedConfirmations: 4,
          isMaxed: false,
        });
      }
    },
  };
}

export function setupBitcoinEmptyScenario(options: { loading?: boolean; recovering?: boolean } = {}) {
  setupAppScenario({ selectedTab: TopTab.BitcoinLocks });

  mocked(getBitcoinLocks).mockReturnValue({
    data: Vue.reactive({ isReconciliationPending: false }),
    recovery: Vue.reactive({ hasPendingHistoryRecovery: false }),
    utxoTracking: { getAllOrphanLifecycleUtxos: fn(() => []) },
    load: options.loading ? fn(() => new Promise<void>(() => undefined)) : fn(async () => undefined),
    getAllLocks: fn(() => []),
  } as unknown as ReturnType<typeof getBitcoinLocks>);
  mocked(useFinancials).mockReturnValue(
    Vue.reactive({
      bitcoinLockDisplayRecords: [],
      liquidInvisibleRecords: [],
      activeBitcoinLockCount: options.recovering ? 2 : 0,
      isHistoryRecoveryInProgress: options.recovering ?? false,
      historyRecovery: { state: options.recovering ? 'restoring' : 'ready', recoveredBlockCount: 0 },
    }) as unknown as ReturnType<typeof useFinancials>,
  );
}

function createSummary(
  id: number,
  status: BitcoinLockStatus,
  overrides: {
    progressPct?: number;
    lockProcessingError?: string;
    statusDetails?: Partial<IBitcoinLockSummary['statusDetails']>;
    pendingLiquidity?: bigint;
    receivedLiquidity?: bigint;
    ratchetPercent?: number;
    totalReturn?: number;
    isHistoryRecoveryPending?: boolean;
    removalReason?: IBitcoinLockRecord['removalReason'];
    removalBlockTime?: Date;
    historicalTransactionFees?: bigint;
  } = {},
): IBitcoinLockSummary {
  const satoshis = BigInt(id + 1) * 12_500_000n;
  const totalLiquidity = satoshis * 38n;
  const createdAt = new Date(Date.UTC(2026, 7, 15 - Math.min(id, 14), 14, 0, 0));
  const record: IBitcoinLockRecord = {
    uuid: `synthetic-bitcoin-${id}`,
    utxoId: 1_000 + id,
    status,
    satoshis,
    liquidityPromised: totalLiquidity,
    lockedTargetPrice: 6_400_000_000n,
    ratchets: [],
    cosignVersion: 'v1',
    lockDetails: {} as IBitcoinLockRecord['lockDetails'],
    fundingUtxoRecordId: null,
    network: 'regtest',
    hdPath: `m/84'/1'/0'/0/${id}`,
    vaultId: id % 2 ? 7 : 12,
    isHistoryRecoveryPending: overrides.isHistoryRecoveryPending ?? false,
    removalReason: overrides.removalReason,
    removalBlockTime: overrides.removalBlockTime,
    createdAt,
    updatedAt: createdAt,
  };

  return {
    uuid: record.uuid,
    utxoId: record.utxoId,
    status,
    statusDetails: {
      hasObservedFundingSignal: false,
      showMismatchAccept: false,
      showFundingMismatch: false,
      showReadyForBitcoin: false,
      isFundingSeenInMempoolOnly: false,
      ...overrides.statusDetails,
    },
    lockProcessingDetails: {
      progressPct: overrides.progressPct ?? 0,
      confirmations: 2,
      expectedConfirmations: 6,
      receivedSatoshis: satoshis,
    },
    lockProcessingError: overrides.lockProcessingError ?? '',
    satoshis,
    valueOfBtc: totalLiquidity + 25_000_000n,
    totalLiquidity,
    pendingLiquidity: overrides.pendingLiquidity ?? 0n,
    receivedLiquidity: overrides.receivedLiquidity ?? totalLiquidity,
    valueBeyondLiquidity: 25_000_000n,
    startingCapital: totalLiquidity,
    endingCapital: totalLiquidity + 42_000_000n,
    ratchetPercent: overrides.ratchetPercent ?? 0,
    totalReturn: overrides.totalReturn ?? 8.25,
    securityFees: 2_500_000n,
    transactionFees: 48_000n,
    totalFees: 2_548_000n,
    historicalTransactionFees: overrides.historicalTransactionFees,
    historicalTotalFees: overrides.historicalTransactionFees
      ? overrides.historicalTransactionFees + 2_500_000n
      : undefined,
    unlockAmount: totalLiquidity - 15_000_000n,
    createdAt,
    record,
  };
}

function createOrphan(
  id: number,
  status: BitcoinUtxoStatus,
  overrides: Partial<IBitcoinUtxoRecord> = {},
): IBitcoinUtxoRecord {
  const observedAt = new Date(Date.UTC(2026, 7, 15, 10, id, 0));
  return {
    id,
    lockUtxoId: 1_009,
    txid: `synthetic-orphan-${id}`,
    vout: 0,
    satoshis: BigInt(id) * 1_250_000n,
    network: 'regtest',
    status,
    firstSeenAt: observedAt,
    firstSeenBitcoinHeight: 250_000 + id,
    createdAt: observedAt,
    updatedAt: observedAt,
    ...overrides,
  };
}

function createFundingRecord(
  lock: IBitcoinLockRecord,
  status: BitcoinUtxoStatus,
  overrides: Partial<IBitcoinUtxoRecord> = {},
): IBitcoinUtxoRecord {
  const observedAt = new Date(Date.UTC(2026, 7, 15, 12, lock.utxoId));
  const record: IBitcoinUtxoRecord = {
    id: 2_000 + (lock.utxoId ?? 0),
    lockUtxoId: lock.utxoId ?? 0,
    txid: `synthetic-funding-${lock.utxoId}`,
    vout: 0,
    satoshis: lock.satoshis,
    network: lock.network,
    status,
    firstSeenAt: observedAt,
    firstSeenOnArgonAt: observedAt,
    firstSeenBitcoinHeight: 250_000 + (lock.utxoId ?? 0),
    firstSeenOracleHeight: 250_000 + (lock.utxoId ?? 0),
    createdAt: observedAt,
    updatedAt: observedAt,
    ...overrides,
  };
  lock.fundingUtxoRecordId = record.id;
  lock.fundingUtxoRecord = record;
  return record;
}
