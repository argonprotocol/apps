import { BitcoinLockStatus } from '../db/BitcoinLocksTable.ts';
import {
  createFinancialPosition,
  type IBitcoinFinancialAsset,
  type IBitcoinLiabilityFinancialPosition,
  type IBitcoinLiquidFinancialPosition,
  withInvestmentBasis,
} from '../../interfaces/IFinancialPosition.ts';
import type { IBitcoinLockSummary } from '../../interfaces/IBitcoinLockSummary.ts';
import type { IBitcoinLockRecord } from '../../interfaces/IBitcoinLockRecord.ts';
import { createBitcoinLiquids, type BitcoinFissions } from '../BitcoinFissions.ts';
import type BitcoinLocks from '../BitcoinLocks.ts';
import type { Db } from '../Db.ts';
import type { IBitcoinSecuritizationTerm } from '../../interfaces/IBitcoinSecuritizationTerm.ts';
import { allocateBitcoinInsuranceCosts } from './BitcoinInsurance.ts';
import { BitcoinLiquid } from '../BitcoinLiquid.ts';
import {
  type ArgonApi,
  bigIntMax,
  BitcoinFission,
  getPercent,
  SATOSHIS_PER_BITCOIN,
  type Currency,
  type IBitcoinFission,
  type IPerformanceReturnInput,
} from '@argonprotocol/apps-core';
import type { PriceIndex } from '@argonprotocol/mainchain';

const activeBitcoinLockStatuses = [BitcoinLockStatus.LockFunded];

type BitcoinFinancialRecord =
  | IBitcoinFinancialAsset
  | IBitcoinLiabilityFinancialPosition
  | IBitcoinLiquidFinancialPosition;

type BitcoinFinancialRecordArgs = {
  hasCurrentPrice: boolean;
  priceIndex?: PriceIndex;
};

export class BitcoinFinancials {
  constructor(
    private readonly locks: BitcoinLocks,
    private readonly fissions: BitcoinFissions,
    private readonly dbPromise: Promise<Db>,
  ) {}

  public async loadSnapshot(args: BitcoinFinancialRecordArgs & { clientAt: ArgonApi }): Promise<{
    positions: BitcoinFinancialRecord[];
    summaries: IBitcoinLockSummary[];
    hodlingInvestments: IPerformanceReturnInput[];
    currentBitcoinDebt: bigint;
  }> {
    const securitizationHistory = await this.dbPromise.then(db =>
      db.bitcoinSecuritizationHistoryTable.getPublishedSnapshot(this.fissions.ownerAccount),
    );
    const fissions = this.fissions.getRecords();
    const activeFissionIds = new Set<number>();
    const activeLiquidLockIds = new Set<number>();
    const fissionsByLockId = new Map<IBitcoinLockRecord['lockId'], BitcoinFission[]>();
    for (const fission of fissions) {
      if (fission.closedAtArgonBlock === undefined) {
        activeFissionIds.add(fission.fissionId);
        activeLiquidLockIds.add(fission.lockId);
      }
      const lockFissions = fissionsByLockId.get(fission.lockId) ?? [];
      lockFissions.push(fission);
      fissionsByLockId.set(fission.lockId, lockFissions);
    }

    const summaries = this.locks.getAllLocks({ includeHistoryRecoveryPending: true }).map(lock => {
      const lockFissions = fissionsByLockId.get(lock.lockId) ?? [];
      const activeFissions = lockFissions.filter(fission => activeFissionIds.has(fission.fissionId));
      let currentRedemptionAmount: bigint | undefined;
      if (activeFissions.length && args.hasCurrentPrice && args.priceIndex) {
        const priceIndex = args.priceIndex;
        currentRedemptionAmount = activeFissions.reduce(
          (total, fission) => total + fission.calculateRedemptionAmount(priceIndex),
          0n,
        );
      }

      return applyBitcoinFissionValuation({
        summary: this.locks.createLockSummary(lock),
        fissions: lockFissions,
        activeFissionIds,
        currentRedemptionAmount,
      });
    });
    const hodlingInvestments: IPerformanceReturnInput[] = [];
    let currentBitcoinDebt = 0n;

    for (const summary of summaries) {
      const lock = summary.record;

      if (this.locks.isLockFunded(lock) && lock.lockId !== undefined && activeLiquidLockIds.has(lock.lockId)) {
        currentBitcoinDebt += summary.unlockAmount;
      }
      if (
        !lock.isHistoryRecoveryPending &&
        (this.locks.isLockFunded(lock) || this.locks.isReleaseStatus(lock)) &&
        lock.lockId !== undefined
      ) {
        let startingCapital = 0n;
        let hodlingSatoshis = 0n;

        for (const fission of fissionsByLockId.get(lock.lockId) ?? []) {
          const opening = fission.ratchets[0];
          if (opening) {
            startingCapital += getFissionTargetValue(fission, opening.microgonsAtTargetPerBtc, opening.source);
            hodlingSatoshis += fission.satoshis;
          } else if (activeFissionIds.has(fission.fissionId)) {
            startingCapital += getFissionTargetValue(fission, fission.microgonsAtTargetPerBtc, 'fission');
            hodlingSatoshis += fission.satoshis;
          }
        }
        if (startingCapital > 0n && summary.satoshis > 0n) {
          hodlingInvestments.push({
            startingDate: lock.createdAt,
            startingCapital,
            endingDate: new Date(),
            // Compare the same Bitcoin quantity at opening and now, excluding unused lock funds.
            endingCapital: (summary.valueOfBtc * hodlingSatoshis) / summary.satoshis,
          });
        }
      }
    }

    const lockPositions = summaries.flatMap(summary =>
      createBitcoinLockPositions(summary, args.hasCurrentPrice, activeLiquidLockIds),
    );
    const liquidPositions = createBitcoinLiquidPositions({
      ...args,
      summaries,
      fissions,
      terms: securitizationHistory?.terms ?? [],
      activeFissionIds,
    });

    return {
      positions: [...lockPositions, ...liquidPositions],
      summaries,
      hodlingInvestments,
      currentBitcoinDebt,
    };
  }

  public createFinancialPositions(
    args: BitcoinFinancialRecordArgs & { summaries: readonly IBitcoinLockSummary[] },
  ): BitcoinFinancialRecord[] {
    return args.summaries.flatMap(summary => createBitcoinLockPositions(summary, args.hasCurrentPrice));
  }
}

export function createBitcoinLiquidPositions(
  args: BitcoinFinancialRecordArgs & {
    summaries: readonly IBitcoinLockSummary[];
    fissions: readonly BitcoinFission[];
    terms: readonly IBitcoinSecuritizationTerm[];
    activeFissionIds: ReadonlySet<number>;
  },
): IBitcoinLiquidFinancialPosition[] {
  const { summaries, fissions, terms, activeFissionIds } = args;
  const currentInsuranceTerms = mergeCurrentInsuranceTerms({ summaries, fissions, terms });
  const insurance = allocateBitcoinInsuranceCosts({
    terms: currentInsuranceTerms,
    fissions,
  });
  const summariesByLockId = new Map<number, IBitcoinLockSummary>();
  for (const summary of summaries) {
    if (summary.lockId !== undefined) summariesByLockId.set(summary.lockId, summary);
  }
  const positions: IBitcoinLiquidFinancialPosition[] = [];

  for (const liquid of createBitcoinLiquids({
    fissions,
    terms: currentInsuranceTerms,
    securitizationCostsByLiquidId: insurance.costByLiquidId,
  })) {
    const { liquidId, fissions: liquidFissions } = liquid;
    const locks = liquidFissions.flatMap(fission => {
      const lock = summariesByLockId.get(fission.lockId)?.record;
      return lock ? [lock] : [];
    });
    const uniqueLocks = [...new Map(locks.map(lock => [lock.uuid, lock])).values()];
    const isActive = liquidFissions.some(fission => activeFissionIds.has(fission.fissionId));
    const hasCompleteInsurance = !insurance.incompleteLiquidIds.has(liquidId);
    let hasCompleteReturn =
      hasCompleteInsurance && uniqueLocks.length === new Set(liquidFissions.map(fission => fission.lockId)).size;
    let hasCompleteTransactionFees = liquid.historyTransactionFees !== undefined;
    let startingCapital = 0n;
    let performanceBitcoinValue = 0n;
    let recordedPrincipal = 0n;
    let receivedLiquidity = 0n;
    let pendingLiquidity = 0n;
    let repaymentAmount = 0n;
    let transactionFees = liquid.historyTransactionFees ?? 0n;

    for (const fission of liquidFissions) {
      const summary = summariesByLockId.get(fission.lockId);
      const ratchets = fission.ratchets;
      const opening = ratchets[0];
      if (!summary || !opening || summary.satoshis <= 0n) {
        hasCompleteReturn = false;
        continue;
      }

      const openingTarget = getFissionTargetValue(fission, opening.microgonsAtTargetPerBtc, opening.source);
      startingCapital += openingTarget;
      performanceBitcoinValue += openingTarget;

      let minted = 0n;
      let burned = 0n;
      let historicalPending = 0n;
      for (const ratchet of ratchets) {
        minted += ratchet.amountMinted;
        burned += ratchet.amountBurned;
        historicalPending += ratchet.mintPending;
      }
      const pending = activeFissionIds.has(fission.fissionId)
        ? fission.pendingMints.reduce((total, mint) => total + mint.remainingAmount, 0n)
        : historicalPending;
      pendingLiquidity += pending;
      receivedLiquidity += bigIntMax((minted || fission.liquidityPromised) - pending - burned, 0n);

      if (activeFissionIds.has(fission.fissionId)) {
        recordedPrincipal += getFissionTargetValue(fission, fission.microgonsAtTargetPerBtc, 'fission');
        if (args.hasCurrentPrice && args.priceIndex) {
          repaymentAmount += fission.calculateRedemptionAmount(args.priceIndex);
        }
      } else {
        if (fission.closeReason === 'lock-spent') {
          // The Bitcoin spend proceeds are not recorded here, so fees and the
          // original lock value cannot establish a complete Liquid return.
          hasCompleteReturn = false;
        } else {
          if (fission.redemptionAmount != null) {
            recordedPrincipal += fission.redemptionAmount;
            repaymentAmount += fission.redemptionAmount;
          } else {
            hasCompleteReturn = false;
          }
        }
      }
    }
    performanceBitcoinValue += liquid.history.reduce(
      (total, entry) => total + (entry.kind === 'ratchet' ? entry.liquidityUnlocked : 0n),
      0n,
    );

    let financialLiquid = liquid;
    if (!isActive) {
      let closeTransactionFees = liquid.closeTransactionFees;
      if (closeTransactionFees !== undefined) {
        transactionFees += closeTransactionFees;
      } else if (liquidFissions.length === 1 && liquidFissions[0].origin === 'lock-migration') {
        const summary = summariesByLockId.get(liquidFissions[0].lockId);
        if (summary?.historicalTransactionFees === undefined) {
          hasCompleteTransactionFees = false;
        } else {
          // Liquid history already includes the Fission fees; add only the release fees from the lock summary.
          closeTransactionFees = bigIntMax(summary.historicalTransactionFees - summary.transactionFees, 0n);
          transactionFees += closeTransactionFees;
        }
      } else {
        hasCompleteTransactionFees = false;
      }
      if (closeTransactionFees !== undefined && liquid.closeTransactionFees === undefined) {
        financialLiquid = new BitcoinLiquid({ ...liquid, closeTransactionFees });
      }
    }

    hasCompleteReturn &&= hasCompleteTransactionFees;
    const insuranceCost = hasCompleteInsurance ? (insurance.costByLiquidId.get(liquidId) ?? 0n) : undefined;
    const knownTransactionFees = hasCompleteTransactionFees ? transactionFees : undefined;
    const totalFees =
      insuranceCost === undefined || knownTransactionFees === undefined
        ? undefined
        : insuranceCost + knownTransactionFees;
    const endingCapital =
      performanceBitcoinValue +
      receivedLiquidity +
      pendingLiquidity -
      recordedPrincipal -
      (totalFees ?? transactionFees);
    const startedAt = liquidFissions
      .map(fission => {
        return fission.createdBlockTime ?? fission.createdAt;
      })
      .filter((date): date is Date => date !== undefined)
      .sort((left, right) => left.getTime() - right.getTime())[0];
    const endedAt = isActive
      ? undefined
      : liquidFissions
          .map(fission => fission.closedBlockTime)
          .filter((date): date is Date => date !== undefined)
          .sort((left, right) => right.getTime() - left.getTime())[0];
    if (!startedAt || (!isActive && !endedAt)) hasCompleteReturn = false;

    positions.push(
      createFinancialPosition(
        'bitcoin-liquid',
        {
          id: `bitcoin-liquid:${liquidId}`,
          label: `Bitcoin Liquid #${liquidId}`,
          lifecycle: isActive ? 'active' : 'completed',
          liquidId,
          liquid: financialLiquid,
          locks: uniqueLocks,
          ...(knownTransactionFees === undefined ? {} : { transactionFees: knownTransactionFees }),
          ...(insuranceCost === undefined ? {} : { insuranceCost, totalFees }),
          receivedLiquidity,
          pendingLiquidity,
          repaymentAmount,
          ...(hasCompleteReturn
            ? {
                performanceEndingCapital: endingCapital,
                totalReturn: calculateBitcoinReturn(startingCapital, endingCapital),
              }
            : {}),
          startedAt,
          endedAt,
        },
        withInvestmentBasis(
          {
            // The owned Bitcoin and pending mint are already carried by the
            // lock asset. A Liquid contributes performance, not another copy
            // of those assets, to the balance sheet.
            currentValue: 0n,
            investedCost: startingCapital,
            paidIncome: totalFees === undefined ? 0n : receivedLiquidity - totalFees,
            settledPrincipalValue: 0n,
          },
          hasCompleteReturn,
        ),
      ),
    );
  }

  return positions.sort((left, right) => left.liquidId - right.liquidId);
}

function mergeCurrentInsuranceTerms(args: {
  summaries: readonly IBitcoinLockSummary[];
  fissions: readonly BitcoinFission[];
  terms: readonly IBitcoinSecuritizationTerm[];
}): IBitcoinSecuritizationTerm[] {
  const fissionLockIds = new Set(args.fissions.map(fission => fission.lockId));
  const fissionsByLockId = new Map<number, BitcoinFission[]>();
  for (const fission of args.fissions) {
    const fissions = fissionsByLockId.get(fission.lockId) ?? [];
    fissions.push(fission);
    fissionsByLockId.set(fission.lockId, fissions);
  }
  const termsByLockId = new Map<number, IBitcoinSecuritizationTerm[]>();
  for (const term of args.terms) {
    const terms = termsByLockId.get(term.lockId) ?? [];
    terms.push({ ...term });
    termsByLockId.set(term.lockId, terms);
  }

  for (const summary of args.summaries) {
    const { record, lockId } = summary;
    if (
      lockId === undefined ||
      !fissionLockIds.has(lockId) ||
      !activeBitcoinLockStatuses.includes(summary.status) ||
      record.securitizationTick === undefined ||
      record.securitizedSatoshis <= 0n
    ) {
      continue;
    }

    const terms = termsByLockId.get(lockId) ?? [];
    if (terms.length) continue;

    const fissions = fissionsByLockId.get(lockId) ?? [];
    if (new Set(fissions.map(fission => fission.liquidId)).size !== 1) continue;
    const opening = fissions.toSorted(
      (left, right) => (left.createdAtArgonBlock ?? 0) - (right.createdAtArgonBlock ?? 0),
    )[0];
    termsByLockId.set(lockId, [
      {
        lockId,
        termIndex: 0,
        origin: 'created',
        startTick: opening?.createdAtTick ?? record.securitizationTick,
        startBlockNumber: opening?.createdAtArgonBlock ?? record.createdAtArgonBlock ?? 0,
        securitizedSatoshis: record.securitizedSatoshis,
        securitizationCoverageMicrogons: record.securitizationCoverageMicrogons,
        cumulativeNetSecurityFee: summary.securityFees,
        addedNetSecurityFee: summary.securityFees,
      },
    ]);
  }

  return [...termsByLockId.values()].flat();
}

export function applyBitcoinFissionValuation(args: {
  summary: IBitcoinLockSummary;
  fissions: readonly BitcoinFission[];
  activeFissionIds: ReadonlySet<number>;
  currentRedemptionAmount: bigint | undefined;
}): IBitcoinLockSummary {
  const { summary, fissions, activeFissionIds, currentRedemptionAmount } = args;
  if (!fissions.length) return summary;

  let totalLiquidity = 0n;
  let pendingLiquidity = 0n;
  let burnedLiquidity = 0n;
  let targetValue = 0n;
  let transactionFees = 0n;
  let historicalRedemptionAmount: bigint | undefined = 0n;
  let hasActiveFission = false;

  for (const fission of fissions) {
    const ratchets = fission.ratchets;
    const minted = ratchets.reduce((total, ratchet) => total + ratchet.amountMinted, 0n);
    totalLiquidity += minted || fission.liquidityPromised;
    burnedLiquidity += ratchets.reduce((total, ratchet) => total + ratchet.amountBurned, 0n);
    transactionFees += ratchets.reduce((total, ratchet) => total + (ratchet.txFee ?? 0n), 0n);
    if (activeFissionIds.has(fission.fissionId)) {
      hasActiveFission = true;
      pendingLiquidity += fission.pendingMints.reduce((total, mint) => total + mint.remainingAmount, 0n);
      targetValue += getFissionTargetValue(fission, fission.microgonsAtTargetPerBtc, 'fission');
      continue;
    }

    if (fission.closeReason !== 'lock-spent') {
      historicalRedemptionAmount =
        historicalRedemptionAmount === undefined || fission.redemptionAmount === undefined
          ? undefined
          : historicalRedemptionAmount + fission.redemptionAmount;
    }

    pendingLiquidity += ratchets.reduce((total, ratchet) => total + ratchet.mintPending, 0n);
    const latestRatchet = ratchets.at(-1);
    targetValue += getFissionTargetValue(
      fission,
      latestRatchet?.microgonsAtTargetPerBtc ?? fission.microgonsAtTargetPerBtc,
      latestRatchet?.source ?? 'fission',
    );
  }

  const receivedLiquidity = bigIntMax(totalLiquidity - pendingLiquidity - burnedLiquidity, 0n);
  const startingCapital = receivedLiquidity + pendingLiquidity;
  const valueBeyondLiquidity = bigIntMax(summary.valueOfBtc - targetValue, 0n);
  const totalFees = summary.securityFees + transactionFees;
  const historicalTransactionFees =
    summary.historicalTransactionFees === undefined ? undefined : summary.historicalTransactionFees + transactionFees;
  const redemptionAmount = currentRedemptionAmount ?? (hasActiveFission ? 0n : (historicalRedemptionAmount ?? 0n));
  const endingCapital = calculateBitcoinEndingCapital({
    bitcoinValue: startingCapital + valueBeyondLiquidity,
    receivedLiquidity,
    pendingLiquidity,
    redemptionAmount,
    fees: totalFees,
  });

  return {
    ...summary,
    totalLiquidity,
    pendingLiquidity,
    receivedLiquidity,
    valueBeyondLiquidity,
    startingCapital,
    endingCapital,
    unlockAmount: redemptionAmount,
    ratchetPercent: calculateBitcoinReturn(targetValue, summary.valueOfBtc),
    transactionFees,
    totalFees,
    historicalTransactionFees,
    historicalTotalFees:
      historicalTransactionFees === undefined ? undefined : summary.securityFees + historicalTransactionFees,
    totalReturn: calculateBitcoinReturn(startingCapital, endingCapital),
  };
}

function getFissionTargetValue(
  fission: Pick<IBitcoinFission, 'satoshis'>,
  rate: bigint,
  source: 'lock' | 'fission',
): bigint {
  // Pre-159 Lock ratchets retain their original total target value. Native Fission
  // history records the target-normalized value per BTC.
  if (source === 'lock') return rate;
  return (fission.satoshis * rate) / SATOSHIS_PER_BITCOIN;
}

function createBitcoinLockPositions(
  summary: IBitcoinLockSummary,
  hasCurrentPrice: boolean,
  activeLiquidLockIds?: ReadonlySet<number>,
): BitcoinFinancialRecord[] {
  const { record } = summary;

  if (record.removalReason || summary.status === BitcoinLockStatus.Released) {
    if (record.removalReason === 'spent' && summary.pendingLiquidity === 0n) return [];

    const isReleased = record.removalReason === 'released';

    let label = 'Removed Bitcoin lock';
    let lifecycle: IBitcoinFinancialAsset['lifecycle'] = 'completed';
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
      createFinancialPosition('bitcoin-asset', {
        id: `bitcoin-asset:${record.uuid}`,
        label,
        lifecycle,
        currentValue,
        lock: record,
      }),
    ];
  }

  const isReleasing = summary.status === BitcoinLockStatus.Releasing;
  if (!isReleasing && !activeBitcoinLockStatuses.includes(summary.status)) return [];

  const currentValue = hasCurrentPrice ? summary.valueOfBtc + summary.pendingLiquidity : undefined;

  const positions: BitcoinFinancialRecord[] = [
    createFinancialPosition('bitcoin-asset', {
      id: `bitcoin-asset:${record.uuid}`,
      label: 'Locked Bitcoin',
      lifecycle: isReleasing ? 'releasing' : 'active',
      currentValue,
      lock: summary.record,
    }),
  ];
  const hasActiveLiquid = activeLiquidLockIds
    ? record.lockId !== undefined && activeLiquidLockIds.has(record.lockId)
    : record.fissionedSatoshis !== 0n;
  if (hasActiveLiquid) {
    positions.push(
      createFinancialPosition('bitcoin-liability', {
        id: `bitcoin-liability:${record.uuid}`,
        label: 'Bitcoin redemption',
        lifecycle: isReleasing ? 'releasing' : 'active',
        currentValue: hasCurrentPrice ? -summary.unlockAmount : undefined,
        lock: summary.record,
      }),
    );
  }
  return positions;
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
