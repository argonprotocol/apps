import { IFrameRecord } from '../../interfaces/db/IFrameRecord';
import { BaseTable, IFieldTypes } from './BaseTable';
import { convertFromSqliteFields, toSqlParams } from '../Utils';
import { bigNumberToBigInt, NetworkConfig } from '@argonprotocol/apps-core';
import BigNumber from 'bignumber.js';
import dayjs from 'dayjs';
import utc from 'dayjs/plugin/utc';
import { TICK_MILLIS } from '../Env.ts';
import { IDashboardFrameStats } from '../../interfaces/IStats.ts';
import { Currency } from '../Currency.ts';

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

  public async fetchLastYear(currency: Currency): Promise<Omit<IDashboardFrameStats, 'score' | 'expected'>[]> {
    const rawRecords = await this.db.select<any[]>(`SELECT 
      id, firstTick, microgonToUsd, microgonToArgonot, allMinersCount, seatCountActive, accruedMicrogonProfits, seatCostTotalFramed, blocksMinedTotal, micronotsMinedTotal, microgonsMinedTotal, microgonsMintedTotal, progress
    FROM Frames ORDER BY id DESC LIMIT 365`);

    const records = convertFromSqliteFields<IDashboardFrameStats[]>(rawRecords, this.fieldTypes)
      .map((x: any) => {
        const date = dayjs.utc(x.firstTick * TICK_MILLIS).format('YYYY-MM-DD');

        const microgonValueEarnedBn = BigNumber(x.microgonsMinedTotal)
          .plus(x.microgonsMintedTotal)
          .plus(currency.micronotToMicrogon(x.micronotsMinedTotal));
        const microgonValueOfRewards = bigNumberToBigInt(microgonValueEarnedBn);
        const profitBn = BigNumber(microgonValueEarnedBn).minus(x.seatCostTotalFramed);
        const profitPctBn = x.seatCostTotalFramed
          ? profitBn.dividedBy(x.seatCostTotalFramed).multipliedBy(100)
          : BigNumber(0);

        if (isNaN(profitPctBn.toNumber())) {
          console.log('profitPctBn', profitPctBn.toNumber(), profitBn.toNumber(), x.seatCostTotalFramed);
        }

        const record: Omit<IDashboardFrameStats, 'score' | 'expected'> = {
          id: x.id,
          date,
          firstTick: x.firstTick,
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
          profit: profitBn.toNumber(),
          profitPct: profitPctBn.toNumber(),
        };

        return record;
      })
      .reverse();

    const ticksPerFrame = NetworkConfig.rewardTicksPerFrame;

    while (records.length < 365) {
      const earliestRecord = records[0];
      if (!earliestRecord) break;
      const previousDay = dayjs.utc(earliestRecord.date).subtract(1, 'day');
      if (previousDay.isBefore(dayjs.utc('2025-01-01'))) {
        break;
      }

      const blankRecord: Omit<IDashboardFrameStats, 'score' | 'expected'> = {
        id: 0,
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

  public async fetchAccruedProfits(): Promise<{ accruedMicrogonProfits: bigint; accruedMicronotProfits: bigint }> {
    const rawRecord = await this.db.select<{ accruedMicrogonProfits: number; accruedMicronotProfits: number }[]>(
      'SELECT accruedMicrogonProfits, accruedMicronotProfits FROM Frames ORDER BY id DESC LIMIT 1',
      [],
    );
    if (!rawRecord || rawRecord.length === 0) {
      return {
        accruedMicrogonProfits: 0n,
        accruedMicronotProfits: 0n,
      };
    }
    return convertFromSqliteFields(rawRecord[0], this.fieldTypes);
  }
}
