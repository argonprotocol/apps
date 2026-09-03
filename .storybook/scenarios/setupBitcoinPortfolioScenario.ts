import * as Vue from 'vue';
import { BitcoinFission } from '@argonprotocol/apps-core';
import type { IBitcoinLockCouponStatus } from '@argonprotocol/apps-router';
import BigNumber from 'bignumber.js';
import { fn, mocked } from 'storybook/test';
import { setupAppScenario } from './setupAppScenario.ts';
import { BitcoinLockStatus, type IBitcoinLockRecord } from '../../src-vue/interfaces/IBitcoinLockRecord.ts';
import type { IBitcoinLockSummary } from '../../src-vue/interfaces/IBitcoinLockSummary.ts';
import { createFinancialPosition } from '../../src-vue/interfaces/IFinancialPosition.ts';
import {
  BitcoinUtxoRole,
  BitcoinUtxoStatus,
  type IBitcoinUtxoRecord,
} from '../../src-vue/interfaces/IBitcoinUtxoRecord.ts';
import { TopTab } from '../../src-vue/interfaces/IConfig.ts';
import { ExtrinsicType, TransactionStatus } from '../../src-vue/interfaces/ITransactionRecord.ts';
import BitcoinLocks from '../../src-vue/lib/BitcoinLocks.ts';
import { createBitcoinLiquids } from '../../src-vue/lib/BitcoinFissions.ts';
import { isBitcoinUtxoReleaseStatus } from '../../src-vue/lib/db/BitcoinUtxosTable.ts';
import { reduceFinancialPositions } from '../../src-vue/lib/financials/index.ts';
import type { TransactionInfo } from '../../src-vue/lib/TransactionInfo.ts';
import {
  BitcoinLiquidCreate,
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
import { getWalletKeys, useWallets } from '../../src-vue/stores/wallets.ts';

export function setupBitcoinPortfolioScenario(
  options: {
    feeWaiver?: boolean;
    feeWaiverRefreshPending?: boolean;
    createLiquidError?: string;
    createLiquidPreviewPending?: boolean;
    closedLiquidArchive?: boolean;
    financialHistoryUnavailable?: boolean;
    noAvailableBitcoin?: boolean;
    pendingLiquidCreation?: boolean;
    settledLiquid?: boolean;
    currentBitcoinPriceUsd?: number;
  } = {},
) {
  setupAppScenario({
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
  const liquidFissions = [
    new BitcoinFission({
      ownerAccount: '5SyntheticLiquidLockingWallet',
      fissionId: 2_401,
      liquidId: 2_401,
      utxoId: summaries[4].record.utxoId!,
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
      utxoId: summaries[5].record.utxoId!,
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
      utxoId: summaries[6].record.utxoId!,
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
          utxoId: archived[0].record.utxoId!,
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
          redemptionAmount: 16_500_000_000n,
          closeTxFee: 4_000_000n,
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
  const liquids = createBitcoinLiquids({ fissions: [...liquidFissions, ...closedLiquidFissions] });
  summaries[6].record.securitizedSatoshis = 100_000_000n;
  if (!options.settledLiquid) {
    liquidFissions[2].pendingMints.push({
      queueIndex: 51,
      fissionId: 2_468,
      utxoId: summaries[6].record.utxoId!,
      ownerAccount: '5SyntheticLiquidLockingWallet',
      remainingAmount: 9_900_800_000n,
      maxAmountPerFrame: 2_000_000_000n,
    });
  }
  if (options.noAvailableBitcoin) {
    for (const record of records) {
      const allocatedSatoshis = liquidFissions
        .filter(fission => fission.utxoId === record.utxoId)
        .reduce((total, fission) => total + fission.satoshis, 0n);
      if (!allocatedSatoshis) continue;

      record.fundedSatoshis = allocatedSatoshis;
      record.securitizedSatoshis = allocatedSatoshis;
    }
  }

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
      isReleaseStatus: fn(isBitcoinUtxoReleaseStatus),
    },
    load: fn(async () => undefined),
    getAllLocks: fn(() => records),
    getLockByUtxoId: fn((utxoId: number) => recordsByUtxoId.get(utxoId)),
    createLockSummary: fn((record: IBitcoinLockRecord) => summariesByUuid.get(record.uuid)!),
    verifyExpirationTime: fn(() => Date.UTC(2026, 7, 16, 16, 0, 0)),
    unlockDeadlineTime: fn(() => Date.UTC(2026, 11, 15, 16, 0, 0)),
    isLockFunded: fn((record: IBitcoinLockRecord) => record.status === BitcoinLockStatus.LockFunded),
    isFinishedStatus: fn((record: IBitcoinLockRecord) => record.status === BitcoinLockStatus.Released),
  });

  mocked(getBitcoinLocks).mockReturnValue(bitcoinLocks as unknown as ReturnType<typeof getBitcoinLocks>);
  mocked(getBitcoinFissions, { partial: true }).mockReturnValue({
    data: Vue.reactive({
      fissionsById: {},
      historyById: {},
      minimumRatchetPercent: 5n,
      isLoaded: true,
      financialRevision: 1,
    }),
    load: fn(async () => undefined),
    refreshCurrent: fn(async () => liquidFissions),
    getAll: fn(() => liquidFissions),
    getHistory: fn(() => []),
    getLiquids: fn(() => liquids),
    getLiquidIdsForLock: fn((utxoId: number) =>
      liquidFissions.filter(fission => fission.utxoId === utxoId).map(fission => fission.liquidId),
    ),
  });
  const pendingLiquidCreateTxInfo = Vue.shallowRef<TransactionInfo<IBitcoinLiquidCreateMetadata>>();
  const bitcoinLiquidCreate = Object.assign(Object.create(BitcoinLiquidCreate.prototype), {
    preview: fn(async () => {
      if (options.createLiquidPreviewPending) return await new Promise<void>(() => undefined);
      if (options.createLiquidError) throw new Error(options.createLiquidError);

      return {
        microgonsAtTargetPerBtc: 6_800_000_000n,
        liquidityMicrogons: 68_000_000_000n,
        totalSecurityFeeMicrogons: 136_000_000n,
        securityFeeMicrogons: 108_800_000n,
        couponCreditMicrogons: options.feeWaiver ? 27_200_000n : 0n,
        maximumSatoshisByUtxoId: Object.fromEntries(
          records
            .filter(record => record.status === BitcoinLockStatus.LockFunded && record.utxoId != null)
            .map(record => [record.utxoId!, record.fundedSatoshis]),
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
        utxoId: allocation.lock.utxoId!,
        satoshis: allocation.satoshis,
        microgonsAtTargetPerBtc: 68_000_000_000n,
      }));
      pendingLiquidCreateTxInfo.value = createPendingLiquidTransaction({
        liquidId,
        snapshotBlockHash: '0xsynthetic-pending-liquid',
        fissions,
        resecuritizations: fissions.slice(0, 1).map(fission => ({
          bitcoin: {
            utxoId: fission.utxoId,
            vaultId: 7,
            securitizedSatoshis: fission.satoshis,
            microgonsAtTargetPerBtc: fission.microgonsAtTargetPerBtc,
            securityFee: 108_800_000n,
          },
        })),
      });
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
      metadata: { liquidId: 2_401, fissionIds: [2_401, 2_402], resecuritizedUtxoIds: [] },
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
  mocked(useFinancials).mockReturnValue(
    Vue.reactive({
      bitcoinWalletTotalSatoshis: summaries
        .filter(summary => summary.record.status === BitcoinLockStatus.LockFunded)
        .reduce((total, summary) => total + summary.satoshis, 0n),
      liquidTotalSatoshis: liquids
        .filter(liquid => !liquid.isClosed)
        .reduce((total, liquid) => total + liquid.satoshis, 0n),
      liquidLockedRecords: Vue.shallowRef(
        summaries.filter(summary => summary.record.status === BitcoinLockStatus.LockFunded),
      ),
      liquidPerformanceReturn: 15.82,
      liquidHodlingReturn: 11.29,
      financialPositionAggregate: Vue.shallowRef(
        reduceFinancialPositions([
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
                      locks: liquidFissions.slice(0, 2).map(fission => recordsByUtxoId.get(fission.utxoId)!),
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
                      locks: [recordsByUtxoId.get(liquidFissions[2].utxoId)!],
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
                            transactionFees: 8_000_000n,
                            totalFees: 9_250_000n,
                            receivedLiquidity: 17_000_000_000n,
                            pendingLiquidity: 0n,
                            repaymentAmount: 16_500_000_000n,
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

  return { bitcoinLiquidCreate };
}

export function setupBitcoinEmptyScenario(options: { loading?: boolean } = {}) {
  setupAppScenario({
    selectedTab: TopTab.BitcoinLocks,
    config: { hasExtensionTreasury: true },
  });

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
      activeBitcoinLockCount: 0,
      isHistoryRecoveryInProgress: false,
      historyRecovery: { state: 'ready', recoveredBlockCount: 0 },
      historyRecoveryByDomain: {
        bitcoin: { state: 'ready', recoveredBlockCount: 0 },
        bonds: { state: 'ready', recoveredBlockCount: 0 },
        vaulting: { state: 'ready', recoveredBlockCount: 0 },
      },
    }) as unknown as ReturnType<typeof useFinancials>,
  );
  mocked(getBitcoinTransactionOperations, { partial: true }).mockReturnValue({
    bitcoinLiquidCreate: {
      getPendingLiquidTxInfos: fn(() => []),
    } as unknown as BitcoinLiquidCreate,
    bitcoinLiquidRatchet: {
      getPendingRatchetTxInfo: fn(() => undefined),
    } as unknown as BitcoinLiquidRatchet,
  });
}

function createPendingLiquidTransaction(
  metadata: IBitcoinLiquidCreateMetadata,
): TransactionInfo<IBitcoinLiquidCreateMetadata> {
  const submittedAt = new Date('2026-08-16T14:20:00.000Z');
  return {
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
    waitForPostProcessing: new Promise<void>(() => undefined),
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
    securitizedSatoshis: satoshis,
    securityFees: 0n,
    couponFeesPaid: 0n,
    fundHoldExtensionsByBitcoinExpirationHeight: {},
    utxos: [],
    fundedSatoshis: satoshis,
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
    utxoId: record.utxoId,
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
    satoshis: lock.fundedSatoshis || lock.securitizedSatoshis,
    network: lock.network,
    role: BitcoinUtxoRole.Funding,
    status,
    firstSeenAt: observedAt,
    firstSeenOnArgonAt: observedAt,
    firstSeenBitcoinHeight: 250_000 + (lock.utxoId ?? 0),
    firstSeenOracleHeight: 250_000 + (lock.utxoId ?? 0),
    createdAt: observedAt,
    updatedAt: observedAt,
    ...overrides,
  };
  lock.utxos = [record];
  lock.fundingUtxo = record;
  lock.fundedSatoshis = record.satoshis;
  return record;
}
