import { BitcoinLockStatus } from '../db/BitcoinLocksTable.ts';
import {
  createFinancialPosition,
  type IBitcoinAssetFinancialPosition,
  type IBitcoinLiabilityFinancialPosition,
  withInvestmentBasis,
} from '../../interfaces/IFinancialPosition.ts';
import type { IBitcoinLockSummary } from '../../interfaces/IBitcoinLockSummary.ts';
import type { IBitcoinLockRecord } from '../../interfaces/IBitcoinLockRecord.ts';
import type BitcoinLocks from '../BitcoinLocks.ts';
import {
  type ArgonQueryClient,
  bigIntMax,
  getPercent,
  SATOSHIS_PER_BITCOIN,
  type Currency,
  type IPerformanceReturnInput,
  BitcoinLock,
} from '@argonprotocol/apps-core';

const activeBitcoinLockStatuses = [BitcoinLockStatus.LockedAndIsMinting, BitcoinLockStatus.LockedAndMinted];

type BitcoinFinancialPosition = IBitcoinAssetFinancialPosition | IBitcoinLiabilityFinancialPosition;

type BitcoinFinancialPositionArgs = {
  hasCurrentPrice: boolean;
  hasConfirmedHistoryCoverage?: boolean;
};

export class BitcoinFinancials {
  constructor(private readonly locks: BitcoinLocks) {}

  public async loadSnapshot(args: BitcoinFinancialPositionArgs & { clientAt: ArgonQueryClient }): Promise<{
    positions: BitcoinFinancialPosition[];
    summaries: IBitcoinLockSummary[];
    hodlingInvestments: IPerformanceReturnInput[];
    currentBitcoinDebt: bigint;
  }> {
    await this.locks.load();

    const summaries = await Promise.all(
      this.locks
        .getAllLocks({ includeHistoryRecoveryPending: true })
        .map(lock => this.locks.createLockSummaryAt(lock, args.clientAt)),
    );
    const hodlingInvestments: IPerformanceReturnInput[] = [];
    let currentBitcoinDebt = 0n;

    for (const summary of summaries) {
      const lock = summary.record;

      if (this.locks.isLockedStatus(lock)) currentBitcoinDebt += summary.unlockAmount;
      if (
        !lock.isHistoryRecoveryPending &&
        (this.locks.isLockedStatus(lock) || this.locks.isReleaseStatus(lock)) &&
        lock.ratchets[0]
      ) {
        hodlingInvestments.push({
          startingDate: lock.createdAt,
          // Hodling compares BTC market movement; this is not the Bitcoin locking profit basis.
          startingCapital: lock.ratchets[0].lockedTargetPrice,
          endingDate: new Date(),
          endingCapital: summary.valueOfBtc,
        });
      }
    }

    return {
      positions: this.createFinancialPositions({ ...args, summaries }),
      summaries,
      hodlingInvestments,
      currentBitcoinDebt,
    };
  }

  public createFinancialPositions(
    args: BitcoinFinancialPositionArgs & { summaries: readonly IBitcoinLockSummary[] },
  ): BitcoinFinancialPosition[] {
    return args.summaries.flatMap(summary =>
      createBitcoinLockPositions(summary, args.hasCurrentPrice, args.hasConfirmedHistoryCoverage === true),
    );
  }
}

function createBitcoinLockPositions(
  summary: IBitcoinLockSummary,
  hasCurrentPrice: boolean,
  hasConfirmedHistoryCoverage: boolean,
): BitcoinFinancialPosition[] {
  const { record } = summary;
  const paidIncome = summary.receivedLiquidity - summary.totalFees;
  const hasConfirmedLockHistory = !record.isHistoryRecoveryPending;

  if (record.removalReason || summary.status === BitcoinLockStatus.Released) {
    if (record.removalReason === 'spent' && summary.pendingLiquidity === 0n) return [];

    const isReleased = record.removalReason === 'released';
    const removalBtcPrice = record.btcPriceAtRemovalMicrogons ?? undefined;
    const removalBtcValue = valueSatoshisAtRate(record.satoshis, removalBtcPrice);
    const bitcoinNetworkFee = record.fundingUtxoRecord?.releaseBitcoinNetworkFee ?? undefined;
    const bitcoinNetworkFeeValue = valueSatoshisAtRate(bitcoinNetworkFee, removalBtcPrice);
    const releaseRedemption = record.releaseRedemptionMicrogons ?? undefined;
    const releaseArgonTxFee = record.releaseArgonTxFeeMicrogons ?? undefined;
    const historicalTotalFees = summary.historicalTotalFees;
    const releaseCompensation =
      hasConfirmedHistoryCoverage && hasConfirmedLockHistory
        ? (record.releaseCompensationMicrogons ?? 0n)
        : (record.releaseCompensationMicrogons ?? undefined);
    const releasePaidIncome =
      releaseArgonTxFee !== undefined && releaseCompensation !== undefined
        ? paidIncome - releaseArgonTxFee + releaseCompensation
        : paidIncome;
    let hasCompleteReleaseHistory = false;
    let settledPrincipalValue: bigint | undefined;
    let performanceEndingCapital: bigint | undefined;

    if (
      isReleased &&
      hasConfirmedHistoryCoverage &&
      hasConfirmedLockHistory &&
      record.removalBlockTime !== undefined &&
      removalBtcValue !== undefined &&
      releaseRedemption !== undefined &&
      releaseArgonTxFee !== undefined &&
      releaseCompensation !== undefined &&
      bitcoinNetworkFeeValue !== undefined &&
      historicalTotalFees !== undefined
    ) {
      hasCompleteReleaseHistory = true;
      settledPrincipalValue = removalBtcValue - releaseRedemption - bitcoinNetworkFeeValue;
      performanceEndingCapital = calculateBitcoinEndingCapital({
        bitcoinValue: summary.startingCapital,
        receivedLiquidity: summary.receivedLiquidity,
        pendingLiquidity: summary.pendingLiquidity,
        redemptionAmount: releaseRedemption,
        fees: historicalTotalFees,
        compensation: releaseCompensation,
      });
    }

    let label = 'Removed Bitcoin lock';
    let lifecycle: IBitcoinAssetFinancialPosition['lifecycle'] = 'completed';
    let currentValue: bigint | undefined = summary.pendingLiquidity;

    if (isReleased) {
      label = 'Released Bitcoin lock';
    } else if (record.removalReason === 'expired') {
      label = 'Expired Bitcoin lock';
      lifecycle = 'held';
      currentValue = hasCurrentPrice ? summary.valueOfBtc + summary.pendingLiquidity : undefined;
    } else if (record.removalReason === 'spent') {
      label = 'Spent Bitcoin lock';
    }

    return [
      createFinancialPosition(
        'bitcoin-asset',
        {
          id: `bitcoin-asset:${record.uuid}`,
          label,
          lifecycle,
          performanceEndingCapital,
          startedAt: record.createdAt,
          endedAt: record.removalBlockTime,
          lock: record,
        },
        {
          currentValue,
          investedCost: hasCompleteReleaseHistory ? summary.startingCapital : undefined,
          paidIncome: releasePaidIncome,
          settledPrincipalValue,
        },
      ),
    ];
  }

  const isReleasing = summary.status === BitcoinLockStatus.Releasing;
  if (!isReleasing && !activeBitcoinLockStatuses.includes(summary.status)) return [];

  const currentValue = hasCurrentPrice ? summary.valueOfBtc + summary.pendingLiquidity : undefined;

  return [
    createFinancialPosition(
      'bitcoin-asset',
      {
        id: `bitcoin-asset:${record.uuid}`,
        label: 'Locked Bitcoin',
        lifecycle: isReleasing ? 'releasing' : 'active',
        ...(hasConfirmedLockHistory ? { performanceEndingCapital: summary.endingCapital } : {}),
        startedAt: record.createdAt,
        lock: summary.record,
      },
      withInvestmentBasis(
        {
          currentValue,
          investedCost: summary.startingCapital,
          paidIncome,
          settledPrincipalValue: 0n,
        },
        hasConfirmedLockHistory,
      ),
    ),
    createFinancialPosition('bitcoin-liability', {
      id: `bitcoin-liability:${record.uuid}`,
      label: 'Bitcoin redemption',
      lifecycle: isReleasing ? 'releasing' : 'active',
      currentValue: hasCurrentPrice ? -summary.unlockAmount : undefined,
      lock: summary.record,
    }),
  ];
}

export function calculateBitcoinLockValuation({ lock, currency }: { lock: IBitcoinLockRecord; currency: Currency }) {
  const btc = currency.convertSatToBtc(lock.satoshis);
  const valueOfBtc = currency.convertBtcToMicrogon(btc);
  const unlockAmount =
    BitcoinLock.calculateRedemptionAmountFromSatoshis(currency.priceIndex, lock.satoshis, lock.lockedTargetPrice) || 0n;
  const grossSecurityFees = lock.ratchets.reduce((total, ratchet) => total + ratchet.securityFee, 0n);
  // couponFeesPaid is the lock's canonical cumulative reimbursement for security fees.
  const securityFees = bigIntMax(grossSecurityFees - (lock.lockDetails?.couponFeesPaid ?? 0n), 0n);
  const transactionFees = lock.ratchets.reduce((total, ratchet) => total + ratchet.txFee, 0n);
  const totalFees = securityFees + transactionFees;
  const releaseBitcoinNetworkFeeValue = valueSatoshisAtRate(
    lock.fundingUtxoRecord?.releaseBitcoinNetworkFee,
    lock.btcPriceAtRemovalMicrogons,
  );
  const hasHistoricalTransactionFees =
    lock.releaseArgonTxFeeMicrogons !== undefined || releaseBitcoinNetworkFeeValue !== undefined;
  const historicalTransactionFees = hasHistoricalTransactionFees
    ? transactionFees + (lock.releaseArgonTxFeeMicrogons ?? 0n) + (releaseBitcoinNetworkFeeValue ?? 0n)
    : undefined;
  const historicalTotalFees =
    historicalTransactionFees === undefined ? undefined : securityFees + historicalTransactionFees;
  const totalLiquidity = lock.ratchets.reduce((total, ratchet) => total + ratchet.mintAmount, 0n);
  const pendingLiquidity = lock.ratchets.reduce((total, ratchet) => total + ratchet.mintPending, 0n);
  const burnedLiquidity = lock.ratchets.reduce((total, ratchet) => total + (ratchet.burned ?? 0n), 0n);
  const receivedLiquidity = totalLiquidity - pendingLiquidity - burnedLiquidity;
  const initialLiquidity = lock.ratchets[0]?.mintAmount ?? lock.liquidityPromised;
  const startingCapital = lock.ratchets[0] ? receivedLiquidity + pendingLiquidity : initialLiquidity;
  const valueBeyondLiquidity = bigIntMax(valueOfBtc - lock.lockedTargetPrice, 0n);
  const currentEndingCapital = calculateBitcoinEndingCapital({
    bitcoinValue: startingCapital + valueBeyondLiquidity,
    receivedLiquidity,
    pendingLiquidity,
    redemptionAmount: unlockAmount,
    fees: totalFees,
  });
  const endingCapital = lock.ratchets[0] ? currentEndingCapital : initialLiquidity;

  return {
    valueOfBtc,
    totalLiquidity,
    pendingLiquidity,
    receivedLiquidity,
    valueBeyondLiquidity,
    startingCapital,
    endingCapital,
    securityFees,
    transactionFees,
    totalFees,
    historicalTransactionFees,
    historicalTotalFees,
    unlockAmount,
    totalReturn: calculateBitcoinReturn(startingCapital, endingCapital),
  };
}

export function calculateBitcoinEndingCapital({
  bitcoinValue,
  receivedLiquidity,
  pendingLiquidity,
  redemptionAmount,
  fees,
  compensation = 0n,
}: {
  bitcoinValue: bigint;
  receivedLiquidity: bigint;
  pendingLiquidity: bigint;
  redemptionAmount: bigint;
  fees: bigint;
  compensation?: bigint;
}): bigint {
  const totalProceeds = bitcoinValue + receivedLiquidity + pendingLiquidity + compensation;
  const totalCosts = redemptionAmount + fees;
  return totalProceeds - totalCosts;
}

export function calculateBitcoinReturn(investment: bigint, currentValue: bigint): number {
  if (investment <= 0n) return 0;

  return getPercent(currentValue - investment, investment);
}

export function valueSatoshisAtRate(satoshis?: bigint, microgonsPerBitcoin?: bigint): bigint | undefined {
  if (satoshis === undefined || microgonsPerBitcoin === undefined || microgonsPerBitcoin <= 0n) return;

  return (satoshis * microgonsPerBitcoin) / SATOSHIS_PER_BITCOIN;
}
