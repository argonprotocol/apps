import { BaseTable, IFieldTypes } from './BaseTable';
import { convertFromSqliteFields, convertSqliteBigInts, toSqlParams } from '../Utils';
import { Currency, getPercent, MiningFrames, NetworkConfig } from '@argonprotocol/apps-core';
import dayjs from 'dayjs';
import utc from 'dayjs/plugin/utc';
import { IDashboardFrameStats } from '../../interfaces/IMiningSeatStats.ts';

dayjs.extend(utc);

export class FramesTable extends BaseTable {
  private processedFrames: { [frameId: number]: boolean } = {};
  private fieldTypes: IFieldTypes = {
    boolean: ['isProcessed'],
    bigintJson: ['microgonToUsd', 'microgonToBtc', 'microgonToArgonot'],
    bigint: [
      'seatCostTotalFramed',
      'microgonsMinedTotal',
      'microgonsMintedTotal',
      'micronotsMinedTotal',
      'microgonFeesCollectedTotal',
      'accruedMicrogonProfits',
      'accruedMicronotProfits',
    ],
  };

  public override async loadState(): Promise<void> {
    const processedFrames = await this.db.select<{ id: number }[]>(
      `SELECT id from Frames WHERE isProcessed = 1 ORDER BY id ASC`,
    );
    for (const frame of processedFrames) {
      this.processedFrames[frame.id] = true;
    }
  }

  public async insertOrUpdate(data: {
    id: number;
    firstTick: number;
    rewardTicksRemaining: number;
    firstBlockNumber: number;
    lastBlockNumber: number;
    microgonToUsd: bigint[];
    microgonToBtc: bigint[];
    microgonToArgonot: bigint[];
    accruedMicrogonProfits: bigint;
    accruedMicronotProfits: bigint;
    progress: number;
  }): Promise<void> {
    const {
      id,
      firstTick,
      rewardTicksRemaining,
      firstBlockNumber,
      lastBlockNumber,
      microgonToUsd,
      microgonToBtc,
      microgonToArgonot,
      accruedMicrogonProfits,
      accruedMicronotProfits,
      progress,
    } = data;
    await this.db.execute(
      `INSERT INTO Frames (
          id, firstTick, rewardTicksRemaining, firstBlockNumber, lastBlockNumber, microgonToUsd, microgonToBtc, microgonToArgonot,
          accruedMicrogonProfits, accruedMicronotProfits, progress, isProcessed
        ) VALUES (
          ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
        ) ON CONFLICT(id) DO UPDATE SET 
          firstTick = excluded.firstTick,
          rewardTicksRemaining = excluded.rewardTicksRemaining, 
          firstBlockNumber = excluded.firstBlockNumber, 
          lastBlockNumber = excluded.lastBlockNumber, 
          microgonToUsd = excluded.microgonToUsd, 
          microgonToBtc = excluded.microgonToBtc, 
          microgonToArgonot = excluded.microgonToArgonot,
          accruedMicrogonProfits = excluded.accruedMicrogonProfits,
          accruedMicronotProfits = excluded.accruedMicronotProfits,
          progress = excluded.progress, 
          isProcessed = excluded.isProcessed
      `,
      toSqlParams([
        id,
        firstTick,
        rewardTicksRemaining,
        firstBlockNumber,
        lastBlockNumber,
        microgonToUsd,
        microgonToBtc,
        microgonToArgonot,
        accruedMicrogonProfits,
        accruedMicronotProfits,
        progress,
        false,
      ]),
    );
  }

  public async update(args: {
    id: number;
    allMinersCount: number;
    seatCountActive: number;
    seatCostTotalFramed: bigint;
    blocksMinedTotal: number;
    micronotsMinedTotal: bigint;
    microgonsMinedTotal: bigint;
    microgonsMintedTotal: bigint;
    microgonFeesCollectedTotal: bigint;
    isProcessed: boolean;
  }): Promise<void> {
    const {
      id,
      allMinersCount,
      seatCountActive,
      seatCostTotalFramed,
      blocksMinedTotal,
      micronotsMinedTotal,
      microgonsMinedTotal,
      microgonsMintedTotal,
      microgonFeesCollectedTotal,
      isProcessed,
    } = args;
    if (isProcessed) {
      this.processedFrames[id] = true;
    }
    await this.db.execute(
      `UPDATE Frames SET 
        allMinersCount = ?,
        seatCountActive = ?, 
        seatCostTotalFramed = ?,
        blocksMinedTotal = ?,
        micronotsMinedTotal = ?,
        microgonsMinedTotal = ?,
        microgonsMintedTotal = ?,
        microgonFeesCollectedTotal = ?,
        isProcessed = ? 
      WHERE id = ?`,
      toSqlParams([
        allMinersCount,
        seatCountActive,
        seatCostTotalFramed,
        blocksMinedTotal,
        micronotsMinedTotal,
        microgonsMinedTotal,
        microgonsMintedTotal,
        microgonFeesCollectedTotal,
        isProcessed,
        id,
      ]),
    );
  }

  public async fetchLastProcessedFrame(): Promise<number> {
    const latest = await this.db.select<{ maxId: number }[]>(
      'SELECT MAX(id) as maxId FROM Frames WHERE isProcessed = 1',
    );
    return latest[0]?.maxId || 0;
  }

  public async fetchExistingCompleteSince(frameId: number, limit = 10): Promise<number[]> {
    if (this.processedFrames[frameId]) {
      const completedFrames = [];

      for (let id = frameId; id < frameId + limit + 1; id++) {
        if (!this.processedFrames[id]) {
          break;
        }
        completedFrames.push(id);
      }
      return completedFrames;
    }

    const frames = await this.db.select<{ id: number }[]>(
      'SELECT id FROM Frames WHERE id >= ? AND isProcessed = 1 ORDER BY id ASC LIMIT ?',
      [frameId, limit + 1],
    );
    return frames.map(frame => frame.id);
  }

  public async fetchArgonotPricesNearFrame(
    frameId: number,
    range = NetworkConfig.framesPerCohort,
  ): Promise<{ id: number; microgonToArgonot: bigint[] }[]> {
    const records = await this.db.select<{ id: number; microgonToArgonot: string }[]>(
      `SELECT id, microgonToArgonot
      FROM Frames
      WHERE id BETWEEN ? AND ?
      ORDER BY id ASC`,
      [frameId - range, frameId + range],
    );
    return convertFromSqliteFields(records, this.fieldTypes);
  }

  public async fetchLastYear(
    miningFrames: MiningFrames,
    liveArgonotPrice: bigint,
  ): Promise<Omit<IDashboardFrameStats, 'score' | 'expected'>[]> {
    const rawRecords = await this.db.select<any[]>(`SELECT 
      id, firstTick, microgonToUsd, microgonToArgonot, allMinersCount, seatCountActive, accruedMicrogonProfits, 
      seatCostTotalFramed, blocksMinedTotal, micronotsMinedTotal, microgonFeesCollectedTotal,
      microgonsMinedTotal, microgonsMintedTotal, progress
      FROM Frames ORDER BY id DESC LIMIT 365
      `);

    await miningFrames.load();

    let previousArgonotPrice = liveArgonotPrice;
    const records = convertFromSqliteFields<IDashboardFrameStats[]>(rawRecords, this.fieldTypes)
      .reverse()
      .map(x => {
        const miningFrame = miningFrames.framesById[x.id];
        const fallbackDate = new Date(x.firstTick * NetworkConfig.tickMillis);
        const dateStart = miningFrame?.dateStart ?? fallbackDate;
        const argonotPrice = x.microgonToArgonot.at(-1) || previousArgonotPrice;
        if (argonotPrice > 0n) previousArgonotPrice = argonotPrice;
        const microgonValueOfRewards = Currency.microgonValueOfMiningRewards({
          microgonsMined: x.microgonsMinedTotal,
          microgonsMinted: x.microgonsMintedTotal,
          micronotsMined: x.micronotsMinedTotal,
          argonotPrice,
        });
        const profit = microgonValueOfRewards - x.seatCostTotalFramed;

        const record: Omit<IDashboardFrameStats, 'score' | 'expected'> = {
          id: x.id,
          date: dayjs.utc(dateStart).format('YYYY-MM-DD'),
          firstTick: miningFrame?.frameStartTick ?? x.firstTick,
          allMinersCount: x.allMinersCount,
          seatCountActive: x.seatCountActive,
          seatCostTotalFramed: x.seatCostTotalFramed,
          blocksMinedTotal: x.blocksMinedTotal,
          microgonToUsd: x.microgonToUsd,
          microgonToArgonot: x.microgonToArgonot,
          microgonsMinedTotal: x.microgonsMinedTotal,
          microgonsMintedTotal: x.microgonsMintedTotal,
          micronotsMinedTotal: x.micronotsMinedTotal,
          microgonFeesCollectedTotal: x.microgonFeesCollectedTotal,
          accruedMicrogonProfits: x.accruedMicrogonProfits,
          microgonValueOfRewards,
          progress: x.progress,
          profit: Number(profit),
          profitPct: getPercent(profit, x.seatCostTotalFramed),
        };

        return record;
      });

    const ticksPerFrame = NetworkConfig.rewardTicksPerFrame;

    while (records.length < 365) {
      const earliestRecord = records[0];
      if (!earliestRecord) break;
      const previousDay = dayjs.utc(earliestRecord.date).subtract(1, 'day');
      if (previousDay.isBefore(dayjs.utc('2025-01-01'))) {
        break;
      }

      const blankRecord: Omit<IDashboardFrameStats, 'score' | 'expected'> = {
        id: earliestRecord.id - 1,
        date: previousDay.format('YYYY-MM-DD'),
        firstTick: earliestRecord.firstTick - ticksPerFrame,
        allMinersCount: 0,
        seatCountActive: 0,
        seatCostTotalFramed: 0n,
        microgonToUsd: [0n],
        microgonToArgonot: [0n],
        blocksMinedTotal: 0,
        microgonsMinedTotal: 0n,
        microgonsMintedTotal: 0n,
        micronotsMinedTotal: 0n,
        microgonFeesCollectedTotal: 0n,
        microgonValueOfRewards: 0n,
        progress: 0,
        profit: 0,
        profitPct: 0,
        accruedMicrogonProfits: 0n,
      };
      records.unshift(blankRecord);
    }

    return records;
  }

  public async fetchProcessedCount(): Promise<number> {
    const [result] = await this.db.select<[{ count: number }]>(
      'SELECT COUNT(*) as count FROM Frames WHERE isProcessed = 1',
    );
    return result.count;
  }
}
