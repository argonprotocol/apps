import type { Address } from 'viem';
import type { IStableSwapPurchaseRecord as IStableSwapPurchaseRow } from '../lib/db/StableSwapPurchasesTable.ts';
import type { IStableSwapSyncStateRecord } from '../lib/db/StableSwapSyncStateTable.ts';
import { UnitOfMeasurement } from '@argonprotocol/apps-core';

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
  targetPriceOffset: bigint;
  discountedEthereumArgonAmount: bigint;
  costToTargetMicrogons: bigint;
  projectedProfitMicrogons: bigint;
  updatedAt: Date;
}

export type IStableSwapInputTokenSymbol =
  | UnitOfMeasurement.ETH
  | UnitOfMeasurement.USDC
  | UnitOfMeasurement.USDT
  | UnitOfMeasurement.ARGNOT;
export type IStableSwapOutputTokenSymbol = UnitOfMeasurement.ARGN;
export type IStableSwapNetwork = 'ethereum';
export type IStableSwapDisabledReason = 'no_tokens' | 'no_pool' | 'not_profitable' | 'quote_failed';

export interface IStableSwap {
  inputToken: IStableSwapInputTokenSymbol;
  outputToken: IStableSwapOutputTokenSymbol;
  network: IStableSwapNetwork;
  inputAmount: bigint;
  inputAmountMicrogons: bigint;
  inputTokenDecimals: number;
  outputAmount: bigint;
  projectedProfitMicrogons: bigint;
  returnPct: number;
  disabledReason?: IStableSwapDisabledReason;
  poolAddress: string;
  poolFee: number;
  poolLiquidity: bigint;
  currentPriceMicrogons: bigint;
  targetPriceMicrogons?: bigint;
  targetPriceOffset: bigint;
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
  purchasedNativeAmount: bigint;
  hasHistoricalBasis: boolean;
  startedAt?: Date;
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
  microgonsPerUsd?: bigint;
};

export type IStableSwapPurchaseBuildResult = Omit<IStableSwapPurchaseRow, 'id' | 'createdAt' | 'updatedAt'>;

export interface IStableSwapQuoteResult {
  amountOut: bigint;
  amountIn: bigint;
  priceAfterFixed18: bigint;
}
