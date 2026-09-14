import { hexToU8a } from '@argonprotocol/mainchain';
import { nanoid } from 'nanoid';
import { BaseTable, type IFieldTypes } from './BaseTable.ts';
import { convertFromSqliteFields, toSqlParams } from '../Utils.ts';
import {
  type IBitcoinReleaseRecord,
  BitcoinReleaseKind,
  BitcoinReleaseStatus,
} from '../../interfaces/IBitcoinReleaseRecord.ts';

export {
  type IBitcoinReleaseRecord,
  BitcoinReleaseKind,
  BitcoinReleaseStatus,
} from '../../interfaces/IBitcoinReleaseRecord.ts';

type IBitcoinReleaseRow = Omit<IBitcoinReleaseRecord, 'vaultSignatures'> & {
  vaultSignatures: Array<Uint8Array | string>;
};

export class BitcoinReleasesTable extends BaseTable {
  private readonly fieldTypes: IFieldTypes = {
    bigint: ['bitcoinNetworkFee', 'insuredMicrogons', 'argonTxFeeMicrogons', 'compensationMicrogons'],
    json: ['inputUtxoIds', 'vaultSignatures'],
    date: [
      'bitcoinFirstSeenAt',
      'bitcoinLastConfirmationCheckAt',
      'argonCompletionBlockTime',
      'createdAt',
      'updatedAt',
    ],
  };

  public static createId(): string {
    return nanoid();
  }

  public async fetchAll(): Promise<IBitcoinReleaseRecord[]> {
    const records = await this.db.select<IBitcoinReleaseRow[]>('SELECT * FROM BitcoinReleases ORDER BY createdAt DESC');
    return records.map(record => this.toRecord(record));
  }

  public async getById(id: string): Promise<IBitcoinReleaseRecord | undefined> {
    const records = await this.db.select<IBitcoinReleaseRow[]>(
      'SELECT * FROM BitcoinReleases WHERE id = ?',
      toSqlParams([id]),
    );
    return records[0] ? this.toRecord(records[0]) : undefined;
  }

  public async insert(release: Omit<IBitcoinReleaseRecord, 'createdAt' | 'updatedAt'>): Promise<IBitcoinReleaseRecord> {
    const records = await this.db.select<IBitcoinReleaseRow[]>(
      `INSERT INTO BitcoinReleases (
        id, kind, lockId, status, inputUtxoIds, requestedReleaseAtTick,
        toScriptPubkey, bitcoinNetworkFee, insuredMicrogons, argonTxFeeMicrogons,
        compensationMicrogons, vaultSignatures, cosignBlockNumber, bitcoinTxid,
        bitcoinFirstSeenAt, bitcoinFirstSeenHeight, bitcoinFirstSeenOracleHeight,
        bitcoinLastConfirmationCheckAt, bitcoinLastConfirmationCheckOracleHeight,
        bitcoinConfirmedHeight, argonCompletionBlockNumber, argonCompletionBlockHash,
        argonCompletionBlockTime, argonCompletionExtrinsicIndex, statusError
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO NOTHING
      RETURNING *`,
      toSqlParams([
        release.id,
        release.kind,
        release.lockId,
        release.status,
        release.inputUtxoIds,
        release.requestedReleaseAtTick,
        release.toScriptPubkey,
        release.bitcoinNetworkFee,
        release.insuredMicrogons,
        release.argonTxFeeMicrogons,
        release.compensationMicrogons,
        release.vaultSignatures,
        release.cosignBlockNumber,
        release.bitcoinTxid,
        release.bitcoinFirstSeenAt,
        release.bitcoinFirstSeenHeight,
        release.bitcoinFirstSeenOracleHeight,
        release.bitcoinLastConfirmationCheckAt,
        release.bitcoinLastConfirmationCheckOracleHeight,
        release.bitcoinConfirmedHeight,
        release.argonCompletionBlockNumber,
        release.argonCompletionBlockHash,
        release.argonCompletionBlockTime,
        release.argonCompletionExtrinsicIndex,
        release.statusError,
      ]),
    );
    if (records[0]) return this.toRecord(records[0]);

    const existing = await this.getById(release.id);
    if (!existing || existing.kind !== release.kind || existing.lockId !== release.lockId) {
      throw new Error(`Bitcoin release ${release.id} already belongs to a different workflow`);
    }
    return existing;
  }

  public async update(
    release: IBitcoinReleaseRecord,
    patch: Partial<Omit<IBitcoinReleaseRecord, 'id' | 'kind' | 'lockId' | 'createdAt'>>,
  ): Promise<void> {
    Object.assign(release, patch);
    const records = await this.db.select<IBitcoinReleaseRow[]>(
      `UPDATE BitcoinReleases SET
        status = ?, inputUtxoIds = ?, requestedReleaseAtTick = ?, toScriptPubkey = ?,
        bitcoinNetworkFee = ?, insuredMicrogons = ?, argonTxFeeMicrogons = ?, compensationMicrogons = ?,
        vaultSignatures = ?, cosignBlockNumber = ?, bitcoinTxid = ?, bitcoinFirstSeenAt = ?,
        bitcoinFirstSeenHeight = ?, bitcoinFirstSeenOracleHeight = ?, bitcoinLastConfirmationCheckAt = ?,
        bitcoinLastConfirmationCheckOracleHeight = ?, bitcoinConfirmedHeight = ?,
        argonCompletionBlockNumber = ?, argonCompletionBlockHash = ?, argonCompletionBlockTime = ?,
        argonCompletionExtrinsicIndex = ?, statusError = ?, updatedAt = CURRENT_TIMESTAMP
       WHERE id = ? RETURNING *`,
      toSqlParams([
        release.status,
        release.inputUtxoIds,
        release.requestedReleaseAtTick,
        release.toScriptPubkey,
        release.bitcoinNetworkFee,
        release.insuredMicrogons,
        release.argonTxFeeMicrogons,
        release.compensationMicrogons,
        release.vaultSignatures,
        release.cosignBlockNumber,
        release.bitcoinTxid,
        release.bitcoinFirstSeenAt,
        release.bitcoinFirstSeenHeight,
        release.bitcoinFirstSeenOracleHeight,
        release.bitcoinLastConfirmationCheckAt,
        release.bitcoinLastConfirmationCheckOracleHeight,
        release.bitcoinConfirmedHeight,
        release.argonCompletionBlockNumber,
        release.argonCompletionBlockHash,
        release.argonCompletionBlockTime,
        release.argonCompletionExtrinsicIndex,
        release.statusError,
        release.id,
      ]),
    );
    if (!records[0]) throw new Error(`Bitcoin release ${release.id} does not exist`);
    Object.assign(release, this.toRecord(records[0]));
  }

  private toRecord(row: IBitcoinReleaseRow): IBitcoinReleaseRecord {
    const record = convertFromSqliteFields<IBitcoinReleaseRow>(row, this.fieldTypes);
    return {
      ...record,
      vaultSignatures: record.vaultSignatures.map(signature =>
        typeof signature === 'string' ? hexToU8a(signature) : signature,
      ),
    };
  }
}
