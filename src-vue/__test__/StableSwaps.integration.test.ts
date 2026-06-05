import { describe, expect, it } from 'vitest';
import { StableSwaps, STABLE_SWAP_QUOTE_TOLERANCE_ETHEREUM_ARGON_AMOUNT } from '../lib/StableSwaps.ts';
import { microgonsToEthereumArgonBaseUnits } from '../lib/StableSwapUtils.ts';
import { createPublicClient, getAddress, http } from 'viem';

const runStableSwapsIntegration = Boolean(JSON.parse(process.env.RUN_STABLE_SWAPS_INTEGRATION ?? '0'));
const stableSwapsRpcUrl = process.env.STABLE_SWAPS_RPC_URL ?? 'https://ethereum-rpc.publicnode.com';
const stableSwapsArgonTokenAddress = getAddress(
  process.env.STABLE_SWAPS_ARGON_TOKEN_ADDRESS ?? '0x6A9143639D8b70D50b031fFaD55d4CC65EA55155',
);

describe.skipIf(!runStableSwapsIntegration).sequential('StableSwaps integration', { timeout: 120e3 }, () => {
  it('finds the amount that reaches the target price boundary on the live Uniswap quote path', async () => {
    const client = createPublicClient({
      transport: http(stableSwapsRpcUrl),
    });
    const blockNumber = await client.getBlockNumber();
    const stableSwaps = new StableSwaps(client, { argonTokenAddress: stableSwapsArgonTokenAddress });
    const pool = await stableSwaps.getActivePoolMetadata(blockNumber);
    const currentPriceFixed18 = await stableSwaps.getCurrentPriceFixed18(pool);

    const sampleQuote = await stableSwaps.quoteExactOutput({
      pool,
      amountOut: 1_000_000_000_000_000n,
      blockNumber,
      throwOnError: true,
    });

    expect(sampleQuote).toBeTruthy();
    expect(sampleQuote!.priceAfterFixed18).toBeGreaterThan(currentPriceFixed18);

    const priceIncreaseFixed18 = sampleQuote!.priceAfterFixed18 - currentPriceFixed18;
    const targetPriceFixed18 = currentPriceFixed18 + (priceIncreaseFixed18 > 1n ? priceIncreaseFixed18 / 2n : 1n);

    const snapshot = await stableSwaps.getMarketSnapshot({
      microgonsPerUsd: 1_000_000n,
      targetPriceFixed18,
      pool,
      blockNumber,
    });

    expect(snapshot.discountedEthereumArgonAmount).toBeGreaterThan(0n);
    expect(snapshot.costToTargetMicrogons).toBeGreaterThan(0n);
    const discountedEthereumArgonBaseUnits = microgonsToEthereumArgonBaseUnits(snapshot.discountedEthereumArgonAmount);
    expect(discountedEthereumArgonBaseUnits).toBeGreaterThan(STABLE_SWAP_QUOTE_TOLERANCE_ETHEREUM_ARGON_AMOUNT);

    const boundaryQuote = await stableSwaps.quoteExactOutput({
      pool,
      amountOut: discountedEthereumArgonBaseUnits,
      blockNumber,
    });

    expect(boundaryQuote).toBeTruthy();
    expect(boundaryQuote!.priceAfterFixed18).toBeGreaterThanOrEqual(targetPriceFixed18);

    const smallerQuote = await stableSwaps.quoteExactOutput({
      pool,
      amountOut: discountedEthereumArgonBaseUnits - STABLE_SWAP_QUOTE_TOLERANCE_ETHEREUM_ARGON_AMOUNT,
      blockNumber,
    });

    expect(smallerQuote).toBeTruthy();
    expect(smallerQuote!.priceAfterFixed18).toBeLessThan(targetPriceFixed18);
  });
});
