import { BaseTable, IFieldTypes } from './BaseTable.ts';
import { convertFromSqliteFields, toSqlParams } from '../Utils.ts';

export enum StableSwapProofStatus {
  Pending = 'Pending',
  Ready = 'Ready',
  Failed = 'Failed',
}

export interface IStableSwapPurchaseRecord {
  id: number;
  walletAddress: string;
  txHash: string;
  blockNumber: number;
  blockHash: string;
  transactionIndex: number;
  receiptRoot: string;
  ethereumTimestamp: Date;
  poolAddress: string;
  poolFee: number;
  ethereumArgonAmount: bigint;
  costBasisUsdc: bigint;
  costBasisMicrogons: bigint;
  effectiveBuyPriceMicrogons: bigint;
  uniswapPriceMicrogons: bigint;
  argonBlockNumber?: number;
  argonBlockHash?: string;
  argonOraclePriceMicrogons?: bigint;
  argonOracleTargetPriceMicrogons?: bigint;
  proofStatus: StableSwapProofStatus;
  proofPayload?: object;
  proofError?: string;
  createdAt: Date;
  updatedAt: Date;
}

type IStableSwapPurchaseRecordKey = keyof IStableSwapPurchaseRecord;

export class StableSwapPurchasesTable extends BaseTable {
  private bigIntFields: IStableSwapPurchaseRecordKey[] = [
    'ethereumArgonAmount',
    'costBasisUsdc',
    'costBasisMicrogons',
    'effectiveBuyPriceMicrogons',
    'uniswapPriceMicrogons',
    'argonOraclePriceMicrogons',
    'argonOracleTargetPriceMicrogons',
  ];
  private dateFields: IStableSwapPurchaseRecordKey[] = ['ethereumTimestamp', 'createdAt', 'updatedAt'];
  private jsonFields: IStableSwapPurchaseRecordKey[] = ['proofPayload'];

  private get fields(): IFieldTypes {
    return {
      bigint: this.bigIntFields,
      date: this.dateFields,
      json: this.jsonFields,
    };
  }

  public async fetchByWallet(walletAddress: string): Promise<IStableSwapPurchaseRecord[]> {
    const records = await this.db.select<IStableSwapPurchaseRecord[]>(
      `SELECT * FROM StableSwapPurchases WHERE walletAddress = ? ORDER BY ethereumTimestamp DESC, id DESC`,
      [walletAddress],
    );
    return convertFromSqliteFields<IStableSwapPurchaseRecord[]>(records, this.fields);
  }

  public async fetchMissingProofs(walletAddress: string): Promise<IStableSwapPurchaseRecord[]> {
    const records = await this.db.select<IStableSwapPurchaseRecord[]>(
      `SELECT * FROM StableSwapPurchases
         WHERE walletAddress = ?
           AND proofStatus != ?
         ORDER BY blockNumber DESC, transactionIndex ASC`,
      toSqlParams([walletAddress, StableSwapProofStatus.Ready]),
    );
    return convertFromSqliteFields<IStableSwapPurchaseRecord[]>(records, this.fields);
  }

  public async upsert(
    args: Omit<IStableSwapPurchaseRecord, 'id' | 'createdAt' | 'updatedAt'>,
  ): Promise<IStableSwapPurchaseRecord | undefined> {
    const {
      walletAddress,
      txHash,
      blockNumber,
      blockHash,
      transactionIndex,
      receiptRoot,
      ethereumTimestamp,
      poolAddress,
      poolFee,
      ethereumArgonAmount,
      costBasisUsdc,
      costBasisMicrogons,
      effectiveBuyPriceMicrogons,
      uniswapPriceMicrogons,
      argonBlockNumber,
      argonBlockHash,
      argonOraclePriceMicrogons,
      argonOracleTargetPriceMicrogons,
      proofStatus,
      proofPayload,
      proofError,
    } = args;

    const records = await this.db.select<IStableSwapPurchaseRecord[]>(
      `INSERT INTO StableSwapPurchases (
         walletAddress,
         txHash,
         blockNumber,
         blockHash,
         transactionIndex,
         receiptRoot,
         ethereumTimestamp,
         poolAddress,
         poolFee,
         ethereumArgonAmount,
         costBasisUsdc,
         costBasisMicrogons,
         effectiveBuyPriceMicrogons,
         uniswapPriceMicrogons,
         argonBlockNumber,
         argonBlockHash,
         argonOraclePriceMicrogons,
         argonOracleTargetPriceMicrogons,
         proofStatus,
         proofPayload,
         proofError
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(walletAddress, txHash) DO UPDATE SET
         blockNumber = excluded.blockNumber,
         blockHash = excluded.blockHash,
         transactionIndex = excluded.transactionIndex,
         receiptRoot = excluded.receiptRoot,
         ethereumTimestamp = excluded.ethereumTimestamp,
         poolAddress = excluded.poolAddress,
         poolFee = excluded.poolFee,
         ethereumArgonAmount = excluded.ethereumArgonAmount,
         costBasisUsdc = excluded.costBasisUsdc,
         costBasisMicrogons = excluded.costBasisMicrogons,
         effectiveBuyPriceMicrogons = excluded.effectiveBuyPriceMicrogons,
         uniswapPriceMicrogons = excluded.uniswapPriceMicrogons,
         argonBlockNumber = excluded.argonBlockNumber,
         argonBlockHash = excluded.argonBlockHash,
         argonOraclePriceMicrogons = excluded.argonOraclePriceMicrogons,
         argonOracleTargetPriceMicrogons = excluded.argonOracleTargetPriceMicrogons,
         proofStatus = excluded.proofStatus,
         proofPayload = excluded.proofPayload,
         proofError = excluded.proofError,
         updatedAt = CURRENT_TIMESTAMP
       RETURNING *`,
      toSqlParams([
        walletAddress,
        txHash,
        blockNumber,
        blockHash,
        transactionIndex,
        receiptRoot,
        ethereumTimestamp,
        poolAddress,
        poolFee,
        ethereumArgonAmount,
        costBasisUsdc,
        costBasisMicrogons,
        effectiveBuyPriceMicrogons,
        uniswapPriceMicrogons,
        argonBlockNumber,
        argonBlockHash,
        argonOraclePriceMicrogons,
        argonOracleTargetPriceMicrogons,
        proofStatus,
        proofPayload,
        proofError,
      ]),
    );

    return convertFromSqliteFields<IStableSwapPurchaseRecord[]>(records, this.fields)[0];
  }

  public async updateProof(
    walletAddress: string,
    txHash: string,
    args: {
      proofStatus: StableSwapProofStatus;
      proofPayload?: object;
      proofError?: string;
    },
  ): Promise<void> {
    const { proofStatus, proofPayload, proofError } = args;
    await this.db.execute(
      `UPDATE StableSwapPurchases
         SET proofStatus = ?,
             proofPayload = ?,
             proofError = ?,
             updatedAt = CURRENT_TIMESTAMP
       WHERE walletAddress = ?
         AND txHash = ?`,
      toSqlParams([proofStatus, proofPayload, proofError, walletAddress, txHash]),
    );
  }
}
