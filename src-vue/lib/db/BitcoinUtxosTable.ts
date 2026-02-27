import { BaseTable, IFieldTypes } from './BaseTable';
import { convertFromSqliteFields, toSqlParams } from '../Utils.ts';
import dayjs from 'dayjs';
import utc from 'dayjs/plugin/utc.js';
dayjs.extend(utc);

export interface IMempoolFundingObservation {
  isConfirmed: boolean;
  confirmations: number;
  satoshis: bigint;
  txid?: string;
  vout?: number;
  transactionBlockHeight: number;
  transactionBlockTime: number;
  argonBitcoinHeight: number;
}

export enum BitcoinUtxoStatus {
  SeenOnMempool = 'SeenOnMempool', // Found on Bitcoin mempool, but not yet an Argon funding candidate.
  FundingCandidate = 'FundingCandidate', // Candidate funding UTXO seen by Argon for this lock (pre-acceptance).
  FundingUtxo = 'FundingUtxo', // Accepted funding UTXO backing this lock.
  ReleaseIsProcessingOnArgon = 'ReleaseIsProcessingOnArgon', // Release request submitted to Argon and still in pre-Bitcoin finalization phases.
  ReleaseIsProcessingOnBitcoin = 'ReleaseIsProcessingOnBitcoin', // Release transaction was observed on Bitcoin and is being confirmed.
  ReleaseComplete = 'ReleaseComplete', // Release is fully complete.
}

export interface IBitcoinUtxoRecord {
  id: number;
  lockUtxoId: number;
  txid: string;
  vout: number;
  satoshis: bigint;
  network: string;
  status: BitcoinUtxoStatus;
  statusError?: string;
  mempoolObservation?: IMempoolFundingObservation;
  firstSeenAt: Date;
  firstSeenOnArgonAt?: Date;
  firstSeenBitcoinHeight: number;
  firstSeenOracleHeight?: number;
  lastConfirmationCheckAt?: Date;
  lastConfirmationCheckOracleHeight?: number;
  requestedReleaseAtTick?: number;
  releaseBitcoinNetworkFee?: bigint;
  releaseToDestinationAddress?: string;
  releaseCosignVaultSignature?: Uint8Array;
  releaseCosignHeight?: number;
  releaseTxid?: string;
  releaseFirstSeenAt?: Date;
  releaseFirstSeenBitcoinHeight?: number;
  releaseFirstSeenOracleHeight?: number;
  releaseLastConfirmationCheckAt?: Date;
  releaseLastConfirmationCheckOracleHeight?: number;
  releasedAtBitcoinHeight?: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface IBitcoinUtxoStatusHistoryRecord {
  id: number;
  utxoRecordId: number;
  newStatus: BitcoinUtxoStatus;
  createdAt: Date;
}

export class BitcoinUtxosTable extends BaseTable {
  private fieldTypes: IFieldTypes = {
    bigint: ['satoshis', 'releaseBitcoinNetworkFee'],
    json: ['mempoolObservation'],
    uint8array: ['releaseCosignVaultSignature'],
    date: [
      'firstSeenAt',
      'firstSeenOnArgonAt',
      'lastConfirmationCheckAt',
      'releaseFirstSeenAt',
      'releaseLastConfirmationCheckAt',
      'createdAt',
      'updatedAt',
    ],
  };

  public async fetchAll(): Promise<IBitcoinUtxoRecord[]> {
    const rawRecords = await this.db.select<IBitcoinUtxoRecord[]>(
      'SELECT * FROM BitcoinUtxos ORDER BY createdAt DESC',
      [],
    );
    return convertFromSqliteFields<IBitcoinUtxoRecord[]>(rawRecords, this.fieldTypes);
  }

  public async fetchStatusHistory(utxoRecordId: number): Promise<IBitcoinUtxoStatusHistoryRecord[]> {
    const rawRecords = await this.db.select<IBitcoinUtxoStatusHistoryRecord[]>(
      `SELECT id, utxoRecordId, newStatus, createdAt
       FROM BitcoinUtxoStatusHistory
       WHERE utxoRecordId = ?
       ORDER BY createdAt ASC, id ASC`,
      toSqlParams([utxoRecordId]),
    );
    return convertFromSqliteFields<IBitcoinUtxoStatusHistoryRecord[]>(rawRecords, { date: ['createdAt'] });
  }

  public async getByLockOutpoint(
    lockUtxoId: number,
    txid: string,
    vout: number,
  ): Promise<IBitcoinUtxoRecord | undefined> {
    const rawRecords = await this.db.select<IBitcoinUtxoRecord[]>(
      'SELECT * FROM BitcoinUtxos WHERE lockUtxoId = ? AND txid = ? AND vout = ? LIMIT 1',
      toSqlParams([lockUtxoId, txid, vout]),
    );
    if (!rawRecords.length) return undefined;
    return convertFromSqliteFields<IBitcoinUtxoRecord[]>(rawRecords, this.fieldTypes)[0];
  }

  public async insert(record: Omit<IBitcoinUtxoRecord, 'id' | 'createdAt' | 'updatedAt'>): Promise<IBitcoinUtxoRecord> {
    const rawRecords = await this.db.select<IBitcoinUtxoRecord[]>(
      `INSERT INTO BitcoinUtxos (
        lockUtxoId,
        txid,
        vout,
        satoshis,
        network,
        status,
        statusError,
        mempoolObservation,
        firstSeenAt,
        firstSeenOnArgonAt,
        firstSeenBitcoinHeight,
        firstSeenOracleHeight,
        lastConfirmationCheckAt,
        lastConfirmationCheckOracleHeight,
        requestedReleaseAtTick,
        releaseBitcoinNetworkFee,
        releaseToDestinationAddress,
        releaseCosignVaultSignature,
        releaseCosignHeight,
        releaseTxid,
        releaseFirstSeenAt,
        releaseFirstSeenBitcoinHeight,
        releaseFirstSeenOracleHeight,
        releaseLastConfirmationCheckAt,
        releaseLastConfirmationCheckOracleHeight,
        releasedAtBitcoinHeight
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(lockUtxoId, txid, vout) DO UPDATE SET
        satoshis = COALESCE(excluded.satoshis, BitcoinUtxos.satoshis),
        mempoolObservation = COALESCE(excluded.mempoolObservation, BitcoinUtxos.mempoolObservation),
        firstSeenOnArgonAt = COALESCE(BitcoinUtxos.firstSeenOnArgonAt, excluded.firstSeenOnArgonAt),
        status = COALESCE(excluded.status, BitcoinUtxos.status),
        requestedReleaseAtTick = COALESCE(excluded.requestedReleaseAtTick, BitcoinUtxos.requestedReleaseAtTick),
        releaseBitcoinNetworkFee = COALESCE(excluded.releaseBitcoinNetworkFee, BitcoinUtxos.releaseBitcoinNetworkFee),
        releaseToDestinationAddress = COALESCE(excluded.releaseToDestinationAddress, BitcoinUtxos.releaseToDestinationAddress),
        releaseCosignVaultSignature = COALESCE(excluded.releaseCosignVaultSignature, BitcoinUtxos.releaseCosignVaultSignature),
        releaseCosignHeight = COALESCE(excluded.releaseCosignHeight, BitcoinUtxos.releaseCosignHeight),
        releaseTxid = COALESCE(excluded.releaseTxid, BitcoinUtxos.releaseTxid),
        releasedAtBitcoinHeight = COALESCE(excluded.releasedAtBitcoinHeight, BitcoinUtxos.releasedAtBitcoinHeight),
        statusError = COALESCE(excluded.statusError, BitcoinUtxos.statusError),
        network = excluded.network
      RETURNING *`,
      toSqlParams([
        record.lockUtxoId,
        record.txid,
        record.vout,
        record.satoshis,
        record.network,
        record.status,
        record.statusError,
        record.mempoolObservation,
        record.firstSeenAt,
        record.firstSeenOnArgonAt,
        record.firstSeenBitcoinHeight,
        record.firstSeenOracleHeight,
        record.lastConfirmationCheckAt,
        record.lastConfirmationCheckOracleHeight,
        record.requestedReleaseAtTick,
        record.releaseBitcoinNetworkFee,
        record.releaseToDestinationAddress,
        record.releaseCosignVaultSignature,
        record.releaseCosignHeight,
        record.releaseTxid,
        record.releaseFirstSeenAt,
        record.releaseFirstSeenBitcoinHeight,
        record.releaseFirstSeenOracleHeight,
        record.releaseLastConfirmationCheckAt,
        record.releaseLastConfirmationCheckOracleHeight,
        record.releasedAtBitcoinHeight,
      ]),
    );

    if (!rawRecords.length) {
      throw new Error('Failed to insert Bitcoin UTXO record');
    }
    return convertFromSqliteFields<IBitcoinUtxoRecord[]>(rawRecords, this.fieldTypes)[0];
  }

  public async updateMempoolObservation(
    record: IBitcoinUtxoRecord,
    mempoolObservation: IMempoolFundingObservation,
    oracleBitcoinBlockHeight: number,
  ): Promise<void> {
    const hadMempoolObservation = !!record.mempoolObservation;
    record.mempoolObservation = mempoolObservation;
    if (!hadMempoolObservation && record.firstSeenBitcoinHeight <= 0) {
      record.firstSeenAt = dayjs.utc().toDate();
    }
    record.firstSeenBitcoinHeight = mempoolObservation.transactionBlockHeight;
    record.firstSeenOracleHeight ??= oracleBitcoinBlockHeight;
    await this.db.execute(
      `UPDATE BitcoinUtxos SET
        status = ?,
        mempoolObservation = ?,
        firstSeenAt = ?,
        firstSeenBitcoinHeight = ?,
        firstSeenOracleHeight = ?
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

  public async setArgonCandidateSeen(record: IBitcoinUtxoRecord): Promise<void> {
    record.status = BitcoinUtxoStatus.FundingCandidate;
    record.firstSeenOnArgonAt ??= dayjs.utc().toDate();
    await this.db.execute(
      `UPDATE BitcoinUtxos SET status = ?, firstSeenOnArgonAt = ? WHERE id = ?`,
      toSqlParams([record.status, record.firstSeenOnArgonAt, record.id]),
    );
  }

  public async updateCandidate(record: IBitcoinUtxoRecord): Promise<void> {
    await this.db.execute(
      `UPDATE BitcoinUtxos SET
        status = ?,
        satoshis = ?,
        firstSeenOnArgonAt = ?
      WHERE id = ?`,
      toSqlParams([record.status, record.satoshis, record.firstSeenOnArgonAt, record.id]),
    );
  }

  public async updateLastConfirmationCheck(record: IBitcoinUtxoRecord): Promise<void> {
    await this.db.execute(
      `UPDATE BitcoinUtxos SET
        lastConfirmationCheckAt = ?,
        lastConfirmationCheckOracleHeight = ?
      WHERE id = ?`,
      toSqlParams([record.lastConfirmationCheckAt, record.lastConfirmationCheckOracleHeight, record.id]),
    );
  }

  public async setReleaseRequest(
    record: IBitcoinUtxoRecord,
    args: { requestedReleaseAtTick: number; releaseToDestinationAddress: string; releaseBitcoinNetworkFee: bigint },
  ): Promise<void> {
    record.requestedReleaseAtTick = args.requestedReleaseAtTick;
    record.releaseToDestinationAddress = args.releaseToDestinationAddress;
    record.releaseBitcoinNetworkFee = args.releaseBitcoinNetworkFee;
    record.statusError = undefined;
    if (record.status !== BitcoinUtxoStatus.ReleaseIsProcessingOnBitcoin) {
      record.status = BitcoinUtxoStatus.ReleaseIsProcessingOnArgon;
    }
    await this.db.execute(
      `UPDATE BitcoinUtxos SET
        status = ?,
        statusError = NULL,
        requestedReleaseAtTick = ?,
        releaseToDestinationAddress = ?,
        releaseBitcoinNetworkFee = ?
      WHERE id = ?`,
      toSqlParams([
        record.status,
        record.requestedReleaseAtTick,
        record.releaseToDestinationAddress,
        record.releaseBitcoinNetworkFee,
        record.id,
      ]),
    );
  }

  public async setReleaseSeenOnBitcoin(
    record: IBitcoinUtxoRecord,
    releaseTxid: string,
    mempoolBitcoinBlockHeight: number,
    oracleBitcoinBlockHeight: number,
  ): Promise<void> {
    if (record.status !== BitcoinUtxoStatus.ReleaseComplete) {
      record.status = BitcoinUtxoStatus.ReleaseIsProcessingOnBitcoin;
    }
    record.releaseTxid = releaseTxid;
    record.releaseFirstSeenAt ??= dayjs.utc().toDate();
    record.releaseFirstSeenBitcoinHeight ??= mempoolBitcoinBlockHeight;
    record.releaseFirstSeenOracleHeight ??= oracleBitcoinBlockHeight;
    record.statusError = undefined;
    await this.db.execute(
      `UPDATE BitcoinUtxos SET
        status = ?,
        statusError = NULL,
        releaseTxid = ?,
        releaseFirstSeenAt = ?,
        releaseFirstSeenBitcoinHeight = ?,
        releaseFirstSeenOracleHeight = ?
      WHERE id = ?`,
      toSqlParams([
        record.status,
        record.releaseTxid,
        record.releaseFirstSeenAt,
        record.releaseFirstSeenBitcoinHeight,
        record.releaseFirstSeenOracleHeight,
        record.id,
      ]),
    );
  }

  public async updateReleaseLastConfirmationCheck(record: IBitcoinUtxoRecord): Promise<void> {
    await this.db.execute(
      `UPDATE BitcoinUtxos SET
        releaseLastConfirmationCheckAt = ?,
        releaseLastConfirmationCheckOracleHeight = ?
      WHERE id = ?`,
      toSqlParams([record.releaseLastConfirmationCheckAt, record.releaseLastConfirmationCheckOracleHeight, record.id]),
    );
  }

  public async clearStatusError(record: IBitcoinUtxoRecord): Promise<void> {
    record.statusError = undefined;
    await this.db.execute(`UPDATE BitcoinUtxos SET statusError = NULL WHERE id = ?`, toSqlParams([record.id]));
  }

  public async setStatusError(record: IBitcoinUtxoRecord, error: string): Promise<void> {
    record.statusError = error;
    await this.db.execute(
      `UPDATE BitcoinUtxos SET statusError = ? WHERE id = ?`,
      toSqlParams([record.statusError, record.id]),
    );
  }

  public async clearFundingCandidateSignalsByLockUtxoId(lockUtxoId: number): Promise<void> {
    await this.db.execute(
      `UPDATE BitcoinUtxos
       SET mempoolObservation = NULL,
           firstSeenOnArgonAt = NULL,
           status = CASE
             WHEN status IN ('SeenOnMempool', 'FundingCandidate')
             THEN 'FundingCandidate'
             ELSE status
           END
       WHERE lockUtxoId = ?`,
      toSqlParams([lockUtxoId]),
    );
  }

  public async setReleaseIsProcessingOnArgon(
    record: IBitcoinUtxoRecord,
    args: {
      requestedReleaseAtTick?: number;
      releaseToDestinationAddress: string;
      releaseBitcoinNetworkFee: bigint;
      releaseCosignVaultSignature?: Uint8Array;
      releaseCosignHeight?: number;
    },
  ): Promise<void> {
    record.status = BitcoinUtxoStatus.ReleaseIsProcessingOnArgon;
    if (args.requestedReleaseAtTick !== undefined) record.requestedReleaseAtTick = args.requestedReleaseAtTick;
    record.releaseToDestinationAddress = args.releaseToDestinationAddress;
    record.releaseBitcoinNetworkFee = args.releaseBitcoinNetworkFee;
    if (args.releaseCosignVaultSignature) {
      record.releaseCosignVaultSignature = args.releaseCosignVaultSignature;
    }
    if (args.releaseCosignHeight !== undefined) {
      record.releaseCosignHeight = args.releaseCosignHeight;
    }
    record.statusError = undefined;
    await this.db.execute(
      `UPDATE BitcoinUtxos
       SET status = ?,
           requestedReleaseAtTick = ?,
           releaseToDestinationAddress = ?,
           releaseBitcoinNetworkFee = ?,
           releaseCosignVaultSignature = ?,
           releaseCosignHeight = ?,
           statusError = NULL
       WHERE id = ?`,
      toSqlParams([
        record.status,
        record.requestedReleaseAtTick,
        record.releaseToDestinationAddress,
        record.releaseBitcoinNetworkFee,
        record.releaseCosignVaultSignature,
        record.releaseCosignHeight,
        record.id,
      ]),
    );
  }

  public async setReleaseCosign(
    record: IBitcoinUtxoRecord,
    args: { releaseCosignVaultSignature: Uint8Array; releaseCosignHeight?: number },
  ): Promise<void> {
    record.releaseCosignVaultSignature = args.releaseCosignVaultSignature;
    if (args.releaseCosignHeight !== undefined) {
      record.releaseCosignHeight = args.releaseCosignHeight;
    }
    await this.db.execute(
      `UPDATE BitcoinUtxos
       SET releaseCosignVaultSignature = ?,
           releaseCosignHeight = ?
       WHERE id = ?`,
      toSqlParams([record.releaseCosignVaultSignature, record.releaseCosignHeight, record.id]),
    );
  }

  public async setReleaseIsProcessingOnBitcoin(record: IBitcoinUtxoRecord): Promise<void> {
    record.status = BitcoinUtxoStatus.ReleaseIsProcessingOnBitcoin;
    await this.db.execute(`UPDATE BitcoinUtxos SET status = ? WHERE id = ?`, toSqlParams([record.status, record.id]));
  }

  public async setReleaseComplete(record: IBitcoinUtxoRecord, releasedAtBitcoinHeight?: number): Promise<void> {
    record.status = BitcoinUtxoStatus.ReleaseComplete;
    record.statusError = undefined;
    if (releasedAtBitcoinHeight !== undefined) {
      record.releasedAtBitcoinHeight = releasedAtBitcoinHeight;
    }
    await this.db.execute(
      `UPDATE BitcoinUtxos SET status = ?, statusError = NULL, releasedAtBitcoinHeight = ? WHERE id = ?`,
      toSqlParams([record.status, record.releasedAtBitcoinHeight, record.id]),
    );
  }

  public async setFundingUtxo(record: IBitcoinUtxoRecord): Promise<void> {
    record.status = BitcoinUtxoStatus.FundingUtxo;
    record.firstSeenOnArgonAt ??= dayjs.utc().toDate();
    await this.db.execute(
      `UPDATE BitcoinUtxos
       SET status = ?,
           firstSeenOnArgonAt = COALESCE(firstSeenOnArgonAt, ?)
       WHERE id = ?`,
      toSqlParams([record.status, record.firstSeenOnArgonAt, record.id]),
    );
  }
}
