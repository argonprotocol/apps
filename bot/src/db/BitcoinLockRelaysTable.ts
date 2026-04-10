import type { SQLOutputValue } from 'node:sqlite';
import { convertFromSqliteFields, toSqliteParams } from '@argonprotocol/apps-core';
import type { IBitcoinLockRelayRecord } from '@argonprotocol/apps-core';
import type { Db } from '../Db.ts';
import { BaseTable } from './BaseTable.ts';

type SqlRelayRow = Record<string, SQLOutputValue>;

export class BitcoinLockRelaysTable extends BaseTable {
  constructor(db: Db) {
    super(db);
  }

  public insertRelay(relay: {
    couponId: number;
    requestedSatoshis: bigint;
    securitizationUsedMicrogons: bigint;
    ownerAccountId: string;
    ownerBitcoinPubkey: string;
    microgonsPerBtc: bigint;
    delegateAddress: string;
    extrinsicHash: string;
    extrinsicMethodJson: any;
    txNonce: number;
    txSubmittedAtBlockHeight: number;
    txSubmittedAtTime: Date;
    txExpiresAtBlockHeight: number;
  }): IBitcoinLockRelayRecord {
    const record = this.db.sql
      .prepare(
        `
        INSERT INTO BitcoinLockRelays (
          couponId,
          status,
          requestedSatoshis,
          securitizationUsedMicrogons,
          ownerAccountId,
          ownerBitcoinPubkey,
          microgonsPerBtc,
          delegateAddress,
          extrinsicHash,
          extrinsicMethodJson,
          txNonce,
          txSubmittedAtBlockHeight,
          txSubmittedAtTime,
          txExpiresAtBlockHeight
        ) VALUES (
          $couponId,
          'Submitted',
          $requestedSatoshis,
          $securitizationUsedMicrogons,
          $ownerAccountId,
          $ownerBitcoinPubkey,
          $microgonsPerBtc,
          $delegateAddress,
          $extrinsicHash,
          $extrinsicMethodJson,
          $txNonce,
          $txSubmittedAtBlockHeight,
          $txSubmittedAtTime,
          $txExpiresAtBlockHeight
        )
        RETURNING *
      `,
      )
      .get(toSqliteParams(relay)) as SqlRelayRow;

    return this.mapRelay(record);
  }

  public fetchById(id: number): IBitcoinLockRelayRecord | null {
    const record = this.db.sql
      .prepare(
        `
        SELECT *
        FROM BitcoinLockRelays
        WHERE id = $id
        LIMIT 1
      `,
      )
      .get({ $id: id }) as SqlRelayRow | undefined;

    return record ? this.mapRelay(record) : null;
  }

  public fetchByCouponId(couponId: number): IBitcoinLockRelayRecord | null {
    const record = this.db.sql
      .prepare(
        `
        SELECT *
        FROM BitcoinLockRelays
        WHERE couponId = $couponId
        LIMIT 1
      `,
      )
      .get({ $couponId: couponId }) as SqlRelayRow | undefined;

    return record ? this.mapRelay(record) : null;
  }

  public fetchNonTerminal(): IBitcoinLockRelayRecord[] {
    return (
      this.db.sql
        .prepare(
          `
        SELECT *
        FROM BitcoinLockRelays
        WHERE status IN ('Submitted', 'InBlock')
        ORDER BY id ASC
      `,
        )
        .all() as SqlRelayRow[]
    ).map(record => this.mapRelay(record));
  }

  public fetchAll(): IBitcoinLockRelayRecord[] {
    return (
      this.db.sql
        .prepare(
          `
        SELECT *
        FROM BitcoinLockRelays
        ORDER BY id ASC
      `,
        )
        .all() as SqlRelayRow[]
    ).map(record => this.mapRelay(record));
  }

  public setInBlock(
    id: number,
    fields: {
      txInBlockHeight: number;
      txInBlockHash: string;
      txFeePlusTip: bigint;
      txTip: bigint;
      utxoId?: number | null;
    },
  ): IBitcoinLockRelayRecord {
    return this.updateRecord(
      id,
      `
        UPDATE BitcoinLockRelays
        SET
          status = 'InBlock',
          txInBlockHeight = $txInBlockHeight,
          txInBlockHash = $txInBlockHash,
          txFeePlusTip = $txFeePlusTip,
          txTip = $txTip,
          utxoId = $utxoId,
          updatedAt = CURRENT_TIMESTAMP
        WHERE id = $id
        RETURNING *
      `,
      fields,
    );
  }

  public revertToSubmitted(id: number): IBitcoinLockRelayRecord {
    return this.updateRecord(
      id,
      `
        UPDATE BitcoinLockRelays
        SET
          status = 'Submitted',
          txInBlockHeight = NULL,
          txInBlockHash = NULL,
          txFeePlusTip = NULL,
          txTip = NULL,
          utxoId = NULL,
          updatedAt = CURRENT_TIMESTAMP
        WHERE id = $id
        RETURNING *
      `,
    );
  }

  public setFinalized(id: number, txFinalizedHeight: number): IBitcoinLockRelayRecord {
    return this.updateRecord(
      id,
      `
        UPDATE BitcoinLockRelays
        SET
          status = 'Finalized',
          txFinalizedHeight = $txFinalizedHeight,
          updatedAt = CURRENT_TIMESTAMP
        WHERE id = $id
        RETURNING *
      `,
      { txFinalizedHeight },
    );
  }

  public setFailed(
    id: number,
    error: string,
    fields?: {
      txInBlockHeight?: number | null;
      txInBlockHash?: string | null;
      txFeePlusTip?: bigint | null;
      txTip?: bigint | null;
      utxoId?: number | null;
    },
  ): IBitcoinLockRelayRecord {
    return this.updateRecord(
      id,
      `
        UPDATE BitcoinLockRelays
        SET
          status = 'Failed',
          error = $error,
          txInBlockHeight = $txInBlockHeight,
          txInBlockHash = $txInBlockHash,
          txFeePlusTip = $txFeePlusTip,
          txTip = $txTip,
          utxoId = $utxoId,
          updatedAt = CURRENT_TIMESTAMP
        WHERE id = $id
        RETURNING *
      `,
      {
        error,
        txInBlockHeight: fields?.txInBlockHeight ?? null,
        txInBlockHash: fields?.txInBlockHash ?? null,
        txFeePlusTip: fields?.txFeePlusTip ?? null,
        txTip: fields?.txTip ?? null,
        utxoId: fields?.utxoId ?? null,
      },
    );
  }

  private updateRecord(id: number, sql: string, fields?: Record<string, unknown>): IBitcoinLockRelayRecord {
    const record = this.db.sql.prepare(sql).get(
      toSqliteParams({
        id,
        ...fields,
      }),
    ) as SqlRelayRow | undefined;

    if (!record) {
      throw new Error(`Bitcoin lock relay ${id} not found after update.`);
    }
    return this.mapRelay(record);
  }

  private mapRelay(record: SqlRelayRow): IBitcoinLockRelayRecord {
    return convertFromSqliteFields<IBitcoinLockRelayRecord>(record, {
      bigint: ['requestedSatoshis', 'securitizationUsedMicrogons', 'microgonsPerBtc', 'txFeePlusTip', 'txTip'],
      json: ['extrinsicMethodJson'],
      date: ['txSubmittedAtTime', 'createdAt', 'updatedAt'],
    });
  }
}
