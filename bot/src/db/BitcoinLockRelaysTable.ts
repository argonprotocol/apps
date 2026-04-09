import type { SQLInputValue, SQLOutputValue, StatementSync } from 'node:sqlite';
import type { BitcoinLockRelayStatus, IBitcoinLockRelayRecord } from '@argonprotocol/apps-core';
import { convertFromSqliteFields, toSqliteParams, toSqliteValue } from '@argonprotocol/apps-core';
import type { Db } from '../Db.ts';
import { BaseTable } from './BaseTable.ts';

export interface IBitcoinLockRelayInsert {
  status: BitcoinLockRelayStatus;
  offerCode: string;
  vaultId: number;
  maxSatoshis: bigint;
  expirationTick: number;
  requestedSatoshis: bigint;
  securitizationUsedMicrogons?: bigint;
  ownerAccountAddress: string;
  ownerBitcoinPubkey: string;
  microgonsPerBtc: bigint;
  delegateAddress?: string;
  extrinsicHash?: string;
  extrinsicMethodJson?: any;
  nonce?: number;
  submittedAtBlockHeight?: number;
  submittedAtTime?: Date;
  expiresAtBlockHeight?: number;
}

type IBitcoinLockRelayPatch = {
  status?: BitcoinLockRelayStatus;
  error?: string | null;
  delegateAddress?: string | null;
  extrinsicHash?: string | null;
  extrinsicMethodJson?: any;
  nonce?: number | null;
  submittedAtBlockHeight?: number | null;
  submittedAtTime?: Date | null;
  expiresAtBlockHeight?: number | null;
  inBlockHeight?: number | null;
  inBlockHash?: string | null;
  finalizedHeight?: number | null;
  txFeePlusTip?: bigint | null;
  txTip?: bigint | null;
  utxoId?: number | null;
  updatedAt?: Date | null;
};

type SqlRelayRow = Record<string, SQLOutputValue>;

export class BitcoinLockRelaysTable extends BaseTable {
  private readonly insertRelayStmt: StatementSync;
  private readonly getRelayByIdStmt: StatementSync;
  private readonly getRelayByOfferCodeStmt: StatementSync;
  private readonly listRelaysStmt: StatementSync;
  private readonly listNonTerminalRelaysStmt: StatementSync;

  constructor(db: Db) {
    super(db);

    this.insertRelayStmt = this.db.sql.prepare(`
      INSERT INTO BitcoinLockRelays (
        offerCode,
        vaultId,
        maxSatoshis,
        expirationTick,
        status,
        requestedSatoshis,
        securitizationUsedMicrogons,
        ownerAccountAddress,
        ownerBitcoinPubkey,
        microgonsPerBtc,
        delegateAddress,
        extrinsicHash,
        extrinsicMethodJson,
        nonce,
        submittedAtBlockHeight,
        submittedAtTime,
        expiresAtBlockHeight
      ) VALUES (
        $offerCode,
        $vaultId,
        $maxSatoshis,
        $expirationTick,
        $status,
        $requestedSatoshis,
        $securitizationUsedMicrogons,
        $ownerAccountAddress,
        $ownerBitcoinPubkey,
        $microgonsPerBtc,
        $delegateAddress,
        $extrinsicHash,
        $extrinsicMethodJson,
        $nonce,
        $submittedAtBlockHeight,
        $submittedAtTime,
        $expiresAtBlockHeight
      )
      RETURNING *
    `);

    this.getRelayByIdStmt = this.db.sql.prepare(`
      SELECT *
      FROM BitcoinLockRelays
      WHERE id = $id
      LIMIT 1
    `);

    this.getRelayByOfferCodeStmt = this.db.sql.prepare(`
      SELECT *
      FROM BitcoinLockRelays
      WHERE offerCode = $offerCode
      LIMIT 1
    `);

    this.listRelaysStmt = this.db.sql.prepare(`
      SELECT *
      FROM BitcoinLockRelays
      ORDER BY offerCode ASC
    `);

    this.listNonTerminalRelaysStmt = this.db.sql.prepare(`
      SELECT *
      FROM BitcoinLockRelays
      WHERE status NOT IN ('Finalized', 'Failed')
      ORDER BY id ASC
    `);
  }

  public insertRelay(relay: IBitcoinLockRelayInsert): IBitcoinLockRelayRecord {
    const record = this.insertRelayStmt.get(
      toSqliteParams({
        ...relay,
        securitizationUsedMicrogons: relay.securitizationUsedMicrogons ?? 0n,
      }),
    ) as SqlRelayRow;

    return this.mapRelay(record);
  }

  public fetchById(id: number): IBitcoinLockRelayRecord | null {
    const record = this.getRelayByIdStmt.get({ $id: id }) as SqlRelayRow | undefined;
    return record ? this.mapRelay(record) : null;
  }

  public fetchByOfferCode(offerCode: string): IBitcoinLockRelayRecord | null {
    const record = this.getRelayByOfferCodeStmt.get({ $offerCode: offerCode }) as SqlRelayRow | undefined;
    return record ? this.mapRelay(record) : null;
  }

  public fetchAll(): IBitcoinLockRelayRecord[] {
    return (this.listRelaysStmt.all() as SqlRelayRow[]).map(record => this.mapRelay(record));
  }

  public fetchNonTerminal(): IBitcoinLockRelayRecord[] {
    return (this.listNonTerminalRelaysStmt.all() as SqlRelayRow[]).map(record => this.mapRelay(record));
  }

  public update(id: number, patch: IBitcoinLockRelayPatch): IBitcoinLockRelayRecord {
    const updates: string[] = [];
    const params: Record<string, SQLInputValue> = { $id: id };

    for (const [key, value] of Object.entries(patch)) {
      if (value === undefined || key === 'updatedAt') continue;

      updates.push(`${key} = $${key}`);
      params[`$${key}`] = toSqliteValue(value);
    }

    updates.push('updatedAt = $updatedAt');
    params.$updatedAt = toSqliteValue(patch.updatedAt ?? new Date());

    this.db.sql
      .prepare(
        `
        UPDATE BitcoinLockRelays
        SET ${updates.join(',\n          ')}
        WHERE id = $id
      `,
      )
      .run(params);

    const relay = this.fetchById(id);
    if (!relay) {
      throw new Error(`Relay ${id} not found after update.`);
    }
    return relay;
  }

  private mapRelay(record: SqlRelayRow): IBitcoinLockRelayRecord {
    return convertFromSqliteFields<IBitcoinLockRelayRecord>(record, {
      bigint: [
        'maxSatoshis',
        'requestedSatoshis',
        'securitizationUsedMicrogons',
        'microgonsPerBtc',
        'txFeePlusTip',
        'txTip',
      ],
      json: ['extrinsicMethodJson'],
      date: ['submittedAtTime', 'createdAt', 'updatedAt'],
    });
  }
}
