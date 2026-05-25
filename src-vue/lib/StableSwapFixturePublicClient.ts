import JSBI from 'jsbi';
import { Pool as UniswapV3Pool, SwapQuoter, TickMath, encodeSqrtRatioX96 } from '@uniswap/v3-sdk';
import { getAddress, isAddressEqual, type Address, type Hex, type PublicClient } from 'viem';
import fixture from '../../e2e/argon/uniswap/test-stable-swaps.json';
import { FIXED_18, getStableSwapArgonToken, getStableSwapUsdcToken } from './StableSwapUtils.ts';

type StableSwapFixture = {
  blockNumber: number;
  pool: {
    poolFee: number;
    poolLiquidity: string;
    currentPriceFixed18: string;
  };
  poolArgonBalance: string;
  quote: {
    amountInPriceFixed18: string;
    priceImpactFixed18PerArgon: string;
  };
};

const USDC_BASE_UNITS_PER_FIXED_18_ARGON = 10n ** 30n;

export function createStableSwapFixturePublicClient(stableSwapFixture: StableSwapFixture = fixture): PublicClient {
  const parsedFixture = parseStableSwapFixture(stableSwapFixture);

  return {
    async readContract(args: { address?: Address; functionName: string }) {
      if (args.functionName === 'liquidity') {
        if (!isFixturePoolAddress(args.address, parsedFixture.pool.poolAddress)) {
          return 0n;
        }

        return parsedFixture.pool.poolLiquidity;
      }

      if (args.functionName === 'slot0') {
        if (!isFixturePoolAddress(args.address, parsedFixture.pool.poolAddress)) {
          throw new Error(`Stable swap fixture client does not have slot0 for ${args.address}.`);
        }

        const sqrtPriceX96 = fixed18PriceToSqrtPriceX96(parsedFixture.pool.currentPriceFixed18);
        return [
          sqrtPriceX96,
          TickMath.getTickAtSqrtRatio(JSBI.BigInt(sqrtPriceX96.toString()) as any),
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

      const amountOut = decodeStableSwapQuoteAmountOut(args.data);
      const amountIn = (amountOut * parsedFixture.quote.amountInPriceFixed18) / USDC_BASE_UNITS_PER_FIXED_18_ARGON;
      const argonsOutFixed18 = amountOut;
      const priceAfterFixed18 =
        parsedFixture.pool.currentPriceFixed18 +
        (argonsOutFixed18 * parsedFixture.quote.priceImpactFixed18PerArgon) / FIXED_18;
      const sqrtPriceX96After = fixed18PriceToSqrtPriceX96(priceAfterFixed18);

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
  return {
    blockNumber: stableSwapFixture.blockNumber,
    pool: {
      poolFee: stableSwapFixture.pool.poolFee,
      poolAddress: getAddress(
        UniswapV3Pool.getAddress(getStableSwapArgonToken(), getStableSwapUsdcToken(), stableSwapFixture.pool.poolFee),
      ),
      poolLiquidity: BigInt(stableSwapFixture.pool.poolLiquidity),
      currentPriceFixed18: BigInt(stableSwapFixture.pool.currentPriceFixed18),
    },
    poolArgonBalance: BigInt(stableSwapFixture.poolArgonBalance),
    quote: {
      amountInPriceFixed18: BigInt(stableSwapFixture.quote.amountInPriceFixed18),
      priceImpactFixed18PerArgon: BigInt(stableSwapFixture.quote.priceImpactFixed18PerArgon),
    },
  };
}

function isFixturePoolAddress(address: Address | undefined, fixturePoolAddress: Address): boolean {
  return Boolean(address && isAddressEqual(address, fixturePoolAddress));
}

function decodeStableSwapQuoteAmountOut(data: Hex): bigint {
  const decoded = SwapQuoter.V2INTERFACE.decodeFunctionData('quoteExactOutputSingle', data) as unknown;
  const values = collectBigIntLikeValues(decoded);
  const amountOut = values.reduce((max, value) => (value > max ? value : max), 0n);
  if (amountOut <= 0n) {
    throw new Error('Stable swap fixture client could not decode the quoted output amount.');
  }

  return amountOut;
}

function collectBigIntLikeValues(value: unknown): bigint[] {
  if (typeof value === 'bigint') {
    return [value];
  }

  if (typeof value === 'number' && Number.isInteger(value)) {
    return [BigInt(value)];
  }

  if (value && typeof value === 'object' && 'toString' in value && typeof value.toString === 'function') {
    const stringValue = value.toString();
    if (/^\d+$/.test(stringValue)) {
      return [BigInt(stringValue)];
    }
  }

  if (Array.isArray(value)) {
    return value.flatMap(item => collectBigIntLikeValues(item));
  }

  if (value && typeof value === 'object') {
    return Object.values(value).flatMap(item => collectBigIntLikeValues(item));
  }

  return [];
}

function fixed18PriceToSqrtPriceX96(priceFixed18: bigint) {
  return encodeSqrtRatioX96((priceFixed18 * 10n ** 6n).toString(), (FIXED_18 * FIXED_18).toString());
}
