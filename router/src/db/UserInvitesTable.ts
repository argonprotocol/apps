import type { SQLOutputValue } from 'node:sqlite';
import { convertFromSqliteFields, toSqliteParams } from '@argonprotocol/apps-core';
import { BaseTable } from './BaseTable.ts';

export type UserInviteType = 'treasury_user' | 'operational_partner';

export interface IUserInviteRecord {
  id: number;
  inviteType: UserInviteType;
  name: string;
  inviteCode: string;
  firstClickedAt?: Date | null;
  lastClickedAt?: Date | null;
  accountAddress?: string | null;
  createdAt: Date;
}

type SqlInviteRow = Record<string, SQLOutputValue>;

const userInviteFieldTypes = {
  date: ['firstClickedAt', 'lastClickedAt', 'createdAt'],
};

export class UserInvitesTable extends BaseTable {
  public insertInvite(invite: Pick<IUserInviteRecord, 'inviteType' | 'name' | 'inviteCode'>): IUserInviteRecord {
    const record = this.db.sql
      .prepare(`
        INSERT INTO UserInvites (
          inviteType,
          name,
          inviteCode
        ) VALUES (
          $inviteType,
          $name,
          $inviteCode
        )
        RETURNING *
      `)
      .get(
        toSqliteParams({
          inviteType: invite.inviteType,
          name: invite.name,
          inviteCode: invite.inviteCode,
        }),
      ) as SqlInviteRow;

    return this.mapInvite(record);
  }

  public fetchByCode(inviteCode: string, inviteType?: UserInviteType): IUserInviteRecord | null {
    const record = this.db.sql
      .prepare(`
        SELECT *
        FROM UserInvites
        WHERE inviteCode = $inviteCode
          AND ($inviteType IS NULL OR inviteType = $inviteType)
        LIMIT 1
      `)
      .get({ $inviteCode: inviteCode, $inviteType: inviteType ?? null }) as SqlInviteRow | undefined;

    return record ? this.mapInvite(record) : null;
  }

  public fetchById(id: number): IUserInviteRecord | null {
    const record = this.db.sql
      .prepare(`
        SELECT *
        FROM UserInvites
        WHERE id = $id
        LIMIT 1
      `)
      .get({ $id: id }) as SqlInviteRow | undefined;

    return record ? this.mapInvite(record) : null;
  }

  public fetchByType(inviteType: UserInviteType): IUserInviteRecord[] {
    return (this.db.sql
      .prepare(`
        SELECT *
        FROM UserInvites
        WHERE inviteType = $inviteType
        ORDER BY createdAt DESC, id DESC
      `)
      .all({ $inviteType: inviteType }) as SqlInviteRow[]).map(record => this.mapInvite(record));
  }

  public fetchOpenedByType(inviteType: UserInviteType): IUserInviteRecord[] {
    return (this.db.sql
      .prepare(`
        SELECT *
        FROM UserInvites
        WHERE inviteType = $inviteType
          AND lastClickedAt IS NOT NULL
        ORDER BY COALESCE(lastClickedAt, createdAt) DESC, id DESC
      `)
      .all({ $inviteType: inviteType }) as SqlInviteRow[]).map(record => this.mapInvite(record));
  }

  public openInvite(id: number, accountAddress: string, clickedAt = new Date()): IUserInviteRecord | null {
    const record = this.db.sql
      .prepare(`
        UPDATE UserInvites
        SET
          firstClickedAt = COALESCE(firstClickedAt, $clickedAt),
          lastClickedAt = $clickedAt,
          accountAddress = COALESCE(accountAddress, $accountAddress)
        WHERE id = $id
        RETURNING *
      `)
      .get(
        toSqliteParams({
          id,
          accountAddress,
          clickedAt,
        }),
      ) as SqlInviteRow | undefined;

    return record ? this.mapInvite(record) : null;
  }

  private mapInvite(record: SqlInviteRow): IUserInviteRecord {
    return convertFromSqliteFields<IUserInviteRecord>(record, userInviteFieldTypes);
  }
}
