import { BaseTable, IFieldTypes } from './BaseTable';
import { convertFromSqliteFields, toSqlParams } from '../Utils';
import { ExtrinsicError, GenericEvent } from '@argonprotocol/mainchain';
import { filterUndefined } from '@argonprotocol/apps-core';
import {
  TransactionHistorySource,
  TransactionHistoryStatus,
  type ITransactionStatusHistoryRecord,
} from './TransactionStatusHistoryTable.ts';

export enum ExtrinsicType {
  VaultCreate = 'VaultCreate',
  VaultModifySettings = 'VaultModifySettings',
  VaultInitialAllocate = 'VaultInitialAllocate',
  VaultIncreaseAllocation = 'VaultIncreaseAllocation',
  VaultCollect = 'VaultCollect',

  BitcoinRequestLock = 'BitcoinRequestLock', // LockIsProcessingOnArgon
  BitcoinRequestRelease = 'BitcoinRequestRelease', // funding UTXO enters release lifecycle on Argon
  VaultCosignBitcoinRelease = 'VaultCosignBitcoinRelease', // vault cosigns release request before bitcoin broadcast
  VaultCosignOrphanedUtxoRelease = 'VaultCosignOrphanedUtxoRelease',
  BitcoinIncreaseSecuritization = 'BitcoinIncreaseSecuritization',
  BitcoinOrphanedUtxoUseAsFunding = 'BitcoinOrphanedUtxoUseAsFunding',
  BitcoinOrphanedUtxoRelease = 'BitcoinOrphanedUtxoRelease',

  Transfer = 'Transfer',
}

export enum TransactionStatus {
  Submitted = 'Submitted',
  InBlock = 'InBlock',
  Finalized = 'Finalized',
  Error = 'Error',
  TimedOutWaitingForBlock = 'TimedOutWaitingForBlock',
}

export interface ITransactionRecord<MetadataType = any> {
  id: number; // Auto-incrementing primary key since extrinsic hash isn't implicitly unique and can overlap
  status: TransactionStatus;
  followOnTxId?: number;
  extrinsicHash: string;
  extrinsicMethodJson: any;
  extrinsicType: ExtrinsicType;
  metadataJson: MetadataType;
  accountAddress: string;
  submittedAtTime: Date;
  submittedAtBlockHeight: number;
  submissionErrorJson: any;
  txNonce?: number;
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
  finalizedHeadHeight: number | undefined;
  finalizedHeadTime: Date | undefined;
  isFinalized: boolean;
  createdAt: Date;
  updatedAt: Date;
}
// eslint-disable-next-line @typescript-eslint/no-redundant-type-constituents
type ITransactionRecordKey = keyof ITransactionRecord & string;
export class TransactionsTable extends BaseTable {
  private bigIntFields: ITransactionRecordKey[] = ['txFeePlusTip', 'txTip'];
  private dateFields: ITransactionRecordKey[] = [
    'submittedAtTime',
    'blockTime',
    'finalizedHeadTime',
    'createdAt',
    'updatedAt',
  ];
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

  public async recordFollowOnTxId(record: ITransactionRecord, followOnTxId: number): Promise<ITransactionRecord> {
    record.followOnTxId = followOnTxId;
    await this.db.execute(
      `UPDATE Transactions SET followOnTxId = ? WHERE id = ?`,
      toSqlParams([record.followOnTxId, record.id]),
    );
    return record;
  }

  public async fetchAll(): Promise<ITransactionRecord[]> {
    const records = await this.db.select<any[]>(
      `SELECT
         id,
         status,
         followOnTxId,
         extrinsicHash,
         extrinsicMethodJson,
         extrinsicType,
         metadataJson,
         accountAddress,
         submittedAtTime,
         submittedAtBlockHeight,
         submissionErrorJson,
         txNonce,
         txTip,
         txFeePlusTip,
         blockHeight,
         blockHash,
         blockTime,
         blockExtrinsicIndex,
         blockExtrinsicEventsJson,
         blockExtrinsicErrorJson,
         lastFinalizedBlockHeight AS finalizedHeadHeight,
         lastFinalizedBlockTime AS finalizedHeadTime,
         isFinalized,
         createdAt,
         updatedAt
       FROM Transactions
       ORDER BY submittedAtBlockHeight DESC, id DESC`,
    );
    return convertFromSqliteFields(records, this.fields);
  }

  public async fetchStatusHistory(transactionId: number): Promise<ITransactionStatusHistoryRecord[]> {
    return await this.db.transactionStatusHistoryTable.fetchByTransactionId(transactionId);
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
    const { batchInterruptedIndex, errorCode, details, message } = block.extrinsicError || {};
    record.blockExtrinsicErrorJson = message
      ? { batchInterruptedIndex, errorCode, details, message: message ?? 'Unknown Error' }
      : undefined;
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
    await this.db.transactionStatusHistoryTable.record({
      transactionId: record.id,
      status: TransactionHistoryStatus.InBlock,
      source: TransactionHistorySource.Block,
      blockHeight: blockNumber,
      blockHash,
    });
    return record;
  }

  public async updateFinalizedHead(
    record: ITransactionRecord,
    finalizedDetails: { blockNumber: number; blockTime: Date },
  ): Promise<ITransactionRecord> {
    record.finalizedHeadHeight = finalizedDetails.blockNumber;
    record.finalizedHeadTime = finalizedDetails.blockTime;
    await this.db.execute(
      `UPDATE Transactions SET lastFinalizedBlockHeight = ?, lastFinalizedBlockTime = ?
        WHERE id = ?
      `,
      toSqlParams([record.finalizedHeadHeight, record.finalizedHeadTime, record.id]),
    );
    return record;
  }

  public async markFinalized(
    record: ITransactionRecord,
    finalizedDetails?: { blockNumber: number; blockTime: Date },
  ): Promise<ITransactionRecord> {
    record.isFinalized = true;
    record.status = TransactionStatus.Finalized;
    if (finalizedDetails) {
      record.finalizedHeadHeight = finalizedDetails.blockNumber;
      record.finalizedHeadTime = finalizedDetails.blockTime;
    }
    await this.db.execute(
      `UPDATE Transactions SET
        isFinalized = ?,
        status = ?,
        lastFinalizedBlockHeight = COALESCE(?, lastFinalizedBlockHeight),
        lastFinalizedBlockTime = COALESCE(?, lastFinalizedBlockTime)
        WHERE id = ?
      `,
      toSqlParams([
        record.isFinalized,
        record.status,
        finalizedDetails?.blockNumber,
        finalizedDetails?.blockTime,
        record.id,
      ]),
    );
    await this.db.transactionStatusHistoryTable.record({
      transactionId: record.id,
      status: TransactionHistoryStatus.Finalized,
      source: TransactionHistorySource.Block,
      blockHeight: finalizedDetails?.blockNumber,
    });
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
    await this.db.transactionStatusHistoryTable.record({
      transactionId: record.id,
      status: TransactionHistoryStatus.TimedOutWaitingForBlock,
      source: TransactionHistorySource.Local,
    });
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
      | 'txNonce'
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
      txNonce,
    } = args;
    const records = await this.db.select<ITransactionRecord[]>(
      `INSERT INTO Transactions (
          extrinsicHash, extrinsicMethodJson, metadataJson, extrinsicType, accountAddress, submittedAtBlockHeight, submittedAtTime, txNonce, status
        ) VALUES (
          ?, ?, ?, ?, ?, ?, ?, ?, ?
        ) RETURNING
          id,
          status,
          followOnTxId,
          extrinsicHash,
          extrinsicMethodJson,
          extrinsicType,
          metadataJson,
          accountAddress,
          submittedAtTime,
          submittedAtBlockHeight,
          submissionErrorJson,
          txNonce,
          txTip,
          txFeePlusTip,
          blockHeight,
          blockHash,
          blockTime,
          blockExtrinsicIndex,
          blockExtrinsicEventsJson,
          blockExtrinsicErrorJson,
          lastFinalizedBlockHeight AS finalizedHeadHeight,
          lastFinalizedBlockTime AS finalizedHeadTime,
          isFinalized,
          createdAt,
          updatedAt`,
      toSqlParams([
        extrinsicHash,
        extrinsicMethodJson,
        metadataJson,
        extrinsicType,
        accountAddress,
        submittedAtBlockHeight,
        submittedAtTime,
        txNonce,
        TransactionStatus.Submitted,
      ]),
    );
    const record = convertFromSqliteFields<ITransactionRecord[]>(records, this.fields)[0];
    await this.db.transactionStatusHistoryTable.record({
      transactionId: record.id,
      status: TransactionHistoryStatus.Submitted,
      source: TransactionHistorySource.Local,
    });
    return record;
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
    await this.db.transactionStatusHistoryTable.record({
      transactionId: record.id,
      status: TransactionHistoryStatus.Error,
      source: TransactionHistorySource.Local,
    });
    return record;
  }
}
