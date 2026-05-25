import JSBI from 'jsbi';
import { CurrencyAmount, TradeType } from '@uniswap/sdk-core';
import { FeeAmount, Pool as UniswapV3Pool, Route as UniswapV3Route, SwapQuoter, TickMath } from '@uniswap/v3-sdk';
import { erc20Abi, formatUnits, getAddress, type Hex, type PublicClient } from 'viem';
import {
  createStableSwapSdkPool,
  ETHEREUM_ARGON_DECIMALS,
  ethereumArgonBaseUnitsToMicrogons,
  fixed18ToMicrogons,
  FIXED_18,
  getStableSwapArgonToken,
  getStableSwapArgonTokenAddress,
  getStableSwapUsdcToken,
  microgonsToEthereumArgonBaseUnits,
  ONE_ETHEREUM_ARGON,
  type StableSwapPoolSlot0,
  type StableSwapSdkPoolState,
  stableSwapSdkPriceToFixed18,
  UNISWAP_V3_POOL_STATE_ABI,
  usdcToFixed18,
  usdcToMicrogons,
} from './StableSwapUtils.ts';
import type {
  IStableSwap,
  IStableSwapMarketSnapshot,
  IStableSwapPoolMetadata,
  IStableSwapQuoteResult,
} from '../interfaces/IStableSwap.ts';
import { UnitOfMeasurement } from '@argonprotocol/apps-core';

export const STABLE_SWAP_QUOTE_TOLERANCE_ETHEREUM_ARGON_AMOUNT = 10n ** 12n;
const UNISWAP_FEE_TIERS = [FeeAmount.LOWEST, FeeAmount.LOW, FeeAmount.MEDIUM, FeeAmount.HIGH] as const;
const UNISWAP_V3_QUOTER_V2_ADDRESS = getAddress('0x61fFE014bA17989E743c5F6cB21bF9697530B21e');

export class StableSwaps {
  constructor(private readonly client: PublicClient) {}

  public async getActive(args: {
    microgonsPerUsd: bigint;
    targetPriceFixed18?: bigint;
    blockNumber?: bigint;
  }): Promise<IStableSwap[]> {
    args.blockNumber = args.blockNumber ?? (await this.client.getBlockNumber());
    const activePool = await this.getActivePoolMetadata(args.blockNumber);
    const snapshot = await this.getMarketSnapshot({
      pool: activePool,
      ...args,
    });
    if (snapshot.discountedEthereumArgonAmount <= 0n || snapshot.costToTargetMicrogons <= 0n) {
      return [];
    }

    return [
      {
        inputToken: UnitOfMeasurement.USDC,
        outputToken: UnitOfMeasurement.ARGN,
        network: 'ethereum',
        inputAmount: snapshot.costToTargetMicrogons,
        outputAmount: snapshot.discountedEthereumArgonAmount,
        projectedProfitMicrogons: snapshot.projectedProfitMicrogons,
        returnPct: calculateStableSwapReturnPct(snapshot.costToTargetMicrogons, snapshot.projectedProfitMicrogons),
        tradeUrl: this.buildStableSwapUniswapUrl(snapshot.discountedEthereumArgonAmount),
        poolAddress: activePool.poolAddress,
        poolFee: activePool.poolFee,
        poolLiquidity: activePool.poolLiquidity,
        currentPriceMicrogons: snapshot.currentPriceMicrogons,
        targetPriceMicrogons: snapshot.targetPriceMicrogons,
        targetPriceOffset: snapshot.targetPriceOffset,
        updatedAt: snapshot.updatedAt,
      },
    ];
  }

  public async getActivePoolMetadata(blockNumber?: bigint): Promise<IStableSwapPoolMetadata> {
    const argonToken = getStableSwapArgonToken();
    const usdcToken = getStableSwapUsdcToken();
    const argonIsToken0 = argonToken.sortsBefore(usdcToken);

    const pools = await Promise.all(
      UNISWAP_FEE_TIERS.map(async poolFee => {
        const poolAddress = getAddress(UniswapV3Pool.getAddress(argonToken, usdcToken, poolFee));

        try {
          const [poolLiquidity, slot0] = (await Promise.all([
            this.client.readContract({
              address: poolAddress,
              abi: UNISWAP_V3_POOL_STATE_ABI,
              functionName: 'liquidity',
              blockNumber,
            }),
            this.client.readContract({
              address: poolAddress,
              abi: UNISWAP_V3_POOL_STATE_ABI,
              functionName: 'slot0',
              blockNumber,
            }),
          ])) as [bigint, StableSwapPoolSlot0];

          return {
            poolAddress,
            poolFee,
            poolLiquidity,
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

  public async getMarketSnapshot(args: {
    microgonsPerUsd: bigint;
    targetPriceFixed18?: bigint;
    pool: IStableSwapPoolMetadata;
    blockNumber?: bigint;
  }): Promise<IStableSwapMarketSnapshot> {
    const { microgonsPerUsd, targetPriceFixed18, pool, blockNumber } = args;
    const currentPriceFixed18 = this.getCurrentPriceFixed18(pool);

    let discountedEthereumArgonAmount = 0n;
    let costToTargetMicrogons = 0n;
    let projectedProfitMicrogons = 0n;

    if (targetPriceFixed18 && currentPriceFixed18 < targetPriceFixed18) {
      const quote = await this.findAmountToTarget({
        pool,
        targetPriceFixed18,
        blockNumber,
      });
      if (quote) {
        discountedEthereumArgonAmount = ethereumArgonBaseUnitsToMicrogons(quote.amountOut);
        costToTargetMicrogons = usdcToMicrogons(quote.amountIn, microgonsPerUsd);
        projectedProfitMicrogons = fixed18ToMicrogons(
          calculateCurrentValueFixed18(quote.amountOut, targetPriceFixed18) - usdcToFixed18(quote.amountIn),
          microgonsPerUsd,
        );
      }
    }

    const currentPriceMicrogons = fixed18ToMicrogons(currentPriceFixed18, microgonsPerUsd);
    const targetPriceMicrogons = targetPriceFixed18
      ? fixed18ToMicrogons(targetPriceFixed18, microgonsPerUsd)
      : undefined;

    return {
      poolAddress: pool.poolAddress,
      poolFee: pool.poolFee,
      poolLiquidity: pool.poolLiquidity,
      currentPriceMicrogons,
      targetPriceMicrogons,
      targetPriceOffset: targetPriceMicrogons !== undefined ? currentPriceMicrogons - targetPriceMicrogons : 0n,
      discountedEthereumArgonAmount,
      costToTargetMicrogons,
      projectedProfitMicrogons,
      updatedAt: new Date(),
    };
  }

  public async findAmountToTarget(args: {
    pool: IStableSwapPoolMetadata;
    targetPriceFixed18: bigint;
    blockNumber?: bigint;
  }): Promise<IStableSwapQuoteResult | null> {
    const { pool, targetPriceFixed18, blockNumber } = args;
    const poolArgonBalance = await this.client.readContract({
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
          await this.quoteExactOutput({
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

  public async quoteExactOutput(args: {
    pool: IStableSwapPoolMetadata;
    amountOut: bigint;
    blockNumber?: bigint;
    throwOnError?: boolean;
  }): Promise<IStableSwapQuoteResult | null> {
    const { pool, amountOut, blockNumber, throwOnError = false } = args;
    const argonToken = getStableSwapArgonToken();
    const usdcToken = getStableSwapUsdcToken();
    const route = new UniswapV3Route([createStableSwapSdkPool(pool)], usdcToken, argonToken);

    try {
      const quotedAmountOut = CurrencyAmount.fromRawAmount(argonToken, amountOut.toString());
      const { calldata } = SwapQuoter.quoteCallParameters(route, quotedAmountOut, TradeType.EXACT_OUTPUT, {
        useQuoterV2: true,
      });

      const quoteResult = await this.client.call({
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

  public getCurrentPriceFixed18(pool: IStableSwapPoolMetadata, state?: StableSwapSdkPoolState): bigint {
    return stableSwapSdkPriceToFixed18(createStableSwapSdkPool(pool, state).priceOf(getStableSwapArgonToken()));
  }

  public buildStableSwapUniswapUrl(argonAmountMicrogons: bigint): string | null {
    if (argonAmountMicrogons <= 0n) {
      return null;
    }

    const ethereumArgonAmount = microgonsToEthereumArgonBaseUnits(argonAmountMicrogons);
    return `https://app.uniswap.org/#/swap?chain=mainnet&outputCurrency=${getStableSwapArgonTokenAddress()}&exactField=output&exactAmount=${formatUnits(ethereumArgonAmount, ETHEREUM_ARGON_DECIMALS)}`;
  }
}

function calculateCurrentValueFixed18(ethereumArgonAmount: bigint, priceFixed18: bigint): bigint {
  return (ethereumArgonAmount * priceFixed18) / FIXED_18;
}

function calculateStableSwapReturnPct(costMicrogons: bigint, projectedProfitMicrogons: bigint): number {
  if (costMicrogons <= 0n) {
    return 0;
  }

  return Number((projectedProfitMicrogons * 10_000n) / costMicrogons) / 100;
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
