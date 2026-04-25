import type { SQLOutputValue } from 'node:sqlite';
import { convertFromSqliteFields, toSqliteParams } from '@argonprotocol/apps-core';
import type { Db } from '../Db.ts';
import { BaseTable } from './BaseTable.ts';

export interface ISessionRecord {
  id: number;
  sessionId: string;
  userId: number;
  expiresAt: Date;
  revokedAt?: Date | null;
  lastSeenAt?: Date | null;
  createdAt: Date;
}

type SqlSessionRow = Record<string, SQLOutputValue>;

const sessionFieldTypes = {
  date: ['expiresAt', 'revokedAt', 'lastSeenAt', 'createdAt'],
};

export class SessionsTable extends BaseTable {
  constructor(db: Db) {
    super(db);
  }

  public insertSession(session: Pick<ISessionRecord, 'sessionId' | 'userId' | 'expiresAt'>): ISessionRecord {
    const record = this.db.sql
      .prepare(
        `
        INSERT INTO Sessions (
          sessionId,
          userId,
          expiresAt
        ) VALUES (
          $sessionId,
          $userId,
          $expiresAt
        )
        RETURNING *
      `,
      )
      .get(toSqliteParams(session)) as SqlSessionRow;

    return this.mapSession(record);
  }

  public fetchBySessionId(sessionId: string): ISessionRecord | null {
    const record = this.db.sql
      .prepare(
        `
        SELECT *
        FROM Sessions
        WHERE sessionId = $sessionId
        LIMIT 1
      `,
      )
      .get({ $sessionId: sessionId }) as SqlSessionRow | undefined;

    return record ? this.mapSession(record) : null;
  }

  public touchLastSeen(id: number, lastSeenAt = new Date()): void {
    this.db.sql
      .prepare(
        `
        UPDATE Sessions
        SET lastSeenAt = $lastSeenAt
        WHERE id = $id
      `,
      )
      .run(toSqliteParams({ id, lastSeenAt }));
  }

  public revoke(id: number, revokedAt = new Date()): void {
    this.db.sql
      .prepare(
        `
        UPDATE Sessions
        SET revokedAt = COALESCE(revokedAt, $revokedAt)
        WHERE id = $id
      `,
      )
      .run(toSqliteParams({ id, revokedAt }));
  }

  public deleteInactiveSessions(now = new Date()): void {
    this.db.sql
      .prepare(
        `
        DELETE FROM Sessions
        WHERE expiresAt <= $now
          OR (revokedAt IS NOT NULL AND revokedAt <= $now)
      `,
      )
      .run(toSqliteParams({ now }));
  }

  private mapSession(record: SqlSessionRow): ISessionRecord {
    return convertFromSqliteFields<ISessionRecord>(record, sessionFieldTypes);
  }
}
