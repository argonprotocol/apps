import JSBI from 'jsbi';
import { ChainId, type Token } from '@uniswap/sdk-core';
import { Pool as UniswapV3Pool, SwapQuoter, TickMath, encodeSqrtRatioX96 } from '@uniswap/v3-sdk';
import { getAddress, type Address, type Hex, type PublicClient } from 'viem';
import fixture from '../../e2e/argon/uniswap/test-stable-swaps.json';
import {
  ETHEREUM_ARGONOT_DECIMALS,
  ETHEREUM_ARGON_DECIMALS,
  FIXED_18,
  getStableSwapArgonotToken,
  getStableSwapArgonToken,
  getStableSwapUsdcToken,
  getStableSwapUsdtToken,
  getStableSwapWethToken,
  USDC_DECIMALS,
  USDT_DECIMALS,
  WETH_DECIMALS,
} from './StableSwapUtils.ts';

type StableSwapFixture = {
  blockNumber: number;
  tokenAddresses: {
    argon: string;
    argonot: string;
  };
  pool: {
    poolFee: number;
    poolLiquidity: string;
    currentPriceFixed18: string;
  };
  bridgePools: Record<
    string,
    {
      poolFee: number;
      poolLiquidity: string;
      currentPriceFixed18: string;
    }
  >;
  poolArgonBalance: string;
  quotes: Record<string, StableSwapFixtureQuote>;
};

type StableSwapFixtureQuote = {
  amountInPriceFixed18: string;
  priceImpactFixed18PerArgon: string;
};

type ParsedStableSwapFixtureQuote = {
  amountInPriceFixed18: bigint;
  priceImpactFixed18PerArgon: bigint;
};

type ParsedStableSwapFixturePool = {
  poolAddress: Address;
  poolLiquidity: bigint;
  currentPriceFixed18: bigint;
  currentSqrtPriceX96: bigint;
};

export const STABLE_SWAP_FIXTURE_ARGON_TOKEN_ADDRESS = getAddress(fixture.tokenAddresses.argon);
export const STABLE_SWAP_FIXTURE_ARGONOT_TOKEN_ADDRESS = getAddress(fixture.tokenAddresses.argonot);

export function createStableSwapFixturePublicClient(stableSwapFixture: StableSwapFixture = fixture): PublicClient {
  const parsedFixture = parseStableSwapFixture(stableSwapFixture);

  return {
    async readContract(args: { address?: Address; functionName: string }) {
      if (args.functionName === 'liquidity') {
        return parsedFixture.poolsByAddress.get(normalizeAddress(args.address))?.poolLiquidity ?? 0n;
      }

      if (args.functionName === 'slot0') {
        const pool = parsedFixture.poolsByAddress.get(normalizeAddress(args.address));
        if (!pool) {
          throw new Error(`Stable swap fixture client does not have slot0 for ${args.address}.`);
        }

        return [
          pool.currentSqrtPriceX96,
          TickMath.getTickAtSqrtRatio(JSBI.BigInt(pool.currentSqrtPriceX96.toString()) as any),
          0,
          0,
          0,
          0,
          true,
        ];
      }

      if (args.functionName === 'balanceOf') {
        return parsedFixture.poolArgonBalance;
      }

      throw new Error(`Stable swap fixture client does not handle readContract(${args.functionName}).`);
    },

    async call(args: { data?: Hex }) {
      if (!args.data) {
        return { data: undefined };
      }

      const { amountOut, routeKey, inputTokenDecimals, isMultiHop } = decodeStableSwapQuote(args.data, parsedFixture);
      const quote = parsedFixture.quotes[routeKey];
      if (!quote) {
        throw new Error(`Stable swap fixture client does not have a quote for ${routeKey}.`);
      }

      const amountIn = tokenQuoteAmountIn(amountOut, quote.amountInPriceFixed18, inputTokenDecimals);
      const argonsOutFixed18 = amountOut;
      const priceAfterFixed18 =
        parsedFixture.pool.currentPriceFixed18 + (argonsOutFixed18 * quote.priceImpactFixed18PerArgon) / FIXED_18;
      const sqrtPriceX96After = fixed18PriceToSqrtPriceX96(
        priceAfterFixed18,
        parsedFixture.tokenBySymbol.ARGN,
        parsedFixture.tokenBySymbol.USDC,
      );

      if (isMultiHop) {
        return {
          data: SwapQuoter.V2INTERFACE.encodeFunctionResult('quoteExactOutput', [
            amountIn.toString(),
            [sqrtPriceX96After.toString()],
            ['0'],
            '0',
          ]) as Hex,
        };
      }

      return {
        data: SwapQuoter.V2INTERFACE.encodeFunctionResult('quoteExactOutputSingle', [
          amountIn.toString(),
          sqrtPriceX96After.toString(),
          '0',
          '0',
        ]) as Hex,
      };
    },

    async getBlockNumber() {
      return BigInt(parsedFixture.blockNumber);
    },

    async getLogs() {
      return [];
    },
  } as unknown as PublicClient;
}

function parseStableSwapFixture(stableSwapFixture: StableSwapFixture) {
  const tokenBySymbol = createStableSwapFixtureTokens(stableSwapFixture);
  const poolsByAddress = new Map<string, ParsedStableSwapFixturePool>();
  const argonUsdcPoolAddress = getAddress(
    UniswapV3Pool.getAddress(tokenBySymbol.ARGN, tokenBySymbol.USDC, stableSwapFixture.pool.poolFee),
  );
  poolsByAddress.set(normalizeAddress(argonUsdcPoolAddress), {
    poolAddress: argonUsdcPoolAddress,
    poolLiquidity: BigInt(stableSwapFixture.pool.poolLiquidity),
    currentPriceFixed18: BigInt(stableSwapFixture.pool.currentPriceFixed18),
    currentSqrtPriceX96: fixed18PriceToSqrtPriceX96(
      BigInt(stableSwapFixture.pool.currentPriceFixed18),
      tokenBySymbol.ARGN,
      tokenBySymbol.USDC,
    ),
  });

  for (const [routeKey, pool] of Object.entries(stableSwapFixture.bridgePools)) {
    const [tokenInSymbol, tokenOutSymbol] = routeKey.split('->') as [
      StableSwapFixtureTokenSymbol,
      StableSwapFixtureTokenSymbol,
    ];
    const poolAddress = getAddress(
      UniswapV3Pool.getAddress(tokenBySymbol[tokenInSymbol], tokenBySymbol[tokenOutSymbol], pool.poolFee),
    );
    poolsByAddress.set(normalizeAddress(poolAddress), {
      poolAddress,
      poolLiquidity: BigInt(pool.poolLiquidity),
      currentPriceFixed18: BigInt(pool.currentPriceFixed18),
      currentSqrtPriceX96: fixed18PriceToSqrtPriceX96(
        BigInt(pool.currentPriceFixed18),
        tokenBySymbol[tokenInSymbol],
        tokenBySymbol[tokenOutSymbol],
      ),
    });
  }

  return {
    blockNumber: stableSwapFixture.blockNumber,
    pool: {
      poolFee: stableSwapFixture.pool.poolFee,
      poolAddress: argonUsdcPoolAddress,
      poolLiquidity: BigInt(stableSwapFixture.pool.poolLiquidity),
      currentPriceFixed18: BigInt(stableSwapFixture.pool.currentPriceFixed18),
      currentSqrtPriceX96: fixed18PriceToSqrtPriceX96(
        BigInt(stableSwapFixture.pool.currentPriceFixed18),
        tokenBySymbol.ARGN,
        tokenBySymbol.USDC,
      ),
    },
    poolsByAddress,
    poolArgonBalance: BigInt(stableSwapFixture.poolArgonBalance),
    quotes: Object.fromEntries(
      Object.entries(stableSwapFixture.quotes).map(([routeKey, quote]) => [
        routeKey,
        {
          amountInPriceFixed18: BigInt(quote.amountInPriceFixed18),
          priceImpactFixed18PerArgon: BigInt(quote.priceImpactFixed18PerArgon),
        } satisfies ParsedStableSwapFixtureQuote,
      ]),
    ) as Record<string, ParsedStableSwapFixtureQuote>,
    tokenBySymbol,
    tokenByAddress: createStableSwapFixtureTokenAddressMap(tokenBySymbol),
  };
}

type StableSwapFixtureTokenSymbol = 'ARGN' | 'USDC' | 'USDT' | 'WETH' | 'ARGNOT';

function createStableSwapFixtureTokens(stableSwapFixture: StableSwapFixture) {
  return {
    ARGN: getStableSwapArgonToken(getAddress(stableSwapFixture.tokenAddresses.argon), ChainId.MAINNET),
    USDC: getStableSwapUsdcToken(ChainId.MAINNET),
    USDT: getStableSwapUsdtToken(ChainId.MAINNET),
    WETH: getStableSwapWethToken(ChainId.MAINNET),
    ARGNOT: getStableSwapArgonotToken(getAddress(stableSwapFixture.tokenAddresses.argonot), ChainId.MAINNET),
  };
}

function createStableSwapFixtureTokenAddressMap(
  tokenBySymbol: ReturnType<typeof createStableSwapFixtureTokens>,
): Map<string, StableSwapFixtureTokenSymbol> {
  return new Map(
    Object.entries(tokenBySymbol).map(([symbol, token]) => [
      normalizeAddress(token.address as Address),
      symbol as StableSwapFixtureTokenSymbol,
    ]),
  );
}

function decodeStableSwapQuote(
  data: Hex,
  parsedFixture: ReturnType<typeof parseStableSwapFixture>,
): { amountOut: bigint; routeKey: string; inputTokenDecimals: number; isMultiHop: boolean } {
  try {
    const decoded = SwapQuoter.V2INTERFACE.decodeFunctionData('quoteExactOutputSingle', data) as unknown as readonly [
      {
        tokenIn: Address;
        tokenOut: Address;
        amount: bigint;
      },
    ];
    const params = decoded[0];
    const inputSymbol = getFixtureTokenSymbol(params.tokenIn, parsedFixture.tokenByAddress);
    const outputSymbol = getFixtureTokenSymbol(params.tokenOut, parsedFixture.tokenByAddress);

    return {
      amountOut: BigInt(params.amount.toString()),
      routeKey: `${inputSymbol}->${outputSymbol}`,
      inputTokenDecimals: getFixtureTokenDecimals(inputSymbol),
      isMultiHop: false,
    };
  } catch {
    const decoded = SwapQuoter.V2INTERFACE.decodeFunctionData('quoteExactOutput', data) as unknown as readonly [
      Hex,
      bigint,
    ];
    const reversedTokenSymbols = decodeUniswapPathSymbols(decoded[0], parsedFixture.tokenByAddress);
    const routeSymbols = reversedTokenSymbols.reverse();
    const inputSymbol = routeSymbols[0];

    return {
      amountOut: BigInt(decoded[1].toString()),
      routeKey: routeSymbols.join('->'),
      inputTokenDecimals: getFixtureTokenDecimals(inputSymbol),
      isMultiHop: true,
    };
  }
}

function decodeUniswapPathSymbols(
  path: Hex,
  tokenByAddress: Map<string, StableSwapFixtureTokenSymbol>,
): StableSwapFixtureTokenSymbol[] {
  const value = path.slice(2);
  const symbols: StableSwapFixtureTokenSymbol[] = [];
  let cursor = 0;

  while (cursor + 40 <= value.length) {
    const address = getAddress(`0x${value.slice(cursor, cursor + 40)}`);
    symbols.push(getFixtureTokenSymbol(address, tokenByAddress));
    cursor += 40;
    if (cursor >= value.length) {
      break;
    }
    cursor += 6;
  }

  return symbols;
}

function getFixtureTokenSymbol(
  address: Address,
  tokenByAddress: Map<string, StableSwapFixtureTokenSymbol>,
): StableSwapFixtureTokenSymbol {
  const symbol = tokenByAddress.get(normalizeAddress(address));
  if (!symbol) {
    throw new Error(`Stable swap fixture client does not know token ${address}.`);
  }
  return symbol;
}

function getFixtureTokenDecimals(symbol: StableSwapFixtureTokenSymbol): number {
  switch (symbol) {
    case 'ARGN':
      return ETHEREUM_ARGON_DECIMALS;
    case 'USDC':
      return USDC_DECIMALS;
    case 'USDT':
      return USDT_DECIMALS;
    case 'WETH':
      return WETH_DECIMALS;
    case 'ARGNOT':
      return ETHEREUM_ARGONOT_DECIMALS;
  }
}

function tokenQuoteAmountIn(amountOut: bigint, amountInPriceFixed18: bigint, inputTokenDecimals: number): bigint {
  return (amountOut * amountInPriceFixed18 * 10n ** BigInt(inputTokenDecimals)) / (FIXED_18 * FIXED_18);
}

function normalizeAddress(address: Address | undefined): string {
  return address ? getAddress(address).toLowerCase() : '';
}

function fixed18PriceToSqrtPriceX96(priceFixed18: bigint, baseToken: Token, quoteToken: Token) {
  const baseRawUnits = 10n ** BigInt(baseToken.decimals);
  const quoteRawUnits = 10n ** BigInt(quoteToken.decimals);

  if (baseToken.sortsBefore(quoteToken)) {
    return BigInt(
      encodeSqrtRatioX96((priceFixed18 * quoteRawUnits).toString(), (FIXED_18 * baseRawUnits).toString()).toString(),
    );
  }

  return BigInt(
    encodeSqrtRatioX96((FIXED_18 * baseRawUnits).toString(), (priceFixed18 * quoteRawUnits).toString()).toString(),
  );
}
