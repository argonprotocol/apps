import { describe, expect, it } from 'vitest';
import BigNumber from 'bignumber.js';
import { StabilizerBuyPool, type IStabilizerBuyPoolSnapshot } from '../src/StabilizerBuyPool.js';

const prices = { tick: 100, argonUsdTargetPrice: BigNumber(1), usdcUsdPrice: BigNumber(1) };
const sourceAddress = `0x${'11'.repeat(20)}` as const;

describe.each([true, false])('cached pool estimates, ARGN token0: %s', argonIsToken0 => {
  it('sizes the purchase at the fee-adjusted maximum savings point, with exact pool quantities', async () => {
    // Symmetric full-range reserves: 1,000 ARGN and 640 USDC at a price of $0.64.
    // At the optimum the marginal cost including the 0.5% fee is $1 per ARGN.
    const sqrt = BigNumber('0.64').sqrt();
    const liquidity = 800_000_000_000_000n;
    const rawPrice = sqrt.times(1e-6);
    let rawSqrt = rawPrice;
    if (!argonIsToken0) rawSqrt = BigNumber(1).div(rawPrice);
    const sqrtPriceX96 = BigInt(rawSqrt.times((1n << 96n).toString()).toFixed(0));
    const snapshot: IStabilizerBuyPoolSnapshot = {
      chainId: 1,
      poolManager: `0x${'22'.repeat(20)}`,
      poolId: `0x${'33'.repeat(32)}`,
      poolKey: {
        currency0: `0x${'44'.repeat(20)}`,
        currency1: `0x${'55'.repeat(20)}`,
        hooks: `0x${'66'.repeat(20)}`,
        fee: 8_388_608,
        tickSpacing: 60,
      },
      argonIsToken0,
      blockNumber: 1n,
      blockHash: `0x${'77'.repeat(32)}`,
      sqrtPriceX96,
      tick: 0,
      liquidity,
      buyFee: 5_000,
      protocolFee: 0,
      ticks: [
        { index: -887220, liquidityGross: liquidity.toString(), liquidityNet: liquidity.toString() },
        { index: 887220, liquidityGross: liquidity.toString(), liquidityNet: (-liquidity).toString() },
      ],
    };
    const pool = new StabilizerBuyPool(snapshot);
    const input = {
      maxUsdcIn: 1_000_000_000n,
      sqrtPriceX96,
      prices,
      sourceAddress,
      minimumMicrogons: 1_000_000n,
      minimumRewardPrincipal: 1_000_000n,
    };
    const result = (await pool.estimate(input))!;
    // Independent constant-product expectation, not the SDK's swap routine.
    const optimum = BigNumber('0.995').sqrt();
    const expectedInput = BigNumber(800).times(optimum.minus('0.8')).div('0.995');
    const expectedOutput = BigNumber(1000).minus(BigNumber(800).div(optimum));
    expect(Number(result.request.maxUsdcIn) / 1e6).toBeCloseTo(expectedInput.toNumber(), 5);
    expect(Number(result.quotedMicrogonsOut) / 1e6).toBeCloseTo(expectedOutput.toNumber(), 5);
    expect(result.qualifiesForRewards).toBe(true);

    const limited = (await pool.estimate({ ...input, maxUsdcIn: 20_000_000n }))!;
    expect(limited.request.maxUsdcIn).toBe(20_000_000n);
    // USDC reserve grows by input minus the pool fee; ARGN output follows x*y=k.
    const bought = BigNumber(1000).minus(BigNumber(640_000).div(BigNumber(640).plus(BigNumber(20).times('0.995'))));
    expect(Number(limited.quotedMicrogonsOut) / 1e6).toBeCloseTo(bought.toNumber(), 5);
    const funding = (await pool.estimate({ ...input, maxUsdcIn: 0n }))!;
    expect((funding.quotedMicrogonsOut * 9950n) / 10000n).toBeGreaterThanOrEqual(input.minimumMicrogons);
    expect(funding.request.maxUsdcIn).toBeLessThan(limited.request.maxUsdcIn);

    // Changing the native price reuses the same bands and reduces the opportunity as target approaches.
    let higherSqrt = BigNumber('0.81').sqrt().times(1e-6);
    if (!argonIsToken0) higherSqrt = BigNumber(1).div(higherSqrt);
    const later = (await pool.estimate({
      ...input,
      sqrtPriceX96: BigInt(higherSqrt.times((1n << 96n).toString()).toFixed(0)),
    }))!;
    expect(later.request.maxUsdcIn).toBeLessThan(result.request.maxUsdcIn);
    expect(later.quotedMicrogonsOut).toBeLessThan(result.quotedMicrogonsOut);
  });
});
