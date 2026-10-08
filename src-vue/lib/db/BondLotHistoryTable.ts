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

export interface IBondLotEarningsBackfill {
  blockNumber: number;
  blockHash: string;
  eventIndex: number;
  addedFrames: number;
  addedEarnings: bigint;
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
  lastObservedBlockNumber: number;
  earningsDestination: BondLot['earningsDestination'];
  earningsBackfills: IBondLotEarningsBackfill[];
  earningsComplete: boolean;
  earningsHistoryThroughFrame?: number;
  createdAt: Date;
  updatedAt: Date;
}

export class BondLotHistoryTable extends BaseTable {
  private fields: IFieldTypes = {
    boolean: ['flexibilityHistoryComplete', 'earningsComplete'] satisfies (keyof IBondLotHistoryRecord)[],
    bigint: [
      'nativePrincipal',
      'entryArgonotRateMicrogons',
      'cumulativeEarningsMicrogons',
      'closingArgonotRateMicrogons',
    ] satisfies (keyof IBondLotHistoryRecord)[],
    date: ['purchaseBlockTime', 'releaseBlockTime', 'createdAt', 'updatedAt'] satisfies (keyof IBondLotHistoryRecord)[],
    json: ['flexibilityHistory', 'earningsBackfills'] satisfies (keyof IBondLotHistoryRecord)[],
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
        lot.owner,
        lot.programType,
        lot.id,
        lot.vaultId,
        lot.nativeAsset,
        nativePrincipal,
        lot.createdFrameId,
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
        lot.owner,
        lot.programType,
        lot.id,
        lot.vaultId,
        lot.nativeAsset,
        nativePrincipal,
        lot.createdFrameId,
        blockNumber,
        blockHash,
        lot.releaseFrameId,
        lot.releaseReason?.type,
        lot.participatedFrames,
        lot.cumulativeEarnings,
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
         releaseReason = excluded.releaseReason`;

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
         cumulativeEarningsMicrogons, lastObservedBlockNumber, earningsDestination
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(accountId, programType, bondLotId) DO UPDATE SET
         ${updateFields},
         participatedFrames = CASE WHEN excluded.lastObservedBlockNumber >= BondLotHistory.lastObservedBlockNumber
           THEN excluded.participatedFrames ELSE BondLotHistory.participatedFrames END,
         cumulativeEarningsMicrogons = CASE WHEN excluded.lastObservedBlockNumber >= BondLotHistory.lastObservedBlockNumber
           THEN excluded.cumulativeEarningsMicrogons ELSE BondLotHistory.cumulativeEarningsMicrogons END,
         earningsDestination = CASE WHEN excluded.lastObservedBlockNumber >= BondLotHistory.lastObservedBlockNumber
           THEN excluded.earningsDestination ELSE BondLotHistory.earningsDestination END,
         lastObservedBlockNumber = MAX(BondLotHistory.lastObservedBlockNumber, excluded.lastObservedBlockNumber),
         updatedAt = CURRENT_TIMESTAMP
       ${purchase ? '' : 'WHERE BondLotHistory.releaseBlockNumber IS NULL'}
      RETURNING *`,
      toSqlParams([
        lot.owner,
        lot.programType,
        lot.id,
        lot.vaultId,
        lot.nativeAsset,
        nativePrincipal,
        lot.createdFrameId,
        blockNumber,
        blockHash,
        purchase ? blockNumber : undefined,
        purchase ? blockHash : undefined,
        purchase?.blockTime,
        purchase?.extrinsicIndex,
        purchase?.entryArgonotRateMicrogons,
        lot.releaseFrameId,
        lot.releaseReason?.type,
        lot.participatedFrames,
        lot.cumulativeEarnings,
        blockNumber,
        lot.earningsDestination,
      ]),
    );
    return convertFromSqliteFields<IBondLotHistoryRecord[]>(records, this.fields)[0];
  }

  public async recordEarningsBackfill(lot: BondLot, backfill: IBondLotEarningsBackfill): Promise<void> {
    await this.db.execute(
      `UPDATE BondLotHistory SET
         earningsBackfills = json_insert(earningsBackfills, '$[#]', json(?)), updatedAt = CURRENT_TIMESTAMP
       WHERE accountId = ? AND programType = ? AND bondLotId = ?
         AND NOT EXISTS (SELECT 1 FROM json_each(earningsBackfills)
           WHERE json_extract(value, '$.blockHash') = ? AND json_extract(value, '$.eventIndex') = ?)`,
      toSqlParams([backfill, lot.owner, lot.programType, lot.id, backfill.blockHash, backfill.eventIndex]),
    );
  }

  public async recordEarningsCoverage(accountId: string, fromFrame: number, throughFrame: number): Promise<void> {
    await this.db.execute(
      `UPDATE BondLotHistory SET earningsHistoryThroughFrame = ?
       WHERE accountId = ? AND COALESCE(earningsHistoryThroughFrame, createdFrame - 1) >= ? - 1
         AND COALESCE(earningsHistoryThroughFrame, -1) < ?`,
      [throughFrame, accountId, fromFrame, throughFrame],
    );
  }

  public async recordRelease(args: {
    lot: BondLot;
    parentBlockNumber: number;
    parentBlockHash: string;
    release: {
      frameId?: number;
      blockNumber: number;
      blockHash: string;
      blockTime: Date;
      extrinsicIndex?: number;
      closingArgonotRateMicrogons?: bigint;
      earningsComplete?: boolean;
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
         closingArgonotRateMicrogons, lastObservedBlockNumber, earningsDestination, earningsComplete
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(accountId, programType, bondLotId) DO UPDATE SET
         (releaseFrame, releaseBlockNumber, releaseBlockHash, releaseBlockTime, releaseExtrinsicIndex,
          releaseParentHash, releaseReason, participatedFrames, cumulativeEarningsMicrogons,
          closingArgonotRateMicrogons, lastObservedBlockNumber, earningsDestination, earningsComplete, updatedAt) =
         (excluded.releaseFrame, excluded.releaseBlockNumber, excluded.releaseBlockHash,
          excluded.releaseBlockTime, excluded.releaseExtrinsicIndex, excluded.releaseParentHash,
          excluded.releaseReason, excluded.participatedFrames, excluded.cumulativeEarningsMicrogons,
          excluded.closingArgonotRateMicrogons, excluded.lastObservedBlockNumber,
          excluded.earningsDestination, excluded.earningsComplete, CURRENT_TIMESTAMP)
       WHERE BondLotHistory.releaseBlockNumber IS NULL
      RETURNING *`,
      toSqlParams([
        lot.owner,
        lot.programType,
        lot.id,
        lot.vaultId,
        lot.nativeAsset,
        nativePrincipal,
        lot.createdFrameId,
        parentBlockNumber,
        parentBlockHash,
        release.frameId ?? lot.releaseFrameId,
        release.blockNumber,
        release.blockHash,
        release.blockTime,
        release.extrinsicIndex,
        parentBlockHash,
        lot.releaseReason?.type,
        lot.participatedFrames,
        lot.cumulativeEarnings,
        release.closingArgonotRateMicrogons,
        release.blockNumber,
        lot.earningsDestination,
        release.earningsComplete ?? true,
      ]),
    );
    return convertFromSqliteFields<IBondLotHistoryRecord[]>(records, this.fields)[0];
  }
}
