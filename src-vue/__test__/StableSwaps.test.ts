import { describe, expect, it } from 'vitest';
import { ChainId } from '@uniswap/sdk-core';
import { parseUnits } from 'viem';
import { encodeSqrtRatioX96, TickMath } from '@uniswap/v3-sdk';
import JSBI from 'jsbi';
import { StableSwaps } from '../lib/StableSwaps.ts';
import {
  createStableSwapFixturePublicClient,
  STABLE_SWAP_FIXTURE_ARGON_TOKEN_ADDRESS,
  STABLE_SWAP_FIXTURE_ARGONOT_TOKEN_ADDRESS,
} from '../lib/StableSwapFixturePublicClient.ts';
import {
  createStableSwapSdkPool,
  getStableSwapArgonToken,
  stableSwapSdkPriceToFixed18,
} from '../lib/StableSwapUtils.ts';
import { hydrateStableSwapWallet } from '../lib/StableSwapWallet.ts';
import { StableSwapFinancials } from '../lib/financials/StableSwaps.ts';

const stableSwapFinancials = new StableSwapFinancials({} as any);
import { type IStableSwapPurchaseRecord, StableSwapProofStatus } from '../lib/db/StableSwapPurchasesTable.ts';
import { type IStableSwapSyncStateRecord } from '../lib/db/StableSwapSyncStateTable.ts';
import { NetworkConfig, UnitOfMeasurement } from '@argonprotocol/apps-core';
import { defaultWalletData } from '../lib/Wallet.ts';

const NOW = new Date('2026-04-06T12:00:00Z');

function createSyncState(overrides: Partial<IStableSwapSyncStateRecord> = {}): IStableSwapSyncStateRecord {
  return {
    walletAddress: overrides.walletAddress ?? '0x1234567890123456789012345678901234567890',
    startBlockNumber: overrides.startBlockNumber ?? 101,
    lastScannedBlockNumber: overrides.lastScannedBlockNumber ?? 101,
    isPurchaseBasisIntact: overrides.isPurchaseBasisIntact ?? true,
    createdAt: overrides.createdAt ?? NOW,
    updatedAt: overrides.updatedAt ?? NOW,
  };
}

function createPurchase(overrides: Partial<IStableSwapPurchaseRecord> = {}): IStableSwapPurchaseRecord {
  return {
    id: overrides.id ?? 1,
    walletAddress: overrides.walletAddress ?? '0x1234567890123456789012345678901234567890',
    txHash: overrides.txHash ?? '0xabc',
    blockNumber: overrides.blockNumber ?? 15,
    blockHash: overrides.blockHash ?? '0xblock',
    transactionIndex: overrides.transactionIndex ?? 2,
    receiptRoot: overrides.receiptRoot ?? '0xreceipts',
    ethereumTimestamp: overrides.ethereumTimestamp ?? NOW,
    poolAddress: overrides.poolAddress ?? '0xpool',
    poolFee: overrides.poolFee ?? 500,
    ethereumArgonAmount: overrides.ethereumArgonAmount ?? 1_000_000_000_000_000_000n,
    costBasisUsdc: overrides.costBasisUsdc ?? 970_000n,
    costBasisMicrogons: overrides.costBasisMicrogons ?? 970_000n,
    effectiveBuyPriceMicrogons: overrides.effectiveBuyPriceMicrogons ?? 970_000n,
    uniswapPriceMicrogons: overrides.uniswapPriceMicrogons ?? 980_000n,
    argonBlockNumber: overrides.argonBlockNumber ?? 77,
    argonBlockHash: overrides.argonBlockHash ?? '0xargon',
    argonOraclePriceMicrogons: overrides.argonOraclePriceMicrogons ?? 1_000_000n,
    argonOracleTargetPriceMicrogons: overrides.argonOracleTargetPriceMicrogons ?? 1_000_000n,
    proofStatus: overrides.proofStatus ?? StableSwapProofStatus.Pending,
    proofPayload: overrides.proofPayload,
    proofError: overrides.proofError,
    createdAt: overrides.createdAt ?? NOW,
    updatedAt: overrides.updatedAt ?? NOW,
  };
}

describe('StableSwaps', () => {
  it('hydrates wallet capital and per-purchase P/L from the current market price', () => {
    const syncState = createSyncState();
    const purchases = [
      createPurchase(),
      createPurchase({
        id: 2,
        txHash: '0xdef',
        ethereumArgonAmount: 2_000_000_000_000_000_000n,
        costBasisUsdc: 1_900_000n,
        costBasisMicrogons: 1_900_000n,
        effectiveBuyPriceMicrogons: 950_000n,
      }),
    ];

    const wallet = hydrateStableSwapWallet(syncState.walletAddress, purchases, 1_000_000n, syncState)!;

    expect(wallet.summary.capitalAppliedMicrogons).toBe(2_870_000n);
    expect(wallet.summary.currentValueMicrogons).toBe(3_000_000n);
    expect(wallet.purchases[0].currentProfitMicrogons).toBe(30_000n);
    expect(wallet.purchases[1].currentProfitMicrogons).toBe(100_000n);
  });

  it('does not reuse purchase basis after ARGN custody is no longer intact', () => {
    const syncState = createSyncState({ isPurchaseBasisIntact: false });
    const walletSnapshot = hydrateStableSwapWallet(syncState.walletAddress, [createPurchase()], 800_000n, syncState);
    const [position] = stableSwapFinancials.createFinancialPositions({
      wallet: {
        ...defaultWalletData,
        address: syncState.walletAddress,
        availableMicrogons: 1_000_000n,
      },
      walletSnapshot,
      currentPriceMicrogons: 800_000n,
    });

    expect(position.id).toBe(`${syncState.walletAddress.toLowerCase()}:ethereum:ARGN`);
    expect(position.group).toBe('ethereum');
    expect(position.currentValue).toBe(800_000n);
    expect(position.isQuantityReconciled).toBe(true);
    expect(position.investedCost).toBeUndefined();
  });

  it('builds a Uniswap output-prefill link with Argon and ETH prefilled', async () => {
    const url = await StableSwaps.buildStableSwapUniswapUrl(12_340_000n, 'ETH', {
      argonTokenAddress: STABLE_SWAP_FIXTURE_ARGON_TOKEN_ADDRESS,
    });

    expect(url).toContain('https://app.uniswap.org/#/swap?');
    expect(url).toContain('chain=mainnet');
    expect(url).toContain('field=output');
    expect(url).toContain(`outputCurrency=${STABLE_SWAP_FIXTURE_ARGON_TOKEN_ADDRESS}`);
    expect(url).toContain('value=12.34');
    expect(url).toContain('inputCurrency=ETH');
  });

  it('resolves stable swap input tokens to Uniswap input currencies', async () => {
    await expect(StableSwaps.getInputCurrency(UnitOfMeasurement.USDC)).resolves.toBe(
      '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
    );
    await expect(StableSwaps.getInputCurrency(UnitOfMeasurement.USDT)).resolves.toBe(
      '0xdAC17F958D2ee523a2206206994597C13D831ec7',
    );
    await expect(StableSwaps.getInputCurrency(UnitOfMeasurement.ETH)).resolves.toBe('ETH');
    await expect(
      StableSwaps.getInputCurrency(UnitOfMeasurement.ARGNOT, {
        argonotTokenAddress: STABLE_SWAP_FIXTURE_ARGONOT_TOKEN_ADDRESS,
      }),
    ).resolves.toBe(STABLE_SWAP_FIXTURE_ARGONOT_TOKEN_ADDRESS);
  });

  it('prices the Argon/USDC pool correctly when USDC is token0', () => {
    NetworkConfig.setRuntimeOverride('dev-docker', {
      ethereumNetwork: {
        usdcTokenAddress: '0x0000000000000000000000000000000000000001',
      },
    });

    try {
      const argonToken = getStableSwapArgonToken(STABLE_SWAP_FIXTURE_ARGON_TOKEN_ADDRESS, ChainId.MAINNET);
      const sqrtPriceX96 = encodeSqrtRatioX96((1n * 10n ** BigInt(argonToken.decimals)).toString(), '970000');
      const pool = createStableSwapSdkPool(
        {
          poolFee: 500,
          poolLiquidity: 1_000_000_000_000_000_000n,
          currentSqrtPriceX96: BigInt(sqrtPriceX96.toString()),
          currentTick: TickMath.getTickAtSqrtRatio(JSBI.BigInt(sqrtPriceX96.toString()) as any),
          argonIsToken0: false,
        },
        argonToken,
      );

      expect(stableSwapSdkPriceToFixed18(pool.priceOf(argonToken))).toBe(970_000_000_000_000_000n);
    } finally {
      NetworkConfig.clearRuntimeOverride('dev-docker');
    }
  });

  it('loads active swaps from the fixture public client when USDC is token0', async () => {
    NetworkConfig.setRuntimeOverride('dev-docker', {
      ethereumNetwork: {
        usdcTokenAddress: '0x0000000000000000000000000000000000000001',
      },
    });

    try {
      const stableSwaps = new StableSwaps(createStableSwapFixturePublicClient(), {
        argonTokenAddress: STABLE_SWAP_FIXTURE_ARGON_TOKEN_ADDRESS,
        argonotTokenAddress: STABLE_SWAP_FIXTURE_ARGONOT_TOKEN_ADDRESS,
      });

      const swaps = await stableSwaps.getActive({
        microgonsPerUsd: 1_000_000n,
        inputTokenPricesMicrogons: {
          USDC: 1_000_000n,
          USDT: 1_000_000n,
          ETH: 3_000_000_000n,
          ARGNOT: 50_000n,
        },
        targetPriceFixed18: parseUnits('1', 18),
      });

      expect(swaps).toHaveLength(4);
      expect(swaps.map(swap => swap.inputToken)).toEqual(['USDC', 'USDT', 'ETH', 'ARGNOT']);
    } finally {
      NetworkConfig.clearRuntimeOverride('dev-docker');
    }
  });

  it('loads active swaps from the fixture public client', async () => {
    const stableSwaps = new StableSwaps(createStableSwapFixturePublicClient(), {
      argonTokenAddress: STABLE_SWAP_FIXTURE_ARGON_TOKEN_ADDRESS,
      argonotTokenAddress: STABLE_SWAP_FIXTURE_ARGONOT_TOKEN_ADDRESS,
    });

    const swaps = await stableSwaps.getActive({
      microgonsPerUsd: 1_000_000n,
      inputTokenPricesMicrogons: {
        USDC: 1_000_000n,
        USDT: 1_000_000n,
        ETH: 3_000_000_000n,
        ARGNOT: 50_000n,
      },
      targetPriceFixed18: parseUnits('1', 18),
    });

    expect(swaps).toHaveLength(4);
    expect(swaps.map(swap => swap.inputToken)).toEqual(['USDC', 'USDT', 'ETH', 'ARGNOT']);
    expect(stableSwaps.marketSnapshot?.currentPriceMicrogons).toBe(swaps[0].currentPriceMicrogons);
    for (const swap of swaps) {
      expect(swap.outputToken).toBe('ARGN');
      expect(swap.poolFee).toBe(500);
      expect(swap.inputAmount).toBeGreaterThan(0n);
      expect(swap.inputAmountMicrogons).toBeGreaterThan(0n);
      expect(swap.outputAmount).toBeGreaterThan(0n);
      expect(swap.returnPct).toBeGreaterThan(0);
    }
  });
});
