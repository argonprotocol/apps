import { MoveToken } from '@argonprotocol/apps-core';
import type { Hash } from 'viem';
import { convertFromSqliteFields, toSqlParams } from '../Utils.ts';
import type { IEthereumFinalizeTransferOutOfArgonArgs } from '../EthereumClient.ts';
import { BaseTable, IFieldTypes } from './BaseTable.ts';

export enum CrosschainOutboundTransferStatus {
  RequestFinalizedOnArgon = 'RequestFinalizedOnArgon',
  Collateralized = 'Collateralized',
  TargetSubmitted = 'TargetSubmitted',
  TargetFinalized = 'TargetFinalized',
}

export interface ICrosschainOutboundTransferRecord {
  transferId: string;
  destinationChain: string;
  token: MoveToken.ARGN | MoveToken.ARGNOT;
  amount: bigint;
  argonSourceAddress: string;
  destinationAddress: string;
  targetTxHash?: Hash;
  targetBlockNumber?: number;
  targetBlockHash?: Hash;
  collateralizedMicrogons?: bigint;
  collateralizedMicronots?: bigint;
  collateralizedArgonBlockNumber?: number;
  collateralizedArgonBlockHash?: string;
  gatewayActivityNonce?: bigint;
  finalizeRequestJson?: IEthereumFinalizeTransferOutOfArgonArgs['request'];
  finalizeProofJson?: IEthereumFinalizeTransferOutOfArgonArgs['proof'];
  status: CrosschainOutboundTransferStatus;
  createdAt: Date;
  updatedAt: Date;
}

type ICrosschainOutboundTransferRecordKey = keyof ICrosschainOutboundTransferRecord;
export type ICrosschainOutboundTransferInsert = Omit<ICrosschainOutboundTransferRecord, 'createdAt' | 'updatedAt'>;
export type ICrosschainOutboundTransferPatch = Partial<Omit<ICrosschainOutboundTransferInsert, 'transferId'>>;

export class CrosschainOutboundTransfersTable extends BaseTable {
  private bigIntFields: ICrosschainOutboundTransferRecordKey[] = [
    'amount',
    'collateralizedMicrogons',
    'collateralizedMicronots',
    'gatewayActivityNonce',
  ];
  private dateFields: ICrosschainOutboundTransferRecordKey[] = ['createdAt', 'updatedAt'];
  private jsonFields: ICrosschainOutboundTransferRecordKey[] = ['finalizeRequestJson', 'finalizeProofJson'];

  private get fields(): IFieldTypes {
    return {
      bigint: this.bigIntFields,
      date: this.dateFields,
      json: this.jsonFields,
    };
  }

  public async fetchAll(): Promise<ICrosschainOutboundTransferRecord[]> {
    const records = await this.db.select<ICrosschainOutboundTransferRecord[]>(
      `SELECT * FROM CrosschainOutboundTransfers ORDER BY updatedAt DESC, createdAt DESC`,
    );
    return convertFromSqliteFields<ICrosschainOutboundTransferRecord[]>(records, this.fields);
  }

  public async get(transferId: string): Promise<ICrosschainOutboundTransferRecord | undefined> {
    const records = await this.db.select<ICrosschainOutboundTransferRecord[]>(
      `SELECT * FROM CrosschainOutboundTransfers WHERE transferId = ? LIMIT 1`,
      toSqlParams([transferId]),
    );
    return convertFromSqliteFields<ICrosschainOutboundTransferRecord[]>(records, this.fields)[0];
  }

  public async getLatestPendingByDestinationChainAndToken(
    destinationChain: string,
    token: MoveToken.ARGN | MoveToken.ARGNOT,
  ): Promise<ICrosschainOutboundTransferRecord | undefined> {
    const records = await this.db.select<ICrosschainOutboundTransferRecord[]>(
      `SELECT * FROM CrosschainOutboundTransfers
        WHERE destinationChain = ? AND token = ? AND status != ?
        ORDER BY updatedAt DESC, createdAt DESC
        LIMIT 1`,
      toSqlParams([destinationChain, token, CrosschainOutboundTransferStatus.TargetFinalized]),
    );
    return convertFromSqliteFields<ICrosschainOutboundTransferRecord[]>(records, this.fields)[0];
  }

  public async upsert(args: ICrosschainOutboundTransferInsert): Promise<ICrosschainOutboundTransferRecord | undefined> {
    const {
      transferId,
      destinationChain,
      token,
      amount,
      argonSourceAddress,
      destinationAddress,
      targetTxHash,
      targetBlockNumber,
      targetBlockHash,
      collateralizedMicrogons,
      collateralizedMicronots,
      collateralizedArgonBlockNumber,
      collateralizedArgonBlockHash,
      gatewayActivityNonce,
      finalizeRequestJson,
      finalizeProofJson,
      status,
    } = args;

    const records = await this.db.select<ICrosschainOutboundTransferRecord[]>(
      `INSERT INTO CrosschainOutboundTransfers (
        transferId,
        destinationChain,
        token,
        amount,
        argonSourceAddress,
        destinationAddress,
        targetTxHash,
        targetBlockNumber,
        targetBlockHash,
        collateralizedMicrogons,
        collateralizedMicronots,
        collateralizedArgonBlockNumber,
        collateralizedArgonBlockHash,
        gatewayActivityNonce,
        finalizeRequestJson,
        finalizeProofJson,
        status
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(transferId) DO UPDATE SET
        destinationChain = excluded.destinationChain,
        token = excluded.token,
        amount = excluded.amount,
        argonSourceAddress = excluded.argonSourceAddress,
        destinationAddress = excluded.destinationAddress,
        targetTxHash = excluded.targetTxHash,
        targetBlockNumber = excluded.targetBlockNumber,
        targetBlockHash = excluded.targetBlockHash,
        collateralizedMicrogons = excluded.collateralizedMicrogons,
        collateralizedMicronots = excluded.collateralizedMicronots,
        collateralizedArgonBlockNumber = excluded.collateralizedArgonBlockNumber,
        collateralizedArgonBlockHash = excluded.collateralizedArgonBlockHash,
        gatewayActivityNonce = excluded.gatewayActivityNonce,
        finalizeRequestJson = excluded.finalizeRequestJson,
        finalizeProofJson = excluded.finalizeProofJson,
        status = excluded.status,
        updatedAt = CURRENT_TIMESTAMP
      RETURNING *`,
      toSqlParams([
        transferId,
        destinationChain,
        token,
        amount,
        argonSourceAddress,
        destinationAddress,
        targetTxHash,
        targetBlockNumber,
        targetBlockHash,
        collateralizedMicrogons,
        collateralizedMicronots,
        collateralizedArgonBlockNumber,
        collateralizedArgonBlockHash,
        gatewayActivityNonce,
        finalizeRequestJson,
        finalizeProofJson,
        status,
      ]),
    );

    return convertFromSqliteFields<ICrosschainOutboundTransferRecord[]>(records, this.fields)[0];
  }

  public async insertRequestFinalizedOnArgon(args: {
    transferId: string;
    destinationChain: string;
    token: MoveToken.ARGN | MoveToken.ARGNOT;
    amount: bigint;
    argonSourceAddress: string;
    destinationAddress: string;
  }) {
    const { transferId, destinationChain, token, amount, argonSourceAddress, destinationAddress } = args;
    return this.upsert({
      transferId,
      destinationChain,
      token,
      amount,
      argonSourceAddress,
      destinationAddress,
      status: CrosschainOutboundTransferStatus.RequestFinalizedOnArgon,
    });
  }

  public async recordCollateralized(args: {
    transferId: string;
    collateralizedMicrogons: bigint;
    collateralizedMicronots: bigint;
    collateralizedArgonBlockNumber?: number;
    collateralizedArgonBlockHash?: string;
    finalizeRequestJson: IEthereumFinalizeTransferOutOfArgonArgs['request'];
    finalizeProofJson: IEthereumFinalizeTransferOutOfArgonArgs['proof'];
  }) {
    const {
      transferId,
      collateralizedMicrogons,
      collateralizedMicronots,
      collateralizedArgonBlockNumber,
      collateralizedArgonBlockHash,
      finalizeRequestJson,
      finalizeProofJson,
    } = args;
    return this.patch(transferId, {
      collateralizedMicrogons,
      collateralizedMicronots,
      collateralizedArgonBlockNumber,
      collateralizedArgonBlockHash,
      finalizeRequestJson,
      finalizeProofJson,
      status: CrosschainOutboundTransferStatus.Collateralized,
    });
  }

  public async recordTargetSubmitted(args: { transferId: string; targetTxHash: Hash }) {
    const { transferId, targetTxHash } = args;
    return this.patch(transferId, {
      targetTxHash,
      status: CrosschainOutboundTransferStatus.TargetSubmitted,
    });
  }

  public async recordTargetFinalized(args: {
    transferId: string;
    targetBlockNumber?: number;
    targetBlockHash?: Hash;
    gatewayActivityNonce: bigint;
  }) {
    const { transferId, targetBlockNumber, targetBlockHash, gatewayActivityNonce } = args;
    return this.patch(transferId, {
      targetBlockNumber,
      targetBlockHash,
      gatewayActivityNonce,
      status: CrosschainOutboundTransferStatus.TargetFinalized,
    });
  }

  public async patch(
    transferId: string,
    patch: ICrosschainOutboundTransferPatch,
  ): Promise<ICrosschainOutboundTransferRecord | undefined> {
    const patchKeys = (Object.keys(patch) as (keyof ICrosschainOutboundTransferPatch)[]).filter(
      key => patch[key] !== undefined,
    );
    if (!patchKeys.length) {
      return await this.get(transferId);
    }

    const fieldsSql = patchKeys.map(key => `${key} = ?`).join(', ');
    const params: Parameters<typeof toSqlParams>[0] = [];
    for (const key of patchKeys) {
      params.push(patch[key] ?? null);
    }
    const records = await this.db.select<ICrosschainOutboundTransferRecord[]>(
      `UPDATE CrosschainOutboundTransfers
      SET ${fieldsSql}, updatedAt = CURRENT_TIMESTAMP
      WHERE transferId = ?
      RETURNING *`,
      toSqlParams([...params, transferId]),
    );

    return convertFromSqliteFields<ICrosschainOutboundTransferRecord[]>(records, this.fields)[0];
  }
}
