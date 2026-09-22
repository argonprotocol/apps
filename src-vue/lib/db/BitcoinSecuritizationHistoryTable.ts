import { JsonExt } from '@argonprotocol/apps-core';
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

  public async createSnapshot(
    ownerAccount: string,
    asOfBlock: number,
    terms: readonly IBitcoinSecuritizationTerm[],
  ): Promise<IBitcoinSecuritizationHistorySnapshot> {
    const basePublication = await this.db.financialCacheTable.get(
      FinancialCacheTypes.BitcoinSecuritizationHistory,
      ownerAccount,
    );
    if (basePublication) {
      const publishedTerms = await this.getSnapshotTerms(ownerAccount, basePublication.snapshotId);
      if (JsonExt.stringify(publishedTerms) === JsonExt.stringify(terms)) {
        return { ownerAccount, snapshotId: basePublication.snapshotId, asOfBlock, basePublication };
      }
    }
    const snapshotId = crypto.randomUUID();

    for (const term of terms) {
      await this.db.execute(
        `INSERT INTO BitcoinSecuritizationHistory (
           ownerAccount,
           snapshotId,
           lockId,
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
          term.lockId,
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

    await this.db.execute(
      `DELETE FROM BitcoinSecuritizationHistory
       WHERE ownerAccount = ? AND snapshotId <> ?`,
      toSqlParams([ownerAccount, snapshotId]),
    );
  }

  public async getPublishedSnapshot(ownerAccount: string): Promise<IBitcoinPublishedSecuritizationHistory | undefined> {
    const publication = await this.db.financialCacheTable.get(
      FinancialCacheTypes.BitcoinSecuritizationHistory,
      ownerAccount,
    );
    if (!publication) return;

    return {
      asOfBlock: publication.asOfBlock,
      terms: await this.getSnapshotTerms(ownerAccount, publication.snapshotId),
    };
  }

  private async getSnapshotTerms(ownerAccount: string, snapshotId: string): Promise<IBitcoinSecuritizationTerm[]> {
    const terms = await this.db.select<IBitcoinSecuritizationTerm[]>(
      `SELECT
         lockId,
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
       ORDER BY lockId, termIndex`,
      toSqlParams([ownerAccount, snapshotId]),
    );
    return convertFromSqliteFields(terms, this.fieldTypes);
  }
}
