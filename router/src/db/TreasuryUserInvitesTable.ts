import type { SQLOutputValue } from 'node:sqlite';
import { convertFromSqliteFields, toSqliteParams } from '@argonprotocol/apps-core';
import { BaseTable } from './BaseTable.ts';

export interface ITreasuryUserInviteCreate {
  name: string;
  inviteCode: string;
  offerCode: string;
  maxSatoshis: bigint;
  expiresAfterTicks: number;
  offerToken: string;
}

export interface ITreasuryUserInviteRecord extends ITreasuryUserInviteCreate {
  id: number;
  vaultId: number;
  expirationTick?: number | null;
  expiresAt?: Date | null;
  firstClickedAt?: Date | null;
  lastClickedAt?: Date | null;
  accountAddress?: string | null;
  redeemedAt?: Date | null;
  lockedBitcoinAt?: Date | null;
  createdAt: Date;
}

export type ITreasuryUserInviteSummary = Pick<
  ITreasuryUserInviteRecord,
  'id' | 'name' | 'inviteCode' | 'maxSatoshis' | 'expiresAt' | 'lastClickedAt' | 'redeemedAt' | 'lockedBitcoinAt'
>;

export type ITreasuryUserMember = Pick<
  ITreasuryUserInviteRecord,
  'id' | 'name' | 'maxSatoshis' | 'expiresAt' | 'lastClickedAt' | 'redeemedAt' | 'lockedBitcoinAt'
>;

type SqlInviteRow = Record<string, SQLOutputValue>;

const inviteFieldTypes = {
  bigint: ['maxSatoshis'],
  date: ['expiresAt', 'firstClickedAt', 'lastClickedAt', 'redeemedAt', 'lockedBitcoinAt', 'createdAt'],
};

const inviteActivityFieldTypes = {
  bigint: ['maxSatoshis'],
  date: ['expiresAt', 'lastClickedAt', 'redeemedAt', 'lockedBitcoinAt'],
};

export class TreasuryUserInvitesTable extends BaseTable {
  public insertInvite(invite: ITreasuryUserInviteCreate & { vaultId: number }): ITreasuryUserInviteRecord {
    const record = this.db.sql
      .prepare(`
        INSERT INTO TreasuryUserInvites (
          name,
          inviteCode,
          offerCode,
          vaultId,
          maxSatoshis,
          expiresAfterTicks,
          offerToken
        ) VALUES (
          $name,
          $inviteCode,
          $offerCode,
          $vaultId,
          $maxSatoshis,
          $expiresAfterTicks,
          $offerToken
        )
        RETURNING *
      `)
      .get(
        toSqliteParams({
          name: invite.name,
          inviteCode: invite.inviteCode,
          offerCode: invite.offerCode,
          vaultId: invite.vaultId,
          maxSatoshis: invite.maxSatoshis,
          expiresAfterTicks: invite.expiresAfterTicks,
          offerToken: invite.offerToken,
        }),
      ) as SqlInviteRow;

    return this.mapInvite(record);
  }

  public fetchInvites(): ITreasuryUserInviteSummary[] {
    return (this.db.sql
      .prepare(`
        SELECT id, name, inviteCode, maxSatoshis, expiresAt, lastClickedAt, redeemedAt, lockedBitcoinAt
        FROM TreasuryUserInvites
        ORDER BY createdAt DESC, id DESC
      `)
      .all() as SqlInviteRow[]).map(record =>
      convertFromSqliteFields<ITreasuryUserInviteSummary>(record, inviteActivityFieldTypes),
    );
  }

  public fetchMembers(): ITreasuryUserMember[] {
    return (this.db.sql
      .prepare(`
        SELECT id, name, maxSatoshis, expiresAt, lastClickedAt, redeemedAt, lockedBitcoinAt
        FROM TreasuryUserInvites
        WHERE redeemedAt IS NOT NULL OR lockedBitcoinAt IS NOT NULL OR lastClickedAt IS NOT NULL
        ORDER BY COALESCE(lockedBitcoinAt, redeemedAt, lastClickedAt, createdAt) DESC, id DESC
      `)
      .all() as SqlInviteRow[]).map(record =>
      convertFromSqliteFields<ITreasuryUserMember>(record, inviteActivityFieldTypes),
    );
  }

  public fetchInviteByCode(inviteCode: string): ITreasuryUserInviteRecord | null {
    const record = this.db.sql
      .prepare(`
        SELECT *
        FROM TreasuryUserInvites
        WHERE inviteCode = $inviteCode
        LIMIT 1
      `)
      .get({ $inviteCode: inviteCode }) as SqlInviteRow | undefined;

    return record ? this.mapInvite(record) : null;
  }

  public fetchInviteById(id: number): ITreasuryUserInviteRecord | null {
    const record = this.db.sql
      .prepare(`
        SELECT *
        FROM TreasuryUserInvites
        WHERE id = $id
        LIMIT 1
      `)
      .get({ $id: id }) as SqlInviteRow | undefined;

    return record ? this.mapInvite(record) : null;
  }

  public openInvite(id: number, accountAddress: string, clickedAt = new Date()): ITreasuryUserInviteRecord | null {
    const record = this.db.sql
      .prepare(`
        UPDATE TreasuryUserInvites
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

  public setIssuedOffer(args: {
    id: number;
    offerToken: string;
    expirationTick: number;
    expiresAt: Date;
  }): ITreasuryUserInviteRecord | null {
    const record = this.db.sql
      .prepare(`
        UPDATE TreasuryUserInvites
        SET
          offerToken = COALESCE(offerToken, $offerToken),
          expirationTick = COALESCE(expirationTick, $expirationTick),
          expiresAt = COALESCE(expiresAt, $expiresAt)
        WHERE id = $id
        RETURNING *
      `)
      .get(
        toSqliteParams({
          id: args.id,
          offerToken: args.offerToken,
          expirationTick: args.expirationTick,
          expiresAt: args.expiresAt,
        }),
      ) as SqlInviteRow | undefined;

    return record ? this.mapInvite(record) : null;
  }

  public setRedeemedAt(id: number, redeemedAt = new Date()): ITreasuryUserInviteRecord | null {
    const record = this.db.sql
      .prepare(`
        UPDATE TreasuryUserInvites
        SET redeemedAt = COALESCE(redeemedAt, $redeemedAt)
        WHERE id = $id
        RETURNING *
      `)
      .get(toSqliteParams({ id, redeemedAt })) as SqlInviteRow | undefined;

    return record ? this.mapInvite(record) : null;
  }

  public setLockedBitcoinAt(id: number, lockedBitcoinAt = new Date()): ITreasuryUserInviteRecord | null {
    const record = this.db.sql
      .prepare(`
        UPDATE TreasuryUserInvites
        SET lockedBitcoinAt = COALESCE(lockedBitcoinAt, $lockedBitcoinAt)
        WHERE id = $id
        RETURNING *
      `)
      .get(toSqliteParams({ id, lockedBitcoinAt })) as SqlInviteRow | undefined;

    return record ? this.mapInvite(record) : null;
  }

  private mapInvite(record: SqlInviteRow): ITreasuryUserInviteRecord {
    return convertFromSqliteFields<ITreasuryUserInviteRecord>(record, inviteFieldTypes);
  }
}
