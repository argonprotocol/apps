import type { BondLot } from '@argonprotocol/apps-core';
import { convertFromSqliteFields, toSqlParams } from '../Utils.ts';
import { BaseTable, type IFieldTypes } from './BaseTable.ts';

export interface IBondLotHistoryRecord {
  id: number;
  accountId: string;
  programType: BondLot['programType'];
  bondLotId: number;
  vaultId?: number;
  nativeAsset: BondLot['nativeAsset'];
  nativePrincipal: bigint;
  createdFrame: number;
  firstObservedBlockNumber: number;
  firstObservedBlockHash: string;
  purchaseBlockNumber?: number;
  purchaseBlockHash?: string;
  purchaseBlockTime?: Date;
  purchaseExtrinsicIndex?: number;
  entryArgonotRateMicrogons?: bigint;
  releaseFrame?: number;
  releaseBlockNumber?: number;
  releaseBlockHash?: string;
  releaseBlockTime?: Date;
  releaseExtrinsicIndex?: number;
  releaseParentHash?: string;
  releaseReason?: string;
  participatedFrames?: number;
  cumulativeEarningsMicrogons?: bigint;
  closingArgonotRateMicrogons?: bigint;
  createdAt: Date;
  updatedAt: Date;
}

export class BondLotHistoryTable extends BaseTable {
  private fields: IFieldTypes = {
    bigint: [
      'nativePrincipal',
      'entryArgonotRateMicrogons',
      'cumulativeEarningsMicrogons',
      'closingArgonotRateMicrogons',
    ] satisfies (keyof IBondLotHistoryRecord)[],
    date: ['purchaseBlockTime', 'releaseBlockTime', 'createdAt', 'updatedAt'] satisfies (keyof IBondLotHistoryRecord)[],
  };

  public async fetchAll(accountId: string): Promise<IBondLotHistoryRecord[]> {
    const records = await this.db.select<IBondLotHistoryRecord[]>(
      `SELECT * FROM BondLotHistory
       WHERE accountId = ?
       ORDER BY bondLotId`,
      toSqlParams([accountId]),
    );
    return convertFromSqliteFields(records, this.fields);
  }

  public async recordObservation(args: {
    lot: BondLot;
    blockNumber: number;
    blockHash: string;
    purchase?: {
      blockTime: Date;
      extrinsicIndex?: number;
      entryArgonotRateMicrogons?: bigint;
    };
  }): Promise<IBondLotHistoryRecord | undefined> {
    const { lot, blockNumber, blockHash, purchase } = args;
    const nativePrincipal = lot.principalMicrogons ?? lot.principalMicronots;
    if (nativePrincipal === undefined) return;
    const updateFields = purchase
      ? `purchaseBlockNumber = excluded.purchaseBlockNumber,
         purchaseBlockHash = excluded.purchaseBlockHash,
         purchaseBlockTime = excluded.purchaseBlockTime,
         purchaseExtrinsicIndex = excluded.purchaseExtrinsicIndex,
         entryArgonotRateMicrogons = COALESCE(
           excluded.entryArgonotRateMicrogons,
           BondLotHistory.entryArgonotRateMicrogons
         )`
      : `releaseFrame = excluded.releaseFrame,
         releaseReason = excluded.releaseReason,
         participatedFrames = excluded.participatedFrames,
         cumulativeEarningsMicrogons = excluded.cumulativeEarningsMicrogons`;

    const records = await this.db.select<IBondLotHistoryRecord[]>(
      `INSERT INTO BondLotHistory (
         accountId,
         programType,
         bondLotId,
         vaultId,
         nativeAsset,
         nativePrincipal,
         createdFrame,
         firstObservedBlockNumber,
         firstObservedBlockHash,
         purchaseBlockNumber,
         purchaseBlockHash,
         purchaseBlockTime,
         purchaseExtrinsicIndex,
         entryArgonotRateMicrogons,
         releaseFrame,
         releaseReason,
         participatedFrames,
         cumulativeEarningsMicrogons
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(accountId, programType, bondLotId) DO UPDATE SET
         ${updateFields},
         updatedAt = CURRENT_TIMESTAMP
      RETURNING *`,
      toSqlParams([
        lot.accountId,
        lot.programType,
        lot.id,
        lot.vaultId,
        lot.nativeAsset,
        nativePrincipal,
        lot.createdFrame,
        blockNumber,
        blockHash,
        purchase ? blockNumber : undefined,
        purchase ? blockHash : undefined,
        purchase?.blockTime,
        purchase?.extrinsicIndex,
        purchase?.entryArgonotRateMicrogons,
        lot.releaseFrame,
        lot.releaseReason,
        lot.participatedFrames,
        lot.lifetimeEarnings,
      ]),
    );
    return convertFromSqliteFields<IBondLotHistoryRecord[]>(records, this.fields)[0];
  }

  public async recordRelease(args: {
    lot: BondLot;
    parentBlockNumber: number;
    parentBlockHash: string;
    release: {
      blockNumber: number;
      blockHash: string;
      blockTime: Date;
      extrinsicIndex?: number;
      closingArgonotRateMicrogons?: bigint;
    };
  }): Promise<IBondLotHistoryRecord | undefined> {
    const { lot, parentBlockNumber, parentBlockHash, release } = args;
    const nativePrincipal = lot.principalMicrogons ?? lot.principalMicronots;
    if (nativePrincipal === undefined) return;

    const records = await this.db.select<IBondLotHistoryRecord[]>(
      `INSERT INTO BondLotHistory (
         accountId,
         programType,
         bondLotId,
         vaultId,
         nativeAsset,
         nativePrincipal,
         createdFrame,
         firstObservedBlockNumber,
         firstObservedBlockHash,
         releaseFrame,
         releaseBlockNumber,
         releaseBlockHash,
         releaseBlockTime,
         releaseExtrinsicIndex,
         releaseParentHash,
         releaseReason,
         participatedFrames,
         cumulativeEarningsMicrogons,
         closingArgonotRateMicrogons
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(accountId, programType, bondLotId) DO UPDATE SET
         (releaseFrame, releaseBlockNumber, releaseBlockHash, releaseBlockTime, releaseExtrinsicIndex,
          releaseParentHash, releaseReason, participatedFrames, cumulativeEarningsMicrogons,
          closingArgonotRateMicrogons, updatedAt) =
         (excluded.releaseFrame, excluded.releaseBlockNumber, excluded.releaseBlockHash,
          excluded.releaseBlockTime, excluded.releaseExtrinsicIndex, excluded.releaseParentHash,
          excluded.releaseReason, excluded.participatedFrames, excluded.cumulativeEarningsMicrogons,
          excluded.closingArgonotRateMicrogons, CURRENT_TIMESTAMP)
       WHERE BondLotHistory.releaseBlockNumber IS NULL
      RETURNING *`,
      toSqlParams([
        lot.accountId,
        lot.programType,
        lot.id,
        lot.vaultId,
        lot.nativeAsset,
        nativePrincipal,
        lot.createdFrame,
        parentBlockNumber,
        parentBlockHash,
        lot.releaseFrame,
        release.blockNumber,
        release.blockHash,
        release.blockTime,
        release.extrinsicIndex,
        parentBlockHash,
        lot.releaseReason,
        lot.participatedFrames,
        lot.lifetimeEarnings,
        release.closingArgonotRateMicrogons,
      ]),
    );
    return convertFromSqliteFields<IBondLotHistoryRecord[]>(records, this.fields)[0];
  }
}
