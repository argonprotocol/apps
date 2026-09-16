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
  BitcoinReleaseKind,
  BitcoinReleaseStatus,
  type IBitcoinReleaseRecord,
} from '../../src-vue/interfaces/IBitcoinReleaseRecord.ts';
import {
  BitcoinUtxoSpendStatus,
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
import BitcoinReleases from '../../src-vue/lib/BitcoinReleases.ts';
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
            lockId: lock.lockId!,
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
        lockId,
        toScriptPubkey,
        bitcoinNetworkFee,
      }: {
        lockId: number;
        toScriptPubkey: string;
        bitcoinNetworkFee: bigint;
      }) =>
        createScenarioTransactionInfo({
          extrinsicType: ExtrinsicType.BitcoinRequestRelease,
          metadata: {
            releaseId: 'synthetic-lock-release',
            lockId,
            toScriptPubkey,
            bitcoinNetworkFee,
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
  const ownVault = createScenarioVault({
    vaultId: 8,
    operatorAccountId: '5SyntheticInternalWallet',
    securitization: 1_500_000_000n,
  });
  const fundingUtxo = createBitcoinUtxo({
    id: 201,
    lockId: lock.lockId!,
    status: BitcoinUtxoStatus.FundingUtxo,
    satoshis: lock.fundedSatoshis,
  });
  lock.fundingUtxoIds = [fundingUtxo.id];
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
    utxoTracking.load(records);
    lock.fundingUtxoIds = records.filter(utxo => utxo.status === BitcoinUtxoStatus.FundingUtxo).map(utxo => utxo.id);
    lock.fundedSatoshis = utxoTracking.getFundingUtxos(lock).reduce((total, utxo) => total + utxo.satoshis, 0n);
  }

  replaceUtxoRecords([fundingUtxo]);
  const releases: BitcoinReleases = Object.assign(Object.create(BitcoinReleases.prototype), {
    data: Vue.reactive({ releasesById: {} }),
  });

  function setRelease(release: IBitcoinReleaseRecord, inputUtxo?: IBitcoinUtxoRecord) {
    releases.data.releasesById[release.id] = release;
    const isActive = ![
      BitcoinReleaseStatus.Complete,
      BitcoinReleaseStatus.Cancelled,
      BitcoinReleaseStatus.Failed,
    ].includes(release.status);
    if (release.kind === BitcoinReleaseKind.Lock) lock.activeReleaseId = isActive ? release.id : undefined;
    if (release.kind === BitcoinReleaseKind.Orphan && inputUtxo) {
      inputUtxo.activeReleaseId = isActive ? release.id : undefined;
    }
  }

  const bitcoinLocks: BitcoinLocks = Object.assign(Object.create(BitcoinLocks.prototype) as BitcoinLocks, {
    data: Vue.reactive({
      pendingLocks: [],
      locksByLockId: { [lock.lockId!]: lock },
      oracleBitcoinBlockHeight: 250_020,
      bitcoinNetwork: BitcoinNetwork.Bitcoin,
      isReconciliationPending: false,
      readiness: 'ready',
    }),
    releases,
    utxoTracking,
    load: fn(async () => undefined),
    getAllLocks: fn(() => locks),
    getLockById: fn((lockId: number) => locks.find(candidate => candidate.lockId === lockId)),
    getLockByUuid: fn((uuid: string) => locks.find(candidate => candidate.uuid === uuid)),
    createLockSummary: fn((record: IBitcoinLockRecord) => createBitcoinLockSummary(record)),
    getTable: fn(async () => ({
      getLockIdByUuid: fn(async (uuid: string) => locks.find(candidate => candidate.uuid === uuid)?.lockId),
      getByLockId: fn(async (lockId: number) => locks.find(candidate => candidate.lockId === lockId)),
      updateFromCurrentLock: fn(async () => undefined),
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
    getSecuritizationHoldExpirationTime: fn(() => scenarioStartedAt + 24 * 60 * 60 * 1_000),
    isSecuritizationHoldExpired: fn(
      (record: IBitcoinLockRecord) => bitcoinLocks.getSecuritizationHoldExpirationTime(record) <= scenarioStartedAt,
    ),
    unlockDeadlineTime: fn(() => scenarioStartedAt + 24 * 60 * 60 * 1_000),
    getSecuritizationHoldProgress: fn(() => 45),
    getRequestReleaseByVaultProgress: fn(() => releaseVaultWaitProgress.value),
    getCosignDeadlineProgress: fn(() => 65),
    getLockTermProgress: fn(() => 58),
    getMintPercent: fn(() => 64),
    acknowledgeFailed: fn(async () => undefined),
  });
  Object.defineProperty(bitcoinLocks, 'currentLoadPromise', {
    configurable: true,
    writable: true,
    value: Promise.resolve(),
  });
  mocked(getBitcoinLocks).mockReturnValue(bitcoinLocks);
  const getBitcoinLock = spyOn(BitcoinLock, 'get').mockImplementation(async (_client, lockId) => {
    const record = locks.find(candidate => candidate.lockId === lockId);
    const scriptDetails = record?.scriptDetails;
    if (!record || !scriptDetails) return;

    return new BitcoinLock({
      lockId,
      p2wshScriptHashHex: scriptDetails.p2wshScriptHashHex,
      vaultId: record.vaultId,
      securitizedSatoshis: record.securitizedSatoshis,
      microgonsAtTargetPerBtc: record.microgonsAtTargetPerBtc ?? 6_800_000_000n,
      securitizationCoverageMicrogons: record.securitizationCoverageMicrogons ?? 0n,
      securitizationTick: record.securitizationTick ?? 10_000,
      fundedSatoshis: record.fundedSatoshis,
      fundingUtxos: utxoTracking.getFundingUtxos(record).map(utxo => ({
        utxoRef: { txid: utxo.txid, vout: utxo.vout },
        satoshis: utxo.satoshis,
      })),
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
      securitizationHoldExpirationBitcoinHeight: record.securitizationHoldExpirationBitcoinHeight!,
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
    lockId: lock.lockId!,
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
  Object.defineProperty(bitcoinFissions, 'currentLoadPromise', {
    configurable: true,
    writable: true,
    value: Promise.resolve(),
  });
  const bitcoinLiquidRatchets: BitcoinLiquidRatchet = Object.assign(Object.create(BitcoinLiquidRatchet.prototype), {
    previewRatchet: fn(async () => ratchetPreview.value),
    submit: fn(async () =>
      createScenarioTransactionInfo({
        extrinsicType: ExtrinsicType.BitcoinRatchet,
        metadata: { liquidId: 77, fissionIds: [1], resecuritizedLockIds: [] },
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
    submit: fn(
      async ({
        record,
        toScriptPubkey,
        bitcoinNetworkFee,
      }: {
        record: IBitcoinUtxoRecord;
        toScriptPubkey: string;
        bitcoinNetworkFee?: bigint;
      }) =>
        createScenarioTransactionInfo({
          extrinsicType: ExtrinsicType.BitcoinOrphanedUtxoRelease,
          metadata: {
            releaseId: `synthetic-orphan-release-${record.id}`,
            releaseKind: 'Orphan',
            lockId: lock.lockId!,
            utxoRecordId: record.id,
            utxoRef: { txid: record.txid, vout: record.vout },
            toScriptPubkey,
            bitcoinNetworkFee: bitcoinNetworkFee ?? 18_000n,
          },
          onCleanup: task => cleanupTasks.add(task),
        }),
    ),
    getPendingReleaseTxInfo: fn((_lockId: number, record: IBitcoinUtxoRecord) => orphanTransactions.get(record.id)),
  };
  mocked(getBitcoinFissions).mockReturnValue(bitcoinFissions);
  mocked(getBitcoinTransactionOperations, { partial: true }).mockReturnValue({
    bitcoinLiquidRatchet: bitcoinLiquidRatchets,
    bitcoinOrphanRelease: bitcoinOrphanRelease as never,
    bitcoinLockCreate: bitcoinLockCreate as never,
    bitcoinLockRelease: bitcoinLockRelease as never,
    bitcoinLockResecuritize: bitcoinLockResecuritize as never,
  });

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
    liquidAllRecords: [],
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

  const vaults = {
    operatorNamesByVaultId: { [vault.vaultId]: 'Atlas Operator' },
    vaultsById: { [vault.vaultId]: vault, [ownVault.vaultId]: ownVault },
    fetchAndCalculateRedemptionAmount: fn(async () => 825_000_000n),
    load: fn(async () => undefined),
    refreshVault: fn(async (vaultId: number) => vaults.vaultsById[vaultId]),
  };
  mocked(getVaults, { partial: true }).mockReturnValue(vaults);
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
    fundingUtxo,
    defaultArgonWallet,
    lock,
    locks,
    lockProcessing,
    myVault,
    ownVault,
    orphanTransactions,
    releaseProcessing,
    releaseVaultWaitProgress,
    ratchetPreview,
    pendingRatchet,
    pendingResecuritization,
    replaceUtxoRecords,
    setRelease,
    scenarioStartedAt,
    setFeeWaiver,
    vault,
    vaults,
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
    lockId: 101,
    p2wshScriptHashHex: `0020${'11'.repeat(32)}`,
    vaultId: 7,
    isFlexible: false,
    ownerAccount: '5SyntheticLiquidLockingWallet',
    securitizationRatio: 1,
    securitizedSatoshis: 12_500_000n,
    fundedSatoshis: 12_500_000n,
    fundingUtxos: [],
    vaultPubkey: `02${'22'.repeat(32)}`,
    securityFees: 4_500_000n,
    couponFeesPaid: 0n,
    vaultClaimPubkey: `02${'33'.repeat(32)}`,
    ownerPubkey: `02${'44'.repeat(32)}`,
    vaultXpubSources: { parentFingerprint: new Uint8Array(4), cosignHdIndex: 0, claimHdIndex: 0 },
    vaultClaimHeight: 250_100,
    openClaimHeight: 250_200,
    createdAtHeight: 250_000,
    securitizationHoldExpirationBitcoinHeight: 250_006,
    createdAtArgonBlock: 18_500,
    fundHoldExtensionsByBitcoinExpirationHeight: {},
  };

  return {
    uuid: 'synthetic-bitcoin-overlay-lock',
    lockId: 101,
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
    securitizationHoldExpirationBitcoinHeight: lockDetails.securitizationHoldExpirationBitcoinHeight,
    isFlexible: lockDetails.isFlexible,
    fundHoldExtensionsByBitcoinExpirationHeight: lockDetails.fundHoldExtensionsByBitcoinExpirationHeight,
    createdAtArgonBlock: lockDetails.createdAtArgonBlock,
    fundedSatoshis: lockDetails.fundedSatoshis,
    fundingUtxoIds: [201],
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
  overrides: Partial<IBitcoinUtxoRecord> & Pick<IBitcoinUtxoRecord, 'id' | 'lockId' | 'status'>,
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
    spendStatus: BitcoinUtxoSpendStatus.Unspent,
    createdAt: timestamp,
    updatedAt: timestamp,
    ...overrides,
  };
}

export function createBitcoinRelease(overrides: Partial<IBitcoinReleaseRecord> = {}): IBitcoinReleaseRecord {
  const timestamp = new Date('2026-08-16T14:20:00.000Z');
  return {
    id: 'synthetic-bitcoin-release',
    sendId: 'synthetic-bitcoin-release',
    kind: BitcoinReleaseKind.Lock,
    lockId: 101,
    releaseNumber: 1,
    status: BitcoinReleaseStatus.WaitingForVaultCosign,
    inputUtxoIds: [201],
    requestedReleaseAtTick: 10_010,
    toScriptPubkey: `0014${'55'.repeat(20)}`,
    bitcoinNetworkFee: 18_000n,
    destinationSatoshis: 12_482_000n,
    changeSatoshis: 0n,
    vaultSignatures: [],
    createdAt: timestamp,
    updatedAt: timestamp,
    ...overrides,
  };
}

export function createExternalBitcoinLock(overrides: Partial<IExternalBitcoinLock> = {}): IExternalBitcoinLock {
  const local = createBitcoinLock();
  const scriptDetails = local.scriptDetails!;
  const lockDetails: IBitcoinLock = {
    lockId: 801,
    p2wshScriptHashHex: scriptDetails.p2wshScriptHashHex,
    vaultId: local.vaultId,
    securitizedSatoshis: local.securitizedSatoshis,
    microgonsAtTargetPerBtc: local.microgonsAtTargetPerBtc!,
    securitizationCoverageMicrogons: 1_700_000_000n,
    securitizationTick: 0,
    fundedSatoshis: 25_000_000n,
    fundingUtxos: [],
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
    securitizationHoldExpirationBitcoinHeight: local.securitizationHoldExpirationBitcoinHeight!,
    isFlexible: local.isFlexible!,
    fundHoldExtensionsByBitcoinExpirationHeight: local.fundHoldExtensionsByBitcoinExpirationHeight,
    createdAtArgonBlock: local.createdAtArgonBlock!,
  };
  return {
    lockId: 801,
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
    lockId: lock.lockId,
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

export function createScenarioTransactionInfo<Metadata>(options: {
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
