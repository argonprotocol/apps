import { IFrameRecord } from '../../interfaces/db/IFrameRecord';
import { BaseTable, IFieldTypes } from './BaseTable';
import { convertFromSqliteFields, fromSqliteBigInt, toSqlParams } from '../Utils';
import { bigNumberToBigInt, MiningFrames } from '@argonprotocol/apps-core';
import BigNumber from 'bignumber.js';
import dayjs from 'dayjs';
import utc from 'dayjs/plugin/utc';
import { TICK_MILLIS } from '../Env.ts';
import { IDashboardFrameStats } from '../../interfaces/IStats.ts';

dayjs.extend(utc);

export class FramesTable extends BaseTable {
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

  async insertOrUpdate(
    id: number,
    firstTick: number,
    lastTick: number,
    firstBlockNumber: number,
    lastBlockNumber: number,
    microgonToUsd: bigint[],
    microgonToBtc: bigint[],
    microgonToArgonot: bigint[],
    progress: number,
    isProcessed: boolean,
  ): Promise<void> {
    await this.db.execute(
      `INSERT INTO Frames (
          id, firstTick, lastTick, firstBlockNumber, lastBlockNumber, microgonToUsd, microgonToBtc, microgonToArgonot, progress, isProcessed
        ) VALUES (
          ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
        ) ON CONFLICT(id) DO UPDATE SET 
          firstTick = excluded.firstTick, 
          lastTick = excluded.lastTick, 
          firstBlockNumber = excluded.firstBlockNumber, 
          lastBlockNumber = excluded.lastBlockNumber, 
          microgonToUsd = excluded.microgonToUsd, 
          microgonToBtc = excluded.microgonToBtc, 
          microgonToArgonot = excluded.microgonToArgonot, 
          progress = excluded.progress, 
          isProcessed = excluded.isProcessed
      `,
      toSqlParams([
        id,
        firstTick,
        lastTick,
        firstBlockNumber,
        lastBlockNumber,
        microgonToUsd,
        microgonToBtc,
        microgonToArgonot,
        progress,
        isProcessed,
      ]),
    );
  }

  async update(args: {
    id: number;
    firstTick: number;
    lastTick: number;
    firstBlockNumber: number;
    lastBlockNumber: number;
    microgonToUsd: bigint[];
    microgonToBtc: bigint[];
    microgonToArgonot: bigint[];
    allMinersCount: number;
    seatCountActive: number;
    seatCostTotalFramed: bigint;
    blocksMinedTotal: number;
    micronotsMinedTotal: bigint;
    microgonsMinedTotal: bigint;
    microgonsMintedTotal: bigint;
    microgonFeesCollectedTotal: bigint;
    accruedMicrogonProfits: bigint;
    accruedMicronotProfits: bigint;
    progress: number;
    isProcessed: boolean;
  }): Promise<void> {
    const {
      id,
      firstTick,
      lastTick,
      firstBlockNumber,
      lastBlockNumber,
      microgonToUsd,
      microgonToBtc,
      microgonToArgonot,
      allMinersCount,
      seatCountActive,
      seatCostTotalFramed,
      blocksMinedTotal,
      micronotsMinedTotal,
      microgonsMinedTotal,
      microgonsMintedTotal,
      microgonFeesCollectedTotal,
      accruedMicrogonProfits,
      accruedMicronotProfits,
      progress,
      isProcessed,
    } = args;
    await this.db.execute(
      `UPDATE Frames SET 
        firstTick = ?, 
        lastTick = ?, 
        firstBlockNumber = ?, 
        lastBlockNumber = ?, 
        microgonToUsd = ?, 
        microgonToBtc = ?, 
        microgonToArgonot = ?,
        allMinersCount = ?,
        seatCountActive = ?, 
        seatCostTotalFramed = ?,
        blocksMinedTotal = ?,
        micronotsMinedTotal = ?,
        microgonsMinedTotal = ?,
        microgonsMintedTotal = ?,
        microgonFeesCollectedTotal = ?,
        accruedMicrogonProfits = ?,
        accruedMicronotProfits = ?,
        progress = ?, 
        isProcessed = ? 
      WHERE id = ?`,
      toSqlParams([
        firstTick,
        lastTick,
        firstBlockNumber,
        lastBlockNumber,
        microgonToUsd,
        microgonToBtc,
        microgonToArgonot,
        allMinersCount,
        seatCountActive,
        seatCostTotalFramed,
        blocksMinedTotal,
        micronotsMinedTotal,
        microgonsMinedTotal,
        microgonsMintedTotal,
        microgonFeesCollectedTotal,
        accruedMicrogonProfits,
        accruedMicronotProfits,
        progress,
        isProcessed,
        id,
      ]),
    );
  }

  async fetchExistingSince(frameId: number, limit = 10): Promise<number[]> {
    const frames = await this.db.select<{ id: number }[]>('SELECT id FROM Frames WHERE id >= ? LIMIT ?', [
      frameId,
      limit + 1,
    ]);
    return frames.map(frame => frame.id);
  }

  async fetchLastYear(): Promise<Omit<IDashboardFrameStats, 'score' | 'expected'>[]> {
    const rawRecords = await this.db.select<any[]>(`SELECT 
      id, firstTick, lastTick, microgonToUsd, microgonToArgonot, allMinersCount, seatCountActive, seatCostTotalFramed, blocksMinedTotal, micronotsMinedTotal, microgonsMinedTotal, microgonsMintedTotal, progress
    FROM Frames ORDER BY id DESC LIMIT 365`);

    const records = convertFromSqliteFields<IDashboardFrameStats[]>(rawRecords, this.fieldTypes)
      .map((x: any) => {
        const date = dayjs.utc(x.firstTick * TICK_MILLIS).format('YYYY-MM-DD');

        // TODO: WE need to calculate the microgon value of micronotsMinted
        const microgonValueEarnedBn = BigNumber(x.microgonsMinedTotal)
          .plus(x.microgonsMintedTotal)
          .plus(x.micronotsMinedTotal);
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
          lastTick: x.lastTick,
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

          microgonValueOfRewards,
          progress: x.progress,
          profit: profitBn.toNumber(),
          profitPct: profitPctBn.toNumber(),
        };

        return record;
      })
      .reverse();

    const ticksPerFrame = MiningFrames.ticksPerFrame;

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
        lastTick: earliestRecord.lastTick - ticksPerFrame,
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
      };
      records.unshift(blankRecord);
    }

    return records;
  }

  async fetchById(id: number): Promise<IFrameRecord> {
    const [rawRecord] = await this.db.select<[any]>('SELECT * FROM Frames WHERE id = ?', [id]);
    if (!rawRecord) throw new Error(`Frame ${id} not found`);

    return convertFromSqliteFields(rawRecord, this.fieldTypes);
  }

  async fetchProcessedCount(): Promise<number> {
    const [result] = await this.db.select<[{ count: number }]>(
      'SELECT COUNT(*) as count FROM Frames WHERE isProcessed = 1',
    );
    return result.count;
  }

  async latestId(): Promise<number> {
    const [rawRecord] = await this.db.select<[{ maxId: number }]>('SELECT COALESCE(MAX(id), 0) as maxId FROM Frames');
    return rawRecord.maxId;
  }

  async fetchAccruedProfits(): Promise<{ accruedMicrogonProfits: bigint; accruedMicronotProfits: bigint }> {
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
