import * as Vue from 'vue';
import { BitcoinFission, createDeferred, SATOSHIS_PER_BITCOIN, UnitOfMeasurement } from '@argonprotocol/apps-core';
import type { IBitcoinLockCouponStatus } from '@argonprotocol/apps-router';
import BigNumber from 'bignumber.js';
import { fn, mocked } from 'storybook/test';
import { setupAppScenario } from './setupAppScenario.ts';
import { BitcoinLockStatus, type IBitcoinLockRecord } from '../../src-vue/interfaces/IBitcoinLockRecord.ts';
import type { IBitcoinLockSummary } from '../../src-vue/interfaces/IBitcoinLockSummary.ts';
import { createFinancialPosition } from '../../src-vue/interfaces/IFinancialPosition.ts';
import {
  BitcoinUtxoSpendStatus,
  BitcoinUtxoStatus,
  type IBitcoinUtxoRecord,
} from '../../src-vue/interfaces/IBitcoinUtxoRecord.ts';
import {
  BitcoinReleaseKind,
  BitcoinReleaseStatus,
  type IBitcoinReleaseRecord,
} from '../../src-vue/interfaces/IBitcoinReleaseRecord.ts';
import { TopTab } from '../../src-vue/interfaces/IConfig.ts';
import { ExtrinsicType, TransactionStatus } from '../../src-vue/interfaces/ITransactionRecord.ts';
import BitcoinLocks from '../../src-vue/lib/BitcoinLocks.ts';
import BitcoinReleases from '../../src-vue/lib/BitcoinReleases.ts';
import { BitcoinFissions, createBitcoinLiquids } from '../../src-vue/lib/BitcoinFissions.ts';
import { reduceFinancialPositions } from '../../src-vue/lib/financials/index.ts';
import type { TransactionInfo } from '../../src-vue/lib/TransactionInfo.ts';
import {
  BitcoinLiquidCreate,
  BitcoinLiquidCreateStateChangedError,
  type BitcoinLiquidCreateInput,
  type IBitcoinLiquidCreateMetadata,
} from '../../src-vue/lib/txs/BitcoinLiquid.create.ts';
import { BitcoinLiquidClose } from '../../src-vue/lib/txs/BitcoinLiquid.close.ts';
import { BitcoinLiquidRatchet } from '../../src-vue/lib/txs/BitcoinLiquid.ratchet.ts';
import {
  getBitcoinFissions,
  getBitcoinLockCoupons,
  getBitcoinLocks,
  getBitcoinTransactionOperations,
} from '../../src-vue/stores/bitcoin.ts';
import { getCurrency } from '../../src-vue/stores/currency.ts';
import { useFinancials } from '../../src-vue/stores/financials.ts';
import { getMainchainClient } from '../../src-vue/stores/mainchain.ts';
import { getVaults } from '../../src-vue/stores/vaults.ts';
import { getWalletKeys, useWallets } from '../../src-vue/stores/wallets.ts';
import { createBitcoinRelease } from './setupBitcoinOverlayScenario.ts';

export function setupBitcoinPortfolioScenario(
  options: {
    feeWaiver?: boolean;
    feeWaiverRefreshPending?: boolean;
    createLiquidError?: string;
    createLiquidAvailableVaultId?: number;
    createLiquidWithoutSecuritization?: boolean;
    createLiquidPreviewPending?: boolean;
    closedLiquidArchive?: boolean;
    archivedOnly?: boolean;
    financialHistoryUnavailable?: boolean;
    noAvailableBitcoin?: boolean;
    pendingLiquidCreation?: boolean;
    settledLiquid?: boolean;
    currentBitcoinPriceUsd?: number;
  } = {},
) {
  const { wallets } = setupAppScenario({
    selectedTab: TopTab.BitcoinLocks,
    config: {
      hasExtensionTreasury: true,
      ...(options.feeWaiver ? { upstreamOperator: { name: 'Atlas Operator', vaultId: 7 } } : {}),
    },
  });
  const currentBitcoinPriceUsd = options.currentBitcoinPriceUsd ?? 68_000;
  const currentBitcoinRate = BigInt(currentBitcoinPriceUsd) * 1_000_000n;
  const currency = getCurrency();
  currency.isLoaded = true;
  currency.priceIndex.btcUsdPrice = BigNumber(currentBitcoinPriceUsd);
  currency.microgonsPer.BTC = currentBitcoinRate;
  wallets.defaultArgonWallet.availableMicrogons = 12_000_000n;
  wallets.defaultArgonWallet.availableMicronots = 3_000_000n;
  wallets.defaultArgonWallet.totalMicrogons = 12_000_000n;
  wallets.defaultArgonWallet.totalMicronots = 3_000_000n;
  Object.assign(getVaults().operatorNamesByVaultId, {
    7: 'Atlas Operator',
    12: 'Meridian Vault',
  });

  const liquidSummary = createSummary(9, BitcoinLockStatus.LockFunded, {
    receivedLiquidity: 1_125_000_000n,
    ratchetPercent: -2.25,
    totalReturn: 13.4,
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
    createSummary(8, BitcoinLockStatus.LockFunded, {
      pendingLiquidity: options.settledLiquid ? 0n : 85_000_000n,
      receivedLiquidity: 510_000_000n,
      ratchetPercent: 5.75,
    }),
    liquidSummary,
    createSummary(10, BitcoinLockStatus.LockFunded, {
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
  const fundingUtxos = [
    createFundingUtxo(releasing[0].record, BitcoinUtxoStatus.FundingUtxo),
    createFundingUtxo(releasing[1].record, BitcoinUtxoStatus.FundingUtxo),
    createFundingUtxo(releasing[2].record, BitcoinUtxoStatus.FundingUtxo),
    createFundingUtxo(releasing[3].record, BitcoinUtxoStatus.FundingUtxo),
    createFundingUtxo(archived[0].record, BitcoinUtxoStatus.FundingUtxo),
  ];
  const orphans = [
    createOrphan(31, BitcoinUtxoStatus.Orphaned),
    createOrphan(32, BitcoinUtxoStatus.Orphaned),
    createOrphan(33, BitcoinUtxoStatus.Orphaned),
    createOrphan(34, BitcoinUtxoStatus.Orphaned),
    createOrphan(35, BitcoinUtxoStatus.Orphaned),
  ];
  const displayRecords = [...summaries, ...releasing];
  const records = [...displayRecords, ...archived].map(summary => summary.record);
  const recordsByLockId = new Map(records.map(record => [record.lockId, record]));
  const summariesByUuid = new Map([...displayRecords, ...archived].map(summary => [summary.uuid, summary]));
  const allUtxos = [...fundingUtxos, ...orphans];
  for (const utxo of fundingUtxos) {
    const lock = recordsByLockId.get(utxo.lockId);
    if (lock) lock.fundingUtxoIds.push(utxo.id);
  }
  const releases = [
    createLockRelease(releasing[0].record, fundingUtxos[0], BitcoinReleaseStatus.SubmittingRequestOnArgon),
    createLockRelease(releasing[1].record, fundingUtxos[1], BitcoinReleaseStatus.WaitingForVaultCosign, {
      toScriptPubkey: '00141111111111111111111111111111111111111111',
      bitcoinNetworkFee: 15_000n,
    }),
    createLockRelease(releasing[2].record, fundingUtxos[2], BitcoinReleaseStatus.ReadyForBitcoinBroadcast, {
      toScriptPubkey: '00142222222222222222222222222222222222222222',
      bitcoinNetworkFee: 16_000n,
      vaultSignatures: [new Uint8Array([1, 2, 3])],
      cosignBlockNumber: 250_011,
    }),
    createLockRelease(releasing[3].record, fundingUtxos[3], BitcoinReleaseStatus.ConfirmingOnBitcoin, {
      toScriptPubkey: '00143333333333333333333333333333333333333333',
      bitcoinNetworkFee: 17_000n,
      vaultSignatures: [new Uint8Array([4, 5, 6])],
      cosignBlockNumber: 250_012,
      bitcoinTxid: 'synthetic-bitcoin-release-14',
      bitcoinFirstSeenAt: new Date('2026-08-15T14:00:00.000Z'),
      bitcoinFirstSeenHeight: 250_014,
      bitcoinFirstSeenOracleHeight: 250_012,
      bitcoinLastConfirmationCheckAt: new Date('2026-08-15T14:10:00.000Z'),
      bitcoinLastConfirmationCheckOracleHeight: 250_013,
    }),
    createLockRelease(archived[0].record, fundingUtxos[4], BitcoinReleaseStatus.Complete, {
      toScriptPubkey: '00144444444444444444444444444444444444444444',
      bitcoinNetworkFee: 18_000n,
      vaultSignatures: [new Uint8Array([7, 8, 9])],
      cosignBlockNumber: 250_013,
      bitcoinTxid: 'synthetic-bitcoin-release-20',
      bitcoinFirstSeenAt: new Date('2026-08-08T14:00:00.000Z'),
      bitcoinFirstSeenHeight: 249_990,
      bitcoinFirstSeenOracleHeight: 249_988,
      bitcoinConfirmedHeight: 249_996,
    }),
    createOrphanRelease(orphans[1], BitcoinReleaseStatus.ReadyForBitcoinBroadcast, {
      vaultSignatures: [new Uint8Array([1, 2, 3])],
    }),
    createOrphanRelease(orphans[2], BitcoinReleaseStatus.ConfirmingOnBitcoin, {
      bitcoinTxid: 'synthetic-return-tx',
      bitcoinFirstSeenAt: new Date('2026-08-15T14:30:00.000Z'),
    }),
    createOrphanRelease(orphans[3], BitcoinReleaseStatus.Failed, {
      statusError: 'The vault signature expired before broadcast.',
    }),
    createOrphanRelease(orphans[4], BitcoinReleaseStatus.Complete),
  ];
  orphans[4].spendStatus = BitcoinUtxoSpendStatus.Spent;
  orphans[4].spentByReleaseId = releases.at(-1)?.id;
  const liquidFissions: BitcoinFission[] = [
    new BitcoinFission({
      ownerAccount: '5SyntheticLiquidLockingWallet',
      fissionId: 2_401,
      liquidId: 2_401,
      lockId: summaries[4].record.lockId!,
      satoshis: 42_000_000n,
      microgonsAtTargetPerBtc: 68_000_000_000n,
      liquidityPromised: 28_560_000_000n,
      createdAtArgonBlock: 18_500,
      ratchetNumber: 1,
      lastRatchetTick: 10_000,
      lastUpdatedArgonBlock: 18_700,
      ratchets: [
        {
          source: 'fission',
          sourceRatchetIndex: 0,
          ratchetNumber: 0,
          microgonsAtTargetPerBtc: 68_000_000_000n,
          liquidityPromised: 28_560_000_000n,
          amountMinted: 28_560_000_000n,
          amountBurned: 0n,
          mintPending: 0n,
          txFee: 5_100_000n,
          blockNumber: 18_500,
          blockTime: new Date('2026-07-01T14:00:00Z'),
          extrinsicIndex: 1,
        },
      ],
    }),
    new BitcoinFission({
      ownerAccount: '5SyntheticLiquidLockingWallet',
      fissionId: 2_402,
      liquidId: 2_401,
      lockId: summaries[5].record.lockId!,
      satoshis: 28_000_000n,
      microgonsAtTargetPerBtc: 68_000_000_000n,
      liquidityPromised: 19_040_000_000n,
      createdAtArgonBlock: 18_500,
      ratchetNumber: 1,
      lastRatchetTick: 10_000,
      lastUpdatedArgonBlock: 18_700,
      ratchets: [
        {
          source: 'fission',
          sourceRatchetIndex: 0,
          ratchetNumber: 0,
          microgonsAtTargetPerBtc: 68_000_000_000n,
          liquidityPromised: 19_040_000_000n,
          amountMinted: 19_040_000_000n,
          amountBurned: 0n,
          mintPending: 0n,
          txFee: 5_100_000n,
          blockNumber: 18_500,
          blockTime: new Date('2026-07-01T14:00:00Z'),
          extrinsicIndex: 1,
        },
      ],
    }),
    new BitcoinFission({
      ownerAccount: '5SyntheticLiquidLockingWallet',
      fissionId: 2_468,
      liquidId: 2_468,
      lockId: summaries[6].record.lockId!,
      satoshis: 56_000_000n,
      microgonsAtTargetPerBtc: 68_000_000_000n,
      liquidityPromised: 38_080_000_000n,
      createdAtArgonBlock: 18_650,
      ratchetNumber: 0,
      lastRatchetTick: 10_010,
      lastUpdatedArgonBlock: 18_650,
      ratchets: [
        {
          source: 'fission',
          sourceRatchetIndex: 0,
          ratchetNumber: 0,
          microgonsAtTargetPerBtc: 68_000_000_000n,
          liquidityPromised: 38_080_000_000n,
          amountMinted: 38_080_000_000n,
          amountBurned: 0n,
          mintPending: options.settledLiquid ? 0n : 9_900_800_000n,
          txFee: 4_800_000n,
          blockNumber: 18_650,
          blockTime: new Date('2026-07-03T16:30:00Z'),
          extrinsicIndex: 2,
        },
      ],
    }),
  ];
  const closedLiquidFissions = options.closedLiquidArchive
    ? [
        new BitcoinFission({
          ownerAccount: '5SyntheticLiquidLockingWallet',
          fissionId: 2_600,
          liquidId: 2_600,
          lockId: archived[0].record.lockId!,
          satoshis: 25_000_000n,
          microgonsAtTargetPerBtc: 68_000_000_000n,
          liquidityPromised: 17_000_000_000n,
          createdAtArgonBlock: 18_300,
          ratchetNumber: 0,
          lastUpdatedArgonBlock: 18_300,
          closedAtArgonBlock: 18_600,
          closedAtTick: 10_050,
          closedBlockTime: new Date('2026-08-08T16:00:00Z'),
          closedExtrinsicIndex: 3,
          closeReason: 'closed',
          redemptionAmount: 16_499_998_867n,
          closeTxFee: 1_688n,
          ratchets: [
            {
              source: 'fission',
              sourceRatchetIndex: 0,
              ratchetNumber: 0,
              microgonsAtTargetPerBtc: 68_000_000_000n,
              liquidityPromised: 17_000_000_000n,
              amountMinted: 17_000_000_000n,
              amountBurned: 0n,
              mintPending: 0n,
              txFee: 4_000_000n,
              blockNumber: 18_300,
              blockTime: new Date('2026-06-27T14:00:00Z'),
              extrinsicIndex: 1,
            },
          ],
        }),
      ]
    : [];
  const fissions = [...liquidFissions, ...closedLiquidFissions];
  for (const fission of fissions) {
    fission.origin ??= 'created';
    fission.feeHistoryCompleteThroughBlock = Math.max(
      fission.lastUpdatedArgonBlock ?? 0,
      fission.closedAtArgonBlock ?? 0,
    );
    fission.createdAt = fission.ratchets[0]?.blockTime ?? new Date('2026-07-01T14:00:00Z');
    fission.updatedAt = fission.closedBlockTime ?? new Date('2026-08-16T16:00:00Z');
  }
  const liquids = createBitcoinLiquids({ fissions });
  summaries[6].record.securitizedSatoshis = 100_000_000n;
  if (!options.settledLiquid) {
    liquidFissions[2].pendingMints.push({
      queueIndex: 51n,
      fissionId: 2_468,
      lockId: summaries[6].record.lockId!,
      ownerAccount: '5SyntheticLiquidLockingWallet',
      remainingAmount: 9_900_800_000n,
      maxAmountPerFrame: 2_000_000_000n,
    });
  }
  if (options.noAvailableBitcoin) {
    for (const record of records) {
      const allocatedSatoshis = liquidFissions
        .filter(fission => fission.lockId === record.lockId)
        .reduce((total, fission) => total + fission.satoshis, 0n);
      if (!allocatedSatoshis) continue;

      record.fundedSatoshis = allocatedSatoshis;
      record.securitizedSatoshis = allocatedSatoshis;
    }
  }

  const bitcoinReleases: BitcoinReleases = Object.assign(Object.create(BitcoinReleases.prototype), {
    data: Vue.reactive({ releasesById: Object.fromEntries(releases.map(release => [release.id, release])) }),
  });
  const bitcoinLocks: BitcoinLocks = Object.assign(Object.create(BitcoinLocks.prototype), {
    data: Vue.reactive({ readiness: 'ready', isReconciliationPending: false }),
    recovery: Vue.reactive({ hasPendingHistoryRecovery: false }),
    releases: bitcoinReleases,
    utxoTracking: {
      getAllOrphanLifecycleUtxos: fn(() => orphans),
      getUnresolvedOrphanRecords: fn(() => orphans),
      getUtxosForLock: fn((lockId: number) => allUtxos.filter(utxo => utxo.lockId === lockId)),
      getObservedFundingUtxos: fn((record: IBitcoinLockRecord) => {
        return allUtxos.filter(
          utxo => utxo.lockId === record.lockId && utxo.status === BitcoinUtxoStatus.SeenOnMempool,
        );
      }),
      getFundingUtxos: fn((lock: IBitcoinLockRecord) =>
        lock.fundingUtxoIds.flatMap(id => {
          const utxo = allUtxos.find(record => record.id === id);
          return utxo?.lockId === lock.lockId ? [utxo] : [];
        }),
      ),
    },
    load: fn(async () => undefined),
    getAllLocks: fn(() =>
      options.createLiquidAvailableVaultId === undefined
        ? records
        : records.filter(
            record =>
              record.status !== BitcoinLockStatus.LockFunded || record.vaultId === options.createLiquidAvailableVaultId,
          ),
    ),
    getLockById: fn((lockId: number) => recordsByLockId.get(lockId)),
    createLockSummary: fn((record: IBitcoinLockRecord) => summariesByUuid.get(record.uuid)!),
    getSecuritizationHoldExpirationTime: fn(() => Date.UTC(2026, 7, 16, 16, 0, 0)),
    unlockDeadlineTime: fn(() => Date.UTC(2026, 11, 15, 16, 0, 0)),
    isLockFunded: fn((record: IBitcoinLockRecord) => record.status === BitcoinLockStatus.LockFunded),
    isFinishedStatus: fn((record: IBitcoinLockRecord) => record.status === BitcoinLockStatus.Released),
    satoshisForArgonLiquidity: fn(
      async (microgons: bigint, microgonsAtTargetPerBtc: bigint) =>
        (microgons * SATOSHIS_PER_BITCOIN) / microgonsAtTargetPerBtc,
    ),
  });
  Object.defineProperty(bitcoinLocks, 'currentLoadPromise', {
    configurable: true,
    writable: true,
    value: Promise.resolve(),
  });

  mocked(getBitcoinLocks).mockReturnValue(bitcoinLocks as unknown as ReturnType<typeof getBitcoinLocks>);
  const displayedFissions = options.archivedOnly ? closedLiquidFissions : fissions;
  const fissionState = Vue.reactive<BitcoinFissions['data']>({
    fissionsById: Object.fromEntries(displayedFissions.map(fission => [fission.fissionId, fission])),
    activeFissionIds: new Set(options.archivedOnly ? [] : liquidFissions.map(fission => fission.fissionId)),
    minimumRatchetPercent: 5n,
    readiness: 'ready' as const,
    financialRevision: 1,
  });
  const bitcoinFissions = Object.assign(Object.create(BitcoinFissions.prototype), {
    data: fissionState,
    ownerAccount: '5SyntheticLiquidLockingWallet',
    load: fn(async () => undefined),
    refreshCurrent: fn(async () => liquidFissions),
  });
  Object.defineProperty(bitcoinFissions, 'currentLoadPromise', { value: Promise.resolve() });
  mocked(getBitcoinFissions).mockReturnValue(bitcoinFissions);
  const pendingLiquidCreateTxInfo = Vue.shallowRef<TransactionInfo<IBitcoinLiquidCreateMetadata>>();
  let finalizePendingLiquidCreation: (() => void) | undefined;
  const bitcoinLiquidCreate = Object.assign(Object.create(BitcoinLiquidCreate.prototype), {
    preview: fn(async () => {
      if (options.createLiquidPreviewPending) return await new Promise<void>(() => undefined);
      if (options.createLiquidError) throw new Error(options.createLiquidError);
      if (options.createLiquidWithoutSecuritization) {
        throw new BitcoinLiquidCreateStateChangedError(
          'Your cosigners can no longer securitize the selected Bitcoin amount.',
          Object.fromEntries(
            records
              .filter(record => record.status === BitcoinLockStatus.LockFunded && record.lockId != null)
              .map(record => [record.lockId!, 0n]),
          ),
        );
      }

      return {
        microgonsAtTargetPerBtc: 6_800_000_000n,
        liquidityMicrogons: 68_000_000_000n,
        totalSecurityFeeMicrogons: 136_000_000n,
        securityFeeMicrogons: 108_800_000n,
        couponCreditMicrogons: options.feeWaiver ? 27_200_000n : 0n,
        maximumSatoshisByLockId: Object.fromEntries(
          records
            .filter(record => record.status === BitcoinLockStatus.LockFunded && record.lockId != null)
            .map(record => [record.lockId!, record.fundedSatoshis]),
        ),
      };
    }),
    getPendingLiquidTxInfos: fn(() => (pendingLiquidCreateTxInfo.value ? [pendingLiquidCreateTxInfo.value] : [])),
    getPendingLiquidTxInfo: fn((liquidId: number) =>
      pendingLiquidCreateTxInfo.value?.tx.metadataJson.liquidId === liquidId
        ? pendingLiquidCreateTxInfo.value
        : undefined,
    ),
    submit: fn((input: BitcoinLiquidCreateInput) => {
      if (!options.pendingLiquidCreation) return Promise.reject(new Error('Unexpected Liquid creation'));

      const liquidId = 2_700;
      const fissions = input.allocations.map((allocation, index) => ({
        fissionId: liquidId + index,
        lockId: allocation.lock.lockId!,
        satoshis: allocation.satoshis,
        microgonsAtTargetPerBtc: 68_000_000_000n,
        liquidityPromised: (allocation.satoshis * 68_000_000_000n) / SATOSHIS_PER_BITCOIN,
      }));
      const pending = createPendingLiquidTransaction({
        liquidId,
        snapshotBlockHash: '0xsynthetic-pending-liquid',
        fissions,
        resecuritizations: fissions.slice(0, 1).map(fission => ({
          bitcoin: {
            lockId: fission.lockId,
            vaultId: 7,
            securitizedSatoshis: fission.satoshis,
            microgonsAtTargetPerBtc: fission.microgonsAtTargetPerBtc,
            securityFee: 108_800_000n,
          },
        })),
      });
      pendingLiquidCreateTxInfo.value = pending.txInfo;
      const submittedAt = new Date('2026-08-16T16:30:00Z');
      fissionState.fissionsById = {
        ...fissionState.fissionsById,
        ...Object.fromEntries(
          fissions.map(fission => [
            fission.fissionId,
            new BitcoinFission({
              ...fission,
              ownerAccount: '5SyntheticLiquidLockingWallet',
              liquidId,
              ratchetNumber: 0,
              origin: 'created',
              ratchets: [],
              createdAt: submittedAt,
              updatedAt: submittedAt,
            }),
          ]),
        ),
      };
      finalizePendingLiquidCreation = () => {
        const finalizedFissionsById = { ...fissionState.fissionsById };
        for (const fission of fissions) {
          const record = new BitcoinFission({
            ...fission,
            ownerAccount: '5SyntheticLiquidLockingWallet',
            liquidId,
            createdAtArgonBlock: 18_701,
            ratchetNumber: 0,
            lastUpdatedArgonBlock: 18_701,
          });
          record.pendingMints.push({
            queueIndex: BigInt(2_700 + liquidFissions.length),
            fissionId: record.fissionId,
            lockId: record.lockId,
            ownerAccount: record.ownerAccount,
            remainingAmount: fission.liquidityPromised,
            maxAmountPerFrame: fission.liquidityPromised / 10n,
          });
          liquidFissions.push(record);
          finalizedFissionsById[record.fissionId] = record;
          fissionState.activeFissionIds.add(record.fissionId);
        }
        fissionState.fissionsById = finalizedFissionsById;
        fissionState.financialRevision += 1;
        pendingLiquidCreateTxInfo.value = undefined;
        pending.finalize();
      };
      return Promise.resolve(pendingLiquidCreateTxInfo.value);
    }),
  });

  const bitcoinLiquidRatchet = Object.assign(Object.create(BitcoinLiquidRatchet.prototype), {
    getPendingRatchetTxInfo: fn(() => undefined),
    previewRatchet: fn(async (liquidId: number) => {
      const liquid = liquids.find(candidate => candidate.liquidId === liquidId)!;
      const sourceLiquidity = liquid.liquidityPromised;
      const newLiquidity = (liquid.satoshis * currentBitcoinRate) / 100_000_000n;
      const amountToMint = newLiquidity > sourceLiquidity ? newLiquidity - sourceLiquidity : 0n;
      const amountToBurn = sourceLiquidity > newLiquidity ? sourceLiquidity - newLiquidity : 0n;
      const canRatchet = Math.abs(((currentBitcoinPriceUsd - 68_000) / 68_000) * 100) >= 5;

      return {
        liquidId,
        fissionIds: liquid.fissions.map(fission => fission.fissionId),
        skippedFissionIds: [],
        sourceLiquidity,
        newLiquidity,
        amountToMint,
        amountToBurn,
        lockChanges: [],
        errors: canRatchet ? [] : ['A ratchet requires at least a 5% Bitcoin price change.'],
        canRatchet,
      };
    }),
    prepare: fn(async () => ({
      client: { consts: { balances: { existentialDeposit: { toBigInt: () => 10_000n } } } },
      txs: [],
      txSigner: { address: '5SyntheticLiquidLockingWallet' },
      metadata: { liquidId: 2_401, fissionIds: [2_401, 2_402], resecuritizedLockIds: [] },
      unavailableBalance: 0n,
      includeExistentialDeposit: false,
      txFeePlusTip: 200_000n,
      availableBalance: 10_000_000_000n,
    })),
  });
  mocked(getBitcoinTransactionOperations, { partial: true }).mockReturnValue({
    bitcoinLiquidCreate,
    bitcoinLiquidClose: Object.assign(Object.create(BitcoinLiquidClose.prototype), {
      getPendingLiquidTxInfo: fn(() => undefined),
      prepare: fn(async () => ({
        client: { consts: { balances: { existentialDeposit: { toBigInt: () => 10_000n } } } },
        txs: [],
        txSigner: { address: '5SyntheticLiquidLockingWallet' },
        metadata: { liquidId: 2_401, fissionIds: [2_401, 2_402], redemptionAmount: 2_651_040_000n },
        unavailableBalance: 2_651_040_000n,
        txFeePlusTip: 200_000n,
        availableBalance: 10_000_000_000n,
      })),
    }),
    bitcoinLiquidRatchet,
  });
  mocked(getMainchainClient).mockResolvedValue({
    query: {
      bitcoinLocks: {
        microgonPerBtcHistory: fn(async () => [[0, currentBitcoinRate]]),
      },
      crosschainTransfer: {
        transferTotalsByAccount: fn(async () => ({ microgonsIn: 0n })),
      },
    },
  } as never);
  Object.assign(getCurrency(), { fetchMainchainRates: fn(async () => ({})) });
  if (options.pendingLiquidCreation) Object.assign(useWallets(), { defaultArgonSpendableMicrogons: 1_000_000_000n });
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
    refresh: fn(() => (options.feeWaiverRefreshPending ? new Promise<void>(() => undefined) : Promise.resolve())),
  });
  const liquidTotalSatoshis = liquids
    .filter(liquid => !liquid.isClosed)
    .reduce((total, liquid) => total + liquid.satoshis, 0n);
  const bitcoinLiquidPendingMintMicrogons = liquidFissions.reduce((total, fission) => {
    return total + fission.pendingMints.reduce((mintTotal, mint) => mintTotal + mint.remainingAmount, 0n);
  }, 0n);
  const bitcoinWalletTotalSatoshis = summaries
    .filter(summary => summary.record.status === BitcoinLockStatus.LockFunded)
    .reduce((total, summary) => total + (summary.satoshis - (summary.record.fissionedSatoshis ?? 0n)), 0n);
  mocked(useFinancials).mockReturnValue(
    Vue.reactive({
      bitcoinWalletTotalSatoshis,
      savingsTotalValue:
        wallets.defaultArgonWallet.availableMicrogons +
        currency.convertMicronotTo(wallets.defaultArgonWallet.availableMicronots, UnitOfMeasurement.Microgon) +
        bitcoinLiquidPendingMintMicrogons +
        currency.convertSatToMicrogon(bitcoinWalletTotalSatoshis),
      liquidTotalSatoshis,
      fundedBitcoinLockSummaries: Vue.shallowRef(
        summaries.filter(summary => summary.record.status === BitcoinLockStatus.LockFunded),
      ),
      bitcoinLiquidPendingMintMicrogons,
      liquidPerformanceReturn: 15.82,
      liquidHodlingReturn: 11.29,
      financialPositionAggregate: Vue.shallowRef(
        reduceFinancialPositions([
          {
            group: 'liquid',
            state: 'ready',
            positions: [],
            observation: { observedAt: new Date('2026-08-16T16:00:00.000Z'), blockNumber: 18_700 },
          },
          {
            group: 'bitcoin',
            state: 'ready',
            positions: options.financialHistoryUnavailable
              ? []
              : [
                  createFinancialPosition(
                    'bitcoin-liquid',
                    {
                      id: 'bitcoin-liquid:2401',
                      label: 'Bitcoin Liquid 2401',
                      lifecycle: 'active',
                      liquidId: 2_401,
                      liquid: liquids.find(liquid => liquid.liquidId === 2_401)!,
                      locks: liquidFissions.slice(0, 2).map(fission => recordsByLockId.get(fission.lockId)!),
                      insuranceCost: 5_000_000n,
                      transactionFees: 96_000n,
                      totalFees: 5_096_000n,
                      receivedLiquidity: 47_600_000_000n,
                      pendingLiquidity: 0n,
                      repaymentAmount: 2_651_040_000n,
                      totalReturn: 13.4,
                      performanceEndingCapital: 54_400_000_000n,
                      startedAt: new Date('2026-08-13T14:00:00.000Z'),
                    },
                    {
                      currentValue: 0n,
                      investedCost: 48_000_000_000n,
                      paidIncome: 0n,
                      settledPrincipalValue: 0n,
                    },
                  ),
                  createFinancialPosition(
                    'bitcoin-liquid',
                    {
                      id: 'bitcoin-liquid:2468',
                      label: 'Bitcoin Liquid 2468',
                      lifecycle: 'active',
                      liquidId: 2_468,
                      liquid: liquids.find(liquid => liquid.liquidId === 2_468)!,
                      locks: [recordsByLockId.get(liquidFissions[2].lockId)!],
                      insuranceCost: 2_500_000n,
                      transactionFees: 48_000n,
                      totalFees: 2_548_000n,
                      receivedLiquidity: 28_179_200_000n,
                      pendingLiquidity: options.settledLiquid ? 0n : 9_900_800_000n,
                      repaymentAmount: 2_121_890_909n,
                      totalReturn: 8.25,
                      performanceEndingCapital: 41_222_000_000n,
                      startedAt: new Date('2026-08-15T14:00:00.000Z'),
                    },
                    {
                      currentValue: 0n,
                      investedCost: 38_080_000_000n,
                      paidIncome: 0n,
                      settledPrincipalValue: 0n,
                    },
                  ),
                  ...(options.closedLiquidArchive
                    ? [
                        createFinancialPosition(
                          'bitcoin-liquid',
                          {
                            id: 'bitcoin-liquid:2600',
                            label: 'Bitcoin Liquid 2600',
                            lifecycle: 'completed',
                            liquidId: 2_600,
                            liquid: liquids.find(liquid => liquid.liquidId === 2_600)!,
                            locks: [archived[0].record],
                            insuranceCost: 1_250_000n,
                            transactionFees: 4_001_688n,
                            totalFees: 5_251_688n,
                            receivedLiquidity: 17_000_000_000n,
                            pendingLiquidity: 0n,
                            repaymentAmount: 16_499_998_867n,
                            totalReturn: 9.72,
                            performanceEndingCapital: 18_652_400_000n,
                            startedAt: new Date('2026-06-27T14:00:00.000Z'),
                            endedAt: new Date('2026-08-08T16:00:00.000Z'),
                          },
                          {
                            currentValue: 0n,
                            investedCost: 17_000_000_000n,
                            paidIncome: 16_990_750_000n,
                            settledPrincipalValue: 0n,
                          },
                        ),
                      ]
                    : []),
                ],
            observation: { observedAt: new Date('2026-08-16T16:00:00.000Z'), blockNumber: 18_700 },
          },
        ]),
      ),
      bitcoinLockDisplayRecords: displayRecords,
      liquidInvisibleRecords: archived,
      activeBitcoinLockCount: 2,
      isHistoryRecoveryInProgress: false,
      historyRecovery: { state: 'ready', recoveredBlockCount: 0 },
      historyRecoveryByDomain: {
        bitcoin: { state: 'ready', recoveredBlockCount: 0 },
        bonds: { state: 'ready', recoveredBlockCount: 0 },
        vaulting: { state: 'ready', recoveredBlockCount: 0 },
      },
      bitcoinLockPerformanceByUuid: {
        [archived[0].uuid]: { profit: 81_000_000n, percent: 9.72 },
      },
    }) as unknown as ReturnType<typeof useFinancials>,
  );

  return {
    bitcoinLiquidCreate,
    finalizePendingLiquidCreation() {
      if (!finalizePendingLiquidCreation) throw new Error('No pending Liquid creation exists.');
      finalizePendingLiquidCreation();
    },
  };
}

export function setupBitcoinEmptyScenario(
  options: { loading?: boolean; loadError?: Error; walletBitcoin?: boolean } = {},
) {
  setupAppScenario({
    selectedTab: TopTab.BitcoinLocks,
    config: { hasExtensionTreasury: true },
  });
  getCurrency().isLoaded = true;

  const bitcoinLocksData = Vue.reactive({
    readiness: options.loadError ? ('error' as const) : options.loading ? ('loading' as const) : ('ready' as const),
    loadError: options.loadError,
    isReconciliationPending: false,
  });
  const walletLock = options.walletBitcoin ? createSummary(30, BitcoinLockStatus.LockFunded) : undefined;
  mocked(getBitcoinLocks).mockReturnValue({
    data: bitcoinLocksData,
    recovery: Vue.reactive({ hasPendingHistoryRecovery: false }),
    utxoTracking: {
      getAllOrphanLifecycleUtxos: fn(() => []),
      getUnresolvedOrphanRecords: fn(() => []),
      getUtxosForLock: fn(() => []),
      getObservedFundingUtxos: fn(() => []),
    },
    load: options.loading
      ? fn(() => new Promise<void>(() => undefined))
      : fn(async () => {
          bitcoinLocksData.readiness = 'loading';
          bitcoinLocksData.loadError = undefined;
          await Promise.resolve();
          bitcoinLocksData.readiness = 'ready';
        }),
    currentLoadPromise: Promise.resolve(),
    getAllLocks: fn(() => (walletLock ? [walletLock.record] : [])),
    getUtxosForLock: fn(() => []),
    isSecuritizationHoldExpired: fn(() => false),
  } as unknown as ReturnType<typeof getBitcoinLocks>);
  mocked(getBitcoinFissions, { partial: true }).mockReturnValue({
    data: Vue.reactive({
      fissionsById: {},
      activeFissionIds: new Set<number>(),
      minimumRatchetPercent: 5n,
      readiness: options.loading ? ('loading' as const) : ('ready' as const),
      financialRevision: 1,
    }),
    load: fn(async () => undefined),
    currentLoadPromise: Promise.resolve(),
    getAll: fn(() => []),
    getArchived: fn(() => []),
    getRecords: fn(() => []),
    getLiquids: fn(() => []),
    getPendingLiquids: fn(() => []),
    refreshCurrent: fn(async () => []),
  });
  Object.assign(useFinancials(), {
    bitcoinLockDisplayRecords: walletLock ? [walletLock] : [],
    liquidInvisibleRecords: [],
    bitcoinLiquids: [],
    bitcoinWalletTotalSatoshis: walletLock?.satoshis ?? 0n,
    activeBitcoinLockCount: 0,
  });
  mocked(getBitcoinTransactionOperations, { partial: true }).mockReturnValue({
    bitcoinLiquidCreate: {
      getPendingLiquidTxInfos: fn(() => []),
    } as unknown as BitcoinLiquidCreate,
    bitcoinLiquidRatchet: {
      getPendingRatchetTxInfo: fn(() => undefined),
    } as unknown as BitcoinLiquidRatchet,
  });
}

function createPendingLiquidTransaction(metadata: IBitcoinLiquidCreateMetadata): {
  txInfo: TransactionInfo<IBitcoinLiquidCreateMetadata>;
  finalize: () => void;
} {
  const submittedAt = new Date('2026-08-16T14:20:00.000Z');
  const postProcessing = createDeferred<void>(false);
  const txInfo = {
    txResult: {
      submissionError: undefined,
      extrinsicError: undefined,
    },
    tx: {
      id: 2_700,
      status: TransactionStatus.InBlock,
      extrinsicHash: '0xsynthetic-pending-liquid',
      extrinsicMethodJson: {},
      extrinsicType: ExtrinsicType.BitcoinLiquidCreate,
      metadataJson: metadata,
      accountAddress: '5SyntheticLiquidLockingWallet',
      submittedAtTime: submittedAt,
      submittedAtBlockHeight: 18_700,
      submissionErrorJson: undefined,
      txTip: 0n,
      txFeePlusTip: 200_000n,
      blockHeight: 18_701,
      blockHash: '0xsynthetic-pending-liquid-block',
      blockTime: new Date('2026-08-16T14:21:00.000Z'),
      blockExtrinsicIndex: 1,
      blockExtrinsicEventsJson: [],
      blockExtrinsicErrorJson: undefined,
      finalizedHeadHeight: 18_702,
      finalizedHeadTime: new Date('2026-08-16T14:22:00.000Z'),
      isFinalized: false,
      createdAt: submittedAt,
      updatedAt: submittedAt,
    },
    isPostProcessed: false,
    waitForPostProcessing: postProcessing.promise,
    subscribeToProgress: fn(
      (callback: Parameters<TransactionInfo<IBitcoinLiquidCreateMetadata>['subscribeToProgress']>[0]) => {
        void callback({
          progressPct: 42,
          progressMessage: 'Waiting for Finalization...',
          confirmations: 1,
          expectedConfirmations: 4,
          isMaxed: false,
        });
        return fn();
      },
    ),
    getStatus: fn(() => ({
      progressPct: 42,
      confirmations: 1,
      expectedConfirmations: 4,
      error: undefined,
      isFinalized: false,
      isMaxed: false,
    })),
  } as unknown as TransactionInfo<IBitcoinLiquidCreateMetadata>;
  return {
    txInfo,
    finalize() {
      txInfo.tx.isFinalized = true;
      postProcessing.resolve();
    },
  };
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
    lockId: 1_000 + id,
    status,
    securitizedSatoshis: satoshis,
    securityFees: 0n,
    couponFeesPaid: 0n,
    fundHoldExtensionsByBitcoinExpirationHeight: {},
    fundedSatoshis: satoshis,
    fundingUtxoIds: [],
    cosignVersion: 'v1',
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
    lockId: record.lockId,
    status,
    statusDetails: {
      hasObservedFundingSignal: false,
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
    lockId: 1_009,
    txid: `synthetic-orphan-${id}`,
    vout: 0,
    satoshis: BigInt(id) * 1_250_000n,
    network: 'regtest',
    status,
    spendStatus: BitcoinUtxoSpendStatus.Unspent,
    firstSeenAt: observedAt,
    firstSeenBitcoinHeight: 250_000 + id,
    createdAt: observedAt,
    updatedAt: observedAt,
    ...overrides,
  };
}

function createFundingUtxo(
  lock: IBitcoinLockRecord,
  status: BitcoinUtxoStatus,
  overrides: Partial<IBitcoinUtxoRecord> = {},
): IBitcoinUtxoRecord {
  const observedAt = new Date(Date.UTC(2026, 7, 15, 12, lock.lockId));
  return {
    id: 2_000 + (lock.lockId ?? 0),
    lockId: lock.lockId ?? 0,
    txid: `synthetic-funding-${lock.lockId}`,
    vout: 0,
    satoshis: lock.fundedSatoshis || lock.securitizedSatoshis,
    network: lock.network,
    status,
    spendStatus: BitcoinUtxoSpendStatus.Unspent,
    firstSeenAt: observedAt,
    firstSeenOnArgonAt: observedAt,
    firstSeenBitcoinHeight: 250_000 + (lock.lockId ?? 0),
    firstSeenOracleHeight: 250_000 + (lock.lockId ?? 0),
    createdAt: observedAt,
    updatedAt: observedAt,
    ...overrides,
  };
}

function createLockRelease(
  lock: IBitcoinLockRecord,
  fundingUtxo: IBitcoinUtxoRecord,
  status: BitcoinReleaseStatus,
  overrides: Partial<IBitcoinReleaseRecord> = {},
): IBitcoinReleaseRecord {
  const release = createBitcoinRelease({
    id: `synthetic-lock-release-${lock.lockId}`,
    lockId: lock.lockId!,
    status,
    inputUtxoIds: [fundingUtxo.id],
    ...overrides,
  });
  if (
    ![
      BitcoinReleaseStatus.Complete,
      BitcoinReleaseStatus.Cancelled,
      BitcoinReleaseStatus.Failed,
      BitcoinReleaseStatus.FailedAcknowledged,
    ].includes(status)
  ) {
    lock.activeReleaseId = release.id;
    fundingUtxo.activeReleaseId = release.id;
  }
  return release;
}

function createOrphanRelease(
  utxo: IBitcoinUtxoRecord,
  status: BitcoinReleaseStatus,
  overrides: Partial<IBitcoinReleaseRecord> = {},
): IBitcoinReleaseRecord {
  const release = createBitcoinRelease({
    id: `synthetic-orphan-release-${utxo.id}`,
    kind: BitcoinReleaseKind.Orphan,
    lockId: utxo.lockId,
    status,
    inputUtxoIds: [utxo.id],
    ...overrides,
  });
  if (
    ![
      BitcoinReleaseStatus.Complete,
      BitcoinReleaseStatus.Cancelled,
      BitcoinReleaseStatus.Failed,
      BitcoinReleaseStatus.FailedAcknowledged,
    ].includes(status)
  ) {
    utxo.activeReleaseId = release.id;
  }
  return release;
}
