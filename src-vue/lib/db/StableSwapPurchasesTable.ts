import { BaseTable, type IFieldTypes } from './BaseTable.ts';
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

export class StableSwapPurchasesTable extends BaseTable {
  private fields: IFieldTypes = {
    bigint: [
      'ethereumArgonAmount',
      'costBasisUsdc',
      'costBasisMicrogons',
      'effectiveBuyPriceMicrogons',
      'uniswapPriceMicrogons',
      'argonOraclePriceMicrogons',
      'argonOracleTargetPriceMicrogons',
    ] satisfies (keyof IStableSwapPurchaseRecord)[],
    date: ['ethereumTimestamp', 'createdAt', 'updatedAt'] satisfies (keyof IStableSwapPurchaseRecord)[],
    json: ['proofPayload'] satisfies (keyof IStableSwapPurchaseRecord)[],
  };

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
         (blockNumber, blockHash, transactionIndex, receiptRoot, ethereumTimestamp,
          poolAddress, poolFee, ethereumArgonAmount, costBasisUsdc, costBasisMicrogons,
          effectiveBuyPriceMicrogons, uniswapPriceMicrogons, argonBlockNumber, argonBlockHash,
          argonOraclePriceMicrogons, argonOracleTargetPriceMicrogons, updatedAt) =
         (excluded.blockNumber, excluded.blockHash, excluded.transactionIndex, excluded.receiptRoot,
          excluded.ethereumTimestamp, excluded.poolAddress, excluded.poolFee, excluded.ethereumArgonAmount,
          excluded.costBasisUsdc, excluded.costBasisMicrogons, excluded.effectiveBuyPriceMicrogons,
          excluded.uniswapPriceMicrogons, excluded.argonBlockNumber, excluded.argonBlockHash,
          excluded.argonOraclePriceMicrogons, excluded.argonOracleTargetPriceMicrogons, CURRENT_TIMESTAMP)
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
