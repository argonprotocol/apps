import { ChainId, Token } from '@uniswap/sdk-core';
import { NetworkConfig } from '@argonprotocol/apps-core';
import uniswapV3PoolEventsArtifact from '@uniswap/v3-core/artifacts/contracts/interfaces/pool/IUniswapV3PoolEvents.sol/IUniswapV3PoolEvents.json';
import uniswapV3PoolStateArtifact from '@uniswap/v3-core/artifacts/contracts/interfaces/pool/IUniswapV3PoolState.sol/IUniswapV3PoolState.json';
import { FeeAmount, Pool as UniswapV3Pool } from '@uniswap/v3-sdk';
import { getAddress, erc20Abi, parseUnits, type Abi, type Address } from 'viem';

export type StableSwapSdkPoolState = {
  sqrtPriceX96: bigint;
  liquidity: bigint;
  tickCurrent: number;
};

export type StableSwapPoolSlot0 = readonly [bigint, number, number, number, number, number, boolean];

export type StableSwapDecodedSwapLog = {
  args: {
    amount0: bigint;
    amount1: bigint;
    sqrtPriceX96: bigint;
    liquidity: bigint;
    tick: number;
  };
};

type StableSwapPoolLike = {
  poolFee: number;
  poolLiquidity: bigint;
  currentSqrtPriceX96: bigint;
  currentTick: number;
  argonIsToken0: boolean;
};

export const UNISWAP_V3_POOL_STATE_ABI = uniswapV3PoolStateArtifact.abi as Abi;
export const UNISWAP_V3_POOL_EVENTS_ABI = uniswapV3PoolEventsArtifact.abi as Abi;

export const FIXED_18 = 10n ** 18n;
export const USDC_TO_FIXED_18_FACTOR = 10n ** 12n;
export const ETHEREUM_ARGON_DECIMALS = 18;
export const USDC_DECIMALS = 6;
export const USDT_DECIMALS = 6;
export const WETH_DECIMALS = 18;
export const ETHEREUM_ARGONOT_DECIMALS = 18;
export const ONE_ETHEREUM_ARGON = 10n ** BigInt(ETHEREUM_ARGON_DECIMALS);
export const ETHEREUM_ARGON_BASE_UNITS_PER_MICROGON = 10n ** 12n;
export const STABLE_SWAP_TRANSFER_EVENT = erc20Abi.find(item => item.type === 'event' && item.name === 'Transfer')!;

type StableSwapChainConfig = {
  chainId: ChainId.MAINNET | ChainId.SEPOLIA;
  tokenAddresses: {
    weth: Address;
    usdt: Address;
  };
  uniswapV3: {
    factory: Address;
    quoterV2: Address;
  };
};

const stableSwapChainConfigById: Record<ChainId.MAINNET | ChainId.SEPOLIA, StableSwapChainConfig> = {
  [ChainId.MAINNET]: {
    chainId: ChainId.MAINNET,
    tokenAddresses: {
      usdt: getAddress('0xdAC17F958D2ee523a2206206994597C13D831ec7'),
      weth: getAddress('0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2'),
    },
    uniswapV3: {
      factory: getAddress('0x1F98431c8aD98523631AE4a59f267346ea31F984'),
      quoterV2: getAddress('0x61fFE014bA17989E743c5F6cB21bF9697530B21e'),
    },
  },
  [ChainId.SEPOLIA]: {
    chainId: ChainId.SEPOLIA,
    tokenAddresses: {
      usdt: getAddress('0xaa8e23fb1079ea71e0a56f48a2aa51851d8433d0'),
      weth: getAddress('0xfff9976782d46cc05630d1f6ebab18b2324d6b14'),
    },
    uniswapV3: {
      factory: getAddress('0x0227628f3F023bb0B980b67D528571c95c6DaC1c'),
      quoterV2: getAddress('0xEd1f6473345F45b75F8179591dd5bA1888cf2FB3'),
    },
  },
};

export function getStableSwapChainConfig(chainId: number) {
  return (
    stableSwapChainConfigById[chainId as StableSwapChainConfig['chainId']] ?? stableSwapChainConfigById[ChainId.MAINNET]
  );
}

export function getStableSwapArgonToken(argonTokenAddress: string, chainId: number): Token {
  const stableSwapChain = getStableSwapChainConfig(chainId);
  return new Token(stableSwapChain.chainId, getAddress(argonTokenAddress), ETHEREUM_ARGON_DECIMALS, 'ARGN', 'Argon');
}

export function getStableSwapUsdcToken(chainId: number): Token {
  const stableSwapChain = getStableSwapChainConfig(chainId);
  return new Token(
    stableSwapChain.chainId,
    getAddress(NetworkConfig.get().ethereumNetwork.usdcTokenAddress),
    USDC_DECIMALS,
    'USDC',
    'USD Coin',
  );
}

export function getStableSwapUsdtToken(chainId: number): Token {
  const stableSwapChain = getStableSwapChainConfig(chainId);
  return new Token(stableSwapChain.chainId, stableSwapChain.tokenAddresses.usdt, USDT_DECIMALS, 'USDT', 'Tether USD');
}

export function getStableSwapWethToken(chainId: number): Token {
  const stableSwapChain = getStableSwapChainConfig(chainId);
  return new Token(
    stableSwapChain.chainId,
    stableSwapChain.tokenAddresses.weth,
    WETH_DECIMALS,
    'WETH',
    'Wrapped Ether',
  );
}

export function getStableSwapArgonotToken(address: Address, chainId: number): Token {
  return new Token(
    getStableSwapChainConfig(chainId).chainId,
    getAddress(address),
    ETHEREUM_ARGONOT_DECIMALS,
    'ARGNOT',
    'Argonot',
  );
}

export function createStableSwapSdkPool(
  pool: StableSwapPoolLike,
  argonToken: Token,
  state?: StableSwapSdkPoolState,
): UniswapV3Pool {
  const usdcToken = getStableSwapUsdcToken(argonToken.chainId);
  const poolState = state ?? {
    sqrtPriceX96: pool.currentSqrtPriceX96,
    liquidity: pool.poolLiquidity,
    tickCurrent: pool.currentTick,
  };
  const token0 = pool.argonIsToken0 ? argonToken : usdcToken;
  const token1 = pool.argonIsToken0 ? usdcToken : argonToken;

  return new UniswapV3Pool(
    token0,
    token1,
    pool.poolFee as FeeAmount,
    poolState.sqrtPriceX96.toString(),
    poolState.liquidity.toString(),
    poolState.tickCurrent,
  );
}

export function stableSwapSdkPriceToFixed18(price: ReturnType<UniswapV3Pool['priceOf']>): bigint {
  const numerator = BigInt(price.numerator.toString());
  const denominator = BigInt(price.denominator.toString());
  const baseScalar = 10n ** BigInt(price.baseCurrency.decimals);
  const quoteScalar = 10n ** BigInt(price.quoteCurrency.decimals);

  if (numerator <= 0n || denominator <= 0n) {
    return 0n;
  }

  return (numerator * baseScalar * FIXED_18) / (denominator * quoteScalar);
}

export function decimalToFixed18(value: string): bigint {
  return parseUnits(value, 18);
}

export function fixed18ToMicrogons(valueFixed18: bigint, microgonsPerUsd: bigint): bigint {
  return (valueFixed18 * microgonsPerUsd) / FIXED_18;
}

export function ethereumArgonBaseUnitsToMicrogons(value: bigint): bigint {
  return value / ETHEREUM_ARGON_BASE_UNITS_PER_MICROGON;
}

export function microgonsToEthereumArgonBaseUnits(value: bigint): bigint {
  return value * ETHEREUM_ARGON_BASE_UNITS_PER_MICROGON;
}

export function usdcToFixed18(usdc: bigint): bigint {
  return usdc * USDC_TO_FIXED_18_FACTOR;
}

export function usdcToMicrogons(usdc: bigint, microgonsPerUsd: bigint): bigint {
  return (usdc * microgonsPerUsd) / 1_000_000n;
}

export function isLikelyRateLimit(error: unknown): boolean {
  const message = error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase();
  return message.includes('429') || message.includes('rate') || message.includes('limit');
}
