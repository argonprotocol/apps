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
    estimatedGiftUsd: number;
    btcPctFee?: number;
    expiresAfterTicks: number;
  }): IBitcoinLockCouponRecord {
    const now = new Date();
    const record = this.db.sql
      .prepare(
        `
        INSERT INTO BitcoinLockCoupons (
          userId,
          sequence,
          offerCode,
          vaultId,
          maxSatoshis,
          estimatedGiftUsd,
          btcPctFee,
          expiresAfterTicks,
          createdAt,
          updatedAt
        ) VALUES (
          $userId,
          (
            SELECT COALESCE(MAX(sequence), 0) + 1
            FROM BitcoinLockCoupons
            WHERE userId = $userId
          ),
          $offerCode,
          $vaultId,
          $maxSatoshis,
          $estimatedGiftUsd,
          $btcPctFee,
          $expiresAfterTicks,
          $createdAt,
          $updatedAt
        )
        RETURNING *
      `,
      )
      .get(
        toSqliteParams({
          ...coupon,
          btcPctFee: coupon.btcPctFee ?? 0,
          createdAt: now,
          updatedAt: now,
        }),
      ) as SqlCouponRow;

    return this.mapCoupon(record);
  }

  public restoreCoupon(
    coupon: Omit<IBitcoinLockCouponRecord, 'sequence'> & { sequence?: number },
  ): IBitcoinLockCouponRecord {
    const existingByOfferCode = this.fetchByOfferCode(coupon.offerCode);
    const sequence = coupon.sequence ?? existingByOfferCode?.sequence ?? 1;
    if (existingByOfferCode) {
      if (
        existingByOfferCode.userId !== coupon.userId ||
        existingByOfferCode.vaultId !== coupon.vaultId ||
        existingByOfferCode.accountId !== coupon.accountId ||
        existingByOfferCode.sequence !== sequence
      ) {
        throw new Error('Recovered bitcoin lock coupon conflicts with existing bot state.');
      }

      return existingByOfferCode;
    }

    const currentCoupon = this.fetchLatestByUserId(coupon.userId);
    if (currentCoupon) {
      if (currentCoupon.accountId !== coupon.accountId) {
        throw new Error('Recovered bitcoin lock coupon conflicts with existing bot state.');
      }

      if (currentCoupon.sequence >= sequence) {
        return currentCoupon;
      }
    }

    const { id: _foreignId, ...couponToRestore } = coupon;
    if (!couponToRestore.accountId) {
      throw new Error('Recovered bitcoin lock coupon conflicts with existing bot state.');
    }

    const record = this.db.sql
      .prepare(
        `
        INSERT INTO BitcoinLockCoupons (
          userId,
          sequence,
          offerCode,
          vaultId,
          maxSatoshis,
          estimatedGiftUsd,
          btcPctFee,
          expiresAfterTicks,
          expirationTick,
          accountId,
          createdAt,
          updatedAt
        ) VALUES (
          $userId,
          $sequence,
          $offerCode,
          $vaultId,
          $maxSatoshis,
          $estimatedGiftUsd,
          $btcPctFee,
          $expiresAfterTicks,
          $expirationTick,
          $accountId,
          $createdAt,
          $updatedAt
        )
        RETURNING *
      `,
      )
      .get(
        toSqliteParams({
          ...couponToRestore,
          sequence,
          expirationTick: couponToRestore.expirationTick ?? null,
        }),
      ) as SqlCouponRow;

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
        ORDER BY sequence DESC, id DESC
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
        ORDER BY sequence DESC, id DESC
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
        ORDER BY createdAt DESC, id DESC
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
          updatedAt = $updatedAt
        WHERE id = $id
        RETURNING *
      `,
      )
      .get(
        toSqliteParams({
          id,
          accountId,
          expirationTick,
          updatedAt: new Date(),
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
