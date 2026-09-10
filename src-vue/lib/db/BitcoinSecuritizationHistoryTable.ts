import { bigIntMax, type IBitcoinLock, type IBlockHeaderInfo } from '@argonprotocol/apps-core';

import type { IBitcoinSecuritizationTerm } from '../../interfaces/IBitcoinSecuritizationTerm.ts';
import { convertFromSqliteFields, toSqlParams } from '../Utils.ts';
import { BaseTable, type IFieldTypes } from './BaseTable.ts';
import { FinancialCacheTypes, type IBitcoinSecuritizationHistoryCacheRecord } from './FinancialCacheTable.ts';

export interface IBitcoinSecuritizationHistorySnapshot {
  ownerAccount: string;
  snapshotId: string;
  asOfBlock: number;
  basePublication?: IBitcoinSecuritizationHistoryCacheRecord;
}

export interface IBitcoinPublishedSecuritizationHistory {
  asOfBlock: number;
  terms: IBitcoinSecuritizationTerm[];
}

export class BitcoinSecuritizationHistoryTable extends BaseTable {
  private readonly fieldTypes: IFieldTypes = {
    bigint: [
      'securitizedSatoshis',
      'securitizationCoverageMicrogons',
      'cumulativeNetSecurityFee',
      'addedNetSecurityFee',
    ] satisfies (keyof IBitcoinSecuritizationTerm)[],
  };

  public async recordFinalizedSecuritization(args: {
    ownerAccount: string;
    block: IBlockHeaderInfo;
    extrinsicIndex: number;
    lock: IBitcoinLock;
    origin: IBitcoinSecuritizationTerm['origin'];
  }): Promise<void> {
    const { ownerAccount, block, extrinsicIndex, lock, origin } = args;
    const published = await this.getPublishedSnapshot(ownerAccount);
    const terms = (published?.terms ?? []).map(term => ({ ...term }));
    const lockTerms = terms
      .filter(term => term.utxoId === lock.utxoId)
      .sort((left, right) => left.termIndex - right.termIndex);
    const existing = lockTerms.find(term => {
      return term.startBlockHash === block.blockHash && term.startExtrinsicIndex === extrinsicIndex;
    });
    const previous = existing ? lockTerms[lockTerms.indexOf(existing) - 1] : lockTerms.at(-1);
    const cumulativeNetSecurityFee = bigIntMax(lock.securityFees - lock.couponFeesPaid, 0n);
    const current: IBitcoinSecuritizationTerm = {
      utxoId: lock.utxoId,
      termIndex: existing?.termIndex ?? lockTerms.length,
      origin,
      startTick: block.tick,
      startBlockNumber: block.blockNumber,
      startBlockHash: block.blockHash,
      startExtrinsicIndex: extrinsicIndex,
      securitizedSatoshis: lock.securitizedSatoshis,
      securitizationCoverageMicrogons: lock.securitizationCoverageMicrogons,
      cumulativeNetSecurityFee,
      addedNetSecurityFee: bigIntMax(cumulativeNetSecurityFee - (previous?.cumulativeNetSecurityFee ?? 0n), 0n),
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
          endReason: 'resecuritized' as const,
        });
      }
      terms.push(current);
    }

    const snapshot = await this.createSnapshot(
      ownerAccount,
      Math.max(published?.asOfBlock ?? 0, block.blockNumber),
      terms.sort((left, right) => left.utxoId - right.utxoId || left.termIndex - right.termIndex),
    );
    await this.publishSnapshot(snapshot);
  }

  public async createSnapshot(
    ownerAccount: string,
    asOfBlock: number,
    terms: readonly IBitcoinSecuritizationTerm[],
  ): Promise<IBitcoinSecuritizationHistorySnapshot> {
    const basePublication = await this.db.financialCacheTable.get(
      FinancialCacheTypes.BitcoinSecuritizationHistory,
      ownerAccount,
    );
    const snapshotId = crypto.randomUUID();

    for (const term of terms) {
      await this.db.execute(
        `INSERT INTO BitcoinSecuritizationHistory (
           ownerAccount,
           snapshotId,
           utxoId,
           termIndex,
           origin,
           startTick,
           startBlockNumber,
           startBlockHash,
           startExtrinsicIndex,
           securitizedSatoshis,
           securitizationCoverageMicrogons,
           cumulativeNetSecurityFee,
           addedNetSecurityFee,
           endTick,
           endBlockNumber,
           endBlockHash,
           endExtrinsicIndex,
           endReason
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        toSqlParams([
          ownerAccount,
          snapshotId,
          term.utxoId,
          term.termIndex,
          term.origin,
          term.startTick,
          term.startBlockNumber,
          term.startBlockHash,
          term.startExtrinsicIndex,
          term.securitizedSatoshis,
          term.securitizationCoverageMicrogons,
          term.cumulativeNetSecurityFee,
          term.addedNetSecurityFee,
          term.endTick,
          term.endBlockNumber,
          term.endBlockHash,
          term.endExtrinsicIndex,
          term.endReason,
        ]),
      );
    }

    return { ownerAccount, snapshotId, asOfBlock, basePublication };
  }

  public async publishSnapshot(snapshot: IBitcoinSecuritizationHistorySnapshot): Promise<void> {
    const { ownerAccount, snapshotId, asOfBlock, basePublication } = snapshot;
    if (basePublication && asOfBlock < basePublication.asOfBlock) {
      throw new Error(`Cannot publish Bitcoin history because newer securitization history is already visible`);
    }

    let rowsAffected: number;
    if (!basePublication) {
      const result = await this.db.execute(
        `INSERT OR IGNORE INTO FinancialCache (type, scope, state)
         VALUES (?, ?, ?)`,
        toSqlParams([FinancialCacheTypes.BitcoinSecuritizationHistory, ownerAccount, { snapshotId, asOfBlock }]),
      );
      rowsAffected = result.rowsAffected;
    } else {
      const result = await this.db.execute(
        `UPDATE FinancialCache
         SET state = ?, updatedAt = CURRENT_TIMESTAMP
         WHERE type = ? AND scope = ? AND state = ?`,
        toSqlParams([
          { snapshotId, asOfBlock },
          FinancialCacheTypes.BitcoinSecuritizationHistory,
          ownerAccount,
          basePublication,
        ]),
      );
      rowsAffected = result.rowsAffected;
    }

    if (rowsAffected !== 1) {
      throw new Error(`Cannot publish Bitcoin history because newer securitization history is already visible`);
    }
  }

  public async getPublishedSnapshot(ownerAccount: string): Promise<IBitcoinPublishedSecuritizationHistory | undefined> {
    const publication = await this.db.financialCacheTable.get(
      FinancialCacheTypes.BitcoinSecuritizationHistory,
      ownerAccount,
    );
    if (!publication) return;

    const terms = await this.db.select<IBitcoinSecuritizationTerm[]>(
      `SELECT
         utxoId,
         termIndex,
         origin,
         startTick,
         startBlockNumber,
         startBlockHash,
         startExtrinsicIndex,
         securitizedSatoshis,
         securitizationCoverageMicrogons,
         cumulativeNetSecurityFee,
         addedNetSecurityFee,
         endTick,
         endBlockNumber,
         endBlockHash,
         endExtrinsicIndex,
         endReason
       FROM BitcoinSecuritizationHistory
       WHERE ownerAccount = ? AND snapshotId = ?
       ORDER BY utxoId, termIndex`,
      toSqlParams([ownerAccount, publication.snapshotId]),
    );
    return {
      asOfBlock: publication.asOfBlock,
      terms: convertFromSqliteFields(terms, this.fieldTypes),
    };
  }
}
