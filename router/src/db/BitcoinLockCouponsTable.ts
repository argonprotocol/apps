import type { SQLOutputValue } from 'node:sqlite';
import {
  bigIntMax,
  convertFromSqliteFields,
  MiningFrames,
  toSqliteParams,
  type IBitcoinLockCouponRecord,
  type IBitcoinLockCouponUseRecord,
  type IBitcoinLockRelayRecord,
} from '@argonprotocol/apps-core';
import { RouterError } from '../RouterError.ts';
import { BaseTable } from './BaseTable.ts';

type SqlRow = Record<string, SQLOutputValue>;

export type IBitcoinLockCouponRow = IBitcoinLockCouponRecord & {
  relayRequestId?: string;
  relay?: IBitcoinLockRelayRecord;
};

type InsertCoupon = Omit<
  IBitcoinLockCouponRecord,
  'id' | 'sequence' | 'expirationTick' | 'accountId' | 'createdAt' | 'updatedAt'
>;

export class BitcoinLockCouponsTable extends BaseTable {
  public insert(coupon: InsertCoupon): IBitcoinLockCouponRow {
    const now = new Date();
    const record = this.db.sql
      .prepare(
        `
        INSERT INTO BitcoinLockCoupons (
          userId, sequence, offerCode, vaultId, maxSatoshis, estimatedGiftUsd,
          btcPctFee, feeCreditMicrogons, expiresAfterTicks, createdAt, updatedAt
        ) VALUES (
          $userId,
          (SELECT COALESCE(MAX(sequence), 0) + 1 FROM BitcoinLockCoupons WHERE userId = $userId),
          $offerCode, $vaultId, $maxSatoshis, $estimatedGiftUsd,
          $btcPctFee, $feeCreditMicrogons, $expiresAfterTicks, $createdAt, $updatedAt
        )
        RETURNING *
      `,
      )
      .get(toSqliteParams({ ...coupon, createdAt: now, updatedAt: now })) as SqlRow;

    return this.map(record);
  }

  public fetchById(id: number): IBitcoinLockCouponRow | null {
    const record = this.db.sql.prepare('SELECT * FROM BitcoinLockCoupons WHERE id = $id LIMIT 1').get({ $id: id }) as
      | SqlRow
      | undefined;
    return record ? this.map(record) : null;
  }

  public fetchByOfferCode(offerCode: string): IBitcoinLockCouponRow | null {
    const record = this.db.sql
      .prepare('SELECT * FROM BitcoinLockCoupons WHERE offerCode = $offerCode LIMIT 1')
      .get({ $offerCode: offerCode }) as SqlRow | undefined;
    return record ? this.map(record) : null;
  }

  public fetchLatestByUserId(userId: number): IBitcoinLockCouponRow | null {
    const record = this.db.sql
      .prepare('SELECT * FROM BitcoinLockCoupons WHERE userId = $userId ORDER BY sequence DESC, id DESC LIMIT 1')
      .get({ $userId: userId }) as SqlRow | undefined;
    return record ? this.map(record) : null;
  }

  public fetchByUserId(userId: number): IBitcoinLockCouponRow[] {
    const records = this.db.sql
      .prepare('SELECT * FROM BitcoinLockCoupons WHERE userId = $userId ORDER BY sequence DESC, id DESC')
      .all({ $userId: userId }) as SqlRow[];
    return records.map(record => this.map(record));
  }

  public fetchAll(): IBitcoinLockCouponRow[] {
    const records = this.db.sql
      .prepare('SELECT * FROM BitcoinLockCoupons ORDER BY createdAt DESC, id DESC')
      .all() as SqlRow[];
    return records.map(record => this.map(record));
  }

  public restore(coupon: Omit<IBitcoinLockCouponRow, 'id'> & { id?: number }): IBitcoinLockCouponRow {
    const existing = this.fetchByOfferCode(coupon.offerCode);
    if (existing) return existing;

    const { id: _id, feeCoupon, relay, ...fields } = coupon;
    const record = this.db.sql
      .prepare(
        `
        INSERT INTO BitcoinLockCoupons (
          userId, sequence, offerCode, vaultId, maxSatoshis, estimatedGiftUsd,
          btcPctFee, feeCreditMicrogons, expiresAfterTicks, expirationTick, accountId,
          feeCouponJson, usedAt, relayRequestId, relayJson, createdAt, updatedAt
        ) VALUES (
          $userId, $sequence, $offerCode, $vaultId, $maxSatoshis, $estimatedGiftUsd,
          $btcPctFee, $feeCreditMicrogons, $expiresAfterTicks, $expirationTick, $accountId,
          $feeCouponJson, $usedAt, $relayRequestId, $relayJson, $createdAt, $updatedAt
        )
        RETURNING *
      `,
      )
      .get(toSqliteParams({ ...fields, feeCouponJson: feeCoupon, relayJson: relay })) as SqlRow;
    return this.map(record);
  }

  public activate(id: number, accountId: string, expirationTick: number): IBitcoinLockCouponRow {
    const record = this.db.sql
      .prepare(
        `
        UPDATE BitcoinLockCoupons
        SET accountId = COALESCE(accountId, $accountId),
            expirationTick = COALESCE(expirationTick, $expirationTick),
            updatedAt = $updatedAt
        WHERE id = $id
        RETURNING *
      `,
      )
      .get(toSqliteParams({ id, accountId, expirationTick, updatedAt: new Date() })) as SqlRow | undefined;
    if (!record) throw new RouterError('Bitcoin lock coupon not found.', 404);
    return this.map(record);
  }

  public assignRelayRequest(id: number, requestId: string): IBitcoinLockCouponRow {
    const record = this.db.sql
      .prepare(
        `
        UPDATE BitcoinLockCoupons
        SET relayRequestId = COALESCE(relayRequestId, $requestId), updatedAt = $updatedAt
        WHERE id = $id
        RETURNING *
      `,
      )
      .get(toSqliteParams({ id, requestId, updatedAt: new Date() })) as SqlRow | undefined;
    if (!record) throw new RouterError('Bitcoin lock coupon not found.', 404);
    return this.map(record);
  }

  public setFeeCredit(id: number, feeCreditMicrogons: bigint): IBitcoinLockCouponRow {
    const record = this.db.sql
      .prepare(
        `
        UPDATE BitcoinLockCoupons
        SET feeCreditMicrogons = COALESCE(feeCreditMicrogons, $feeCreditMicrogons), updatedAt = $updatedAt
        WHERE id = $id
        RETURNING *
      `,
      )
      .get(toSqliteParams({ id, feeCreditMicrogons, updatedAt: new Date() })) as SqlRow | undefined;
    if (!record) throw new RouterError('Bitcoin lock coupon not found.', 404);
    return this.map(record);
  }

  public recordRelay(id: number, relay: IBitcoinLockRelayRecord): IBitcoinLockCouponRow {
    const record = this.db.sql
      .prepare(
        `
        UPDATE BitcoinLockCoupons
        SET relayRequestId = $relayRequestId, relayJson = $relayJson, updatedAt = $updatedAt
        WHERE id = $id
        RETURNING *
      `,
      )
      .get(
        toSqliteParams({
          id,
          relayRequestId: relay.requestId,
          relayJson: relay,
          updatedAt: new Date(),
        }),
      ) as SqlRow | undefined;
    if (!record) throw new RouterError('Bitcoin lock coupon not found.', 404);
    return this.map(record);
  }

  public updateExpiration(id: number, expirationTick: number): IBitcoinLockCouponRow {
    const record = this.db.sql
      .prepare(
        `
        UPDATE BitcoinLockCoupons
        SET expirationTick = $expirationTick, updatedAt = $updatedAt
        WHERE id = $id
        RETURNING *
      `,
      )
      .get(toSqliteParams({ id, expirationTick, updatedAt: new Date() })) as SqlRow | undefined;
    if (!record) throw new RouterError('Bitcoin lock coupon not found.', 404);
    return this.map(record);
  }

  public insertUse(
    use: Omit<IBitcoinLockCouponUseRecord, 'id' | 'status' | 'feeCoupon' | 'relay' | 'createdAt' | 'updatedAt'>,
  ): IBitcoinLockCouponUseRecord {
    return this.db.transaction(() => {
      const existing = this.fetchUseByRequestId(use.requestId);
      if (existing) return existing;

      const coupon = this.fetchById(use.couponId);
      if (!coupon?.feeCreditMicrogons) throw new RouterError('Bitcoin fee credit is not available.', 409);

      // Fee coupons use the beneficiary's next on-chain nonce, so only one can remain unfinalized per member.
      const activeUse = this.db.sql
        .prepare(
          `
          SELECT 1
          FROM BitcoinLockCouponUses
          JOIN BitcoinLockCoupons ON BitcoinLockCoupons.id = BitcoinLockCouponUses.couponId
          WHERE BitcoinLockCoupons.userId = $userId
            AND BitcoinLockCouponUses.status IN ('Prepared', 'Submitted', 'InBlock')
          LIMIT 1
        `,
        )
        .get({ $userId: coupon.userId });
      if (activeUse) throw new RouterError('This member already has a Bitcoin lock in progress.', 409);

      if (this.getAllocatedFeeCreditMicrogons(use.couponId) + use.feeCreditMicrogons > coupon.feeCreditMicrogons) {
        throw new RouterError('This Bitcoin fee credit does not have enough remaining.', 409);
      }

      const record = this.db.sql
        .prepare(
          `
          INSERT INTO BitcoinLockCouponUses (
            couponId, requestId, status, feeCreditMicrogons, requestedSatoshis,
            ownerAccountId, ownerBitcoinPubkey, microgonsAtTargetPerBtc
          ) VALUES (
            $couponId, $requestId, 'Prepared', $feeCreditMicrogons, $requestedSatoshis,
            $ownerAccountId, $ownerBitcoinPubkey, $microgonsAtTargetPerBtc
          )
          RETURNING *
        `,
        )
        .get(toSqliteParams(use)) as SqlRow;
      this.db.sql
        .prepare('UPDATE BitcoinLockCoupons SET updatedAt = $updatedAt WHERE id = $couponId')
        .run(toSqliteParams({ couponId: use.couponId, updatedAt: new Date() }));
      return this.mapUse(record);
    });
  }

  public fetchUseByRequestId(requestId: string): IBitcoinLockCouponUseRecord | null {
    const record = this.db.sql
      .prepare('SELECT * FROM BitcoinLockCouponUses WHERE requestId = $requestId LIMIT 1')
      .get({ $requestId: requestId }) as SqlRow | undefined;
    return record ? this.mapUse(record) : null;
  }

  public fetchUsesByCouponId(couponId: number): IBitcoinLockCouponUseRecord[] {
    const records = this.db.sql
      .prepare('SELECT * FROM BitcoinLockCouponUses WHERE couponId = $couponId ORDER BY id ASC')
      .all({ $couponId: couponId }) as SqlRow[];
    return records.map(record => this.mapUse(record));
  }

  public fetchNonTerminalUses(couponId?: number): IBitcoinLockCouponUseRecord[] {
    const records = this.db.sql
      .prepare(
        `
        SELECT * FROM BitcoinLockCouponUses
        WHERE status IN ('Prepared', 'Submitted', 'InBlock')
          AND ($couponId IS NULL OR couponId = $couponId)
        ORDER BY id ASC
      `,
      )
      .all(toSqliteParams({ couponId })) as SqlRow[];
    return records.map(record => this.mapUse(record));
  }

  public recordInitializationAuthorization(
    requestId: string,
    authorization: Pick<
      IBitcoinLockCouponUseRecord,
      'feeCreditMicrogons' | 'requestedSatoshis' | 'microgonsAtTargetPerBtc' | 'feeCoupon'
    >,
  ): IBitcoinLockCouponUseRecord {
    return this.db.transaction(() => {
      const current = this.fetchUseByRequestId(requestId);
      if (!current) throw new RouterError('Bitcoin fee credit use not found.', 404);

      const coupon = this.fetchById(current.couponId);
      if (!coupon?.feeCreditMicrogons) throw new RouterError('Bitcoin fee credit is not available.', 409);
      if (coupon.expirationTick != null && MiningFrames.calculateCurrentTickFromSystemTime() >= coupon.expirationTick) {
        throw new RouterError('This bitcoin lock coupon has expired.', 400);
      }
      if (current.status !== 'Prepared') {
        throw new RouterError('This Bitcoin lock initialization can no longer be changed.', 409);
      }

      const reservedFeeCreditMicrogons = bigIntMax(authorization.feeCreditMicrogons, current.feeCreditMicrogons);
      if (
        this.getAllocatedFeeCreditMicrogons(current.couponId, requestId) + reservedFeeCreditMicrogons >
        coupon.feeCreditMicrogons
      ) {
        throw new RouterError('This Bitcoin fee credit does not have enough remaining.', 409);
      }

      const updatedAt = new Date();
      const { feeCoupon, ...fields } = authorization;
      const record = this.db.sql
        .prepare(
          `
          UPDATE BitcoinLockCouponUses
          SET feeCreditMicrogons = $feeCreditMicrogons,
              requestedSatoshis = $requestedSatoshis,
              microgonsAtTargetPerBtc = $microgonsAtTargetPerBtc,
              feeCouponJson = $feeCouponJson,
              updatedAt = $updatedAt
          WHERE requestId = $requestId
          RETURNING *
        `,
        )
        .get(
          toSqliteParams({
            ...fields,
            requestId,
            feeCreditMicrogons: reservedFeeCreditMicrogons,
            feeCouponJson: feeCoupon,
            updatedAt,
          }),
        ) as SqlRow;
      this.db.sql
        .prepare('UPDATE BitcoinLockCoupons SET updatedAt = $updatedAt WHERE id = $couponId')
        .run(toSqliteParams({ couponId: current.couponId, updatedAt }));
      return this.mapUse(record);
    });
  }

  public failUnsignedPreparedUses(): void {
    this.db.transaction(() => {
      const updatedAt = new Date();
      this.db.sql
        .prepare(
          `
          UPDATE BitcoinLockCouponUses
          SET status = 'Failed', updatedAt = $updatedAt
          WHERE status = 'Prepared' AND feeCouponJson IS NULL
        `,
        )
        .run(toSqliteParams({ updatedAt }));
      this.db.sql
        .prepare(
          `
          UPDATE BitcoinLockCoupons
          SET updatedAt = $updatedAt
          WHERE id IN (
            SELECT couponId FROM BitcoinLockCouponUses
            WHERE status = 'Failed' AND updatedAt = $updatedAt
          )
        `,
        )
        .run(toSqliteParams({ updatedAt }));
    });
  }

  public recordUse(
    requestId: string,
    update: Pick<IBitcoinLockCouponUseRecord, 'status'>,
  ): IBitcoinLockCouponUseRecord {
    const current = this.fetchUseByRequestId(requestId);
    if (!current) throw new RouterError('Bitcoin fee credit use not found.', 404);
    if (current.status === 'Finalized' || current.status === 'Failed') return current;

    return this.db.transaction(() => {
      const updatedAt = new Date();
      const record = this.db.sql
        .prepare(
          `
        UPDATE BitcoinLockCouponUses
        SET status = $status,
            updatedAt = $updatedAt
        WHERE requestId = $requestId
        RETURNING *
      `,
        )
        .get(
          toSqliteParams({
            requestId,
            status: update.status,
            updatedAt,
          }),
        ) as SqlRow;
      this.db.sql
        .prepare('UPDATE BitcoinLockCoupons SET updatedAt = $updatedAt WHERE id = $couponId')
        .run(toSqliteParams({ couponId: current.couponId, updatedAt }));
      return this.mapUse(record);
    });
  }

  public restoreUse(
    couponId: number,
    use: Omit<IBitcoinLockCouponUseRecord, 'id' | 'couponId'>,
  ): IBitcoinLockCouponUseRecord {
    const existing = this.fetchUseByRequestId(use.requestId);
    if (existing) return existing;

    const { feeCoupon, relay, ...fields } = use;
    if (fields.status === 'Prepared' && !feeCoupon) fields.status = 'Failed';
    const record = this.db.sql
      .prepare(
        `
        INSERT INTO BitcoinLockCouponUses (
          couponId, requestId, status, feeCreditMicrogons, requestedSatoshis,
          ownerAccountId, ownerBitcoinPubkey, microgonsAtTargetPerBtc,
          feeCouponJson, relayJson, createdAt, updatedAt
        ) VALUES (
          $couponId, $requestId, $status, $feeCreditMicrogons, $requestedSatoshis,
          $ownerAccountId, $ownerBitcoinPubkey, $microgonsAtTargetPerBtc,
          $feeCouponJson, $relayJson, $createdAt, $updatedAt
        )
        RETURNING *
      `,
      )
      .get(toSqliteParams({ ...fields, couponId, feeCouponJson: feeCoupon, relayJson: relay })) as SqlRow;
    return this.mapUse(record);
  }

  private getAllocatedFeeCreditMicrogons(couponId: number, excludingRequestId?: string): bigint {
    const record = this.db.sql
      .prepare(
        `
        SELECT COALESCE(SUM(CAST(feeCreditMicrogons AS INTEGER)), 0) AS amount
        FROM BitcoinLockCouponUses
        WHERE couponId = $couponId
          AND status != 'Failed'
          AND ($excludingRequestId IS NULL OR requestId != $excludingRequestId)
      `,
      )
      .get(toSqliteParams({ couponId, excludingRequestId })) as { amount: number | bigint };
    return BigInt(record.amount);
  }

  private map(record: SqlRow): IBitcoinLockCouponRow {
    const mapped = convertFromSqliteFields<
      Omit<IBitcoinLockCouponRow, 'feeCoupon' | 'relay'> & {
        feeCouponJson?: IBitcoinLockCouponRecord['feeCoupon'] | null;
        relayJson?: IBitcoinLockRelayRecord | null;
      }
    >(record, {
      bigint: ['maxSatoshis', 'feeCreditMicrogons'],
      date: ['usedAt', 'createdAt', 'updatedAt'],
      json: ['feeCouponJson', 'relayJson'],
    });
    const { feeCouponJson, relayJson, ...coupon } = mapped;
    return {
      ...coupon,
      feeCoupon: feeCouponJson ?? undefined,
      relay: relayJson ?? undefined,
    };
  }

  private mapUse(record: SqlRow): IBitcoinLockCouponUseRecord {
    const mapped = convertFromSqliteFields<
      Omit<IBitcoinLockCouponUseRecord, 'feeCoupon' | 'relay'> & {
        feeCouponJson?: IBitcoinLockCouponUseRecord['feeCoupon'] | null;
        relayJson?: IBitcoinLockRelayRecord | null;
      }
    >(record, {
      bigint: ['feeCreditMicrogons', 'requestedSatoshis', 'microgonsAtTargetPerBtc'],
      date: ['createdAt', 'updatedAt'],
      json: ['feeCouponJson', 'relayJson'],
    });
    const { feeCouponJson, relayJson, ...use } = mapped;
    return {
      ...use,
      feeCoupon: feeCouponJson ?? undefined,
      relay: relayJson ?? undefined,
    };
  }
}
