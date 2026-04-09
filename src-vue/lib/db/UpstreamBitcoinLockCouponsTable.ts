import { BaseTable, IFieldTypes } from './BaseTable.ts';
import { convertFromSqliteFields, toSqlParams } from '../Utils.ts';

export interface IUpstreamBitcoinLockCouponRecord {
  id: number;
  operatorHost: string;
  inviteCode: string;
  offerCode: string;
  vaultId: number;
  couponToken: string;
  expirationTick?: number;
  usedLockUuid?: string;
  usedAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

type IUpstreamBitcoinLockCouponKey = keyof IUpstreamBitcoinLockCouponRecord;

export class UpstreamBitcoinLockCouponsTable extends BaseTable {
  private dateFields: IUpstreamBitcoinLockCouponKey[] = ['usedAt', 'createdAt', 'updatedAt'];

  private get fields(): IFieldTypes {
    return {
      date: this.dateFields,
    };
  }

  public async upsert(
    coupon: Pick<
      IUpstreamBitcoinLockCouponRecord,
      'operatorHost' | 'inviteCode' | 'offerCode' | 'vaultId' | 'couponToken'
    > & {
      expirationTick?: number;
    },
  ): Promise<IUpstreamBitcoinLockCouponRecord | undefined> {
    const records = await this.db.select<IUpstreamBitcoinLockCouponRecord[]>(
      `INSERT INTO BitcoinLockCoupons (
         operatorHost,
         inviteCode,
         offerCode,
         vaultId,
         couponToken,
         expirationTick
       ) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(offerCode) DO UPDATE SET
         operatorHost = excluded.operatorHost,
         inviteCode = excluded.inviteCode,
         vaultId = excluded.vaultId,
         couponToken = excluded.couponToken,
         expirationTick = excluded.expirationTick,
         updatedAt = CURRENT_TIMESTAMP
       RETURNING *`,
      toSqlParams([
        coupon.operatorHost,
        coupon.inviteCode,
        coupon.offerCode,
        coupon.vaultId,
        coupon.couponToken,
        coupon.expirationTick,
      ]),
    );

    const coupons = convertFromSqliteFields<IUpstreamBitcoinLockCouponRecord[]>(records, this.fields);
    return coupons[0];
  }

  public async markUsed(offerCode: string, usedLockUuid: string): Promise<void> {
    await this.db.execute(
      `UPDATE BitcoinLockCoupons
       SET usedLockUuid = ?, usedAt = CURRENT_TIMESTAMP
       WHERE offerCode = ?`,
      toSqlParams([usedLockUuid, offerCode]),
    );
  }

  public async fetchByVault(vaultId: number): Promise<IUpstreamBitcoinLockCouponRecord[]> {
    const records = await this.db.select<IUpstreamBitcoinLockCouponRecord[]>(
      `SELECT *
       FROM BitcoinLockCoupons
        WHERE vaultId = ?
       ORDER BY updatedAt DESC, id DESC`,
      toSqlParams([vaultId]),
    );

    return convertFromSqliteFields<IUpstreamBitcoinLockCouponRecord[]>(records, this.fields);
  }
}
