import { BaseTable, IFieldTypes } from './BaseTable.ts';
import { convertFromSqliteFields, toSqlParams } from '../Utils.ts';
import type { Hash } from 'viem';
import { MoveToken } from '@argonprotocol/apps-core';

export enum CrosschainInboundTransferStatus {
  SourceSubmitted = 'SourceSubmitted',
  SourceFinalized = 'SourceFinalized',
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
  sourceLogIndex?: number;
  gatewayActivityNonce?: bigint;
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
  private bigIntFields: ICrosschainInboundTransferRecordKey[] = ['amountBaseUnits', 'gatewayActivityNonce'];
  private dateFields: ICrosschainInboundTransferRecordKey[] = ['createdAt', 'updatedAt'];

  private get fields(): IFieldTypes {
    return {
      bigint: this.bigIntFields,
      date: this.dateFields,
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
      sourceLogIndex,
      gatewayActivityNonce,
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
        sourceLogIndex,
        gatewayActivityNonce,
        argonBlockNumber,
        argonBlockHash,
        status
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(transferId) DO UPDATE SET
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
        sourceLogIndex,
        gatewayActivityNonce,
        argonBlockNumber,
        argonBlockHash,
        status,
      ]),
    );

    return convertFromSqliteFields<ICrosschainInboundTransferRecord[]>(records, this.fields)[0];
  }

  public async insertSourceSubmitted(args: {
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
      status: CrosschainInboundTransferStatus.SourceSubmitted,
    });
  }

  public async recordConfirmedSourceTransfer(args: {
    transferId: string;
    sourceBlockNumber: number;
    sourceBlockHash: Hash;
    sourceLogIndex: number;
    gatewayActivityNonce: bigint;
  }) {
    const { transferId, sourceBlockNumber, sourceBlockHash, sourceLogIndex, gatewayActivityNonce } = args;
    return this.patch(transferId, {
      sourceBlockNumber,
      sourceBlockHash,
      sourceLogIndex,
      gatewayActivityNonce,
    });
  }

  public async recordSourceFinalized(transferId: string) {
    return this.patch(transferId, {
      status: CrosschainInboundTransferStatus.SourceFinalized,
    });
  }

  public async recordArgonFinalized(args: { transferId: string; argonBlockNumber?: number; argonBlockHash?: string }) {
    const { transferId, argonBlockNumber, argonBlockHash } = args;
    return this.patch(transferId, {
      argonBlockNumber,
      argonBlockHash,
      status: CrosschainInboundTransferStatus.ArgonFinalized,
    });
  }

  public async patch(
    transferId: string,
    patch: ICrosschainInboundTransferPatch,
  ): Promise<ICrosschainInboundTransferRecord | undefined> {
    const patchEntries = Object.entries(patch).filter(([, value]) => value !== undefined);
    if (!patchEntries.length) {
      return await this.get(transferId);
    }

    const fieldsSql = patchEntries.map(([key]) => `${key} = ?`).join(', ');
    const records = await this.db.select<ICrosschainInboundTransferRecord[]>(
      `UPDATE CrosschainInboundTransfers
      SET ${fieldsSql}, updatedAt = CURRENT_TIMESTAMP
      WHERE transferId = ?
      RETURNING *`,
      toSqlParams([...patchEntries.map(([, value]) => value), transferId]),
    );

    return convertFromSqliteFields<ICrosschainInboundTransferRecord[]>(records, this.fields)[0];
  }
}
