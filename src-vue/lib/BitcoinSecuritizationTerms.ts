import { bigIntMax, type IBitcoinLock, type IBlockHeaderInfo } from '@argonprotocol/apps-core';

import type { IBitcoinSecuritizationTerm } from '../interfaces/IBitcoinSecuritizationTerm.ts';
import type { BitcoinSecuritizationHistoryTable } from './db/BitcoinSecuritizationHistoryTable.ts';

export function mergeRecoveredSecuritizationTerms(
  published: readonly IBitcoinSecuritizationTerm[],
  recovered: readonly IBitcoinSecuritizationTerm[],
  asOfBlock: number,
): IBitcoinSecuritizationTerm[] {
  const coveredTerms = recovered.filter(term => term.startBlockNumber <= asOfBlock);
  const recoveredLockIds = new Set(coveredTerms.map(term => term.lockId));
  const mergedTerms = published.filter(term => !recoveredLockIds.has(term.lockId));

  for (const lockId of recoveredLockIds) {
    const publishedLockTerms = published.filter(term => term.lockId === lockId);
    const lockTerms = coveredTerms.filter(term => term.lockId === lockId).map(term => ({ ...term }));

    // Recovery must retain closures observed after its coverage ended.
    for (const term of lockTerms) {
      if (term.endBlockNumber !== undefined) continue;

      const publishedTerm = publishedLockTerms.find(
        candidate =>
          candidate.startBlockNumber === term.startBlockNumber &&
          candidate.startExtrinsicIndex === term.startExtrinsicIndex &&
          candidate.startBlockHash === term.startBlockHash,
      );
      if (!publishedTerm?.endBlockNumber) continue;
      if (publishedTerm.endBlockNumber <= asOfBlock) continue;

      Object.assign(term, {
        endTick: publishedTerm.endTick,
        endBlockNumber: publishedTerm.endBlockNumber,
        endBlockHash: publishedTerm.endBlockHash,
        endExtrinsicIndex: publishedTerm.endExtrinsicIndex,
        endReason: publishedTerm.endReason,
      });
    }

    for (const term of publishedLockTerms) {
      if (term.startBlockNumber > asOfBlock) lockTerms.push({ ...term });
    }
    lockTerms.sort(
      (a, b) => a.startBlockNumber - b.startBlockNumber || (a.startExtrinsicIndex ?? 0) - (b.startExtrinsicIndex ?? 0),
    );

    // Earlier recovered terms change the indexes and each term's incremental fee.
    for (const [index, term] of lockTerms.entries()) {
      term.termIndex = index;
      if (term.origin === 'partial-release') {
        term.addedNetSecurityFee = 0n;
      } else {
        const previousFee = lockTerms[index - 1]?.cumulativeNetSecurityFee ?? 0n;
        term.addedNetSecurityFee = bigIntMax(term.cumulativeNetSecurityFee - previousFee, 0n);
      }

      if (term.endBlockNumber !== undefined) continue;
      const next = lockTerms[index + 1];
      if (!next) continue;

      Object.assign(term, {
        endTick: next.startTick,
        endBlockNumber: next.startBlockNumber,
        endBlockHash: next.startBlockHash,
        endExtrinsicIndex: next.startExtrinsicIndex,
        endReason: next.origin === 'partial-release' ? 'partial-release' : 'resecuritized',
      });
    }
    mergedTerms.push(...lockTerms);
  }

  return mergedTerms.sort((a, b) => a.lockId - b.lockId || a.termIndex - b.termIndex);
}

export async function closeFinalizedSecuritization(
  table: BitcoinSecuritizationHistoryTable,
  args: {
    ownerAccount: string;
    lockId: number;
    block: IBlockHeaderInfo;
    extrinsicIndex?: number;
  },
): Promise<void> {
  const { ownerAccount, lockId, block, extrinsicIndex } = args;
  const published = await table.getPublishedSnapshot(ownerAccount);
  if (!published) return;

  const terms = published.terms.map(term => ({ ...term }));
  const current = terms.findLast(term => term.lockId === lockId);
  if (!current || current.endTick !== undefined) return;

  Object.assign(current, {
    endTick: block.tick,
    endBlockNumber: block.blockNumber,
    endBlockHash: block.blockHash,
    endExtrinsicIndex: extrinsicIndex,
    endReason: 'released' as const,
  });
  const snapshot = await table.createSnapshot(ownerAccount, Math.max(published.asOfBlock, block.blockNumber), terms);
  await table.publishSnapshot(snapshot);
}

export async function recordFinalizedSecuritization(
  table: BitcoinSecuritizationHistoryTable,
  args: {
    block: IBlockHeaderInfo;
    extrinsicIndex: number;
    lock: IBitcoinLock;
    origin: IBitcoinSecuritizationTerm['origin'];
  },
): Promise<void> {
  const { block, extrinsicIndex, lock, origin } = args;
  const published = await table.getPublishedSnapshot(lock.ownerAccount);
  const terms = (published?.terms ?? []).map(term => ({ ...term }));
  const lockTerms = terms.filter(term => term.lockId === lock.lockId);
  const existing = lockTerms.find(term => {
    return term.startBlockHash === block.blockHash && term.startExtrinsicIndex === extrinsicIndex;
  });
  const previous = existing ? lockTerms[lockTerms.indexOf(existing) - 1] : lockTerms.at(-1);
  if (
    !existing &&
    origin === 'partial-release' &&
    previous &&
    previous.endTick === undefined &&
    previous.securitizedSatoshis === lock.securitizedSatoshis
  ) {
    return;
  }

  const observedNetSecurityFee = bigIntMax(lock.securityFees - lock.couponFeesPaid, 0n);
  const cumulativeNetSecurityFee =
    origin === 'partial-release' && previous ? previous.cumulativeNetSecurityFee : observedNetSecurityFee;
  const current: IBitcoinSecuritizationTerm = {
    lockId: lock.lockId,
    termIndex: existing?.termIndex ?? lockTerms.length,
    origin,
    startTick: block.tick,
    startBlockNumber: block.blockNumber,
    startBlockHash: block.blockHash,
    startExtrinsicIndex: extrinsicIndex,
    securitizedSatoshis: lock.securitizedSatoshis,
    securitizationCoverageMicrogons: lock.securitizationCoverageMicrogons,
    cumulativeNetSecurityFee,
    addedNetSecurityFee:
      origin === 'partial-release'
        ? 0n
        : bigIntMax(cumulativeNetSecurityFee - (previous?.cumulativeNetSecurityFee ?? 0n), 0n),
    endTick: existing?.endTick,
    endBlockNumber: existing?.endBlockNumber,
    endBlockHash: existing?.endBlockHash,
    endExtrinsicIndex: existing?.endExtrinsicIndex,
    endReason: existing?.endReason,
  };

  if (existing) {
    terms[terms.indexOf(existing)] = current;
  } else {
    if (previous && previous.endTick === undefined) {
      Object.assign(previous, {
        endTick: block.tick,
        endBlockNumber: block.blockNumber,
        endBlockHash: block.blockHash,
        endExtrinsicIndex: extrinsicIndex,
        endReason: origin === 'partial-release' ? 'partial-release' : 'resecuritized',
      });
    }
    terms.push(current);
  }

  const snapshot = await table.createSnapshot(
    lock.ownerAccount,
    Math.max(published?.asOfBlock ?? 0, block.blockNumber),
    terms.sort((left, right) => left.lockId - right.lockId || left.termIndex - right.termIndex),
  );
  await table.publishSnapshot(snapshot);
}
