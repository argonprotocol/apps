import { bigIntMax, BitcoinFission, SATOSHIS_PER_BITCOIN, type IBitcoinFissionRatchet } from '@argonprotocol/apps-core';
import type { PriceIndex } from '@argonprotocol/mainchain';

import type { IBitcoinSecuritizationTerm } from '../interfaces/IBitcoinSecuritizationTerm.ts';

export interface IBitcoinLiquidHistoryEntry {
  key: string;
  kind: 'created' | 'ratchet';
  blockNumber: number;
  blockTime?: Date;
  extrinsicIndex?: number;
  previousMicrogonsAtTargetPerBtc?: bigint;
  microgonsAtTargetPerBtc: bigint;
  liabilityBefore: bigint;
  liabilityAfter: bigint;
  liquidityUnlocked: bigint;
  liquidityPending: bigint;
  pocketed: bigint;
  recycled: bigint;
  mintPending: bigint;
  transactionFee?: bigint;
  securityFee?: bigint;
  actionFees?: bigint;
  affectedFissionCount: number;
  affectedSatoshis: bigint;
}

export interface IBitcoinLiquidCloseHistoryEntry {
  key: string;
  kind: 'closed';
  blockNumber: number;
  blockTime?: Date;
  repaymentAmount?: bigint;
  transactionFee?: bigint;
  totalCloseCost?: bigint;
}

export type BitcoinLiquidHistoryRowEntry = IBitcoinLiquidHistoryEntry | IBitcoinLiquidCloseHistoryEntry;

export class BitcoinLiquid {
  public readonly liquidId: number;
  public readonly fissions: BitcoinFission[];
  public readonly history: IBitcoinLiquidHistoryEntry[];
  public readonly historyTransactionFees?: bigint;
  public readonly closeTransactionFees?: bigint;

  constructor(args: {
    liquidId: number;
    fissions: BitcoinFission[];
    history: IBitcoinLiquidHistoryEntry[];
    historyTransactionFees?: bigint;
    closeTransactionFees?: bigint;
  }) {
    this.liquidId = args.liquidId;
    this.fissions = args.fissions;
    this.history = args.history;
    this.historyTransactionFees = args.historyTransactionFees;
    this.closeTransactionFees = args.closeTransactionFees;
  }

  public static create(args: {
    liquidId: number;
    fissions: readonly BitcoinFission[];
    terms?: readonly IBitcoinSecuritizationTerm[];
  }): BitcoinLiquid {
    const { liquidId, fissions, terms = [] } = args;
    return createBitcoinLiquid(liquidId, [...fissions], terms);
  }

  public get isClosed(): boolean {
    return this.fissions.length > 0 && this.fissions.every(fission => fission.closedAtArgonBlock != null);
  }

  public get closedAt(): Date | undefined {
    if (!this.isClosed) return;

    return this.fissions
      .flatMap(fission => (fission.closedBlockTime ? [fission.closedBlockTime] : []))
      .sort((left, right) => right.getTime() - left.getTime())[0];
  }

  public get redemptionAmount(): bigint | undefined {
    if (!this.isClosed) return;

    let total = 0n;
    for (const fission of this.fissions) {
      if (fission.closeReason === 'lock-spent') continue;
      if (fission.redemptionAmount === undefined) return;
      total += fission.redemptionAmount;
    }
    return total;
  }

  public get totalCloseCost(): bigint | undefined {
    const redemptionAmount = this.redemptionAmount;
    if (redemptionAmount === undefined || this.closeTransactionFees === undefined) return;
    return redemptionAmount + this.closeTransactionFees;
  }

  public get closeHistoryEntry(): IBitcoinLiquidCloseHistoryEntry | undefined {
    if (!this.isClosed) return;

    return {
      key: `liquid:${this.liquidId}:closed`,
      kind: 'closed',
      blockNumber: Math.max(...this.fissions.map(fission => fission.closedAtArgonBlock ?? 0)),
      blockTime: this.closedAt,
      repaymentAmount: this.redemptionAmount,
      transactionFee: this.closeTransactionFees,
      totalCloseCost: this.totalCloseCost,
    };
  }

  public get satoshis(): bigint {
    return this.fissions.reduce((total, fission) => total + fission.satoshis, 0n);
  }

  public get liquidityPromised(): bigint {
    return this.fissions.reduce((total, fission) => total + fission.liquidityPromised, 0n);
  }

  public get pendingLiquidity(): bigint {
    return this.fissions.reduce(
      (total, fission) => total + fission.pendingMints.reduce((pending, mint) => pending + mint.remainingAmount, 0n),
      0n,
    );
  }

  public get receivedLiquidity(): bigint {
    return bigIntMax(this.liquidityPromised - this.pendingLiquidity, 0n);
  }

  public getRatchetStatus(args: { microgonsAtTargetPerBtc: bigint; minimumRatchetPercent: bigint }): {
    percent: number;
    isAvailable: boolean;
  } {
    const { microgonsAtTargetPerBtc, minimumRatchetPercent } = args;
    let weightedBasisPoints = 0n;
    let isAvailable = false;

    for (const fission of this.fissions) {
      if (fission.microgonsAtTargetPerBtc <= 0n) continue;

      const basisPoints =
        ((microgonsAtTargetPerBtc - fission.microgonsAtTargetPerBtc) * 10_000n) / fission.microgonsAtTargetPerBtc;
      weightedBasisPoints += basisPoints * fission.satoshis;
      isAvailable ||= fission.isRatchetAvailable({ microgonsAtTargetPerBtc, minimumRatchetPercent });
    }

    const percent = this.satoshis ? Number(weightedBasisPoints / this.satoshis) / 100 : 0;
    return { percent, isAvailable };
  }

  public getRepaymentAmount(priceIndex: PriceIndex): bigint {
    return this.fissions.reduce((total, fission) => total + fission.calculateRedemptionAmount(priceIndex), 0n);
  }
}

type FissionHistoryFragment = {
  fission: BitcoinFission;
  ratchet: IBitcoinFissionRatchet;
  liabilityBefore: bigint;
  liabilityAfter: bigint;
};

function createBitcoinLiquid(
  liquidId: number,
  fissions: BitcoinFission[],
  terms: readonly IBitcoinSecuritizationTerm[],
): BitcoinLiquid {
  const fragmentsByTransaction = new Map<string, FissionHistoryFragment[]>();
  for (const fission of fissions) {
    let liabilityBefore = 0n;
    for (const ratchet of fission.ratchets) {
      const liabilityAfter =
        ratchet.liquidityPromised ??
        (ratchet.amountBurned > 0n ? ratchet.amountMinted : liabilityBefore + ratchet.amountMinted);
      const key = getTransactionKey(fission, ratchet);
      const fragments = fragmentsByTransaction.get(key) ?? [];
      fragments.push({ fission, ratchet, liabilityBefore, liabilityAfter });
      fragmentsByTransaction.set(key, fragments);
      liabilityBefore = liabilityAfter;
    }
  }

  const liabilityByFissionId = new Map<number, bigint>();
  const targetByFissionId = new Map<number, bigint>();
  let totalLiability = 0n;
  const history = [...fragmentsByTransaction]
    .map(([, fragments]) => ({ key: getHistoryEntryKey(fragments), fragments }))
    .sort((left, right) => {
      const leftRatchet = left.fragments[0].ratchet;
      const rightRatchet = right.fragments[0].ratchet;
      if (leftRatchet.blockNumber !== rightRatchet.blockNumber) {
        return leftRatchet.blockNumber - rightRatchet.blockNumber;
      }
      return (leftRatchet.extrinsicIndex ?? -1) - (rightRatchet.extrinsicIndex ?? -1);
    })
    .map(({ key, fragments }): IBitcoinLiquidHistoryEntry => {
      const first = fragments[0].ratchet;
      const liabilityBefore = totalLiability;
      let affectedSatoshis = 0n;
      let previousTargetSatoshis = 0n;
      let weightedPreviousTarget = 0n;
      let weightedTarget = 0n;
      let liquidityUnlocked = 0n;
      let liquidityPending = 0n;
      let pocketed = 0n;
      let recycled = 0n;
      let mintPending = 0n;

      for (const fragment of fragments) {
        const { fission, ratchet, liabilityAfter: fissionLiabilityAfter } = fragment;
        affectedSatoshis += fission.satoshis;
        const targetPerBtc =
          ratchet.source === 'fission'
            ? ratchet.microgonsAtTargetPerBtc
            : (ratchet.microgonsAtTargetPerBtc * SATOSHIS_PER_BITCOIN) / fission.satoshis;
        const previousTargetPerBtc = targetByFissionId.get(fission.fissionId);
        if (previousTargetPerBtc !== undefined) {
          previousTargetSatoshis += fission.satoshis;
          weightedPreviousTarget += previousTargetPerBtc * fission.satoshis;
        }
        weightedTarget += targetPerBtc * fission.satoshis;
        if (fragment.liabilityAfter > fragment.liabilityBefore) {
          liquidityUnlocked += fragment.liabilityAfter - fragment.liabilityBefore;
          liquidityPending += ratchet.mintPending;
        } else {
          pocketed += fragment.liabilityBefore - fragment.liabilityAfter;
        }
        recycled += ratchet.amountBurned;
        mintPending += ratchet.mintPending;
        const priorLiability = liabilityByFissionId.get(fission.fissionId) ?? 0n;
        totalLiability += fissionLiabilityAfter - priorLiability;
        liabilityByFissionId.set(fission.fissionId, fissionLiabilityAfter);
        targetByFissionId.set(fission.fissionId, targetPerBtc);
      }

      const transactionFee = fragments.every(({ ratchet }) => ratchet.txFee != null)
        ? fragments[0].ratchet.txFee
        : undefined;
      const historicalSecurityFees = fragments.filter(({ ratchet }) => ratchet.source === 'lock');
      const hasHistoricalSecurityFees = historicalSecurityFees.every(({ ratchet }) => ratchet.securityFee != null);
      const directlyCreatedTerms =
        first.extrinsicIndex === undefined
          ? []
          : terms.filter(term => {
              return (
                term.startBlockNumber === first.blockNumber &&
                term.startExtrinsicIndex === first.extrinsicIndex &&
                fragments.some(({ fission }) => fission.utxoId === term.utxoId)
              );
            });
      const securityFee = hasHistoricalSecurityFees
        ? historicalSecurityFees.reduce((total, { ratchet }) => total + (ratchet.securityFee ?? 0n), 0n) +
          directlyCreatedTerms.reduce((total, term) => total + term.addedNetSecurityFee, 0n)
        : undefined;
      const liabilityAfter = totalLiability;

      return {
        key,
        kind: fragments.every(({ ratchet }) => ratchet.sourceRatchetIndex === 0) ? 'created' : 'ratchet',
        blockNumber: first.blockNumber,
        blockTime: first.blockTime,
        extrinsicIndex: first.extrinsicIndex,
        previousMicrogonsAtTargetPerBtc:
          previousTargetSatoshis === affectedSatoshis && affectedSatoshis
            ? weightedPreviousTarget / affectedSatoshis
            : undefined,
        microgonsAtTargetPerBtc: affectedSatoshis ? weightedTarget / affectedSatoshis : 0n,
        liabilityBefore,
        liabilityAfter,
        liquidityUnlocked,
        liquidityPending,
        pocketed,
        recycled,
        mintPending,
        transactionFee,
        securityFee,
        actionFees:
          transactionFee === undefined || securityFee === undefined ? undefined : transactionFee + securityFee,
        affectedFissionCount: fragments.length,
        affectedSatoshis,
      };
    });
  const closeFeesByTransaction = new Map<string, bigint | undefined>();
  for (const fission of fissions) {
    if (fission.closedAtArgonBlock === undefined) continue;
    const key =
      fission.closedExtrinsicIndex === undefined
        ? `${fission.closedBlockHash ?? fission.closedAtArgonBlock}:close:${fission.fissionId}`
        : `${fission.closedBlockHash ?? fission.closedAtArgonBlock}:${fission.closedExtrinsicIndex}`;
    if (!closeFeesByTransaction.has(key)) closeFeesByTransaction.set(key, fission.closeTxFee);
  }
  const historyFees = history.map(entry => entry.transactionFee);
  const closeFees = [...closeFeesByTransaction.values()];
  const historyTransactionFees = historyFees.every(fee => fee !== undefined)
    ? historyFees.reduce((total, fee) => total + (fee ?? 0n), 0n)
    : undefined;
  const closeTransactionFees = closeFees.every(fee => fee !== undefined)
    ? closeFees.reduce((total, fee) => total + (fee ?? 0n), 0n)
    : undefined;

  return new BitcoinLiquid({
    liquidId,
    fissions,
    history,
    historyTransactionFees,
    closeTransactionFees,
  });
}

function getTransactionKey(fission: BitcoinFission, ratchet: IBitcoinFissionRatchet): string {
  if (ratchet.extrinsicIndex === undefined) {
    return `${ratchet.blockHash ?? ratchet.blockNumber}:fission:${fission.fissionId}:${ratchet.sourceRatchetIndex}`;
  }
  return `${ratchet.blockHash ?? ratchet.blockNumber}:${ratchet.extrinsicIndex}`;
}

function getHistoryEntryKey(fragments: readonly FissionHistoryFragment[]): string {
  const first = [...fragments].sort((left, right) => {
    if (left.fission.fissionId !== right.fission.fissionId) return left.fission.fissionId - right.fission.fissionId;
    if (left.ratchet.source !== right.ratchet.source) return left.ratchet.source.localeCompare(right.ratchet.source);
    return left.ratchet.sourceRatchetIndex - right.ratchet.sourceRatchetIndex;
  })[0];
  return `fission:${first.fission.fissionId}:${first.ratchet.source}:${first.ratchet.sourceRatchetIndex}`;
}
