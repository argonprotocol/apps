import JSBI from 'jsbi';
import { CurrencyAmount, TradeType } from '@uniswap/sdk-core';
import { FeeAmount, Pool as UniswapV3Pool, Route as UniswapV3Route, SwapQuoter, TickMath } from '@uniswap/v3-sdk';
import { erc20Abi, formatUnits, getAddress, type Address, type Hex, type PublicClient } from 'viem';
import type { Db } from './Db.ts';
import { type IStableSwapMarketStateRecord } from './db/StableSwapMarketStateTable.ts';
import {
  ETHEREUM_ARGON_DECIMALS,
  FIXED_18,
  ONE_ETHEREUM_ARGON,
  UNISWAP_V3_POOL_STATE_ABI,
  createStableSwapSdkPool,
  fixed18ToMicrogons,
  getStableSwapArgonToken,
  getStableSwapArgonTokenAddress,
  getStableSwapUsdcToken,
  stableSwapSdkPriceToFixed18,
  usdcToFixed18,
  usdcToMicrogons,
  type StableSwapPoolSlot0,
  type StableSwapSdkPoolState,
} from './StableSwapUtils.ts';
import type {
  IStableSwapPoolMetadata,
  IStableSwapMarketSnapshot,
  IStableSwapQuoteResult,
} from '../interfaces/IStableSwap.ts';

export { getStableSwapArgonTokenAddress } from './StableSwapUtils.ts';
export {
  backfillStableSwapProofs,
  buildStableSwapPurchaseFromTransaction,
  buildStableSwapReceiptProofs,
  hydrateStableSwapWallet,
  loadStableSwapWalletSnapshot,
  syncStableSwapWallet,
  type StableSwapReceiptProof,
} from './StableSwapWallet.ts';

export const STABLE_SWAP_QUOTE_TOLERANCE_ETHEREUM_ARGON_AMOUNT = 10n ** 12n;
const UNISWAP_FEE_TIERS = [FeeAmount.LOWEST, FeeAmount.LOW, FeeAmount.MEDIUM, FeeAmount.HIGH] as const;
const UNISWAP_V3_QUOTER_V2_ADDRESS = getAddress('0x61fFE014bA17989E743c5F6cB21bF9697530B21e');

export function normalizeStableSwapAddress(address: string): Address {
  return getAddress(address.trim());
}

export async function fetchStableSwapPoolMetadata(
  client: PublicClient,
  blockNumber?: bigint,
): Promise<IStableSwapPoolMetadata> {
  const argonToken = getStableSwapArgonToken();
  const usdcToken = getStableSwapUsdcToken();
  const argonIsToken0 = argonToken.sortsBefore(usdcToken);

  const pools = await Promise.all(
    UNISWAP_FEE_TIERS.map(async poolFee => {
      const poolAddress = getAddress(UniswapV3Pool.getAddress(argonToken, usdcToken, poolFee));

      try {
        const [liquidity, slot0] = (await Promise.all([
          client.readContract({
            address: poolAddress,
            abi: UNISWAP_V3_POOL_STATE_ABI,
            functionName: 'liquidity',
            blockNumber,
          }),
          client.readContract({
            address: poolAddress,
            abi: UNISWAP_V3_POOL_STATE_ABI,
            functionName: 'slot0',
            blockNumber,
          }),
        ])) as [bigint, StableSwapPoolSlot0];

        return {
          poolAddress,
          poolFee,
          poolLiquidity: liquidity,
          currentSqrtPriceX96: slot0[0],
          currentTick: Number(slot0[1]),
          argonIsToken0,
        } satisfies IStableSwapPoolMetadata;
      } catch {
        return null;
      }
    }),
  );

  const activePool = pools
    .filter((pool): pool is IStableSwapPoolMetadata => Boolean(pool))
    .filter(pool => pool.poolLiquidity > 0n)
    .sort((left, right) => {
      if (left.poolLiquidity === right.poolLiquidity) {
        return left.poolFee - right.poolFee;
      }
      return left.poolLiquidity > right.poolLiquidity ? -1 : 1;
    })[0];

  if (!activePool) {
    throw new Error('Could not find an active Uniswap v3 Argon/USDC pool on Ethereum.');
  }

  return activePool;
}

export async function fetchStableSwapMarketSnapshot(
  client: PublicClient,
  microgonsPerUsd: bigint,
  targetPriceFixed18?: bigint,
  pool?: IStableSwapPoolMetadata,
  blockNumber?: bigint,
): Promise<{ pool: IStableSwapPoolMetadata; snapshot: IStableSwapMarketSnapshot }> {
  const activePool = pool ?? (await fetchStableSwapPoolMetadata(client, blockNumber));
  const currentPriceFixed18 = getStableSwapPoolPriceFixed18(activePool);

  let discountedEthereumArgonAmount = 0n;
  let costToTargetMicrogons = 0n;
  let projectedProfitMicrogons = 0n;

  if (targetPriceFixed18 && currentPriceFixed18 < targetPriceFixed18) {
    const quote = await findStableSwapAmountToTarget({
      client,
      pool: activePool,
      targetPriceFixed18,
      blockNumber,
    });
    if (quote) {
      discountedEthereumArgonAmount = quote.amountOut;
      costToTargetMicrogons = usdcToMicrogons(quote.amountIn, microgonsPerUsd);
      projectedProfitMicrogons = fixed18ToMicrogons(
        calculateCurrentValueFixed18(quote.amountOut, targetPriceFixed18) - usdcToFixed18(quote.amountIn),
        microgonsPerUsd,
      );
    }
  }

  return {
    pool: activePool,
    snapshot: {
      poolAddress: activePool.poolAddress,
      poolFee: activePool.poolFee,
      poolLiquidity: activePool.poolLiquidity,
      currentPriceMicrogons: fixed18ToMicrogons(currentPriceFixed18, microgonsPerUsd),
      targetPriceMicrogons: targetPriceFixed18 ? fixed18ToMicrogons(targetPriceFixed18, microgonsPerUsd) : undefined,
      discountedEthereumArgonAmount,
      costToTargetMicrogons,
      projectedProfitMicrogons,
      updatedAt: new Date(),
    },
  };
}

export function getStableSwapPoolPriceFixed18(pool: IStableSwapPoolMetadata, state?: StableSwapSdkPoolState): bigint {
  return stableSwapSdkPriceToFixed18(createStableSwapSdkPool(pool, state).priceOf(getStableSwapArgonToken()));
}

export function buildStableSwapUniswapUrl(ethereumArgonAmount: bigint): string | null {
  if (ethereumArgonAmount <= 0n) {
    return null;
  }

  return `https://app.uniswap.org/#/swap?chain=mainnet&outputCurrency=${getStableSwapArgonTokenAddress()}&exactField=output&exactAmount=${formatUnits(ethereumArgonAmount, ETHEREUM_ARGON_DECIMALS)}`;
}

export function stableSwapMarketRecordToSnapshot(record: IStableSwapMarketStateRecord): IStableSwapMarketSnapshot {
  return {
    poolAddress: record.poolAddress,
    poolFee: record.poolFee,
    poolLiquidity: record.poolLiquidity,
    currentPriceMicrogons: record.currentPriceMicrogons,
    targetPriceMicrogons: record.targetPriceMicrogons,
    discountedEthereumArgonAmount: record.discountedEthereumArgonAmount,
    costToTargetMicrogons: record.costToTargetMicrogons,
    projectedProfitMicrogons: record.projectedProfitMicrogons,
    updatedAt: record.updatedAt,
  };
}

export async function storeStableSwapMarketSnapshot(args: {
  db: Db;
  snapshot: IStableSwapMarketSnapshot;
}): Promise<void> {
  const { db, snapshot } = args;

  await db.stableSwapMarketStateTable.upsert({
    poolAddress: snapshot.poolAddress,
    poolFee: snapshot.poolFee,
    poolLiquidity: snapshot.poolLiquidity,
    currentPriceMicrogons: snapshot.currentPriceMicrogons,
    targetPriceMicrogons: snapshot.targetPriceMicrogons,
    discountedEthereumArgonAmount: snapshot.discountedEthereumArgonAmount,
    costToTargetMicrogons: snapshot.costToTargetMicrogons,
    projectedProfitMicrogons: snapshot.projectedProfitMicrogons,
  });
}

export async function findStableSwapAmountToTarget(args: {
  client: PublicClient;
  pool: IStableSwapPoolMetadata;
  targetPriceFixed18: bigint;
  blockNumber?: bigint;
}): Promise<IStableSwapQuoteResult | null> {
  const { client, pool, targetPriceFixed18, blockNumber } = args;
  const poolArgonBalance = await client.readContract({
    address: getStableSwapArgonTokenAddress(),
    abi: erc20Abi,
    functionName: 'balanceOf',
    args: [pool.poolAddress],
    blockNumber,
  });
  if (poolArgonBalance <= 0n) {
    return null;
  }

  let low = 0n;
  let high = poolArgonBalance > ONE_ETHEREUM_ARGON ? ONE_ETHEREUM_ARGON : poolArgonBalance;

  const quoteCache = new Map<string, IStableSwapQuoteResult | null>();
  const quoteAmountOut = async (amountOut: bigint) => {
    const cacheKey = amountOut.toString();
    if (!quoteCache.has(cacheKey)) {
      quoteCache.set(
        cacheKey,
        await quoteStableSwapExactOutput({
          client,
          pool,
          amountOut,
          blockNumber,
        }),
      );
    }

    return quoteCache.get(cacheKey)!;
  };

  let bestQuote: IStableSwapQuoteResult | null = null;
  while (high < poolArgonBalance) {
    const quote = await quoteAmountOut(high);
    if (quote && quote.priceAfterFixed18 >= targetPriceFixed18) {
      bestQuote = quote;
      break;
    }
    low = high;
    high = high * 2n;
    if (high > poolArgonBalance) {
      high = poolArgonBalance;
    }
  }

  if (!bestQuote) {
    const quote = await quoteAmountOut(high);
    if (!quote || quote.priceAfterFixed18 < targetPriceFixed18) {
      return null;
    }
    bestQuote = quote;
  }

  while (high - low > STABLE_SWAP_QUOTE_TOLERANCE_ETHEREUM_ARGON_AMOUNT) {
    const mid = (low + high) / 2n;
    const quote = await quoteAmountOut(mid);
    if (!quote) {
      high = mid;
      continue;
    }

    if (quote.priceAfterFixed18 >= targetPriceFixed18) {
      bestQuote = quote;
      high = mid;
    } else {
      low = mid;
    }
  }

  return bestQuote;
}

export async function quoteStableSwapExactOutput(args: {
  client: PublicClient;
  pool: IStableSwapPoolMetadata;
  amountOut: bigint;
  blockNumber?: bigint;
  throwOnError?: boolean;
}): Promise<IStableSwapQuoteResult | null> {
  const { client, pool, amountOut, blockNumber, throwOnError = false } = args;
  const argonToken = getStableSwapArgonToken();
  const usdcToken = getStableSwapUsdcToken();
  const route = new UniswapV3Route([createStableSwapSdkPool(pool)], usdcToken, argonToken);

  try {
    const quotedAmountOut = CurrencyAmount.fromRawAmount(argonToken, amountOut.toString());
    const { calldata } = SwapQuoter.quoteCallParameters(route, quotedAmountOut, TradeType.EXACT_OUTPUT, {
      useQuoterV2: true,
    });

    const quoteResult = await client.call({
      to: UNISWAP_V3_QUOTER_V2_ADDRESS,
      data: calldata as Hex,
      blockNumber,
    });
    if (!quoteResult.data) {
      return null;
    }

    const { amountIn, sqrtPriceX96After } = decodeStableSwapExactOutputQuote(quoteResult.data);
    const tickAfter = TickMath.getTickAtSqrtRatio(JSBI.BigInt(sqrtPriceX96After.toString()) as any);
    const quotedPool = createStableSwapSdkPool(pool, {
      sqrtPriceX96: sqrtPriceX96After,
      liquidity: pool.poolLiquidity,
      tickCurrent: tickAfter,
    });

    return {
      amountOut,
      amountIn,
      priceAfterFixed18: stableSwapSdkPriceToFixed18(quotedPool.priceOf(argonToken)),
    };
  } catch (error) {
    if (throwOnError) {
      throw error;
    }

    return null;
  }
}

function calculateCurrentValueFixed18(ethereumArgonAmount: bigint, priceFixed18: bigint): bigint {
  return (ethereumArgonAmount * priceFixed18) / FIXED_18;
}

function decodeStableSwapExactOutputQuote(data: Hex): {
  amountIn: bigint;
  sqrtPriceX96After: bigint;
} {
  const decoded = SwapQuoter.V2INTERFACE.decodeFunctionResult('quoteExactOutputSingle', data) as unknown as readonly [
    { toString(): string },
    { toString(): string },
  ];

  return {
    amountIn: BigInt(decoded[0].toString()),
    sqrtPriceX96After: BigInt(decoded[1].toString()),
  };
}
