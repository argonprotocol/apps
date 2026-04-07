import { describe, expect, it } from 'vitest';
import {
  createStableSwapPublicClient,
  fetchStableSwapMarketSnapshot,
  fetchStableSwapPoolMetadata,
  getStableSwapPoolPriceFixed18,
  quoteStableSwapExactOutput,
  STABLE_SWAP_QUOTE_TOLERANCE_ETHEREUM_ARGON_AMOUNT,
} from '../lib/StableSwaps.ts';

const runStableSwapsIntegration = Boolean(JSON.parse(process.env.RUN_STABLE_SWAPS_INTEGRATION ?? '0'));
const stableSwapsRpcUrl = process.env.STABLE_SWAPS_RPC_URL ?? 'https://ethereum-rpc.publicnode.com';

describe.skipIf(!runStableSwapsIntegration).sequential('StableSwaps integration', { timeout: 120e3 }, () => {
  it('finds the amount that reaches the target price boundary on the live Uniswap quote path', async () => {
    const client = createStableSwapPublicClient(stableSwapsRpcUrl);
    const blockNumber = await client.getBlockNumber();
    const pool = await fetchStableSwapPoolMetadata(client, blockNumber);

    const currentPriceFixed18 = getStableSwapPoolPriceFixed18(pool);
    const sampleQuote = await quoteStableSwapExactOutput({
      client,
      pool,
      amountOut: 1_000_000_000_000_000n,
      blockNumber,
      throwOnError: true,
    });

    expect(sampleQuote).toBeTruthy();
    expect(sampleQuote!.priceAfterFixed18).toBeGreaterThan(currentPriceFixed18);

    const priceIncreaseFixed18 = sampleQuote!.priceAfterFixed18 - currentPriceFixed18;
    const targetPriceFixed18 = currentPriceFixed18 + (priceIncreaseFixed18 > 1n ? priceIncreaseFixed18 / 2n : 1n);

    const { snapshot } = await fetchStableSwapMarketSnapshot(client, 1_000_000n, targetPriceFixed18, pool, blockNumber);

    expect(snapshot.discountedEthereumArgonAmount).toBeGreaterThan(0n);
    expect(snapshot.discountedEthereumArgonAmount).toBeGreaterThan(STABLE_SWAP_QUOTE_TOLERANCE_ETHEREUM_ARGON_AMOUNT);
    expect(snapshot.costToTargetMicrogons).toBeGreaterThan(0n);

    const boundaryQuote = await quoteStableSwapExactOutput({
      client,
      pool,
      amountOut: snapshot.discountedEthereumArgonAmount,
      blockNumber,
    });

    expect(boundaryQuote).toBeTruthy();
    expect(boundaryQuote!.priceAfterFixed18).toBeGreaterThanOrEqual(targetPriceFixed18);

    const smallerQuote = await quoteStableSwapExactOutput({
      client,
      pool,
      amountOut: snapshot.discountedEthereumArgonAmount - STABLE_SWAP_QUOTE_TOLERANCE_ETHEREUM_ARGON_AMOUNT,
      blockNumber,
    });

    expect(smallerQuote).toBeTruthy();
    expect(smallerQuote!.priceAfterFixed18).toBeLessThan(targetPriceFixed18);
  });
});
