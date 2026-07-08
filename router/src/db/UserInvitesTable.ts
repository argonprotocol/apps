import type { SQLOutputValue } from 'node:sqlite';
import { convertFromSqliteFields, toSqliteParams } from '@argonprotocol/apps-core';
import type { Db } from '../Db.ts';
import { BaseTable } from './BaseTable.ts';
import type { Role } from './UsersTable.ts';

export interface IUserInviteRecord {
  id: number;
  name: string;
  fromName: string;
  inviteCode: string;
  firstClickedAt?: Date | null;
  lastClickedAt?: Date | null;
  operationsUpgradeRequestedAt?: Date | null;
  operationsUpgradedAt?: Date | null;
  operationalAccountId?: string | null;
  defaultAccountId?: string | null;
  authAccountId?: string | null;
  createdAt: Date;
}

type SqlInviteRow = Record<string, SQLOutputValue>;

const inviteFieldTypes = {
  date: ['firstClickedAt', 'lastClickedAt', 'operationsUpgradeRequestedAt', 'operationsUpgradedAt', 'createdAt'],
};

const selectInviteRecord = `
  SELECT
    Users.id AS id,
    Users.name AS name,
    UserInvites.fromName AS fromName,
    UserInvites.inviteCode AS inviteCode,
    UserInvites.firstClickedAt AS firstClickedAt,
    UserInvites.lastClickedAt AS lastClickedAt,
    UserInvites.operationsUpgradeRequestedAt AS operationsUpgradeRequestedAt,
    UserInvites.operationsUpgradedAt AS operationsUpgradedAt,
    Users.operationalAccountId AS operationalAccountId,
    Users.accountId AS defaultAccountId,
    Users.authAccountId AS authAccountId,
    UserInvites.createdAt AS createdAt
  FROM UserInvites
  JOIN Users ON Users.id = UserInvites.userId
`;

export class UserInvitesTable extends BaseTable {
  constructor(db: Db) {
    super(db);
  }

  public insertInvite(userId: number, inviteCode: string, fromName: string): IUserInviteRecord {
    this.db.sql
      .prepare(
        `
        INSERT INTO UserInvites (
          userId,
          inviteCode,
          fromName
        ) VALUES (
          $userId,
          $inviteCode,
          $fromName
        )
      `,
      )
      .run(
        toSqliteParams({
          userId,
          inviteCode,
          fromName,
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
      .get({ $inviteCode: inviteCode, $role: role ?? null }) as SqlInviteRow | undefined;

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
      .get({ $id: id }) as SqlInviteRow | undefined;

    return record ? this.mapInvite(record) : null;
  }

  public fetchByDefaultAccountId(defaultAccountId: string, role?: Role): IUserInviteRecord | null {
    const record = this.db.sql
      .prepare(
        `
        ${selectInviteRecord}
        WHERE Users.accountId = $defaultAccountId
          AND ($role IS NULL OR Users.role = $role)
        ORDER BY COALESCE(UserInvites.lastClickedAt, UserInvites.createdAt) DESC, Users.id DESC
        LIMIT 1
      `,
      )
      .get({
        $defaultAccountId: defaultAccountId,
        $role: role ?? null,
      }) as SqlInviteRow | undefined;

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
        .all({ $role: role }) as SqlInviteRow[]
    ).map(record => this.mapInvite(record));
  }

  public claimInvite(
    id: number,
    defaultAccountId: string,
    authAccountId: string,
    clickedAt = new Date(),
  ): IUserInviteRecord | null {
    const user = this.db.usersTable.claimAccount(id, defaultAccountId, authAccountId);
    if (!user) return null;

    this.db.sql
      .prepare(
        `
        UPDATE UserInvites
        SET
          firstClickedAt = COALESCE(firstClickedAt, $clickedAt),
          lastClickedAt = $clickedAt
        WHERE userId = $id
      `,
      )
      .run(
        toSqliteParams({
          id,
          clickedAt,
        }),
      );

    return this.fetchById(id);
  }

  public deleteByUserId(userId: number): void {
    this.db.sql
      .prepare(
        `
        DELETE FROM UserInvites
        WHERE userId = $userId
      `,
      )
      .run({ $userId: userId });
  }

  public requestOperationsUpgrade(id: number, requestedAt = new Date()): IUserInviteRecord | null {
    this.db.sql
      .prepare(
        `
        UPDATE UserInvites
        SET operationsUpgradeRequestedAt = COALESCE(operationsUpgradeRequestedAt, $requestedAt)
        WHERE userId = $id
      `,
      )
      .run(
        toSqliteParams({
          id,
          requestedAt,
        }),
      );

    return this.fetchById(id);
  }

  public markOperationsUpgraded(id: number, upgradedAt = new Date()): IUserInviteRecord | null {
    this.db.sql
      .prepare(
        `
        UPDATE UserInvites
        SET operationsUpgradedAt = COALESCE(operationsUpgradedAt, $upgradedAt)
        WHERE userId = $id
      `,
      )
      .run(
        toSqliteParams({
          id,
          upgradedAt,
        }),
      );

    return this.fetchById(id);
  }

  private mapInvite(record: SqlInviteRow): IUserInviteRecord {
    return convertFromSqliteFields<IUserInviteRecord>(record, inviteFieldTypes);
  }
}
