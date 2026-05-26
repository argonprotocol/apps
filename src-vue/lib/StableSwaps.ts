import JSBI from 'jsbi';
import { CurrencyAmount, Token, TradeType } from '@uniswap/sdk-core';
import { FeeAmount, Pool as UniswapV3Pool, Route as UniswapV3Route, SwapQuoter, TickMath } from '@uniswap/v3-sdk';
import { erc20Abi, formatUnits, getAddress, type Address, type Hex, type PublicClient } from 'viem';
import {
  createStableSwapSdkPool,
  ETHEREUM_ARGONOT_DECIMALS,
  ETHEREUM_ARGON_DECIMALS,
  ethereumArgonBaseUnitsToMicrogons,
  fixed18ToMicrogons,
  FIXED_18,
  getStableSwapArgonotToken,
  getStableSwapArgonToken,
  getStableSwapArgonTokenAddress,
  getStableSwapUsdtToken,
  getStableSwapUsdcToken,
  getStableSwapWethToken,
  microgonsToEthereumArgonBaseUnits,
  ONE_ETHEREUM_ARGON,
  type StableSwapPoolSlot0,
  type StableSwapSdkPoolState,
  stableSwapSdkPriceToFixed18,
  UNISWAP_V3_POOL_STATE_ABI,
  USDC_DECIMALS,
  USDT_DECIMALS,
  usdcToFixed18,
  usdcToMicrogons,
  WETH_DECIMALS,
} from './StableSwapUtils.ts';
import type {
  IStableSwap,
  IStableSwapInputTokenSymbol,
  IStableSwapMarketSnapshot,
  IStableSwapPoolMetadata,
  IStableSwapQuoteResult,
} from '../interfaces/IStableSwap.ts';
import { UnitOfMeasurement } from '@argonprotocol/apps-core';
import { loadEthereumChainConfig } from './EthereumClient.ts';

export const STABLE_SWAP_QUOTE_TOLERANCE_ETHEREUM_ARGON_AMOUNT = 10n ** 12n;
const UNISWAP_FEE_TIERS = [FeeAmount.LOWEST, FeeAmount.LOW, FeeAmount.MEDIUM, FeeAmount.HIGH] as const;
const UNISWAP_V3_QUOTER_V2_ADDRESS = getAddress('0x61fFE014bA17989E743c5F6cB21bF9697530B21e');

type StableSwapRoutePoolMetadata = {
  poolAddress: Address;
  poolFee: number;
  poolLiquidity: bigint;
  currentSqrtPriceX96: bigint;
  currentTick: number;
  token0: Token;
  token1: Token;
};

type StableSwapInputRoute = {
  inputToken: IStableSwapInputTokenSymbol;
  inputTokenDecimals: number;
  inputTokenPriceMicrogons: bigint;
  route: UniswapV3Route<Token, Token>;
};

type StableSwapsOptions = {
  argonotTokenAddress?: Address;
};

export class StableSwaps {
  constructor(
    private readonly client: PublicClient,
    private readonly options: StableSwapsOptions = {},
  ) {}

  public async getActive(args: {
    microgonsPerUsd: bigint;
    inputTokenPricesMicrogons?: Partial<Record<IStableSwapInputTokenSymbol, bigint>>;
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

    const inputRoutes = await this.getStableSwapInputRoutes({
      activePool,
      microgonsPerUsd: args.microgonsPerUsd,
      inputTokenPricesMicrogons: args.inputTokenPricesMicrogons,
      blockNumber: args.blockNumber,
    });
    const outputAmount = microgonsToEthereumArgonBaseUnits(snapshot.discountedEthereumArgonAmount);
    const outputValueMicrogons = args.targetPriceFixed18
      ? fixed18ToMicrogons(calculateCurrentValueFixed18(outputAmount, args.targetPriceFixed18), args.microgonsPerUsd)
      : 0n;

    const swaps = await Promise.all(
      inputRoutes.map(async inputRoute => {
        const quote = await this.quoteExactOutput({
          pool: activePool,
          route: inputRoute.route,
          amountOut: outputAmount,
          blockNumber: args.blockNumber,
        });
        if (!quote) {
          return null;
        }

        const inputAmountMicrogons = tokenBaseUnitsToMicrogons(
          quote.amountIn,
          inputRoute.inputTokenDecimals,
          inputRoute.inputTokenPriceMicrogons,
        );
        const projectedProfitMicrogons = outputValueMicrogons - inputAmountMicrogons;

        const swap: IStableSwap = {
          inputToken: inputRoute.inputToken,
          outputToken: UnitOfMeasurement.ARGN,
          network: 'ethereum',
          inputAmount: quote.amountIn,
          inputAmountMicrogons,
          inputTokenDecimals: inputRoute.inputTokenDecimals,
          outputAmount: snapshot.discountedEthereumArgonAmount,
          projectedProfitMicrogons,
          returnPct: calculateStableSwapReturnPct(inputAmountMicrogons, projectedProfitMicrogons),
          poolAddress: activePool.poolAddress,
          poolFee: activePool.poolFee,
          poolLiquidity: activePool.poolLiquidity,
          currentPriceMicrogons: snapshot.currentPriceMicrogons,
          targetPriceMicrogons: snapshot.targetPriceMicrogons,
          targetPriceOffset: snapshot.targetPriceOffset,
          updatedAt: snapshot.updatedAt,
        };
        return swap;
      }),
    );

    return swaps.filter((swap): swap is IStableSwap => Boolean(swap));
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
    route?: UniswapV3Route<Token, Token>;
    amountOut: bigint;
    blockNumber?: bigint;
    throwOnError?: boolean;
  }): Promise<IStableSwapQuoteResult | null> {
    const { pool, amountOut, blockNumber, throwOnError = false } = args;
    const argonToken = getStableSwapArgonToken();
    const usdcToken = getStableSwapUsdcToken();
    const route = args.route ?? new UniswapV3Route([createStableSwapSdkPool(pool)], usdcToken, argonToken);

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

      const { amountIn, sqrtPriceX96After } = decodeStableSwapExactOutputQuote(quoteResult.data, route.pools.length);
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

  public static buildStableSwapUniswapUrl(argonAmountMicrogons: bigint, inputCurrency?: string): string | null {
    if (argonAmountMicrogons <= 0n) {
      return null;
    }

    const ethereumArgonAmount = microgonsToEthereumArgonBaseUnits(argonAmountMicrogons);
    const inputCurrencyParam = inputCurrency ? `&inputCurrency=${inputCurrency}` : '';
    return `https://app.uniswap.org/#/swap?chain=mainnet${inputCurrencyParam}&outputCurrency=${getStableSwapArgonTokenAddress()}&field=output&value=${formatUnits(ethereumArgonAmount, ETHEREUM_ARGON_DECIMALS)}`;
  }

  public static async getInputCurrency(
    inputToken: IStableSwapInputTokenSymbol,
    options: { argonotTokenAddress?: Address } = {},
  ): Promise<string | undefined> {
    switch (inputToken) {
      case UnitOfMeasurement.USDC:
        return getStableSwapUsdcToken().address;
      case UnitOfMeasurement.USDT:
        return getStableSwapUsdtToken().address;
      case UnitOfMeasurement.ETH:
        return 'ETH';
      case UnitOfMeasurement.ARGNOT:
        return options.argonotTokenAddress ?? (await loadEthereumChainConfig())?.argonotTokenAddress;
    }
  }

  private async getStableSwapInputRoutes(args: {
    activePool: IStableSwapPoolMetadata;
    microgonsPerUsd: bigint;
    inputTokenPricesMicrogons?: Partial<Record<IStableSwapInputTokenSymbol, bigint>>;
    blockNumber?: bigint;
  }): Promise<StableSwapInputRoute[]> {
    const { activePool, microgonsPerUsd, inputTokenPricesMicrogons, blockNumber } = args;
    const argonToken = getStableSwapArgonToken();
    const usdcToken = getStableSwapUsdcToken();
    const argonUsdcPool = this.createRoutePoolMetadata(activePool, argonToken, usdcToken);
    const routes: StableSwapInputRoute[] = [
      {
        inputToken: UnitOfMeasurement.USDC,
        inputTokenDecimals: USDC_DECIMALS,
        inputTokenPriceMicrogons: inputTokenPricesMicrogons?.[UnitOfMeasurement.USDC] ?? microgonsPerUsd,
        route: new UniswapV3Route([createUniswapV3SdkPool(argonUsdcPool)], usdcToken, argonToken),
      },
    ];

    const ethTokenPriceMicrogons = inputTokenPricesMicrogons?.[UnitOfMeasurement.ETH];
    const argonotTokenPriceMicrogons = inputTokenPricesMicrogons?.[UnitOfMeasurement.ARGNOT];
    const bridgeRoutes = await Promise.all([
      this.createBridgeInputRoute({
        inputToken: UnitOfMeasurement.USDT,
        inputTokenDecimals: USDT_DECIMALS,
        inputTokenPriceMicrogons: inputTokenPricesMicrogons?.[UnitOfMeasurement.USDT] ?? microgonsPerUsd,
        inputTokenSdk: getStableSwapUsdtToken(),
        usdcToken,
        argonToken,
        argonUsdcPool,
        blockNumber,
      }),
      ethTokenPriceMicrogons !== undefined
        ? this.createBridgeInputRoute({
            inputToken: UnitOfMeasurement.ETH,
            inputTokenDecimals: WETH_DECIMALS,
            inputTokenPriceMicrogons: ethTokenPriceMicrogons,
            inputTokenSdk: getStableSwapWethToken(),
            usdcToken,
            argonToken,
            argonUsdcPool,
            blockNumber,
          })
        : null,
      this.createArgonotInputRoute({
        argonotTokenPriceMicrogons,
        usdcToken,
        argonToken,
        argonUsdcPool,
        blockNumber,
      }),
    ]);

    return routes.concat(bridgeRoutes.filter((route): route is StableSwapInputRoute => Boolean(route)));
  }

  private async createBridgeInputRoute(args: {
    inputToken: IStableSwapInputTokenSymbol;
    inputTokenDecimals: number;
    inputTokenPriceMicrogons: bigint;
    inputTokenSdk: Token;
    usdcToken: Token;
    argonToken: Token;
    argonUsdcPool: StableSwapRoutePoolMetadata;
    blockNumber?: bigint;
  }): Promise<StableSwapInputRoute | null> {
    const bridgePool = await this.getActiveRoutePoolMetadata(args.inputTokenSdk, args.usdcToken, args.blockNumber);
    if (!bridgePool) {
      return null;
    }

    return {
      inputToken: args.inputToken,
      inputTokenDecimals: args.inputTokenDecimals,
      inputTokenPriceMicrogons: args.inputTokenPriceMicrogons,
      route: new UniswapV3Route(
        [createUniswapV3SdkPool(bridgePool), createUniswapV3SdkPool(args.argonUsdcPool)],
        args.inputTokenSdk,
        args.argonToken,
      ),
    };
  }

  private async createArgonotInputRoute(args: {
    argonotTokenPriceMicrogons?: bigint;
    usdcToken: Token;
    argonToken: Token;
    argonUsdcPool: StableSwapRoutePoolMetadata;
    blockNumber?: bigint;
  }): Promise<StableSwapInputRoute | null> {
    if (args.argonotTokenPriceMicrogons === undefined) {
      return null;
    }

    const argonotToken = await this.getArgonotToken();
    if (!argonotToken) {
      return null;
    }

    return this.createBridgeInputRoute({
      inputToken: UnitOfMeasurement.ARGNOT,
      inputTokenDecimals: ETHEREUM_ARGONOT_DECIMALS,
      inputTokenPriceMicrogons: args.argonotTokenPriceMicrogons,
      inputTokenSdk: argonotToken,
      usdcToken: args.usdcToken,
      argonToken: args.argonToken,
      argonUsdcPool: args.argonUsdcPool,
      blockNumber: args.blockNumber,
    });
  }

  private async getArgonotToken(): Promise<Token | null> {
    try {
      const argonotTokenAddress =
        this.options.argonotTokenAddress ?? (await loadEthereumChainConfig())?.argonotTokenAddress;
      return argonotTokenAddress ? getStableSwapArgonotToken(argonotTokenAddress) : null;
    } catch {
      return null;
    }
  }

  private createRoutePoolMetadata(
    pool: IStableSwapPoolMetadata,
    tokenA: Token,
    tokenB: Token,
  ): StableSwapRoutePoolMetadata {
    const [token0, token1] = sortUniswapTokens(tokenA, tokenB);
    return {
      poolAddress: pool.poolAddress,
      poolFee: pool.poolFee,
      poolLiquidity: pool.poolLiquidity,
      currentSqrtPriceX96: pool.currentSqrtPriceX96,
      currentTick: pool.currentTick,
      token0,
      token1,
    };
  }

  private async getActiveRoutePoolMetadata(
    tokenA: Token,
    tokenB: Token,
    blockNumber?: bigint,
  ): Promise<StableSwapRoutePoolMetadata | null> {
    const [token0, token1] = sortUniswapTokens(tokenA, tokenB);
    const pools = await Promise.all(
      UNISWAP_FEE_TIERS.map(async poolFee => {
        const poolAddress = getAddress(UniswapV3Pool.getAddress(tokenA, tokenB, poolFee));

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
            token0,
            token1,
          } satisfies StableSwapRoutePoolMetadata;
        } catch {
          return null;
        }
      }),
    );

    return (
      pools
        .filter((pool): pool is StableSwapRoutePoolMetadata => Boolean(pool))
        .filter(pool => pool.poolLiquidity > 0n)
        .sort((left, right) => {
          if (left.poolLiquidity === right.poolLiquidity) {
            return left.poolFee - right.poolFee;
          }
          return left.poolLiquidity > right.poolLiquidity ? -1 : 1;
        })[0] ?? null
    );
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

function createUniswapV3SdkPool(pool: StableSwapRoutePoolMetadata): UniswapV3Pool {
  return new UniswapV3Pool(
    pool.token0,
    pool.token1,
    pool.poolFee as FeeAmount,
    pool.currentSqrtPriceX96.toString(),
    pool.poolLiquidity.toString(),
    pool.currentTick,
  );
}

function sortUniswapTokens(tokenA: Token, tokenB: Token): [Token, Token] {
  return tokenA.sortsBefore(tokenB) ? [tokenA, tokenB] : [tokenB, tokenA];
}

function tokenBaseUnitsToMicrogons(amount: bigint, decimals: number, tokenPriceMicrogons: bigint): bigint {
  return (amount * tokenPriceMicrogons) / 10n ** BigInt(decimals);
}

function decodeStableSwapExactOutputQuote(
  data: Hex,
  poolCount: number,
): {
  amountIn: bigint;
  sqrtPriceX96After: bigint;
} {
  if (poolCount > 1) {
    const decoded = SwapQuoter.V2INTERFACE.decodeFunctionResult('quoteExactOutput', data) as unknown as readonly [
      { toString(): string },
      readonly { toString(): string }[],
    ];

    return {
      amountIn: BigInt(decoded[0].toString()),
      sqrtPriceX96After: BigInt(decoded[1][0].toString()),
    };
  }

  try {
    const decoded = SwapQuoter.V2INTERFACE.decodeFunctionResult('quoteExactOutputSingle', data) as unknown as readonly [
      { toString(): string },
      { toString(): string },
    ];

    return {
      amountIn: BigInt(decoded[0].toString()),
      sqrtPriceX96After: BigInt(decoded[1].toString()),
    };
  } catch {
    const decoded = SwapQuoter.V2INTERFACE.decodeFunctionResult('quoteExactOutput', data) as unknown as readonly [
      { toString(): string },
      readonly { toString(): string }[],
    ];

    return {
      amountIn: BigInt(decoded[0].toString()),
      sqrtPriceX96After: BigInt(decoded[1][0].toString()),
    };
  }
}
