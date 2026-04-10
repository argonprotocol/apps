import type { SQLOutputValue } from 'node:sqlite';
import { convertFromSqliteFields, toSqliteParams } from '@argonprotocol/apps-core';
import type { IBitcoinLockCouponRecord } from '@argonprotocol/apps-core';
import type { Db } from '../Db.ts';
import { BaseTable } from './BaseTable.ts';

type SqlCouponRow = Record<string, SQLOutputValue>;

export class BitcoinLockCouponsTable extends BaseTable {
  constructor(db: Db) {
    super(db);
  }

  public insertCoupon(coupon: {
    userId: number;
    offerCode: string;
    vaultId: number;
    maxSatoshis: bigint;
    expiresAfterTicks: number;
  }): IBitcoinLockCouponRecord {
    const record = this.db.sql
      .prepare(
        `
        INSERT INTO BitcoinLockCoupons (
          userId,
          offerCode,
          vaultId,
          maxSatoshis,
          expiresAfterTicks
        ) VALUES (
          $userId,
          $offerCode,
          $vaultId,
          $maxSatoshis,
          $expiresAfterTicks
        )
        RETURNING *
      `,
      )
      .get(toSqliteParams(coupon)) as SqlCouponRow;

    return this.mapCoupon(record);
  }

  public fetchById(id: number): IBitcoinLockCouponRecord | null {
    const record = this.db.sql
      .prepare(
        `
        SELECT *
        FROM BitcoinLockCoupons
        WHERE id = $id
        LIMIT 1
      `,
      )
      .get({ $id: id }) as SqlCouponRow | undefined;

    return record ? this.mapCoupon(record) : null;
  }

  public fetchByOfferCode(offerCode: string): IBitcoinLockCouponRecord | null {
    const record = this.db.sql
      .prepare(
        `
        SELECT *
        FROM BitcoinLockCoupons
        WHERE offerCode = $offerCode
        LIMIT 1
      `,
      )
      .get({ $offerCode: offerCode }) as SqlCouponRow | undefined;

    return record ? this.mapCoupon(record) : null;
  }

  public fetchLatestByUserId(userId: number): IBitcoinLockCouponRecord | null {
    const record = this.db.sql
      .prepare(
        `
        SELECT *
        FROM BitcoinLockCoupons
        WHERE userId = $userId
        ORDER BY id DESC
        LIMIT 1
      `,
      )
      .get({ $userId: userId }) as SqlCouponRow | undefined;

    return record ? this.mapCoupon(record) : null;
  }

  public fetchByUserId(userId: number): IBitcoinLockCouponRecord[] {
    return (
      this.db.sql
        .prepare(
          `
        SELECT *
        FROM BitcoinLockCoupons
        WHERE userId = $userId
        ORDER BY id DESC
      `,
        )
        .all({ $userId: userId }) as SqlCouponRow[]
    ).map(record => this.mapCoupon(record));
  }

  public fetchAll(): IBitcoinLockCouponRecord[] {
    return (
      this.db.sql
        .prepare(
          `
        SELECT *
        FROM BitcoinLockCoupons
        ORDER BY id DESC
      `,
        )
        .all() as SqlCouponRow[]
    ).map(record => this.mapCoupon(record));
  }

  public activateCoupon(id: number, accountId: string, expirationTick: number): IBitcoinLockCouponRecord | null {
    const record = this.db.sql
      .prepare(
        `
        UPDATE BitcoinLockCoupons
        SET
          accountId = COALESCE(accountId, $accountId),
          expirationTick = COALESCE(expirationTick, $expirationTick),
          updatedAt = CURRENT_TIMESTAMP
        WHERE id = $id
        RETURNING *
      `,
      )
      .get(
        toSqliteParams({
          id,
          accountId,
          expirationTick,
        }),
      ) as SqlCouponRow | undefined;

    return record ? this.mapCoupon(record) : null;
  }

  private mapCoupon(record: SqlCouponRow): IBitcoinLockCouponRecord {
    return convertFromSqliteFields<IBitcoinLockCouponRecord>(record, {
      bigint: ['maxSatoshis'],
      date: ['createdAt', 'updatedAt'],
    });
  }
}
