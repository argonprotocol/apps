import { MoveToken } from '@argonprotocol/apps-core';
import type { Hash } from 'viem';
import type { ICrosschainTransferProgress } from '../CrosschainTransferProgress.ts';
import type { IEthereumFinalizeTransferOutOfArgonArgs } from '../EthereumClient.ts';
import { convertFromSqliteFields, toSqlParams } from '../Utils.ts';
import { BaseTable, IFieldTypes } from './BaseTable.ts';

export enum CrosschainOutboundTransferStatus {
  RequestSubmittedToArgon = 'RequestSubmittedToArgon',
  RequestFinalizedOnArgon = 'RequestFinalizedOnArgon',
  MintingAuthorized = 'MintingAuthorized',
  TransferSubmittedToTargetChain = 'TransferSubmittedToTargetChain',
  TransferFinalizedOnTargetChain = 'TransferFinalizedOnTargetChain',
}

export interface ICrosschainOutboundTransferRecord {
  id: string;
  transferId?: string;
  destinationChain: string;
  token: MoveToken.ARGN | MoveToken.ARGNOT;
  amount: bigint;
  argonSourceAddress: string;
  destinationAddress: string;
  // Local Transactions.id for the Argon transfer-out request.
  argonRequestTransactionId?: number;
  // Local Transactions.id for the Minting Authorization extrinsic.
  mintingAuthorizationTransactionId?: number;
  targetTxHash?: Hash;
  targetBlockNumber?: number;
  targetBlockHash?: Hash;
  mintingAuthorizedMicrogons?: bigint;
  mintingAuthorizedMicronots?: bigint;
  mintingAuthorizedArgonBlockNumber?: number;
  mintingAuthorizedArgonBlockHash?: string;
  gatewayActivityNonce?: bigint;
  finalizeRequestJson?: IEthereumFinalizeTransferOutOfArgonArgs['request'];
  finalizeProofJson?: IEthereumFinalizeTransferOutOfArgonArgs['proof'];
  failureReason?: string;
  isFailureAcknowledged: boolean;
  progressJson: ICrosschainTransferProgress;
  status: CrosschainOutboundTransferStatus;
  createdAt: Date;
  updatedAt: Date;
}

type ICrosschainOutboundTransferRecordKey = keyof ICrosschainOutboundTransferRecord;
export type ICrosschainOutboundTransferInsert = Omit<
  ICrosschainOutboundTransferRecord,
  'createdAt' | 'updatedAt' | 'failureReason' | 'isFailureAcknowledged'
> & {
  failureReason?: string | null;
  isFailureAcknowledged?: boolean;
};
export type ICrosschainOutboundTransferPatch = Partial<
  Omit<ICrosschainOutboundTransferInsert, 'id' | 'failureReason'>
> & {
  failureReason?: string | null;
};

export class CrosschainOutboundTransfersTable extends BaseTable {
  private bigIntFields: ICrosschainOutboundTransferRecordKey[] = [
    'amount',
    'mintingAuthorizedMicrogons',
    'mintingAuthorizedMicronots',
    'gatewayActivityNonce',
  ];
  private booleanFields: ICrosschainOutboundTransferRecordKey[] = ['isFailureAcknowledged'];
  private dateFields: ICrosschainOutboundTransferRecordKey[] = ['createdAt', 'updatedAt'];
  private jsonFields: ICrosschainOutboundTransferRecordKey[] = [
    'finalizeRequestJson',
    'finalizeProofJson',
    'progressJson',
  ];

  private get fields(): IFieldTypes {
    return {
      boolean: this.booleanFields,
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

  public async get(id: string): Promise<ICrosschainOutboundTransferRecord | undefined> {
    const records = await this.db.select<ICrosschainOutboundTransferRecord[]>(
      `SELECT * FROM CrosschainOutboundTransfers WHERE id = ? LIMIT 1`,
      toSqlParams([id]),
    );
    return convertFromSqliteFields<ICrosschainOutboundTransferRecord[]>(records, this.fields)[0];
  }

  public async getByTransferId(transferId: string): Promise<ICrosschainOutboundTransferRecord | undefined> {
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
        WHERE destinationChain = ? AND token = ? AND status != ? AND isFailureAcknowledged = 0
        ORDER BY updatedAt DESC, createdAt DESC
        LIMIT 1`,
      toSqlParams([destinationChain, token, CrosschainOutboundTransferStatus.TransferFinalizedOnTargetChain]),
    );
    return convertFromSqliteFields<ICrosschainOutboundTransferRecord[]>(records, this.fields)[0];
  }

  public async upsert(args: ICrosschainOutboundTransferInsert): Promise<ICrosschainOutboundTransferRecord | undefined> {
    const {
      id,
      transferId,
      destinationChain,
      token,
      amount,
      argonSourceAddress,
      destinationAddress,
      argonRequestTransactionId,
      mintingAuthorizationTransactionId,
      targetTxHash,
      targetBlockNumber,
      targetBlockHash,
      mintingAuthorizedMicrogons,
      mintingAuthorizedMicronots,
      mintingAuthorizedArgonBlockNumber,
      mintingAuthorizedArgonBlockHash,
      gatewayActivityNonce,
      finalizeRequestJson,
      finalizeProofJson,
      failureReason,
      isFailureAcknowledged = false,
      progressJson,
      status,
    } = args;

    const records = await this.db.select<ICrosschainOutboundTransferRecord[]>(
      `INSERT INTO CrosschainOutboundTransfers (
        id,
        transferId,
        destinationChain,
        token,
        amount,
        argonSourceAddress,
        destinationAddress,
        argonRequestTransactionId,
        mintingAuthorizationTransactionId,
        targetTxHash,
        targetBlockNumber,
        targetBlockHash,
        mintingAuthorizedMicrogons,
        mintingAuthorizedMicronots,
        mintingAuthorizedArgonBlockNumber,
        mintingAuthorizedArgonBlockHash,
        gatewayActivityNonce,
        finalizeRequestJson,
        finalizeProofJson,
        failureReason,
        isFailureAcknowledged,
        progressJson,
        status
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        transferId = excluded.transferId,
        destinationChain = excluded.destinationChain,
        token = excluded.token,
        amount = excluded.amount,
        argonSourceAddress = excluded.argonSourceAddress,
        destinationAddress = excluded.destinationAddress,
        argonRequestTransactionId = excluded.argonRequestTransactionId,
        mintingAuthorizationTransactionId = excluded.mintingAuthorizationTransactionId,
        targetTxHash = excluded.targetTxHash,
        targetBlockNumber = excluded.targetBlockNumber,
        targetBlockHash = excluded.targetBlockHash,
        mintingAuthorizedMicrogons = excluded.mintingAuthorizedMicrogons,
        mintingAuthorizedMicronots = excluded.mintingAuthorizedMicronots,
        mintingAuthorizedArgonBlockNumber = excluded.mintingAuthorizedArgonBlockNumber,
        mintingAuthorizedArgonBlockHash = excluded.mintingAuthorizedArgonBlockHash,
        gatewayActivityNonce = excluded.gatewayActivityNonce,
        finalizeRequestJson = excluded.finalizeRequestJson,
        finalizeProofJson = excluded.finalizeProofJson,
        failureReason = excluded.failureReason,
        isFailureAcknowledged = excluded.isFailureAcknowledged,
        progressJson = excluded.progressJson,
        status = excluded.status,
        updatedAt = CURRENT_TIMESTAMP
      RETURNING *`,
      toSqlParams([
        id,
        transferId,
        destinationChain,
        token,
        amount,
        argonSourceAddress,
        destinationAddress,
        argonRequestTransactionId,
        mintingAuthorizationTransactionId,
        targetTxHash,
        targetBlockNumber,
        targetBlockHash,
        mintingAuthorizedMicrogons,
        mintingAuthorizedMicronots,
        mintingAuthorizedArgonBlockNumber,
        mintingAuthorizedArgonBlockHash,
        gatewayActivityNonce,
        finalizeRequestJson,
        finalizeProofJson,
        failureReason,
        isFailureAcknowledged,
        progressJson,
        status,
      ]),
    );

    return convertFromSqliteFields<ICrosschainOutboundTransferRecord[]>(records, this.fields)[0];
  }

  public async recordRequestSubmittedToArgon(args: {
    id: string;
    destinationChain: string;
    token: MoveToken.ARGN | MoveToken.ARGNOT;
    amount: bigint;
    argonSourceAddress: string;
    destinationAddress: string;
    argonRequestTransactionId?: number;
    progressJson: ICrosschainTransferProgress;
  }) {
    const {
      id,
      destinationChain,
      token,
      amount,
      argonSourceAddress,
      destinationAddress,
      argonRequestTransactionId,
      progressJson,
    } = args;
    return this.upsert({
      id,
      destinationChain,
      token,
      amount,
      argonSourceAddress,
      destinationAddress,
      argonRequestTransactionId,
      failureReason: null,
      isFailureAcknowledged: false,
      progressJson,
      status: CrosschainOutboundTransferStatus.RequestSubmittedToArgon,
    });
  }

  public async recordRequestFinalizedOnArgon(args: {
    id: string;
    transferId: string;
    progressJson: ICrosschainTransferProgress;
  }) {
    const { id, transferId, progressJson } = args;
    return this.patch(id, {
      transferId,
      failureReason: null,
      isFailureAcknowledged: false,
      progressJson,
      status: CrosschainOutboundTransferStatus.RequestFinalizedOnArgon,
    });
  }

  public async recordMintingAuthorized(args: {
    id: string;
    mintingAuthorizationTransactionId?: number;
    mintingAuthorizedMicrogons: bigint;
    mintingAuthorizedMicronots: bigint;
    mintingAuthorizedArgonBlockNumber?: number;
    mintingAuthorizedArgonBlockHash?: string;
    finalizeRequestJson: IEthereumFinalizeTransferOutOfArgonArgs['request'];
    finalizeProofJson: IEthereumFinalizeTransferOutOfArgonArgs['proof'];
    progressJson?: ICrosschainTransferProgress;
  }) {
    const {
      id,
      mintingAuthorizationTransactionId,
      mintingAuthorizedMicrogons,
      mintingAuthorizedMicronots,
      mintingAuthorizedArgonBlockNumber,
      mintingAuthorizedArgonBlockHash,
      finalizeRequestJson,
      finalizeProofJson,
      progressJson,
    } = args;
    return this.patch(id, {
      mintingAuthorizationTransactionId,
      mintingAuthorizedMicrogons,
      mintingAuthorizedMicronots,
      mintingAuthorizedArgonBlockNumber,
      mintingAuthorizedArgonBlockHash,
      finalizeRequestJson,
      finalizeProofJson,
      failureReason: null,
      isFailureAcknowledged: false,
      progressJson,
      status: CrosschainOutboundTransferStatus.MintingAuthorized,
    });
  }

  public async recordTransferSubmittedToTargetChain(args: {
    id: string;
    targetTxHash: Hash;
    progressJson?: ICrosschainTransferProgress;
  }) {
    const { id, targetTxHash, progressJson } = args;
    return this.patch(id, {
      targetTxHash,
      failureReason: null,
      isFailureAcknowledged: false,
      progressJson,
      status: CrosschainOutboundTransferStatus.TransferSubmittedToTargetChain,
    });
  }

  public async recordTransferFinalizedOnTargetChain(args: {
    id: string;
    targetBlockNumber?: number;
    targetBlockHash?: Hash;
    gatewayActivityNonce: bigint;
    progressJson?: ICrosschainTransferProgress;
  }) {
    const { id, targetBlockNumber, targetBlockHash, gatewayActivityNonce, progressJson } = args;
    return this.patch(id, {
      targetBlockNumber,
      targetBlockHash,
      gatewayActivityNonce,
      failureReason: null,
      isFailureAcknowledged: false,
      progressJson,
      status: CrosschainOutboundTransferStatus.TransferFinalizedOnTargetChain,
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
    patch: ICrosschainOutboundTransferPatch,
  ): Promise<ICrosschainOutboundTransferRecord | undefined> {
    const patchKeys = (Object.keys(patch) as (keyof ICrosschainOutboundTransferPatch)[]).filter(
      key => patch[key] !== undefined,
    );
    if (!patchKeys.length) {
      return await this.get(id);
    }

    const fieldsSql = patchKeys.map(key => `${key} = ?`).join(', ');
    const params: Parameters<typeof toSqlParams>[0] = [];
    for (const key of patchKeys) {
      params.push(patch[key] ?? null);
    }
    const records = await this.db.select<ICrosschainOutboundTransferRecord[]>(
      `UPDATE CrosschainOutboundTransfers
      SET ${fieldsSql}, updatedAt = CURRENT_TIMESTAMP
      WHERE id = ?
      RETURNING *`,
      toSqlParams([...params, id]),
    );

    return convertFromSqliteFields<ICrosschainOutboundTransferRecord[]>(records, this.fields)[0];
  }
}
