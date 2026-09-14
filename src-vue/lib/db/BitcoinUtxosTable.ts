import dayjs from 'dayjs';
import utc from 'dayjs/plugin/utc.js';
import { BaseTable, type IFieldTypes } from './BaseTable.ts';
import { convertFromSqliteFields, toSqlParams } from '../Utils.ts';
import {
  BitcoinUtxoSpendStatus,
  BitcoinUtxoStatus,
  type IBitcoinUtxoRecord,
  type IBitcoinUtxoStatusHistoryRecord,
  type IMempoolFundingObservation,
} from '../../interfaces/IBitcoinUtxoRecord.ts';

dayjs.extend(utc);

export {
  BitcoinUtxoSpendStatus,
  BitcoinUtxoStatus,
  type IBitcoinUtxoRecord,
  type IBitcoinUtxoStatusHistoryRecord,
  type IMempoolFundingObservation,
} from '../../interfaces/IBitcoinUtxoRecord.ts';

export class BitcoinUtxosTable extends BaseTable {
  private readonly fieldTypes: IFieldTypes = {
    bigint: ['satoshis'],
    json: ['mempoolObservation'],
    date: ['firstSeenAt', 'firstSeenOnArgonAt', 'lastConfirmationCheckAt', 'createdAt', 'updatedAt'],
  };

  public async fetchAll(): Promise<IBitcoinUtxoRecord[]> {
    const records = await this.db.select<IBitcoinUtxoRecord[]>('SELECT * FROM BitcoinUtxos ORDER BY createdAt DESC');
    return records.map(record => this.toRecord(record));
  }

  public async fetchByLockId(lockId: number): Promise<IBitcoinUtxoRecord[]> {
    const records = await this.db.select<IBitcoinUtxoRecord[]>(
      'SELECT * FROM BitcoinUtxos WHERE lockId = ? ORDER BY createdAt DESC',
      toSqlParams([lockId]),
    );
    return records.map(record => this.toRecord(record));
  }

  public async fetchStatusHistory(utxoRecordId: number): Promise<IBitcoinUtxoStatusHistoryRecord[]> {
    const records = await this.db.select<IBitcoinUtxoStatusHistoryRecord[]>(
      `SELECT id, utxoRecordId, newStatus, createdAt
       FROM BitcoinUtxoStatusHistory
       WHERE utxoRecordId = ?
       ORDER BY createdAt ASC, id ASC`,
      toSqlParams([utxoRecordId]),
    );
    return convertFromSqliteFields(records, { date: ['createdAt'] });
  }

  public async getByLockOutpoint(lockId: number, txid: string, vout: number): Promise<IBitcoinUtxoRecord | undefined> {
    const records = await this.db.select<IBitcoinUtxoRecord[]>(
      'SELECT * FROM BitcoinUtxos WHERE lockId = ? AND txid = ? AND vout = ? LIMIT 1',
      toSqlParams([lockId, txid, vout]),
    );
    return records[0] ? this.toRecord(records[0]) : undefined;
  }

  public async insert(record: Omit<IBitcoinUtxoRecord, 'id' | 'createdAt' | 'updatedAt'>): Promise<IBitcoinUtxoRecord> {
    const records = await this.db.select<IBitcoinUtxoRecord[]>(
      `INSERT INTO BitcoinUtxos (
        lockId, txid, vout, satoshis, network, status, spendStatus,
        activeReleaseId, createdByReleaseId, spentByReleaseId, statusError,
        mempoolObservation, firstSeenAt, firstSeenOnArgonAt, firstSeenBitcoinHeight,
        firstSeenOracleHeight, lastConfirmationCheckAt, lastConfirmationCheckOracleHeight
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(lockId, txid, vout) DO UPDATE SET
        satoshis = excluded.satoshis,
        network = excluded.network,
        status = excluded.status,
        spendStatus = excluded.spendStatus,
        activeReleaseId = COALESCE(excluded.activeReleaseId, BitcoinUtxos.activeReleaseId),
        createdByReleaseId = COALESCE(excluded.createdByReleaseId, BitcoinUtxos.createdByReleaseId),
        spentByReleaseId = COALESCE(excluded.spentByReleaseId, BitcoinUtxos.spentByReleaseId),
        statusError = COALESCE(excluded.statusError, BitcoinUtxos.statusError),
        mempoolObservation = COALESCE(excluded.mempoolObservation, BitcoinUtxos.mempoolObservation),
        firstSeenOnArgonAt = COALESCE(BitcoinUtxos.firstSeenOnArgonAt, excluded.firstSeenOnArgonAt),
        firstSeenOracleHeight = COALESCE(BitcoinUtxos.firstSeenOracleHeight, excluded.firstSeenOracleHeight),
        lastConfirmationCheckAt = COALESCE(excluded.lastConfirmationCheckAt, BitcoinUtxos.lastConfirmationCheckAt),
        lastConfirmationCheckOracleHeight = COALESCE(
          excluded.lastConfirmationCheckOracleHeight,
          BitcoinUtxos.lastConfirmationCheckOracleHeight
        )
      RETURNING *`,
      toSqlParams([
        record.lockId,
        record.txid,
        record.vout,
        record.satoshis,
        record.network,
        record.status,
        record.spendStatus,
        record.activeReleaseId,
        record.createdByReleaseId,
        record.spentByReleaseId,
        record.statusError,
        record.mempoolObservation,
        record.firstSeenAt,
        record.firstSeenOnArgonAt,
        record.firstSeenBitcoinHeight,
        record.firstSeenOracleHeight,
        record.lastConfirmationCheckAt,
        record.lastConfirmationCheckOracleHeight,
      ]),
    );
    if (!records[0]) throw new Error('Failed to insert Bitcoin UTXO record');
    return this.toRecord(records[0]);
  }

  public async saveRecoveredHistory(record: IBitcoinUtxoRecord): Promise<void> {
    await this.db.execute(
      `UPDATE BitcoinUtxos SET
        satoshis = ?, network = ?, status = ?, spendStatus = ?,
        activeReleaseId = ?, createdByReleaseId = ?, spentByReleaseId = ?, statusError = ?,
        mempoolObservation = ?, firstSeenAt = ?, firstSeenOnArgonAt = ?, firstSeenBitcoinHeight = ?,
        firstSeenOracleHeight = ?, lastConfirmationCheckAt = ?, lastConfirmationCheckOracleHeight = ?
       WHERE id = ?`,
      toSqlParams([
        record.satoshis,
        record.network,
        record.status,
        record.spendStatus,
        record.activeReleaseId,
        record.createdByReleaseId,
        record.spentByReleaseId,
        record.statusError,
        record.mempoolObservation,
        record.firstSeenAt,
        record.firstSeenOnArgonAt,
        record.firstSeenBitcoinHeight,
        record.firstSeenOracleHeight,
        record.lastConfirmationCheckAt,
        record.lastConfirmationCheckOracleHeight,
        record.id,
      ]),
    );
  }

  public async updateMempoolObservation(
    record: IBitcoinUtxoRecord,
    mempoolObservation: IMempoolFundingObservation,
    oracleBitcoinBlockHeight: number,
  ): Promise<void> {
    const hadMempoolObservation = !!record.mempoolObservation;
    record.mempoolObservation = mempoolObservation;
    if (!(record.firstSeenAt instanceof Date) || Number.isNaN(record.firstSeenAt.getTime())) {
      record.firstSeenAt = dayjs.utc().toDate();
    }
    if (!hadMempoolObservation && record.firstSeenBitcoinHeight <= 0) record.firstSeenAt = dayjs.utc().toDate();
    record.firstSeenBitcoinHeight = mempoolObservation.transactionBlockHeight;
    if (mempoolObservation.isConfirmed && record.firstSeenOracleHeight == null) {
      record.firstSeenOracleHeight = oracleBitcoinBlockHeight;
    }
    await this.db.execute(
      `UPDATE BitcoinUtxos SET
        status = ?, mempoolObservation = ?, firstSeenAt = ?,
        firstSeenBitcoinHeight = ?, firstSeenOracleHeight = ?
       WHERE id = ?`,
      toSqlParams([
        record.status,
        record.mempoolObservation,
        record.firstSeenAt,
        record.firstSeenBitcoinHeight,
        record.firstSeenOracleHeight,
        record.id,
      ]),
    );
  }

  public async updateObservedDeposit(record: IBitcoinUtxoRecord): Promise<void> {
    await this.db.execute(
      'UPDATE BitcoinUtxos SET status = ?, satoshis = ?, firstSeenOnArgonAt = ? WHERE id = ?',
      toSqlParams([record.status, record.satoshis, record.firstSeenOnArgonAt, record.id]),
    );
  }

  public async setFundingUtxo(record: IBitcoinUtxoRecord): Promise<void> {
    record.status = BitcoinUtxoStatus.FundingUtxo;
    record.firstSeenOnArgonAt ??= dayjs.utc().toDate();
    await this.persistInboundStatus(record);
  }

  public async setOrphaned(record: IBitcoinUtxoRecord): Promise<void> {
    record.status = BitcoinUtxoStatus.Orphaned;
    record.firstSeenOnArgonAt ??= dayjs.utc().toDate();
    await this.persistInboundStatus(record);
  }

  public async setActiveRelease(record: IBitcoinUtxoRecord, releaseId?: string): Promise<void> {
    record.activeReleaseId = releaseId;
    await this.db.execute(
      'UPDATE BitcoinUtxos SET activeReleaseId = ? WHERE id = ?',
      toSqlParams([releaseId, record.id]),
    );
  }

  public async setSpent(record: IBitcoinUtxoRecord, releaseId: string): Promise<void> {
    record.spendStatus = BitcoinUtxoSpendStatus.Spent;
    record.activeReleaseId = undefined;
    record.spentByReleaseId = releaseId;
    await this.db.execute(
      'UPDATE BitcoinUtxos SET spendStatus = ?, activeReleaseId = NULL, spentByReleaseId = ? WHERE id = ?',
      toSqlParams([record.spendStatus, releaseId, record.id]),
    );
  }

  public async updateLastConfirmationCheck(record: IBitcoinUtxoRecord): Promise<void> {
    await this.db.execute(
      'UPDATE BitcoinUtxos SET lastConfirmationCheckAt = ?, lastConfirmationCheckOracleHeight = ? WHERE id = ?',
      toSqlParams([record.lastConfirmationCheckAt, record.lastConfirmationCheckOracleHeight, record.id]),
    );
  }

  public async clearStatusError(record: IBitcoinUtxoRecord): Promise<void> {
    record.statusError = undefined;
    await this.db.execute('UPDATE BitcoinUtxos SET statusError = NULL WHERE id = ?', toSqlParams([record.id]));
  }

  public async setStatusError(record: IBitcoinUtxoRecord, error: string): Promise<void> {
    record.statusError = error;
    await this.db.execute('UPDATE BitcoinUtxos SET statusError = ? WHERE id = ?', toSqlParams([error, record.id]));
  }

  private async persistInboundStatus(record: IBitcoinUtxoRecord): Promise<void> {
    await this.db.execute(
      `UPDATE BitcoinUtxos
       SET status = ?, firstSeenOnArgonAt = COALESCE(firstSeenOnArgonAt, ?)
       WHERE id = ?`,
      toSqlParams([record.status, record.firstSeenOnArgonAt, record.id]),
    );
  }

  private toRecord(record: IBitcoinUtxoRecord): IBitcoinUtxoRecord {
    const mapped = convertFromSqliteFields<IBitcoinUtxoRecord>(record, this.fieldTypes);
    return {
      ...mapped,
      activeReleaseId: mapped.activeReleaseId ?? undefined,
      createdByReleaseId: mapped.createdByReleaseId ?? undefined,
      spentByReleaseId: mapped.spentByReleaseId ?? undefined,
    };
  }
}
