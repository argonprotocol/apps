import { BaseTable, IFieldTypes } from './BaseTable.ts';
import { convertFromSqliteFields, toSqlParams } from '../Utils.ts';

export interface IStableSwapMarketStateRecord {
  id: number;
  poolAddress: string;
  poolFee: number;
  poolLiquidity: bigint;
  currentPriceMicrogons: bigint;
  targetPriceMicrogons?: bigint;
  discountedEthereumArgonAmount: bigint;
  costToTargetMicrogons: bigint;
  projectedProfitMicrogons: bigint;
  createdAt: Date;
  updatedAt: Date;
}

type IStableSwapMarketStateRecordKey = keyof IStableSwapMarketStateRecord;

export class StableSwapMarketStateTable extends BaseTable {
  private bigIntFields: IStableSwapMarketStateRecordKey[] = [
    'poolLiquidity',
    'currentPriceMicrogons',
    'targetPriceMicrogons',
    'discountedEthereumArgonAmount',
    'costToTargetMicrogons',
    'projectedProfitMicrogons',
  ];
  private dateFields: IStableSwapMarketStateRecordKey[] = ['createdAt', 'updatedAt'];

  private get fields(): IFieldTypes {
    return {
      bigint: this.bigIntFields,
      date: this.dateFields,
    };
  }

  public async get(): Promise<IStableSwapMarketStateRecord | null> {
    const records = await this.db.select<IStableSwapMarketStateRecord[]>(
      `SELECT * FROM StableSwapMarketState WHERE id = 1 LIMIT 1`,
      [],
    );
    return convertFromSqliteFields<IStableSwapMarketStateRecord[]>(records, this.fields)[0] ?? null;
  }

  public async upsert(
    args: Omit<IStableSwapMarketStateRecord, 'id' | 'createdAt' | 'updatedAt'>,
  ): Promise<IStableSwapMarketStateRecord | undefined> {
    const {
      poolAddress,
      poolFee,
      poolLiquidity,
      currentPriceMicrogons,
      targetPriceMicrogons,
      discountedEthereumArgonAmount,
      costToTargetMicrogons,
      projectedProfitMicrogons,
    } = args;

    const records = await this.db.select<IStableSwapMarketStateRecord[]>(
      `INSERT INTO StableSwapMarketState (
         id,
         poolAddress,
         poolFee,
         poolLiquidity,
         currentPriceMicrogons,
         targetPriceMicrogons,
         discountedEthereumArgonAmount,
         costToTargetMicrogons,
         projectedProfitMicrogons
       ) VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         poolAddress = excluded.poolAddress,
         poolFee = excluded.poolFee,
         poolLiquidity = excluded.poolLiquidity,
         currentPriceMicrogons = excluded.currentPriceMicrogons,
         targetPriceMicrogons = excluded.targetPriceMicrogons,
         discountedEthereumArgonAmount = excluded.discountedEthereumArgonAmount,
         costToTargetMicrogons = excluded.costToTargetMicrogons,
         projectedProfitMicrogons = excluded.projectedProfitMicrogons,
         updatedAt = CURRENT_TIMESTAMP
       RETURNING *`,
      toSqlParams([
        poolAddress,
        poolFee,
        poolLiquidity,
        currentPriceMicrogons,
        targetPriceMicrogons,
        discountedEthereumArgonAmount,
        costToTargetMicrogons,
        projectedProfitMicrogons,
      ]),
    );

    return convertFromSqliteFields<IStableSwapMarketStateRecord[]>(records, this.fields)[0];
  }
}
