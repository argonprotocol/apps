import { BaseTable, IFieldTypes } from './BaseTable';
import { convertFromSqliteFields, toSqlParams } from '../Utils';
import { ExtrinsicError, GenericEvent } from '@argonprotocol/mainchain';
import { filterUndefined } from '@argonprotocol/apps-core';

export enum ExtrinsicType {
  VaultCreate = 'VaultCreate',
  VaultModifySettings = 'VaultModifySettings',
  VaultInitialAllocate = 'VaultInitialAllocate',
  VaultIncreaseAllocation = 'VaultIncreaseAllocation',
  VaultCollect = 'VaultCollect',

  BitcoinRequestLock = 'BitcoinRequestLock', // LockIsProcessingOnArgon
  BitcoinRequestRelease = 'BitcoinRequestRelease', // ReleaseIsProcessingOnBitcoin
  VaultCosignBitcoinRelease = 'VaultCosignBitcoinRelease', // ReleaseIsWaitingForVault

  Transfer = 'Transfer',
}

export enum TransactionStatus {
  Submitted = 'Submitted',
  InBlock = 'InBlock',
  Finalized = 'Finalized',
  Error = 'Error',
  TimedOutWaitingForBlock = 'TimedOutWaitingForBlock',
}

export interface ITransactionRecord {
  id: number; // Auto-incrementing primary key since extrinsic hash isn't implicitly unique and can overlap
  status: TransactionStatus;
  extrinsicHash: string;
  extrinsicMethodJson: any;
  extrinsicType: ExtrinsicType;
  metadataJson: any;
  accountAddress: string;
  submittedAtTime: Date;
  submittedAtBlockHeight: number;
  submissionErrorJson: any;
  txTip: bigint | undefined;
  txFeePlusTip: bigint | undefined;
  blockHeight: number | undefined;
  blockHash: string | undefined;
  blockTime: Date | undefined;
  blockExtrinsicIndex: number | undefined;
  blockExtrinsicEventsJson: any[];
  blockExtrinsicErrorJson:
    | { batchInterruptedIndex?: number; errorCode?: string; details?: string; message: string }
    | undefined;
  lastFinalizedBlockHeight: number | undefined;
  lastFinalizedBlockTime: Date | undefined;
  isFinalized: boolean;
  createdAt: Date;
  updatedAt: Date;
}
// eslint-disable-next-line @typescript-eslint/no-redundant-type-constituents
type ITransactionRecordKey = keyof ITransactionRecord & string;
export class TransactionsTable extends BaseTable {
  private bigIntFields: ITransactionRecordKey[] = ['txFeePlusTip', 'txTip'];
  private dateFields: ITransactionRecordKey[] = ['submittedAtTime', 'blockTime', 'createdAt', 'updatedAt'];
  private jsonFields: ITransactionRecordKey[] = [
    'submissionErrorJson',
    'extrinsicMethodJson',
    'metadataJson',
    'blockExtrinsicErrorJson',
    'blockExtrinsicEventsJson',
  ];
  private booleanFields: ITransactionRecordKey[] = ['isFinalized'];

  private get fields(): IFieldTypes {
    return {
      bigint: this.bigIntFields,
      date: this.dateFields,
      json: this.jsonFields,
      boolean: this.booleanFields,
    };
  }

  public async fetchAll(): Promise<ITransactionRecord[]> {
    const records = await this.db.select<any[]>('SELECT * FROM Transactions ORDER BY submittedAtBlockHeight DESC');
    return convertFromSqliteFields(records, this.fields);
  }

  public async recordInBlock(
    record: ITransactionRecord,
    block: {
      blockNumber: number;
      blockHash: string;
      blockTime: Date;
      tip: bigint;
      feePlusTip: bigint;
      extrinsicError?: ExtrinsicError;
      extrinsicIndex: number;
      transactionEvents: GenericEvent[];
    },
  ): Promise<ITransactionRecord> {
    const { blockNumber, blockHash, blockTime, feePlusTip, tip } = block;
    record.txFeePlusTip = feePlusTip;
    record.txTip = tip;
    record.status = TransactionStatus.InBlock;
    record.blockHash = blockHash;
    record.blockHeight = blockNumber;
    record.blockTime = blockTime;
    record.blockExtrinsicIndex = block.extrinsicIndex;
    const { batchInterruptedIndex, errorCode, details, message = 'Unknown Error' } = block.extrinsicError || {};
    record.blockExtrinsicErrorJson = message ? { batchInterruptedIndex, errorCode, details, message } : undefined;
    record.blockExtrinsicEventsJson = block.transactionEvents.map(event => {
      return {
        raw: event.toHex(),
        human: event.toHuman(),
      };
    });
    console.log('Events for extrinsic', record.extrinsicHash, record.blockExtrinsicEventsJson);
    await this.db.execute(
      `UPDATE Transactions SET 
          blockHeight = ?,
          blockHash = ?,
          blockTime = ?, 
          txFeePlusTip = ?, 
          txTip = ?,
          blockExtrinsicErrorJson = ?,
          blockExtrinsicIndex = ?,
          blockExtrinsicEventsJson = ?,
          status = ?
        WHERE id = ?
      `,
      toSqlParams([
        blockNumber,
        blockHash,
        blockTime,
        feePlusTip,
        tip,
        record.blockExtrinsicErrorJson,
        record.blockExtrinsicIndex,
        record.blockExtrinsicEventsJson,
        record.status,
        record.id,
      ]),
    );
    return record;
  }

  public async updateLastFinalizedBlock(
    record: ITransactionRecord,
    finalizedDetails: { blockNumber: number; blockTime: Date },
  ): Promise<ITransactionRecord> {
    record.lastFinalizedBlockHeight = finalizedDetails.blockNumber;
    record.lastFinalizedBlockTime = finalizedDetails.blockTime;
    await this.db.execute(
      `UPDATE Transactions SET lastFinalizedBlockHeight = ?, lastFinalizedBlockTime = ?
        WHERE id = ?
      `,
      toSqlParams([record.lastFinalizedBlockHeight, record.lastFinalizedBlockTime, record.id]),
    );
    return record;
  }

  public async markFinalized(record: ITransactionRecord): Promise<ITransactionRecord> {
    record.isFinalized = true;
    record.status = TransactionStatus.Finalized;
    await this.db.execute(
      `UPDATE Transactions SET isFinalized = ?, status = ?
        WHERE id = ?
      `,
      toSqlParams([record.isFinalized, record.status, record.id]),
    );
    return record;
  }

  public async markExpiredWaitingForBlock(record: ITransactionRecord): Promise<ITransactionRecord> {
    record.status = TransactionStatus.TimedOutWaitingForBlock;
    await this.db.execute(
      `UPDATE Transactions SET status = ?
        WHERE id = ?
      `,
      toSqlParams([record.status, record.id]),
    );
    return record;
  }

  public async insert(
    args: Pick<
      ITransactionRecord,
      | 'extrinsicHash'
      | 'extrinsicMethodJson'
      | 'metadataJson'
      | 'extrinsicType'
      | 'accountAddress'
      | 'submittedAtBlockHeight'
      | 'submittedAtTime'
    >,
  ): Promise<ITransactionRecord> {
    const {
      extrinsicHash,
      extrinsicMethodJson,
      metadataJson,
      extrinsicType,
      accountAddress,
      submittedAtBlockHeight,
      submittedAtTime,
    } = args;
    const records = await this.db.select<ITransactionRecord[]>(
      `INSERT INTO Transactions (
          extrinsicHash, extrinsicMethodJson, metadataJson, extrinsicType, accountAddress, submittedAtBlockHeight, submittedAtTime, status
        ) VALUES (
          ?, ?, ?, ?, ?, ?, ?, ?
        ) RETURNING *`,
      toSqlParams([
        extrinsicHash,
        extrinsicMethodJson,
        metadataJson,
        extrinsicType,
        accountAddress,
        submittedAtBlockHeight,
        submittedAtTime,
        TransactionStatus.Submitted,
      ]),
    );
    return convertFromSqliteFields<ITransactionRecord[]>(records, this.fields)[0];
  }

  public async recordSubmissionError(record: ITransactionRecord, submissionError: Error): Promise<ITransactionRecord> {
    record.submissionErrorJson = submissionError
      ? filterUndefined({
          message: submissionError.message,
          name: submissionError.name,
          code: (submissionError as any).code,
          data: (submissionError as any).data,
        })
      : undefined;
    record.status = TransactionStatus.Error;
    await this.db.execute(
      `UPDATE Transactions SET submissionErrorJson = ?, status = ? WHERE id = ?`,
      toSqlParams([record.submissionErrorJson, record.status, record.id]),
    );
    return record;
  }
}
