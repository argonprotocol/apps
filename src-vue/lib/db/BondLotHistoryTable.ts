import type { BondLot } from '@argonprotocol/apps-core';
import { convertFromSqliteFields, toSqlParams } from '../Utils.ts';
import { BaseTable, type IFieldTypes } from './BaseTable.ts';

export interface IBondLotFlexibilityTransition {
  isFlexible: boolean;
  cumulativeEarningsMicrogons: bigint;
  source: 'purchase' | 'flexibility-change' | 'release';
  blockNumber: number;
  blockHash: string;
  blockTime: Date;
  extrinsicIndex?: number;
  eventIndex?: number;
}

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
  flexibilityHistory: IBondLotFlexibilityTransition[];
  flexibilityHistoryComplete: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export class BondLotHistoryTable extends BaseTable {
  private fields: IFieldTypes = {
    boolean: ['flexibilityHistoryComplete'] satisfies (keyof IBondLotHistoryRecord)[],
    bigint: [
      'nativePrincipal',
      'entryArgonotRateMicrogons',
      'cumulativeEarningsMicrogons',
      'closingArgonotRateMicrogons',
    ] satisfies (keyof IBondLotHistoryRecord)[],
    date: ['purchaseBlockTime', 'releaseBlockTime', 'createdAt', 'updatedAt'] satisfies (keyof IBondLotHistoryRecord)[],
    json: ['flexibilityHistory'] satisfies (keyof IBondLotHistoryRecord)[],
  };

  public async fetchAll(accountId: string): Promise<IBondLotHistoryRecord[]> {
    const records = await this.db.select<IBondLotHistoryRecord[]>(
      `SELECT * FROM BondLotHistory
       WHERE accountId = ?
       ORDER BY bondLotId`,
      toSqlParams([accountId]),
    );
    const history = convertFromSqliteFields<IBondLotHistoryRecord[]>(records, this.fields);
    for (const record of history) {
      record.flexibilityHistory.sort(
        (left, right) =>
          left.blockNumber - right.blockNumber ||
          (left.extrinsicIndex ?? -1) - (right.extrinsicIndex ?? -1) ||
          (left.eventIndex ?? -1) - (right.eventIndex ?? -1),
      );
    }
    return history;
  }

  public async recordFlexibility(lot: BondLot, transition: IBondLotFlexibilityTransition): Promise<void> {
    const nativePrincipal = lot.principalMicrogons;
    if (lot.programType !== 'Vault' || nativePrincipal === undefined || lot.vaultId === undefined) {
      throw new Error(`Flexible bond lot ${lot.id} is not attached to a vault`);
    }

    await this.db.execute(
      `INSERT INTO BondLotHistory (
         accountId, programType, bondLotId, vaultId, nativeAsset, nativePrincipal, createdFrame,
         firstObservedBlockNumber, firstObservedBlockHash, flexibilityHistory
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(accountId, programType, bondLotId) DO UPDATE SET
         flexibilityHistory = json_insert(BondLotHistory.flexibilityHistory, '$[#]', json(?)),
         updatedAt = CURRENT_TIMESTAMP
       WHERE NOT EXISTS (
         SELECT 1 FROM json_each(BondLotHistory.flexibilityHistory)
         WHERE json_extract(value, '$.blockHash') = ?
           AND json_extract(value, '$.extrinsicIndex') IS ?
           AND json_extract(value, '$.eventIndex') IS ?
           AND json_extract(value, '$.source') = ?
           AND json_extract(value, '$.isFlexible') = ?
       )`,
      toSqlParams([
        lot.accountId,
        lot.programType,
        lot.id,
        lot.vaultId,
        lot.nativeAsset,
        nativePrincipal,
        lot.createdFrame,
        transition.blockNumber,
        transition.blockHash,
        [transition],
        transition,
        transition.blockHash,
        transition.extrinsicIndex,
        transition.eventIndex,
        transition.source,
        transition.isFlexible,
      ]),
    );
  }

  public async confirmFlexibilityHistory(accountId: string, bondLotId?: number): Promise<void> {
    await this.db.execute(
      `UPDATE BondLotHistory SET flexibilityHistoryComplete = 1, updatedAt = CURRENT_TIMESTAMP
       WHERE accountId = ? AND (? IS NULL OR bondLotId = ?)`,
      toSqlParams([accountId, bondLotId, bondLotId]),
    );
  }

  public async recordReleaseSchedule(args: { lot: BondLot; blockNumber: number; blockHash: string }): Promise<void> {
    const { lot, blockNumber, blockHash } = args;
    const nativePrincipal = lot.principalMicrogons ?? lot.principalMicronots;
    if (nativePrincipal === undefined) return;

    await this.db.execute(
      `INSERT INTO BondLotHistory (
         accountId, programType, bondLotId, vaultId, nativeAsset, nativePrincipal, createdFrame,
         firstObservedBlockNumber, firstObservedBlockHash, releaseFrame, releaseReason,
         participatedFrames, cumulativeEarningsMicrogons
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(accountId, programType, bondLotId) DO UPDATE SET
         releaseFrame = COALESCE(BondLotHistory.releaseFrame, excluded.releaseFrame),
         releaseReason = COALESCE(BondLotHistory.releaseReason, excluded.releaseReason),
         updatedAt = CURRENT_TIMESTAMP
       WHERE BondLotHistory.releaseBlockNumber IS NULL`,
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
        lot.releaseFrame,
        lot.releaseReason,
        lot.participatedFrames,
        lot.lifetimeEarnings,
      ]),
    );
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
       ${purchase ? '' : 'WHERE BondLotHistory.releaseBlockNumber IS NULL'}
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
