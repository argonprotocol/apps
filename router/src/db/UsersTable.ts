import type { SQLOutputValue } from 'node:sqlite';
import type { UserRole } from '@argonprotocol/apps-core';
import { convertFromSqliteFields, toSqliteParams } from '@argonprotocol/apps-core';
import type { Db } from '../Db.ts';
import { BaseTable } from './BaseTable.ts';

export type Role = UserRole;

export interface IUserRecord {
  id: number;
  role: Role;
  name: string;
  accountId?: string | null;
  authAccountId?: string | null;
  createdAt: Date;
}

type SqlUserRow = Record<string, SQLOutputValue>;

const userFieldTypes = {
  date: ['createdAt'],
};

export class UsersTable extends BaseTable {
  constructor(db: Db) {
    super(db);
  }

  public insertUser(user: Pick<IUserRecord, 'role' | 'name'>): IUserRecord {
    const record = this.db.sql
      .prepare(
        `
        INSERT INTO Users (
          role,
          name
        ) VALUES (
          $role,
          $name
        )
        RETURNING *
      `,
      )
      .get(
        toSqliteParams({
          role: user.role,
          name: user.name,
        }),
      ) as SqlUserRow;

    return this.mapUser(record);
  }

  public fetchById(id: number): IUserRecord | null {
    const record = this.db.sql
      .prepare(
        `
        SELECT *
        FROM Users
        WHERE id = $id
        LIMIT 1
      `,
      )
      .get({ $id: id }) as SqlUserRow | undefined;

    return record ? this.mapUser(record) : null;
  }

  public fetchByAccountId(accountId: string, role?: Role): IUserRecord | null {
    const record = this.db.sql
      .prepare(
        `
        SELECT *
        FROM Users
        WHERE accountId = $accountId
          AND ($role IS NULL OR role = $role)
        ORDER BY createdAt DESC, id DESC
        LIMIT 1
      `,
      )
      .get({
        $accountId: accountId,
        $role: role ?? null,
      }) as SqlUserRow | undefined;

    return record ? this.mapUser(record) : null;
  }

  public fetchByAuthAccountId(authAccountId: string, role?: Role): IUserRecord | null {
    const record = this.db.sql
      .prepare(
        `
        SELECT *
        FROM Users
        WHERE authAccountId = $authAccountId
          AND ($role IS NULL OR role = $role)
        ORDER BY createdAt DESC, id DESC
        LIMIT 1
      `,
      )
      .get({
        $authAccountId: authAccountId,
        $role: role ?? null,
      }) as SqlUserRow | undefined;

    return record ? this.mapUser(record) : null;
  }

  public claimAccount(id: number, accountId: string, authAccountId: string): IUserRecord | null {
    const record = this.db.sql
      .prepare(
        `
        UPDATE Users
        SET
          accountId = COALESCE(accountId, $accountId),
          authAccountId = $authAccountId
        WHERE id = $id
          AND (accountId IS NULL OR accountId = $accountId)
        RETURNING *
      `,
      )
      .get(
        toSqliteParams({
          id,
          accountId,
          authAccountId,
        }),
      ) as SqlUserRow | undefined;

    return record ? this.mapUser(record) : null;
  }

  public fetchByRole(role: Role): IUserRecord[] {
    return (
      this.db.sql
        .prepare(
          `
        SELECT *
        FROM Users
        WHERE role = $role
        ORDER BY createdAt DESC, id DESC
      `,
        )
        .all({ $role: role }) as SqlUserRow[]
    ).map(record => this.mapUser(record));
  }

  public deleteById(id: number): void {
    this.db.sql
      .prepare(
        `
        DELETE FROM Users
        WHERE id = $id
      `,
      )
      .run({ $id: id });
  }

  private mapUser(record: SqlUserRow): IUserRecord {
    return convertFromSqliteFields<IUserRecord>(record, userFieldTypes);
  }
}
