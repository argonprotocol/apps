import { BaseTable, IFieldTypes } from './BaseTable.ts';
import { convertFromSqliteFields, toSqlParams } from '../Utils.ts';
import type { Hash } from 'viem';
import { MoveToken } from '@argonprotocol/apps-core';

export enum CrosschainInboundTransferStatus {
  SourceBurned = 'SourceBurned',
  SourceFinalized = 'SourceFinalized',
  ArgonProofSubmitted = 'ArgonProofSubmitted',
  ArgonFinalized = 'ArgonFinalized',
}

export interface ICrosschainInboundTransferRecord {
  transferId: string;
  sourceChain: string;
  token: MoveToken;
  amountBaseUnits: bigint;
  sourceAddress?: string;
  argonDestinationAddress: string;
  sourceTxHash?: Hash;
  sourceBlockNumber?: number;
  sourceBlockHash?: Hash;
  sourceReferenceJson?: any;
  argonTxId?: number;
  argonTxHash?: string;
  argonBlockNumber?: number;
  argonBlockHash?: string;
  status: CrosschainInboundTransferStatus;
  createdAt: Date;
  updatedAt: Date;
}

type ICrosschainInboundTransferRecordKey = keyof ICrosschainInboundTransferRecord;
export type ICrosschainInboundTransferInsert = Omit<ICrosschainInboundTransferRecord, 'createdAt' | 'updatedAt'>;
export type ICrosschainInboundTransferPatch = Partial<Omit<ICrosschainInboundTransferInsert, 'transferId'>>;

export class CrosschainInboundTransfersTable extends BaseTable {
  private bigIntFields: ICrosschainInboundTransferRecordKey[] = ['amountBaseUnits'];
  private dateFields: ICrosschainInboundTransferRecordKey[] = ['createdAt', 'updatedAt'];
  private jsonFields: ICrosschainInboundTransferRecordKey[] = ['sourceReferenceJson'];

  private get fields(): IFieldTypes {
    return {
      bigint: this.bigIntFields,
      date: this.dateFields,
      json: this.jsonFields,
    };
  }

  public async fetchAll(): Promise<ICrosschainInboundTransferRecord[]> {
    const records = await this.db.select<ICrosschainInboundTransferRecord[]>(
      `SELECT * FROM CrosschainInboundTransfers ORDER BY updatedAt DESC, createdAt DESC`,
    );
    return convertFromSqliteFields<ICrosschainInboundTransferRecord[]>(records, this.fields);
  }

  public async get(transferId: string): Promise<ICrosschainInboundTransferRecord | undefined> {
    const records = await this.db.select<ICrosschainInboundTransferRecord[]>(
      `SELECT * FROM CrosschainInboundTransfers WHERE transferId = ? LIMIT 1`,
      toSqlParams([transferId]),
    );
    return convertFromSqliteFields<ICrosschainInboundTransferRecord[]>(records, this.fields)[0];
  }

  public async getLatestPendingByToken(
    token: MoveToken.ARGN | MoveToken.ARGNOT,
  ): Promise<ICrosschainInboundTransferRecord | undefined> {
    const records = await this.db.select<ICrosschainInboundTransferRecord[]>(
      `SELECT * FROM CrosschainInboundTransfers
        WHERE token = ? AND status != ?
        ORDER BY updatedAt DESC, createdAt DESC
        LIMIT 1`,
      toSqlParams([token, CrosschainInboundTransferStatus.ArgonFinalized]),
    );
    return convertFromSqliteFields<ICrosschainInboundTransferRecord[]>(records, this.fields)[0];
  }

  public async upsert(args: ICrosschainInboundTransferInsert): Promise<ICrosschainInboundTransferRecord | undefined> {
    const {
      transferId,
      sourceChain,
      token,
      amountBaseUnits,
      sourceAddress,
      argonDestinationAddress,
      sourceTxHash,
      sourceBlockNumber,
      sourceBlockHash,
      sourceReferenceJson,
      argonTxId,
      argonTxHash,
      argonBlockNumber,
      argonBlockHash,
      status,
    } = args;

    const records = await this.db.select<ICrosschainInboundTransferRecord[]>(
      `INSERT INTO CrosschainInboundTransfers (
        transferId,
        sourceChain,
        token,
        amountBaseUnits,
        sourceAddress,
        argonDestinationAddress,
        sourceTxHash,
        sourceBlockNumber,
        sourceBlockHash,
        sourceReferenceJson,
        argonTxId,
        argonTxHash,
        argonBlockNumber,
        argonBlockHash,
        status
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(transferId) DO UPDATE SET
        sourceChain = excluded.sourceChain,
        token = excluded.token,
        amountBaseUnits = excluded.amountBaseUnits,
        sourceAddress = excluded.sourceAddress,
        argonDestinationAddress = excluded.argonDestinationAddress,
        sourceTxHash = excluded.sourceTxHash,
        sourceBlockNumber = excluded.sourceBlockNumber,
        sourceBlockHash = excluded.sourceBlockHash,
        sourceReferenceJson = excluded.sourceReferenceJson,
        argonTxId = excluded.argonTxId,
        argonTxHash = excluded.argonTxHash,
        argonBlockNumber = excluded.argonBlockNumber,
        argonBlockHash = excluded.argonBlockHash,
        status = excluded.status,
        updatedAt = CURRENT_TIMESTAMP
      RETURNING *`,
      toSqlParams([
        transferId,
        sourceChain,
        token,
        amountBaseUnits,
        sourceAddress,
        argonDestinationAddress,
        sourceTxHash,
        sourceBlockNumber,
        sourceBlockHash,
        sourceReferenceJson,
        argonTxId,
        argonTxHash,
        argonBlockNumber,
        argonBlockHash,
        status,
      ]),
    );

    return convertFromSqliteFields<ICrosschainInboundTransferRecord[]>(records, this.fields)[0];
  }

  public async insertSourceBurned(args: {
    transferId: string;
    token: MoveToken.ARGN | MoveToken.ARGNOT;
    amountBaseUnits: bigint;
    sourceAddress?: string;
    argonDestinationAddress: string;
    sourceTxHash: Hash;
  }) {
    const { transferId, token, amountBaseUnits, sourceAddress, argonDestinationAddress, sourceTxHash } = args;
    return this.upsert({
      transferId,
      sourceChain: 'ethereum',
      token,
      amountBaseUnits,
      sourceAddress,
      argonDestinationAddress,
      sourceTxHash,
      status: CrosschainInboundTransferStatus.SourceBurned,
    });
  }

  public async recordConfirmedBurn(args: {
    transferId: string;
    sourceBlockNumber: number;
    sourceBlockHash: Hash;
    burnLogIndex: number;
  }) {
    const { transferId, sourceBlockNumber, sourceBlockHash, burnLogIndex } = args;
    return this.patch(transferId, {
      sourceBlockNumber,
      sourceBlockHash,
      sourceReferenceJson: { burnLogIndex },
    });
  }

  public async recordSourceFinalized(transferId: string) {
    return this.patch(transferId, {
      status: CrosschainInboundTransferStatus.SourceFinalized,
    });
  }

  public async recordArgonProofSubmitted(args: { transferId: string; argonTxId: number; argonTxHash: string }) {
    const { transferId, argonTxId, argonTxHash } = args;
    return this.patch(transferId, {
      argonTxId,
      argonTxHash,
      status: CrosschainInboundTransferStatus.ArgonProofSubmitted,
    });
  }

  public async recordArgonFinalized(args: {
    transferId: string;
    argonTxId: number;
    argonTxHash: string;
    argonBlockNumber: number;
    argonBlockHash: string;
  }) {
    const { transferId, argonTxId, argonTxHash, argonBlockNumber, argonBlockHash } = args;
    return this.patch(transferId, {
      argonTxId,
      argonTxHash,
      argonBlockNumber,
      argonBlockHash,
      status: CrosschainInboundTransferStatus.ArgonFinalized,
    });
  }

  public async rewindToSourceStage(
    record: ICrosschainInboundTransferRecord,
    status: CrosschainInboundTransferStatus.SourceBurned | CrosschainInboundTransferStatus.SourceFinalized,
  ) {
    const records = await this.db.select<ICrosschainInboundTransferRecord[]>(
      `UPDATE CrosschainInboundTransfers
      SET
        argonTxId = NULL,
        argonTxHash = NULL,
        argonBlockNumber = NULL,
        argonBlockHash = NULL,
        status = ?,
        updatedAt = CURRENT_TIMESTAMP
      WHERE transferId = ?
      RETURNING *`,
      toSqlParams([status, record.transferId]),
    );
    const persistedRecord = convertFromSqliteFields<ICrosschainInboundTransferRecord[]>(records, this.fields)[0];
    if (persistedRecord) {
      return persistedRecord;
    }

    const {
      argonTxId: _fallbackArgonTxId,
      argonTxHash: _fallbackArgonTxHash,
      argonBlockNumber: _fallbackArgonBlockNumber,
      argonBlockHash: _fallbackArgonBlockHash,
      ...fallbackSourceStageRecord
    } = record;

    return {
      ...fallbackSourceStageRecord,
      status,
    };
  }

  public async patch(
    transferId: string,
    patch: ICrosschainInboundTransferPatch,
  ): Promise<ICrosschainInboundTransferRecord | undefined> {
    const currentRecord = await this.get(transferId);
    if (!currentRecord) {
      return;
    }

    const { createdAt: _createdAt, updatedAt: _updatedAt, ...recordToPersist } = currentRecord;
    return this.upsert({
      ...recordToPersist,
      ...patch,
      transferId,
    });
  }

  public async delete(transferId: string): Promise<void> {
    await this.db.execute(`DELETE FROM CrosschainInboundTransfers WHERE transferId = ?`, toSqlParams([transferId]));
  }
}
