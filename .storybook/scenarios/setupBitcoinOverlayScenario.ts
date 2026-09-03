import * as Vue from 'vue';
import { BitcoinNetwork } from '@argonprotocol/bitcoin';
import {
  BitcoinLock,
  BitcoinFission as BitcoinFissionModel,
  type ArgonClient,
  type IBitcoinLock,
  type IBitcoinLockDetails,
  type IBitcoinLockCouponUseRecord,
  UnitOfMeasurement,
  TxResult,
} from '@argonprotocol/apps-core';
import type { IBitcoinLockCouponStatus } from '@argonprotocol/apps-router';

import { fn, mocked, spyOn } from 'storybook/test';
import { createScenarioVault } from './createScenarioVault.ts';
import { setupAppScenario } from './setupAppScenario.ts';
import { TopTab } from '../../src-vue/interfaces/IConfig.ts';
import { BitcoinLockStatus, type IBitcoinLockRecord } from '../../src-vue/interfaces/IBitcoinLockRecord.ts';
import {
  BitcoinUtxoRole,
  BitcoinUtxoStatus,
  type IBitcoinUtxoRecord,
} from '../../src-vue/interfaces/IBitcoinUtxoRecord.ts';
import type {
  IBitcoinLockProcessingDetails,
  IBitcoinLockSummary,
} from '../../src-vue/interfaces/IBitcoinLockSummary.ts';
import {
  ExtrinsicType,
  TransactionStatus,
  type ITransactionRecord,
} from '../../src-vue/interfaces/ITransactionRecord.ts';
import BitcoinLocks from '../../src-vue/lib/BitcoinLocks.ts';
import { BitcoinFissions } from '../../src-vue/lib/BitcoinFissions.ts';
import {
  BitcoinLiquidRatchet,
  type IBitcoinLiquidRatchetPreview,
} from '../../src-vue/lib/txs/BitcoinLiquid.ratchet.ts';
import { BitcoinLockCreate } from '../../src-vue/lib/txs/BitcoinLock.create.ts';
import BitcoinMempool from '../../src-vue/lib/BitcoinMempool.ts';
import BitcoinUtxoTracking from '../../src-vue/lib/BitcoinUtxoTracking.ts';
import type { IExternalBitcoinLock } from '../../src-vue/lib/MyVault.ts';
import { TransactionInfo } from '../../src-vue/lib/TransactionInfo.ts';
import {
  getBitcoinFissions,
  getBitcoinLockCoupons,
  getBitcoinLocks,
  getBitcoinTransactionOperations,
  loadBitcoinTransactionOperations,
} from '../../src-vue/stores/bitcoin.ts';
import { getCurrency } from '../../src-vue/stores/currency.ts';
import { useFinancials } from '../../src-vue/stores/financials.ts';
import { getMainchainClient } from '../../src-vue/stores/mainchain.ts';
import { getMyVault, getVaults } from '../../src-vue/stores/vaults.ts';
import { getWalletKeys } from '../../src-vue/stores/wallets.ts';
import { useVaultingStats } from '../../src-vue/stores/vaultingStats.ts';

export type BitcoinOverlayScenario = ReturnType<typeof setupBitcoinOverlayScenario>;

const scenarioMainchainClient = {
  query: {
    bitcoinLocks: {
      microgonPerBtcHistory: fn(async () => [[10_000, 6_800_000_000n]]),
    },
    crosschainTransfer: {
      transferTotalsByAccount: fn(async () => ({ microgonsIn: 0n })),
    },
    ticks: { currentTick: fn(async () => 10_001) },
  },
  consts: {
    bitcoinLocks: { maxBtcPriceTickAge: { toNumber: () => 100 } },
  },
  tx: { bitcoinLocks: {} },
} as unknown as ArgonClient;

export function setupBitcoinOverlayScenario() {
  const scenarioStartedAt = Date.now();
  const pendingResolvers = new Set<VoidFunction>();
  const cleanupTasks = new Set<VoidFunction>();
  const lock = Vue.reactive(
    createBitcoinLock({
      createdAt: new Date(scenarioStartedAt - 24 * 60 * 60 * 1_000),
      updatedAt: new Date(scenarioStartedAt - 24 * 60 * 60 * 1_000),
    }),
  );
  const bitcoinLockCreate: BitcoinLockCreate = Object.assign(Object.create(BitcoinLockCreate.prototype), {
    preview: fn(async () => ({
      canAfford: true,
      requiredWalletBalanceMicrogons: 2_125_000n,
      securityFee: 2_000_000n,
      txFeePlusTip: 125_000n,
    })),
    submit: fn(async () =>
      createScenarioTransactionInfo({
        extrinsicType: ExtrinsicType.BitcoinRequestLock,
        metadata: {
          bitcoin: {
            uuid: lock.uuid,
            vaultId: lock.vaultId,
            satoshis: lock.securitizedSatoshis,
            hdPath: lock.hdPath,
            lockedTargetPrice: lock.microgonsAtTargetPerBtc ?? 6_800_000_000n,
            liquidityPromised: lock.securitizationCoverageMicrogons ?? 0n,
            securityFee: 0n,
          },
        },
        onCleanup: task => cleanupTasks.add(task),
      }),
    ),
  });
  const pendingResecuritization = Vue.shallowRef<TransactionInfo>();
  const bitcoinLockResecuritize = {
    submit: fn(async () => {
      const txInfo = createScenarioTransactionInfo({
        extrinsicType: ExtrinsicType.BitcoinResecuritize,
        metadata: {
          bitcoin: {
            utxoId: lock.utxoId!,
            vaultId: lock.vaultId,
            securitizedSatoshis: lock.fundedSatoshis,
            microgonsAtTargetPerBtc: lock.microgonsAtTargetPerBtc ?? 6_800_000_000n,
            securityFee: 0n,
          },
        },
        onCleanup: task => cleanupTasks.add(task),
      });
      pendingResecuritization.value = txInfo;
      return txInfo;
    }),
    getPendingResecuritizationTxInfo: fn(() => pendingResecuritization.value),
  };
  const bitcoinLockRelease = {
    prepare: fn(async () => ({
      canAfford: true,
      availableBalance: 25_000_000n,
      txFeePlusTip: 125_000n,
    })),
    submit: fn(
      async ({
        utxoId,
        toScriptPubkey,
        bitcoinNetworkFee,
      }: {
        utxoId: number;
        toScriptPubkey: string;
        bitcoinNetworkFee: bigint;
      }) =>
        createScenarioTransactionInfo({
          extrinsicType: ExtrinsicType.BitcoinRequestRelease,
          metadata: {
            utxoId,
            toScriptPubkey,
            bitcoinNetworkFee,
            redemptionAmount: 0n,
          },
          onCleanup: task => cleanupTasks.add(task),
        }),
    ),
    getPendingReleaseTxInfo: fn(() => undefined),
  };
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
    bitcoinLockCreate,
  });
  // The controller already owns the base scenario's intentionally pending load; only this workflow needs config ready.
  config.isLoadedPromise = Promise.resolve();

  const vault = createScenarioVault({
    vaultId: 7,
    securitization: 2_000_000_000n,
  });
  const fundingRecord = createBitcoinUtxo({
    id: 201,
    lockUtxoId: lock.utxoId!,
    role: BitcoinUtxoRole.Funding,
    status: BitcoinUtxoStatus.FundingUtxo,
    satoshis: lock.fundedSatoshis,
  });
  lock.utxos = [fundingRecord];
  lock.fundingUtxo = fundingRecord;

  const locks = Vue.reactive<IBitcoinLockRecord[]>([lock]);
  const lockProcessing = Vue.reactive<IBitcoinLockProcessingDetails>({
    progressPct: 38,
    confirmations: 1,
    expectedConfirmations: 4,
    receivedSatoshis: lock.fundedSatoshis,
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
  const releaseVaultWaitProgress = Vue.ref(0);
  const orphanTransactions = new Map<number, TransactionInfo>();
  const utxoTracking = new BitcoinUtxoTracking({
    dbPromise: new Promise(() => undefined),
    getBitcoinNetwork: () => BitcoinNetwork.Bitcoin,
    getOracleBitcoinBlockHeight: () => 250_020,
    getConfig: () => undefined,
    getMainchainClient: () => new Promise(() => undefined),
    mempool: new BitcoinMempool(),
  });
  utxoTracking.data = Vue.reactive(utxoTracking.data);

  function replaceUtxoRecords(records: IBitcoinUtxoRecord[]) {
    utxoTracking.data.utxosByLockUtxoId = { [lock.utxoId!]: records };
    utxoTracking.data.utxosByKey = {};
    utxoTracking.data.utxosById = Object.fromEntries(records.map(record => [record.id, record]));

    const acceptedFunding = records.find(record => record.role === BitcoinUtxoRole.Funding);
    lock.utxos = records;
    lock.fundingUtxo = acceptedFunding;
    lock.fundedSatoshis = acceptedFunding?.satoshis ?? 0n;
  }

  replaceUtxoRecords([fundingRecord]);
  utxoTracking.getReleaseLifecycleProgress = fn(() => releaseLifecycle);

  const bitcoinLocks: BitcoinLocks = Object.assign(Object.create(BitcoinLocks.prototype) as BitcoinLocks, {
    data: Vue.reactive({
      pendingLocks: [],
      locksByUtxoId: { [lock.utxoId!]: lock },
      oracleBitcoinBlockHeight: 250_020,
      bitcoinNetwork: BitcoinNetwork.Bitcoin,
      isReconciliationPending: false,
    }),
    orphanReleases: {},
    utxoTracking,
    load: fn(async () => undefined),
    getAllLocks: fn(() => locks),
    getLockByUtxoId: fn((utxoId: number) => locks.find(candidate => candidate.utxoId === utxoId)),
    getLockByUuid: fn((uuid: string) => locks.find(candidate => candidate.uuid === uuid)),
    createLockSummary: fn((record: IBitcoinLockRecord) => createBitcoinLockSummary(record)),
    getTable: fn(async () => ({
      getUtxoIdByUuid: fn(async (uuid: string) => locks.find(candidate => candidate.uuid === uuid)?.utxoId),
      getByUtxoId: fn(async (utxoId: number) => locks.find(candidate => candidate.utxoId === utxoId)),
      setCurrentLockFunded: fn(async () => undefined),
    })),
    getLockProcessingDetails: fn(() => lockProcessing),
    getLockProcessingError: fn((record: IBitcoinLockRecord) => record.blockExtrinsicErrorJson?.message ?? ''),
    getReleaseProcessingDetails: fn(() => releaseProcessing),
    getLockableBitcoinCapacity: fn(async () => ({
      availableLiquidityMicrogons: 2_000_000_000n,
      availableSatoshis: 29_411_764n,
      vaultCapacitySatoshis: 29_411_764n,
    })),
    minimumSatoshiPerLock: fn(async () => 100_000n),
    satoshisForArgonLiquidity: fn(async (microgons: bigint) => (microgons * 100_000_000n) / 6_800_000_000n),
    argonLiquidityForSatoshis: fn((satoshis: bigint) => (satoshis * 6_800_000_000n) / 100_000_000n),
    calculateBitcoinNetworkFee: fn(async () => 18_000n),
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
    acknowledgeFailed: fn(async () => undefined),
  });
  mocked(getBitcoinLocks).mockReturnValue(bitcoinLocks);
  const getBitcoinLock = spyOn(BitcoinLock, 'get').mockImplementation(async (_client, utxoId) => {
    const record = locks.find(candidate => candidate.utxoId === utxoId);
    const scriptDetails = record?.scriptDetails;
    if (!record || !scriptDetails) return;

    return new BitcoinLock({
      utxoId,
      p2wshScriptHashHex: scriptDetails.p2wshScriptHashHex,
      vaultId: record.vaultId,
      securitizedSatoshis: record.securitizedSatoshis,
      microgonsAtTargetPerBtc: record.microgonsAtTargetPerBtc ?? 6_800_000_000n,
      securitizationCoverageMicrogons: record.securitizationCoverageMicrogons ?? 0n,
      securitizationTick: record.securitizationTick ?? 10_000,
      fundedSatoshis: record.fundedSatoshis,
      fissionedSatoshis: record.fissionedSatoshis ?? 0n,
      ownerAccount: record.ownerAccount ?? defaultArgonWallet.address,
      securitizationRatio: record.securitizationRatio ?? 1,
      securityFees: record.securityFees,
      couponFeesPaid: record.couponFeesPaid,
      vaultPubkey: scriptDetails.vaultPubkey,
      vaultClaimPubkey: scriptDetails.vaultClaimPubkey,
      ownerPubkey: scriptDetails.ownerPubkey,
      vaultXpubSources: scriptDetails.vaultXpubSources,
      vaultClaimHeight: scriptDetails.vaultClaimHeight,
      openClaimHeight: scriptDetails.openClaimHeight,
      createdAtHeight: scriptDetails.createdAtHeight,
      fundingExpirationHeight: record.fundingExpirationHeight!,
      isFlexible: record.isFlexible ?? false,
      fundHoldExtensionsByBitcoinExpirationHeight: record.fundHoldExtensionsByBitcoinExpirationHeight,
      createdAtArgonBlock: record.createdAtArgonBlock!,
    });
  });
  cleanupTasks.add(() => getBitcoinLock.mockRestore());

  const ratchetPreview = Vue.ref<IBitcoinLiquidRatchetPreview>({
    liquidId: 77,
    fissionIds: [1],
    skippedFissionIds: [],
    sourceLiquidity: 850_000_000n,
    newLiquidity: 900_000_000n,
    amountToMint: 50_000_000n,
    amountToBurn: 0n,
    lockChanges: [],
    errors: [],
    canRatchet: true,
  });
  const pendingRatchet = Vue.shallowRef<TransactionInfo>();
  const currentFission = new BitcoinFissionModel({
    ownerAccount: lock.ownerAccount ?? '5SyntheticLiquidLockingWallet',
    fissionId: 1,
    liquidId: 77,
    utxoId: lock.utxoId!,
    satoshis: lock.fissionedSatoshis ?? lock.securitizedSatoshis,
    microgonsAtTargetPerBtc: lock.microgonsAtTargetPerBtc ?? 6_800_000_000n,
    liquidityPromised: ratchetPreview.value.sourceLiquidity,
    createdAtArgonBlock: lock.createdAtArgonBlock ?? 18_500,
    ratchetNumber: 0,
    lastRatchetTick: 10_000,
    lastUpdatedArgonBlock: lock.createdAtArgonBlock ?? 18_500,
  });
  const bitcoinFissions: BitcoinFissions = Object.assign(Object.create(BitcoinFissions.prototype), {
    data: Vue.reactive({
      fissionsById: { [currentFission.fissionId]: currentFission },
    }),
    load: fn(async () => undefined),
  });
  const bitcoinLiquidRatchets: BitcoinLiquidRatchet = Object.assign(Object.create(BitcoinLiquidRatchet.prototype), {
    previewRatchet: fn(async () => ratchetPreview.value),
    submit: fn(async () =>
      createScenarioTransactionInfo({
        extrinsicType: ExtrinsicType.BitcoinRatchet,
        metadata: { liquidId: 77, fissionIds: [1], resecuritizedUtxoIds: [] },
        onCleanup: task => cleanupTasks.add(task),
      }),
    ),
    getPendingRatchetTxInfo: fn(() => pendingRatchet.value),
  });
  const bitcoinOrphanRelease = {
    prepare: fn(async () => ({
      canAfford: true,
      availableBalance: 25_000_000n,
      txFeePlusTip: 125_000n,
    })),
    submit: fn(async ({ record }: { record: IBitcoinUtxoRecord }) =>
      createScenarioTransactionInfo({
        extrinsicType: ExtrinsicType.BitcoinOrphanedUtxoRelease,
        metadata: {
          releaseKind: 'Orphan',
          utxoId: lock.utxoId!,
          utxoRecordId: record.id,
          utxoRef: { txid: record.txid, vout: record.vout },
          toScriptPubkey: record.releaseToDestinationAddress ?? '',
          bitcoinNetworkFee: record.releaseBitcoinNetworkFee ?? 18_000n,
        },
        onCleanup: task => cleanupTasks.add(task),
      }),
    ),
    getPendingReleaseTxInfo: fn((_lockUtxoId: number, record: IBitcoinUtxoRecord) => orphanTransactions.get(record.id)),
  };
  mocked(getBitcoinFissions).mockReturnValue(bitcoinFissions);
  mocked(getBitcoinTransactionOperations, { partial: true }).mockReturnValue({
    bitcoinLiquidRatchet: bitcoinLiquidRatchets,
    bitcoinOrphanRelease: bitcoinOrphanRelease as never,
    bitcoinLockCreate: bitcoinLockCreate as never,
    bitcoinLockRelease: bitcoinLockRelease as never,
    bitcoinLockResecuritize: bitcoinLockResecuritize as never,
  });
  mocked(loadBitcoinTransactionOperations).mockImplementation(async () => getBitcoinTransactionOperations());

  function setFeeWaiver(remainingFeeCreditMicrogons = 20_400_000n, resumableRequestedSatoshis?: bigint) {
    Object.assign(vault, {
      terms: { ...vault.terms, bitcoinBaseFee: 2_000_000n },
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
        accountId: defaultArgonWallet.address,
        createdAt: new Date(scenarioStartedAt - 24 * 60 * 60 * 1_000),
        updatedAt: new Date(scenarioStartedAt),
      },
    };
    let resumableCoupon: IBitcoinLockCouponStatus | undefined;
    if (resumableRequestedSatoshis != null) {
      const pendingInitialization: IBitcoinLockCouponUseRecord = {
        id: 2,
        couponId: 2,
        requestId: 'synthetic-signed-initialization',
        status: 'Prepared',
        feeCreditMicrogons: remainingFeeCreditMicrogons,
        requestedSatoshis: resumableRequestedSatoshis,
        ownerAccountId: defaultArgonWallet.address,
        ownerBitcoinPubkey: `02${'55'.repeat(32)}`,
        microgonsAtTargetPerBtc: 6_800_000_000n,
        feeCoupon: {
          feeDiscount: remainingFeeCreditMicrogons,
          securitizationSpaceToUnreserve: 0n,
          expiresAtFrame: 10_100n,
          nonce: 2n,
          signature: '0xsignature',
        },
        createdAt: new Date(scenarioStartedAt - 60_000),
        updatedAt: new Date(scenarioStartedAt),
      };
      resumableCoupon = {
        ...coupon,
        status: 'Prepared',
        pendingFeeCreditMicrogons: remainingFeeCreditMicrogons,
        remainingFeeCreditMicrogons: 0n,
        coupon: {
          ...coupon.coupon,
          id: 2,
          sequence: 0,
          offerCode: 'synthetic-resumable-fee-waiver',
        },
        uses: [pendingInitialization],
      };
    }
    const bitcoinLockCoupons = Vue.reactive({
      currentCoupon: coupon,
      ...(resumableCoupon ? { resumableCoupon } : {}),
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
    microgonsPer: {
      ...currency.microgonsPer,
      [UnitOfMeasurement.ARGNOT]: 14_000_000n,
      [UnitOfMeasurement.USD]: 1_000_000n,
      [UnitOfMeasurement.BTC]: 6_800_000_000n,
    },
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

  const defaultArgonWallet = Vue.reactive({
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
  Object.assign(wallets, { defaultArgonWallet });
  mocked(getWalletKeys, { partial: true }).mockReturnValue({
    defaultArgonAddress: '5SyntheticInternalWallet',
    vaultingAddress: '5SyntheticVaultingWallet',
    getLiquidLockingKeypair: fn(async () => ({ address: '5SyntheticLiquidLockingWallet' }) as never),
  });

  const myVault = getMyVault();
  Object.assign(myVault, {
    collectBuilder: { getNotice: fn(() => undefined) },
    load: fn(async () => undefined),
    subscribe: fn(async () => undefined),
    getBitcoinReleaseRequestTxInfo: fn(() => undefined),
    getTxInfoByType: fn(() => undefined),
  });

  mocked(getVaults, { partial: true }).mockReturnValue({
    operatorNamesByVaultId: { [vault.vaultId]: 'Atlas Operator' },
    vaultsById: { [vault.vaultId]: vault },
    fetchAndCalculateRedemptionAmount: fn(async () => 825_000_000n),
    load: fn(async () => undefined),
    refreshVault: fn(async () => vault),
  });
  mocked(useVaultingStats, { partial: true }).mockReturnValue({ bitcoinAPR: 8.4 });
  mocked(getMainchainClient).mockResolvedValue(scenarioMainchainClient);

  return {
    bitcoinLocks,
    bitcoinFissions,
    bitcoinLiquidRatchets,
    bitcoinLockCreate,
    bitcoinLockRelease,
    bitcoinLockResecuritize,
    bitcoinOrphanRelease,
    config,
    financials,
    fundingRecord,
    defaultArgonWallet,
    lock,
    locks,
    lockProcessing,
    myVault,
    orphanTransactions,
    releaseLifecycle,
    releaseProcessing,
    releaseVaultWaitProgress,
    ratchetPreview,
    pendingRatchet,
    pendingResecuritization,
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
  const lockDetails: IBitcoinLockDetails = {
    utxoId: 101,
    p2wshScriptHashHex: `0020${'11'.repeat(32)}`,
    vaultId: 7,
    isFlexible: false,
    ownerAccount: '5SyntheticLiquidLockingWallet',
    securitizationRatio: 1,
    securitizedSatoshis: 12_500_000n,
    fundedSatoshis: 12_500_000n,
    vaultPubkey: `02${'22'.repeat(32)}`,
    securityFees: 4_500_000n,
    couponFeesPaid: 0n,
    vaultClaimPubkey: `02${'33'.repeat(32)}`,
    ownerPubkey: `02${'44'.repeat(32)}`,
    vaultXpubSources: { parentFingerprint: new Uint8Array(4), cosignHdIndex: 0, claimHdIndex: 0 },
    vaultClaimHeight: 250_100,
    openClaimHeight: 250_200,
    createdAtHeight: 250_000,
    fundingExpirationHeight: 250_006,
    createdAtArgonBlock: 18_500,
    fundHoldExtensionsByBitcoinExpirationHeight: {},
  };

  return {
    uuid: 'synthetic-bitcoin-overlay-lock',
    utxoId: 101,
    status: BitcoinLockStatus.LockFunded,
    securitizedSatoshis: lockDetails.securitizedSatoshis,
    ownerAccount: lockDetails.ownerAccount,
    microgonsAtTargetPerBtc: 6_800_000_000n,
    securitizationCoverageMicrogons: 850_000_000n,
    securitizationTick: 10_000,
    fissionedSatoshis: 12_500_000n,
    securitizationRatio: lockDetails.securitizationRatio,
    securityFees: lockDetails.securityFees,
    couponFeesPaid: lockDetails.couponFeesPaid,
    scriptDetails: {
      p2wshScriptHashHex: lockDetails.p2wshScriptHashHex,
      vaultPubkey: lockDetails.vaultPubkey,
      vaultClaimPubkey: lockDetails.vaultClaimPubkey,
      ownerPubkey: lockDetails.ownerPubkey,
      vaultXpubSources: lockDetails.vaultXpubSources,
      vaultClaimHeight: lockDetails.vaultClaimHeight,
      openClaimHeight: lockDetails.openClaimHeight,
      createdAtHeight: lockDetails.createdAtHeight,
    },
    fundingExpirationHeight: lockDetails.fundingExpirationHeight,
    isFlexible: lockDetails.isFlexible,
    fundHoldExtensionsByBitcoinExpirationHeight: lockDetails.fundHoldExtensionsByBitcoinExpirationHeight,
    createdAtArgonBlock: lockDetails.createdAtArgonBlock,
    utxos: [],
    fundedSatoshis: lockDetails.fundedSatoshis,
    cosignVersion: 'v1',
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
  const scriptDetails = local.scriptDetails!;
  const lockDetails: IBitcoinLock = {
    utxoId: 801,
    p2wshScriptHashHex: scriptDetails.p2wshScriptHashHex,
    vaultId: local.vaultId,
    securitizedSatoshis: local.securitizedSatoshis,
    microgonsAtTargetPerBtc: local.microgonsAtTargetPerBtc!,
    securitizationCoverageMicrogons: 1_700_000_000n,
    securitizationTick: 0,
    fundedSatoshis: 25_000_000n,
    fissionedSatoshis: 0n,
    ownerAccount: '5SyntheticExternalOwner',
    securitizationRatio: local.securitizationRatio!,
    securityFees: local.securityFees,
    couponFeesPaid: local.couponFeesPaid,
    vaultPubkey: scriptDetails.vaultPubkey,
    vaultClaimPubkey: scriptDetails.vaultClaimPubkey,
    ownerPubkey: scriptDetails.ownerPubkey,
    vaultXpubSources: scriptDetails.vaultXpubSources,
    vaultClaimHeight: scriptDetails.vaultClaimHeight,
    openClaimHeight: scriptDetails.openClaimHeight,
    createdAtHeight: scriptDetails.createdAtHeight,
    fundingExpirationHeight: local.fundingExpirationHeight!,
    isFlexible: local.isFlexible!,
    fundHoldExtensionsByBitcoinExpirationHeight: local.fundHoldExtensionsByBitcoinExpirationHeight,
    createdAtArgonBlock: local.createdAtArgonBlock!,
  };
  return {
    utxoId: 801,
    satoshis: 25_000_000n,
    securitizationCoverageMicrogons: 1_700_000_000n,
    isPending: false,
    isReleasing: false,
    lockDetails,
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
      showReadyForBitcoin: false,
      isFundingSeenInMempoolOnly: false,
    },
    lockProcessingDetails: { progressPct: 0, confirmations: 0, expectedConfirmations: 0 },
    lockProcessingError: '',
    satoshis: lock.fundedSatoshis || lock.securitizedSatoshis,
    valueOfBtc: 875_000_000n,
    totalLiquidity: 850_000_000n,
    pendingLiquidity: 300_000_000n,
    receivedLiquidity: 550_000_000n,
    valueBeyondLiquidity: 25_000_000n,
    startingCapital: 850_000_000n,
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
