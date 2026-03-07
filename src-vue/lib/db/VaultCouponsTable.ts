import { convertFromSqliteFields, toSqlParams } from '../Utils.ts';
import { BaseTable, IFieldTypes } from './BaseTable.ts';

export interface IVaultCouponRecord {
  id: number;
  vaultId: number;
  txId: number;
  label: string;
  publicKey: string;
  privateKey: string;
  maxSatoshis: bigint;
  createdAt: Date;
  updatedAt: Date;
}

// eslint-disable-next-line @typescript-eslint/no-redundant-type-constituents
type IVaultCouponRecordKey = keyof IVaultCouponRecord & string;

export class VaultCouponsTable extends BaseTable {
  private bigIntFields: IVaultCouponRecordKey[] = ['maxSatoshis'];
  private dateFields: IVaultCouponRecordKey[] = ['createdAt', 'updatedAt'];

  private get fields(): IFieldTypes {
    return {
      bigint: this.bigIntFields,
      date: this.dateFields,
    };
  }

  public async fetchByVaultId(vaultId: number): Promise<IVaultCouponRecord[]> {
    const records = await this.db.select<IVaultCouponRecord[]>(
      'SELECT * FROM VaultCoupons WHERE vaultId = ? ORDER BY createdAt DESC, id DESC',
      toSqlParams([vaultId]),
    );
    return convertFromSqliteFields(records, this.fields);
  }

  public async insert(
    args: Pick<IVaultCouponRecord, 'vaultId' | 'txId' | 'label' | 'publicKey' | 'privateKey' | 'maxSatoshis'>,
  ): Promise<IVaultCouponRecord> {
    const records = await this.db.select<IVaultCouponRecord[]>(
      `INSERT INTO VaultCoupons (
          vaultId, txId, label, publicKey, privateKey, maxSatoshis
        ) VALUES (
          ?, ?, ?, ?, ?, ?
        ) RETURNING *`,
      toSqlParams([args.vaultId, args.txId, args.label, args.publicKey, args.privateKey, args.maxSatoshis]),
    );
    const normalizedRecords = convertFromSqliteFields<IVaultCouponRecord[]>(records, this.fields);
    const record = normalizedRecords[0];
    if (!record) {
      throw new Error('Failed to insert vault coupon');
    }
    return record;
  }
}
