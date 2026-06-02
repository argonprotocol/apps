import { BaseTable, IFieldTypes } from './BaseTable.ts';
import { convertFromSqliteFields, toSqlParams } from '../Utils.ts';
import type { Hash } from 'viem';
import { MoveToken } from '@argonprotocol/apps-core';
import type { ICrosschainTransferProgress } from '../CrosschainTransferProgress.ts';

export enum CrosschainInboundTransferStatus {
  SourceSubmitted = 'SourceSubmitted',
  SourceFinalized = 'SourceFinalized',
  ArgonFinalized = 'ArgonFinalized',
}

export interface ICrosschainInboundTransferRecord {
  id: string;
  sourceChain: string;
  token: MoveToken;
  amountBaseUnits: bigint;
  sourceAddress?: string;
  argonDestinationAddress: string;
  sourceTxHash?: Hash;
  sourceBlockNumber?: number;
  sourceBlockHash?: Hash;
  sourceLogIndex?: number;
  gatewayActivityNonce?: bigint;
  argonBlockNumber?: number;
  argonBlockHash?: string;
  failureReason?: string;
  isFailureAcknowledged: boolean;
  progressJson: ICrosschainTransferProgress;
  status: CrosschainInboundTransferStatus;
  createdAt: Date;
  updatedAt: Date;
}

type ICrosschainInboundTransferRecordKey = keyof ICrosschainInboundTransferRecord;
export type ICrosschainInboundTransferInsert = Omit<
  ICrosschainInboundTransferRecord,
  'createdAt' | 'updatedAt' | 'failureReason' | 'isFailureAcknowledged'
> & {
  failureReason?: string | null;
  isFailureAcknowledged?: boolean;
};
export type ICrosschainInboundTransferPatch = Partial<
  Omit<ICrosschainInboundTransferInsert, 'id' | 'failureReason'>
> & {
  failureReason?: string | null;
};

export class CrosschainInboundTransfersTable extends BaseTable {
  private bigIntFields: ICrosschainInboundTransferRecordKey[] = ['amountBaseUnits', 'gatewayActivityNonce'];
  private booleanFields: ICrosschainInboundTransferRecordKey[] = ['isFailureAcknowledged'];
  private dateFields: ICrosschainInboundTransferRecordKey[] = ['createdAt', 'updatedAt'];
  private jsonFields: ICrosschainInboundTransferRecordKey[] = ['progressJson'];

  private get fields(): IFieldTypes {
    return {
      boolean: this.booleanFields,
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

  public async get(id: string): Promise<ICrosschainInboundTransferRecord | undefined> {
    const records = await this.db.select<ICrosschainInboundTransferRecord[]>(
      `SELECT * FROM CrosschainInboundTransfers WHERE id = ? LIMIT 1`,
      toSqlParams([id]),
    );
    return convertFromSqliteFields<ICrosschainInboundTransferRecord[]>(records, this.fields)[0];
  }

  public async getLatestPendingByToken(
    sourceChain: string,
    token: MoveToken.ARGN | MoveToken.ARGNOT,
  ): Promise<ICrosschainInboundTransferRecord | undefined> {
    const records = await this.db.select<ICrosschainInboundTransferRecord[]>(
      `SELECT * FROM CrosschainInboundTransfers
        WHERE sourceChain = ? AND token = ? AND status != ? AND isFailureAcknowledged = 0
        ORDER BY updatedAt DESC, createdAt DESC
        LIMIT 1`,
      toSqlParams([sourceChain, token, CrosschainInboundTransferStatus.ArgonFinalized]),
    );
    return convertFromSqliteFields<ICrosschainInboundTransferRecord[]>(records, this.fields)[0];
  }

  public async upsert(args: ICrosschainInboundTransferInsert): Promise<ICrosschainInboundTransferRecord | undefined> {
    const {
      id,
      sourceChain,
      token,
      amountBaseUnits,
      sourceAddress,
      argonDestinationAddress,
      sourceTxHash,
      sourceBlockNumber,
      sourceBlockHash,
      sourceLogIndex,
      gatewayActivityNonce,
      argonBlockNumber,
      argonBlockHash,
      failureReason,
      isFailureAcknowledged = false,
      progressJson,
      status,
    } = args;

    const records = await this.db.select<ICrosschainInboundTransferRecord[]>(
      `INSERT INTO CrosschainInboundTransfers (
        id,
        sourceChain,
        token,
        amountBaseUnits,
        sourceAddress,
        argonDestinationAddress,
        sourceTxHash,
        sourceBlockNumber,
        sourceBlockHash,
        sourceLogIndex,
        gatewayActivityNonce,
        argonBlockNumber,
        argonBlockHash,
        failureReason,
        isFailureAcknowledged,
        progressJson,
        status
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        sourceChain = excluded.sourceChain,
        token = excluded.token,
        amountBaseUnits = excluded.amountBaseUnits,
        sourceAddress = excluded.sourceAddress,
        argonDestinationAddress = excluded.argonDestinationAddress,
        sourceTxHash = excluded.sourceTxHash,
        sourceBlockNumber = excluded.sourceBlockNumber,
        sourceBlockHash = excluded.sourceBlockHash,
        sourceLogIndex = excluded.sourceLogIndex,
        gatewayActivityNonce = excluded.gatewayActivityNonce,
        argonBlockNumber = excluded.argonBlockNumber,
        argonBlockHash = excluded.argonBlockHash,
        failureReason = excluded.failureReason,
        isFailureAcknowledged = excluded.isFailureAcknowledged,
        progressJson = excluded.progressJson,
        status = excluded.status,
        updatedAt = CURRENT_TIMESTAMP
      RETURNING *`,
      toSqlParams([
        id,
        sourceChain,
        token,
        amountBaseUnits,
        sourceAddress,
        argonDestinationAddress,
        sourceTxHash,
        sourceBlockNumber,
        sourceBlockHash,
        sourceLogIndex,
        gatewayActivityNonce,
        argonBlockNumber,
        argonBlockHash,
        failureReason,
        isFailureAcknowledged,
        progressJson,
        status,
      ]),
    );

    return convertFromSqliteFields<ICrosschainInboundTransferRecord[]>(records, this.fields)[0];
  }

  public async insertSourceSubmitted(args: {
    sourceChain: string;
    id: string;
    token: MoveToken.ARGN | MoveToken.ARGNOT;
    amountBaseUnits: bigint;
    sourceAddress?: string;
    argonDestinationAddress: string;
    sourceTxHash: Hash;
    progressJson: ICrosschainTransferProgress;
  }) {
    const {
      sourceChain,
      id,
      token,
      amountBaseUnits,
      sourceAddress,
      argonDestinationAddress,
      sourceTxHash,
      progressJson,
    } = args;
    return this.upsert({
      id,
      sourceChain,
      token,
      amountBaseUnits,
      sourceAddress,
      argonDestinationAddress,
      sourceTxHash,
      failureReason: null,
      isFailureAcknowledged: false,
      progressJson,
      status: CrosschainInboundTransferStatus.SourceSubmitted,
    });
  }

  public async recordConfirmedSourceTransfer(args: {
    id: string;
    sourceBlockNumber: number;
    sourceBlockHash: Hash;
    sourceLogIndex: number;
    gatewayActivityNonce: bigint;
    progressJson?: ICrosschainTransferProgress;
  }) {
    const { id, sourceBlockNumber, sourceBlockHash, sourceLogIndex, gatewayActivityNonce, progressJson } = args;
    return this.patch(id, {
      sourceBlockNumber,
      sourceBlockHash,
      sourceLogIndex,
      gatewayActivityNonce,
      failureReason: null,
      isFailureAcknowledged: false,
      progressJson,
    });
  }

  public async recordSourceFinalized(id: string, progressJson?: ICrosschainTransferProgress) {
    return this.patch(id, {
      failureReason: null,
      isFailureAcknowledged: false,
      progressJson,
      status: CrosschainInboundTransferStatus.SourceFinalized,
    });
  }

  public async recordArgonFinalized(args: {
    id: string;
    argonBlockNumber?: number;
    argonBlockHash?: string;
    progressJson?: ICrosschainTransferProgress;
  }) {
    const { id, argonBlockNumber, argonBlockHash, progressJson } = args;
    return this.patch(id, {
      argonBlockNumber,
      argonBlockHash,
      failureReason: null,
      isFailureAcknowledged: false,
      progressJson,
      status: CrosschainInboundTransferStatus.ArgonFinalized,
    });
  }

  public async recordFailed(args: { id: string; failureReason: string; progressJson?: ICrosschainTransferProgress }) {
    const { id, failureReason, progressJson } = args;
    return this.patch(id, {
      failureReason,
      isFailureAcknowledged: false,
      progressJson,
    });
  }

  public async acknowledgeFailed(id: string) {
    return this.patch(id, {
      isFailureAcknowledged: true,
    });
  }

  public async patch(
    id: string,
    patch: ICrosschainInboundTransferPatch,
  ): Promise<ICrosschainInboundTransferRecord | undefined> {
    const patchEntries = Object.entries(patch).filter(([, value]) => value !== undefined);
    if (!patchEntries.length) {
      return await this.get(id);
    }

    const fieldsSql = patchEntries.map(([key]) => `${key} = ?`).join(', ');
    const records = await this.db.select<ICrosschainInboundTransferRecord[]>(
      `UPDATE CrosschainInboundTransfers
      SET ${fieldsSql}, updatedAt = CURRENT_TIMESTAMP
      WHERE id = ?
      RETURNING *`,
      toSqlParams([...patchEntries.map(([, value]) => value), id]),
    );

    return convertFromSqliteFields<ICrosschainInboundTransferRecord[]>(records, this.fields)[0];
  }
}
