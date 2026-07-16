import type { IVaultCapitalEvent } from '@argonprotocol/apps-core';
import { BaseTable, type IFieldTypes } from './BaseTable.ts';
import { convertFromSqliteFields, toSqlParams } from '../Utils.ts';

type IVaultCapitalHistoryInput = IVaultCapitalEvent & {
  walletAddress: string;
  blockNumber: number;
  blockHash: string;
  blockTime?: Date;
  extrinsicIndex?: number;
};

export type IVaultCapitalHistoryRecord = IVaultCapitalHistoryInput & {
  id: number;
  createdAt: Date;
};

export class VaultCapitalHistoryTable extends BaseTable {
  public revision = 0;

  private fields: IFieldTypes = {
    bigint: [
      'amount',
      'securitization',
      'securitizationTarget',
      'releaseHeight',
      'securitizationRemaining',
      'securitizationReleased',
    ],
    date: ['blockTime', 'createdAt'],
  };

  public async insert(args: IVaultCapitalHistoryInput): Promise<IVaultCapitalHistoryRecord | undefined> {
    const { walletAddress, vaultId, eventType, blockNumber, blockHash, blockTime, extrinsicIndex } = args;
    const amount = 'amount' in args ? args.amount : undefined;
    const securitization = 'securitization' in args ? args.securitization : undefined;
    const securitizationTarget = 'securitizationTarget' in args ? args.securitizationTarget : undefined;
    const releaseHeight = 'releaseHeight' in args ? args.releaseHeight : undefined;
    const securitizationRemaining = 'securitizationRemaining' in args ? args.securitizationRemaining : undefined;
    const securitizationReleased = 'securitizationReleased' in args ? args.securitizationReleased : undefined;

    const records = await this.db.select<IVaultCapitalHistoryRecord[]>(
      `INSERT INTO VaultCapitalHistory (
         walletAddress, vaultId, eventType, amount, securitization, securitizationTarget,
         releaseHeight, securitizationRemaining, securitizationReleased, blockNumber, blockHash, blockTime,
         extrinsicIndex
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT DO NOTHING
       RETURNING *`,
      toSqlParams([
        walletAddress,
        vaultId,
        eventType,
        amount,
        securitization,
        securitizationTarget,
        releaseHeight,
        securitizationRemaining,
        securitizationReleased,
        blockNumber,
        blockHash,
        blockTime,
        extrinsicIndex,
      ]),
    );
    const record = convertFromSqliteFields<IVaultCapitalHistoryRecord[]>(records, this.fields)[0];
    if (record) this.revision += 1;
    return record;
  }

  public async fetchAll(walletAddress: string, vaultId: number): Promise<IVaultCapitalHistoryRecord[]> {
    const records = await this.db.select<IVaultCapitalHistoryRecord[]>(
      `SELECT * FROM VaultCapitalHistory
       WHERE walletAddress = ? AND vaultId = ?
       ORDER BY blockNumber, id`,
      toSqlParams([walletAddress, vaultId]),
    );
    return convertFromSqliteFields<IVaultCapitalHistoryRecord[]>(records, this.fields);
  }

  public async fetchAllByWallet(walletAddress: string): Promise<IVaultCapitalHistoryRecord[]> {
    const records = await this.db.select<IVaultCapitalHistoryRecord[]>(
      `SELECT * FROM VaultCapitalHistory
       WHERE walletAddress = ?
       ORDER BY blockNumber, COALESCE(extrinsicIndex, -1), id`,
      toSqlParams([walletAddress]),
    );
    return convertFromSqliteFields<IVaultCapitalHistoryRecord[]>(records, this.fields);
  }

  public async fetchVaultIds(walletAddress: string): Promise<number[]> {
    const records = await this.db.select<{ vaultId: number }[]>(
      `SELECT DISTINCT vaultId FROM VaultCapitalHistory WHERE walletAddress = ?`,
      toSqlParams([walletAddress]),
    );
    return records.map(record => record.vaultId);
  }
}
