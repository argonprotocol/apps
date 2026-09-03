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
import {
  type ArgonApi,
  BitcoinFission,
  bigIntMax,
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
    const active = this.fissions.getAll();
    const history = this.fissions.getHistory();
    const activeFissionIds = new Set(active.map(fission => fission.fissionId));
    const incompleteFissionIds = new Set<number>();
    const fissionsById = new Map(history.map(record => [record.fissionId, new BitcoinFission(record)]));
    for (const fission of active) {
      const historical = fissionsById.get(fission.fissionId);
      if (
        !historical ||
        historical.lastUpdatedArgonBlock < fission.lastUpdatedArgonBlock ||
        historical.ratchetNumber !== fission.ratchetNumber
      ) {
        incompleteFissionIds.add(fission.fissionId);
      }
      fissionsById.set(
        fission.fissionId,
        historical ? BitcoinFission.fromCurrentAndHistory(fission, historical) : fission,
      );
    }
    const fissions = [...fissionsById.values()];
    const fissionsByUtxoId = new Map<IBitcoinLockRecord['utxoId'], BitcoinFission[]>();
    for (const fission of fissions) {
      const lockFissions = fissionsByUtxoId.get(fission.utxoId) ?? [];
      lockFissions.push(fission);
      fissionsByUtxoId.set(fission.utxoId, lockFissions);
    }

    const summaries = this.locks.getAllLocks({ includeHistoryRecoveryPending: true }).map(lock =>
      applyBitcoinFissionValuation({
        summary: this.locks.createLockSummary(lock),
        fissions: fissionsByUtxoId.get(lock.utxoId) ?? [],
        activeFissionIds,
      }),
    );
    const hodlingInvestments: IPerformanceReturnInput[] = [];
    let currentBitcoinDebt = 0n;

    for (const summary of summaries) {
      const lock = summary.record;

      if (this.locks.isLockFunded(lock)) currentBitcoinDebt += summary.unlockAmount;
      if (
        !lock.isHistoryRecoveryPending &&
        (this.locks.isLockFunded(lock) || this.locks.isReleaseStatus(lock)) &&
        lock.utxoId !== undefined
      ) {
        let startingCapital = 0n;

        for (const fission of fissionsByUtxoId.get(lock.utxoId) ?? []) {
          const opening = fission.ratchets[0];
          if (opening) {
            startingCapital += getFissionTargetValue(fission, opening.microgonsAtTargetPerBtc, opening.source);
          } else if (activeFissionIds.has(fission.fissionId)) {
            startingCapital += getFissionTargetValue(fission, fission.microgonsAtTargetPerBtc, 'fission');
          }
        }
        if (startingCapital > 0n) {
          hodlingInvestments.push({
            startingDate: lock.createdAt,
            startingCapital,
            endingDate: new Date(),
            endingCapital: summary.valueOfBtc,
          });
        }
      }
    }

    const lockPositions = this.createFinancialPositions({ ...args, summaries });
    const liquidPositions = createBitcoinLiquidPositions({
      ...args,
      summaries,
      fissions,
      terms: securitizationHistory?.terms ?? [],
      activeFissionIds,
      incompleteFissionIds,
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
    incompleteFissionIds?: ReadonlySet<number>;
  },
): IBitcoinLiquidFinancialPosition[] {
  const { summaries, fissions, terms, activeFissionIds, incompleteFissionIds = new Set() } = args;
  const insurance = allocateBitcoinInsuranceCosts({ terms, fissions });
  const summariesByUtxoId = new Map<number, IBitcoinLockSummary>();
  for (const summary of summaries) {
    if (summary.utxoId !== undefined) summariesByUtxoId.set(summary.utxoId, summary);
  }
  const positions: IBitcoinLiquidFinancialPosition[] = [];

  for (const liquid of createBitcoinLiquids({ fissions, terms })) {
    const { liquidId, fissions: liquidFissions } = liquid;
    const locks = liquidFissions.flatMap(fission => {
      const lock = summariesByUtxoId.get(fission.utxoId)?.record;
      return lock ? [lock] : [];
    });
    const uniqueLocks = [...new Map(locks.map(lock => [lock.uuid, lock])).values()];
    const isActive = liquidFissions.some(fission => activeFissionIds.has(fission.fissionId));
    const hasCurrentFissionHistory = liquidFissions.every(fission => !incompleteFissionIds.has(fission.fissionId));
    const hasCompleteInsurance = !insurance.incompleteLiquidIds.has(liquidId);
    let hasCompleteEconomics =
      hasCompleteInsurance &&
      hasCurrentFissionHistory &&
      uniqueLocks.length === new Set(liquidFissions.map(fission => fission.utxoId)).size;
    let hasCompleteTransactionFees = hasCurrentFissionHistory && liquid.historyTransactionFees !== undefined;
    let startingCapital = 0n;
    let bitcoinValue = 0n;
    let valueBeyondLiquidity = 0n;
    let receivedLiquidity = 0n;
    let pendingLiquidity = 0n;
    let repaymentAmount = 0n;
    let transactionFees = liquid.historyTransactionFees ?? 0n;

    for (const fission of liquidFissions) {
      const summary = summariesByUtxoId.get(fission.utxoId);
      const opening = fission.ratchets[0];
      const latest = fission.ratchets.at(-1);
      if (!summary || !opening || !latest || summary.satoshis <= 0n) {
        hasCompleteEconomics = false;
        continue;
      }

      const openingTarget = getFissionTargetValue(fission, opening.microgonsAtTargetPerBtc, opening.source);
      const latestTarget = activeFissionIds.has(fission.fissionId)
        ? getFissionTargetValue(fission, fission.microgonsAtTargetPerBtc, 'fission')
        : getFissionTargetValue(fission, latest.microgonsAtTargetPerBtc, latest.source);
      startingCapital += openingTarget;
      const minted = fission.ratchets.reduce((total, ratchet) => total + ratchet.amountMinted, 0n);
      const burned = fission.ratchets.reduce((total, ratchet) => total + ratchet.amountBurned, 0n);
      const pending = activeFissionIds.has(fission.fissionId)
        ? fission.pendingMints.reduce((total, mint) => total + mint.remainingAmount, 0n)
        : fission.ratchets.reduce((total, ratchet) => total + ratchet.mintPending, 0n);
      pendingLiquidity += pending;
      receivedLiquidity += bigIntMax((minted || fission.liquidityPromised) - pending - burned, 0n);

      let fissionBitcoinValue: bigint | undefined;
      if (activeFissionIds.has(fission.fissionId)) {
        if (args.hasCurrentPrice) {
          fissionBitcoinValue = (summary.valueOfBtc * fission.satoshis) / summary.satoshis;
        }
        if (args.priceIndex) repaymentAmount += fission.calculateRedemptionAmount(args.priceIndex);
        else hasCompleteEconomics = false;
      } else {
        const closingPrice =
          fission.btcPriceAtCloseMicrogons ??
          (fission.origin === 'lock-migration' || fission.closeReason === 'lock-spent'
            ? summary.record.btcPriceAtRemovalMicrogons
            : undefined);
        fissionBitcoinValue = valueSatoshisAtRate(fission.satoshis, closingPrice);
        if (fission.closeReason === 'lock-spent') repaymentAmount += 0n;
        else if (fission.redemptionAmount != null) repaymentAmount += fission.redemptionAmount;
        else hasCompleteEconomics = false;
      }
      if (fissionBitcoinValue === undefined) {
        hasCompleteEconomics = false;
      } else {
        bitcoinValue += fissionBitcoinValue;
        valueBeyondLiquidity += bigIntMax(fissionBitcoinValue - latestTarget, 0n);
      }
    }

    if (!isActive) {
      if (liquid.closeTransactionFees !== undefined) {
        transactionFees += liquid.closeTransactionFees;
      } else if (liquidFissions.length === 1 && liquidFissions[0].origin === 'lock-migration') {
        const summary = summariesByUtxoId.get(liquidFissions[0].utxoId);
        const releaseArgonTxFee = summary?.record.releaseArgonTxFeeMicrogons;
        const releaseBitcoinNetworkFee = valueSatoshisAtRate(
          summary?.record.fundingUtxo?.releaseBitcoinNetworkFee,
          summary?.record.btcPriceAtRemovalMicrogons,
        );
        if (releaseArgonTxFee === undefined || releaseBitcoinNetworkFee === undefined) {
          hasCompleteTransactionFees = false;
        } else {
          transactionFees += releaseArgonTxFee + releaseBitcoinNetworkFee;
        }
      } else {
        hasCompleteTransactionFees = false;
      }
    }

    hasCompleteEconomics &&= hasCompleteTransactionFees;
    const insuranceCost = hasCompleteInsurance ? (insurance.costByLiquidId.get(liquidId) ?? 0n) : undefined;
    const knownTransactionFees = hasCompleteTransactionFees ? transactionFees : undefined;
    const totalFees =
      insuranceCost === undefined || knownTransactionFees === undefined
        ? undefined
        : insuranceCost + knownTransactionFees;
    const endingCapital = calculateBitcoinEndingCapital({
      bitcoinValue: startingCapital + valueBeyondLiquidity,
      receivedLiquidity,
      pendingLiquidity,
      redemptionAmount: repaymentAmount,
      fees: totalFees ?? transactionFees,
    });
    const startedAt = liquidFissions
      .map(fission => fission.createdBlockTime ?? fission.createdAt)
      .filter((date): date is Date => date !== undefined)
      .sort((left, right) => left.getTime() - right.getTime())[0];
    const endedAt = isActive
      ? undefined
      : liquidFissions
          .map(fission => fission.closedBlockTime)
          .filter((date): date is Date => date !== undefined)
          .sort((left, right) => right.getTime() - left.getTime())[0];
    if (!startedAt || (!isActive && !endedAt)) hasCompleteEconomics = false;

    positions.push(
      createFinancialPosition(
        'bitcoin-liquid',
        {
          id: `bitcoin-liquid:${liquidId}`,
          label: `Bitcoin Liquid #${liquidId}`,
          lifecycle: isActive ? 'active' : 'completed',
          liquidId,
          liquid,
          locks: uniqueLocks,
          ...(knownTransactionFees === undefined ? {} : { transactionFees: knownTransactionFees }),
          ...(insuranceCost === undefined ? {} : { insuranceCost, totalFees }),
          receivedLiquidity,
          pendingLiquidity,
          repaymentAmount,
          ...(hasCompleteEconomics
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
          hasCompleteEconomics,
        ),
      ),
    );
  }

  return positions.sort((left, right) => left.liquidId - right.liquidId);
}

export function applyBitcoinFissionValuation(args: {
  summary: IBitcoinLockSummary;
  fissions: readonly BitcoinFission[];
  activeFissionIds: ReadonlySet<number>;
}): IBitcoinLockSummary {
  const { summary, fissions, activeFissionIds } = args;
  if (!fissions.length) return summary;

  let totalLiquidity = 0n;
  let pendingLiquidity = 0n;
  let burnedLiquidity = 0n;
  let targetValue = 0n;
  let transactionFees = 0n;

  for (const fission of fissions) {
    const ratchets = fission.ratchets ?? [];
    const minted = ratchets.reduce((total, ratchet) => total + ratchet.amountMinted, 0n);
    totalLiquidity += minted || fission.liquidityPromised;
    burnedLiquidity += ratchets.reduce((total, ratchet) => total + ratchet.amountBurned, 0n);
    transactionFees += ratchets.reduce((total, ratchet) => total + (ratchet.txFee ?? 0n), 0n);
    if (activeFissionIds.has(fission.fissionId)) {
      pendingLiquidity += fission.pendingMints.reduce((total, mint) => total + mint.remainingAmount, 0n);
      targetValue += getFissionTargetValue(fission, fission.microgonsAtTargetPerBtc, 'fission');
      continue;
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
  const endingCapital = calculateBitcoinEndingCapital({
    bitcoinValue: startingCapital + valueBeyondLiquidity,
    receivedLiquidity,
    pendingLiquidity,
    redemptionAmount: summary.unlockAmount,
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

function createBitcoinLockPositions(summary: IBitcoinLockSummary, hasCurrentPrice: boolean): BitcoinFinancialRecord[] {
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

  return [
    createFinancialPosition('bitcoin-asset', {
      id: `bitcoin-asset:${record.uuid}`,
      label: 'Locked Bitcoin',
      lifecycle: isReleasing ? 'releasing' : 'active',
      currentValue,
      lock: summary.record,
    }),
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
  const satoshis = lock.fundedSatoshis || lock.securitizedSatoshis;
  const btc = currency.convertSatToBtc(satoshis);
  const valueOfBtc = currency.convertBtcToMicrogon(btc);
  const unlockAmount = lock.releaseRedemptionMicrogons ?? lock.securitizationCoverageMicrogons ?? 0n;
  const securityFees = bigIntMax(lock.securityFees - lock.couponFeesPaid, 0n);
  const transactionFees = 0n;
  const totalFees = securityFees + transactionFees;
  const releaseBitcoinNetworkFeeValue = valueSatoshisAtRate(
    lock.fundingUtxo?.releaseBitcoinNetworkFee,
    lock.btcPriceAtRemovalMicrogons,
  );
  const hasHistoricalTransactionFees =
    lock.releaseArgonTxFeeMicrogons !== undefined || releaseBitcoinNetworkFeeValue !== undefined;
  const historicalTransactionFees = hasHistoricalTransactionFees
    ? transactionFees + (lock.releaseArgonTxFeeMicrogons ?? 0n) + (releaseBitcoinNetworkFeeValue ?? 0n)
    : undefined;
  const historicalTotalFees =
    historicalTransactionFees === undefined ? undefined : securityFees + historicalTransactionFees;
  const totalLiquidity = 0n;
  const pendingLiquidity = 0n;
  const receivedLiquidity = 0n;
  const startingCapital = valueOfBtc;
  const valueBeyondLiquidity = valueOfBtc;
  const currentEndingCapital = calculateBitcoinEndingCapital({
    bitcoinValue: startingCapital + valueBeyondLiquidity,
    receivedLiquidity,
    pendingLiquidity,
    redemptionAmount: unlockAmount,
    fees: totalFees,
  });
  const endingCapital = currentEndingCapital;

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
