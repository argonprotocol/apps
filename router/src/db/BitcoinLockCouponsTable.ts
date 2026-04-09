import type { SQLOutputValue } from 'node:sqlite';
import { convertFromSqliteFields, toSqliteParams } from '@argonprotocol/apps-core';
import { BaseTable } from './BaseTable.ts';

export interface IBitcoinLockCouponRecord {
  id: number;
  inviteId: number;
  offerCode: string;
  offerToken: string;
  vaultId: number;
  maxSatoshis: bigint;
  expiresAfterTicks: number;
  expirationTick?: number | null;
  expiresAt?: Date | null;
  createdAt: Date;
}

type SqlCouponRow = Record<string, SQLOutputValue>;

export class BitcoinLockCouponsTable extends BaseTable {
  public insertCoupon(
    coupon: Pick<
      IBitcoinLockCouponRecord,
      'inviteId' | 'offerCode' | 'offerToken' | 'vaultId' | 'maxSatoshis' | 'expiresAfterTicks'
    >,
  ): IBitcoinLockCouponRecord {
    const record = this.db.sql
      .prepare(`
        INSERT INTO BitcoinLockCoupons (
          inviteId,
          offerCode,
          offerToken,
          vaultId,
          maxSatoshis,
          expiresAfterTicks
        ) VALUES (
          $inviteId,
          $offerCode,
          $offerToken,
          $vaultId,
          $maxSatoshis,
          $expiresAfterTicks
        )
        RETURNING *
      `)
      .get(
        toSqliteParams({
          inviteId: coupon.inviteId,
          offerCode: coupon.offerCode,
          offerToken: coupon.offerToken,
          vaultId: coupon.vaultId,
          maxSatoshis: coupon.maxSatoshis,
          expiresAfterTicks: coupon.expiresAfterTicks,
        }),
      ) as SqlCouponRow;

    return this.mapCoupon(record);
  }

  public fetchByOfferCode(offerCode: string): IBitcoinLockCouponRecord | null {
    const record = this.db.sql
      .prepare(`
        SELECT *
        FROM BitcoinLockCoupons
        WHERE offerCode = $offerCode
        LIMIT 1
      `)
      .get({ $offerCode: offerCode }) as SqlCouponRow | undefined;

    return record ? this.mapCoupon(record) : null;
  }

  public fetchLatestByInviteId(inviteId: number): IBitcoinLockCouponRecord | null {
    const record = this.db.sql
      .prepare(`
        SELECT *
        FROM BitcoinLockCoupons
        WHERE inviteId = $inviteId
        ORDER BY id DESC
        LIMIT 1
      `)
      .get({ $inviteId: inviteId }) as SqlCouponRow | undefined;

    return record ? this.mapCoupon(record) : null;
  }

  public fetchLatestByInviteIds(inviteIds: number[]): Map<number, IBitcoinLockCouponRecord> {
    if (!inviteIds.length) return new Map();

    const placeholders = inviteIds.map((_, i) => `$inviteId${i}`).join(', ');
    const params = Object.fromEntries(inviteIds.map((id, i) => [`$inviteId${i}`, id]));
    const records = this.db.sql
      .prepare(`
        SELECT *
        FROM BitcoinLockCoupons
        WHERE id IN (
          SELECT MAX(id)
          FROM BitcoinLockCoupons
          WHERE inviteId IN (${placeholders})
          GROUP BY inviteId
        )
      `)
      .all(params) as SqlCouponRow[];

    return new Map(records.map(record => {
      const coupon = this.mapCoupon(record);
      return [coupon.inviteId, coupon] as const;
    }));
  }

  public setIssuedCoupon(id: number, expirationTick: number, expiresAt: Date): IBitcoinLockCouponRecord | null {
    const record = this.db.sql
      .prepare(`
        UPDATE BitcoinLockCoupons
        SET
          expirationTick = COALESCE(expirationTick, $expirationTick),
          expiresAt = COALESCE(expiresAt, $expiresAt)
        WHERE id = $id
        RETURNING *
      `)
      .get(
        toSqliteParams({
          id,
          expirationTick,
          expiresAt,
        }),
      ) as SqlCouponRow | undefined;

    return record ? this.mapCoupon(record) : null;
  }

  private mapCoupon(record: SqlCouponRow): IBitcoinLockCouponRecord {
    return convertFromSqliteFields<IBitcoinLockCouponRecord>(record, {
      bigint: ['maxSatoshis'],
      date: ['expiresAt', 'createdAt'],
    });
  }
}
