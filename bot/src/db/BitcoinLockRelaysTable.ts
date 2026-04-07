import type { SQLInputValue, SQLOutputValue, StatementSync } from 'node:sqlite';
import type { BitcoinLockRelayStatus, IBitcoinLockRelayLock, IBitcoinLockRelayRecord } from '@argonprotocol/apps-core';
import { convertFromSqliteFields, toSqliteParams, toSqliteValue } from '@argonprotocol/apps-core';
import type { Db } from '../Db.ts';
import { BaseTable } from './BaseTable.ts';

export interface IBitcoinLockRelayQueuedInsert {
  status: BitcoinLockRelayStatus;
  queueReason?: string | null;
  routerInviteId: number;
  offerCode: string;
  vaultId: number;
  maxSatoshis: bigint;
  expirationTick: number;
  requestedSatoshis: bigint;
  ownerAccountAddress: string;
  ownerBitcoinPubkey: string;
  microgonsPerBtc: bigint;
}

type IBitcoinLockRelayPatch = {
  status?: BitcoinLockRelayStatus;
  queueReason?: string | null;
  error?: string | null;
  reservedSatoshis?: bigint;
  reservedLiquidityMicrogons?: bigint;
  delegateAddress?: string | null;
  extrinsicHash?: string | null;
  extrinsicMethodJson?: any;
  nonce?: number | null;
  submittedAtBlockHeight?: number | null;
  submittedAtTime?: Date | null;
  inBlockHeight?: number | null;
  inBlockHash?: string | null;
  finalizedHeight?: number | null;
  txFeePlusTip?: bigint | null;
  txTip?: bigint | null;
  utxoId?: number | null;
  createdLock?: IBitcoinLockRelayLock | null;
  updatedAt?: Date | null;
};

type SqlRelayRow = Record<string, SQLOutputValue>;

export class BitcoinLockRelaysTable extends BaseTable {
  private readonly insertQueuedRelayStmt: StatementSync;
  private readonly getRelayByIdStmt: StatementSync;
  private readonly getLatestRelayByInviteIdStmt: StatementSync;
  private readonly listNonTerminalRelaysStmt: StatementSync;
  private readonly listOutstandingReservationRelaysStmt: StatementSync;

  constructor(db: Db) {
    super(db);

    this.insertQueuedRelayStmt = this.db.sql.prepare(`
      INSERT INTO BitcoinLockRelays (
        routerInviteId,
        offerCode,
        vaultId,
        maxSatoshis,
        expirationTick,
        status,
        queueReason,
        requestedSatoshis,
        ownerAccountAddress,
        ownerBitcoinPubkey,
        microgonsPerBtc
      ) VALUES (
        $routerInviteId,
        $offerCode,
        $vaultId,
        $maxSatoshis,
        $expirationTick,
        $status,
        $queueReason,
        $requestedSatoshis,
        $ownerAccountAddress,
        $ownerBitcoinPubkey,
        $microgonsPerBtc
      )
      RETURNING *
    `);

    this.getRelayByIdStmt = this.db.sql.prepare(`
      SELECT *
      FROM BitcoinLockRelays
      WHERE id = $id
      LIMIT 1
    `);

    this.getLatestRelayByInviteIdStmt = this.db.sql.prepare(`
      SELECT *
      FROM BitcoinLockRelays
      WHERE routerInviteId = $routerInviteId
      ORDER BY id DESC
      LIMIT 1
    `);

    this.listNonTerminalRelaysStmt = this.db.sql.prepare(`
      SELECT *
      FROM BitcoinLockRelays
      WHERE status NOT IN ('Finalized', 'Failed')
      ORDER BY id ASC
    `);

    this.listOutstandingReservationRelaysStmt = this.db.sql.prepare(`
      SELECT *
      FROM BitcoinLockRelays
      WHERE status IN ('Submitting', 'Submitted', 'InBlock')
        AND (reservedSatoshis != '0' OR reservedLiquidityMicrogons != '0')
      ORDER BY id ASC
    `);
  }

  public insertQueuedRelay(relay: IBitcoinLockRelayQueuedInsert): IBitcoinLockRelayRecord {
    const record = this.insertQueuedRelayStmt.get(
      toSqliteParams({
        routerInviteId: relay.routerInviteId,
        offerCode: relay.offerCode,
        vaultId: relay.vaultId,
        maxSatoshis: relay.maxSatoshis,
        expirationTick: relay.expirationTick,
        status: relay.status,
        queueReason: relay.queueReason ?? null,
        requestedSatoshis: relay.requestedSatoshis,
        ownerAccountAddress: relay.ownerAccountAddress,
        ownerBitcoinPubkey: relay.ownerBitcoinPubkey,
        microgonsPerBtc: relay.microgonsPerBtc,
      }),
    ) as SqlRelayRow;

    return this.mapRelay(record);
  }

  public fetchById(id: number): IBitcoinLockRelayRecord | null {
    const record = this.getRelayByIdStmt.get({ $id: id }) as SqlRelayRow | undefined;
    return record ? this.mapRelay(record) : null;
  }

  public fetchLatestByInviteId(routerInviteId: number): IBitcoinLockRelayRecord | null {
    const record = this.getLatestRelayByInviteIdStmt.get({ $routerInviteId: routerInviteId }) as
      | SqlRelayRow
      | undefined;
    return record ? this.mapRelay(record) : null;
  }

  public fetchNonTerminal(): IBitcoinLockRelayRecord[] {
    return (this.listNonTerminalRelaysStmt.all() as SqlRelayRow[]).map(record => this.mapRelay(record));
  }

  public fetchOutstandingReservations(): IBitcoinLockRelayRecord[] {
    return (this.listOutstandingReservationRelaysStmt.all() as SqlRelayRow[]).map(record => this.mapRelay(record));
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

  public clearReservation(id: number): IBitcoinLockRelayRecord {
    return this.update(id, {
      reservedSatoshis: 0n,
      reservedLiquidityMicrogons: 0n,
      queueReason: null,
    });
  }

  private mapRelay(record: SqlRelayRow): IBitcoinLockRelayRecord {
    return convertFromSqliteFields<IBitcoinLockRelayRecord>(record, {
      bigint: [
        'maxSatoshis',
        'requestedSatoshis',
        'reservedSatoshis',
        'reservedLiquidityMicrogons',
        'microgonsPerBtc',
        'txFeePlusTip',
        'txTip',
      ],
      json: ['extrinsicMethodJson', 'createdLock'],
      date: ['submittedAtTime', 'createdAt', 'updatedAt'],
    });
  }
}
