import type { SQLOutputValue } from 'node:sqlite';
import { convertFromSqliteFields, toSqliteParams } from '@argonprotocol/apps-core';
import type { Db } from '../Db.ts';
import { BaseTable } from './BaseTable.ts';
import type { Role } from './UsersTable.ts';

export interface IUserInviteRecord {
  id: number;
  role: Role;
  name: string;
  inviteCode: string;
  firstClickedAt?: Date | null;
  lastClickedAt?: Date | null;
  accountId?: string | null;
  createdAt: Date;
}

type SqlUserRow = Record<string, SQLOutputValue>;

const userFieldTypes = {
  date: ['firstClickedAt', 'lastClickedAt', 'createdAt'],
};

const selectInviteRecord = `
  SELECT
    Users.id AS id,
    Users.role AS role,
    Users.name AS name,
    UserInvites.inviteCode AS inviteCode,
    UserInvites.firstClickedAt AS firstClickedAt,
    UserInvites.lastClickedAt AS lastClickedAt,
    Users.accountId AS accountId,
    UserInvites.createdAt AS createdAt
  FROM UserInvites
  JOIN Users ON Users.id = UserInvites.userId
`;

export class UserInvitesTable extends BaseTable {
  constructor(db: Db) {
    super(db);
  }

  public insertInvite(userId: number, inviteCode: string): IUserInviteRecord {
    this.db.sql
      .prepare(
        `
        INSERT INTO UserInvites (
          userId,
          inviteCode
        ) VALUES (
          $userId,
          $inviteCode
        )
      `,
      )
      .run(
        toSqliteParams({
          userId,
          inviteCode,
        }),
      );

    const invite = this.fetchById(userId);
    if (!invite) {
      throw new Error(`Invite ${userId} not found after insert.`);
    }
    return invite;
  }

  public fetchByCode(inviteCode: string, role?: Role): IUserInviteRecord | null {
    const record = this.db.sql
      .prepare(
        `
        ${selectInviteRecord}
        WHERE UserInvites.inviteCode = $inviteCode
          AND ($role IS NULL OR Users.role = $role)
        LIMIT 1
      `,
      )
      .get({ $inviteCode: inviteCode, $role: role ?? null }) as SqlUserRow | undefined;

    return record ? this.mapInvite(record) : null;
  }

  public fetchById(id: number): IUserInviteRecord | null {
    const record = this.db.sql
      .prepare(
        `
        ${selectInviteRecord}
        WHERE UserInvites.userId = $id
        LIMIT 1
      `,
      )
      .get({ $id: id }) as SqlUserRow | undefined;

    return record ? this.mapInvite(record) : null;
  }

  public fetchByAccountId(accountId: string, role?: Role): IUserInviteRecord | null {
    const record = this.db.sql
      .prepare(
        `
        ${selectInviteRecord}
        WHERE Users.accountId = $accountId
          AND ($role IS NULL OR Users.role = $role)
        ORDER BY COALESCE(UserInvites.lastClickedAt, UserInvites.createdAt) DESC, Users.id DESC
        LIMIT 1
      `,
      )
      .get({
        $accountId: accountId,
        $role: role ?? null,
      }) as SqlUserRow | undefined;

    return record ? this.mapInvite(record) : null;
  }

  public fetchByRole(role: Role): IUserInviteRecord[] {
    return (
      this.db.sql
        .prepare(
          `
        ${selectInviteRecord}
        WHERE Users.role = $role
        ORDER BY UserInvites.createdAt DESC, Users.id DESC
      `,
        )
        .all({ $role: role }) as SqlUserRow[]
    ).map(record => this.mapInvite(record));
  }

  public fetchOpenedByRole(role: Role): IUserInviteRecord[] {
    return (
      this.db.sql
        .prepare(
          `
        ${selectInviteRecord}
        WHERE Users.role = $role
          AND UserInvites.lastClickedAt IS NOT NULL
        ORDER BY COALESCE(UserInvites.lastClickedAt, UserInvites.createdAt) DESC, Users.id DESC
      `,
        )
        .all({ $role: role }) as SqlUserRow[]
    ).map(record => this.mapInvite(record));
  }

  public openInvite(id: number, accountId: string, clickedAt = new Date()): IUserInviteRecord | null {
    this.db.usersTable.updateAccountId(id, accountId);

    const updatedInvite = this.db.sql
      .prepare(
        `
        UPDATE UserInvites
        SET
          firstClickedAt = COALESCE(firstClickedAt, $clickedAt),
          lastClickedAt = $clickedAt
        WHERE userId = $id
        RETURNING *
      `,
      )
      .get(
        toSqliteParams({
          id,
          clickedAt,
        }),
      ) as SqlUserRow | undefined;

    if (!updatedInvite) {
      return null;
    }

    return this.fetchById(id);
  }

  private mapInvite(record: SqlUserRow): IUserInviteRecord {
    return convertFromSqliteFields<IUserInviteRecord>(record, userFieldTypes);
  }
}
