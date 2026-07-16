import { BitcoinLockStatus } from '../db/BitcoinLocksTable.ts';
import {
  createFinancialPosition,
  type IBitcoinAssetFinancialPosition,
  type IBitcoinLiabilityFinancialPosition,
  type IFinancialPositionSource,
} from '../../interfaces/IFinancialPosition.ts';
import type { IBitcoinLockSummary } from '../../interfaces/IBitcoinLockSummary.ts';
import type BitcoinLocks from '../BitcoinLocks.ts';
import { bigIntMax, SATOSHIS_PER_BITCOIN } from '@argonprotocol/apps-core';

const activeBitcoinLockStatuses = [BitcoinLockStatus.LockedAndIsMinting, BitcoinLockStatus.LockedAndMinted];

type BitcoinFinancialPosition = IBitcoinAssetFinancialPosition | IBitcoinLiabilityFinancialPosition;

type BitcoinFinancialPositionArgs = {
  hasCurrentPrice: boolean;
  hasConfirmedHistoryCoverage?: boolean;
};

export class BitcoinFinancials
  implements IFinancialPositionSource<BitcoinFinancialPositionArgs, BitcoinFinancialPosition>
{
  constructor(private readonly locks: BitcoinLocks) {}

  public async loadPositions(args: BitcoinFinancialPositionArgs): Promise<BitcoinFinancialPosition[]> {
    await this.locks.load();

    return this.createFinancialPositions({
      ...args,
      summaries: this.locks.getAllLocks().map(lock => this.locks.createLockSummary(lock)),
    });
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

  if (record.removalReason || summary.status === BitcoinLockStatus.Released) {
    const isReleased = record.removalReason === 'released';
    const removalBtcValue = valueSatoshisAtRate(summary.satoshis, record.btcPriceAtRemovalMicrogons);
    const bitcoinNetworkFee = record.fundingUtxoRecord?.releaseBitcoinNetworkFee;
    const bitcoinNetworkFeeValue = valueSatoshisAtRate(bitcoinNetworkFee, record.btcPriceAtRemovalMicrogons);
    const releaseRedemption = record.releaseRedemptionMicrogons;
    const releaseArgonTxFee = record.releaseArgonTxFeeMicrogons;
    const releaseCompensation = hasConfirmedHistoryCoverage
      ? (record.releaseCompensationMicrogons ?? 0n)
      : record.releaseCompensationMicrogons;
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
      record.removalBlockTime !== undefined &&
      removalBtcValue !== undefined &&
      releaseRedemption !== undefined &&
      releaseArgonTxFee !== undefined &&
      releaseCompensation !== undefined &&
      bitcoinNetworkFeeValue !== undefined
    ) {
      hasCompleteReleaseHistory = true;
      settledPrincipalValue = removalBtcValue - releaseRedemption - bitcoinNetworkFeeValue;
      performanceEndingCapital =
        summary.startingCapital +
        bigIntMax(removalBtcValue - record.lockedTargetPrice, 0n) +
        summary.receivedLiquidity +
        summary.pendingLiquidity -
        releaseRedemption -
        summary.totalFees -
        releaseArgonTxFee +
        releaseCompensation -
        bitcoinNetworkFeeValue;
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
          id: `bitcoin-asset:${summary.uuid}`,
          label,
          lifecycle,
          performanceEndingCapital,
          startedAt: summary.createdAt,
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
        id: `bitcoin-asset:${summary.uuid}`,
        label: 'Locked Bitcoin',
        lifecycle: isReleasing ? 'releasing' : 'active',
        performanceEndingCapital: summary.endingCapital,
        startedAt: summary.createdAt,
        lock: summary.record,
      },
      {
        currentValue,
        investedCost: summary.startingCapital,
        paidIncome,
        settledPrincipalValue: 0n,
      },
    ),
    createFinancialPosition('bitcoin-liability', {
      id: `bitcoin-liability:${summary.uuid}`,
      label: 'Bitcoin redemption',
      lifecycle: isReleasing ? 'releasing' : 'active',
      currentValue: hasCurrentPrice ? -summary.unlockAmount : undefined,
      lock: summary.record,
    }),
  ];
}

function valueSatoshisAtRate(satoshis?: bigint, microgonsPerBitcoin?: bigint): bigint | undefined {
  if (satoshis === undefined || microgonsPerBitcoin === undefined || microgonsPerBitcoin <= 0n) return;

  return (satoshis * microgonsPerBitcoin) / SATOSHIS_PER_BITCOIN;
}
