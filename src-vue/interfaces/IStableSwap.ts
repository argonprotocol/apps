import type { Address } from 'viem';
import type { IStableSwapPurchaseRecord as IStableSwapPurchaseRow } from '../lib/db/StableSwapPurchasesTable.ts';
import type { IStableSwapSyncStateRecord } from '../lib/db/StableSwapSyncStateTable.ts';

export interface IStableSwapPoolMetadata {
  poolAddress: Address;
  poolFee: number;
  poolLiquidity: bigint;
  currentSqrtPriceX96: bigint;
  currentTick: number;
  argonIsToken0: boolean;
}

export interface IStableSwapMarketSnapshot {
  poolAddress: string;
  poolFee: number;
  poolLiquidity: bigint;
  currentPriceMicrogons: bigint;
  targetPriceMicrogons?: bigint;
  discountedEthereumArgonAmount: bigint;
  costToTargetMicrogons: bigint;
  projectedProfitMicrogons: bigint;
  updatedAt: Date;
}

export interface IStableSwapPurchaseRecord extends IStableSwapPurchaseRow {
  currentValueMicrogons: bigint;
  currentProfitMicrogons: bigint;
}

export interface IStableSwapAddressSummary {
  walletAddress: string;
  watchedSinceBlockNumber?: number;
  capitalAppliedMicrogons: bigint;
  currentValueMicrogons: bigint;
  currentProfitMicrogons: bigint;
  returnPct: number;
  purchaseCount: number;
}

export interface IStableSwapWalletSnapshot {
  startedTracking: boolean;
  purchases: IStableSwapPurchaseRecord[];
  summary: IStableSwapAddressSummary;
  syncState: IStableSwapSyncStateRecord;
}

export type IStableSwapArgonPriceSnapshot = {
  argonBlockNumber?: number;
  argonBlockHash?: string;
  argonOraclePriceMicrogons?: bigint;
  argonOracleTargetPriceMicrogons?: bigint;
};

export type IStableSwapPurchaseBuildResult = Omit<IStableSwapPurchaseRow, 'id' | 'createdAt' | 'updatedAt'>;

export interface IStableSwapQuoteResult {
  amountOut: bigint;
  amountIn: bigint;
  priceAfterFixed18: bigint;
}
