import BigNumber from 'bignumber.js';
import { describe, expect, it, vi } from 'vitest';
import { maxUint128, toHex, decodeFunctionData, type PublicClient } from 'viem';
import { runtimeClient, type LiveQueryRecord } from '@argonprotocol/runtime-client';
import { StabilizerBuy } from '../src/StabilizerBuy.ts';
import {
  StabilizerBuyContracts,
  StabilizerBuyQuoteUnavailableError,
  type IStabilizerBuyQuote,
} from '../src/StabilizerBuyContracts.ts';
import type { ArgonCurrentQueryClient } from '../src/MainchainClients.ts';
import { getOfflineRegistry, EvmContracts } from '@argonprotocol/mainchain';
import { Metadata } from '@polkadot/types';
import { decorateExtrinsics, decorateStorage } from '@polkadot/types/metadata/decorate';

const auction: NonNullable<LiveQueryRecord<'stabilizerBuys', 'auctions'>> = {
  matchingRate: new BigNumber('0.75'),
  totalMatchingBasis: 750n,
  budget: 0n,
  remainingBudget: 0n,
  remainingMatchingBasis: 0n,
  maturesAtFrame: 42,
};
const purchase: NonNullable<LiveQueryRecord<'stabilizerBuys', 'buysByAccountAndFrame'>> = {
  pendingLiquidRepays: 0n,
  liquidRepaymentRewardRate: null,
  principal: 100_000_000n,
  capturedDiscount: 101n,
  bidRate: new BigNumber('0.33'),
  positiveBidCount: 1,
};

describe('Stabilizer buy auction position', () => {
  it.each([true, false])(
    'sizes opportunities below target and accepts exact buys crossing target with ARGN as token0=%s',
    async argonIsToken0 => {
      const addresses = {
        gateway: `0x${'11'.repeat(20)}`,
        adapter: `0x${'22'.repeat(20)}`,
        argon: `0x${'33'.repeat(20)}`,
        usdc: `0x${'44'.repeat(20)}`,
        poolManager: `0x${'55'.repeat(20)}`,
        quoter: `0x${'66'.repeat(20)}`,
        source: `0x${'77'.repeat(20)}`,
      } as const;
      const poolId = `0x${'88'.repeat(32)}` as const;
      let minimum = 1n;
      let poolApproved = true;
      let usdcAllowance = 0n;
      let usdcBalance = 0n;
      let outputPercent = 100n;
      let startingPriceUsdc = BigNumber(1);
      let usdcUsdPrice = BigNumber('0.8');
      let startingSqrtPriceX96: bigint | undefined;
      const contractReads = { swapContract: addresses.adapter, ...addresses };
      const simulate = vi.fn(
        async ({
          args,
          functionName,
        }: {
          args: [{ exactAmount: bigint }];
          blockNumber: bigint;
          functionName: string;
        }) => {
          let amount = args[0].exactAmount;
          if (functionName === 'quoteExactOutputSingle') {
            const divisor = outputPercent * 1_000_000_000_000n;
            amount = (amount * 100n + divisor - 1n) / divisor;
          }
          // Synthetic quoter market: 50 USDC reaches $1.25/ARGN; USDC's oracle price is $0.80.
          const priceUsdc = startingPriceUsdc.plus(BigNumber(amount).div(200_000_000));
          let ratio = priceUsdc.div(1e12);
          if (!argonIsToken0) ratio = BigNumber(1e12).div(priceUsdc);
          const sqrtPriceX96 = BigInt(
            ratio
              .sqrt()
              .times((1n << 96n).toString())
              .integerValue()
              .toFixed(0),
          );
          let result = (amount * outputPercent * 1_000_000_000_000n) / 100n;
          if (functionName === 'quoteExactOutputSingle') result = amount;
          return { result: [result, 0n, sqrtPriceX96] };
        },
      );
      const ethereum = {
        getChainId: async () => 31337,
        getBlock: async () => ({ number: 100n, timestamp: 1_000n }),
        getStorageAt: async () => {
          if (startingSqrtPriceX96 !== undefined) return toHex(startingSqrtPriceX96, { size: 32 });
          let ratio = startingPriceUsdc.div(1e12);
          if (!argonIsToken0) ratio = BigNumber(1e12).div(startingPriceUsdc);
          const sqrtPrice = BigInt(
            ratio
              .sqrt()
              .times((1n << 96n).toString())
              .integerValue()
              .toFixed(0),
          );
          return toHex(sqrtPrice, { size: 32 });
        },
        readContract: async ({
          functionName,
        }: {
          functionName: keyof typeof contractReads | 'minimumSwapMicrogons' | 'allowance' | 'balanceOf';
        }) => {
          if (functionName === 'minimumSwapMicrogons') return minimum;
          if (functionName === 'allowance') return usdcAllowance;
          if (functionName === 'balanceOf') return usdcBalance;
          return contractReads[functionName];
        },
        simulateContract: simulate,
        estimateContractGas: async ({ functionName, args }: { functionName: string; args: unknown[] }) => {
          if (functionName === 'buyAndTransfer') {
            const request = args[0] as IStabilizerBuyQuote['request'];
            if (usdcBalance < request.maxUsdcIn) throw new Error('USDC transfer exceeds wallet balance');
          }
          return 50_000n;
        },
      } as unknown as PublicClient;
      const client = runtimeClient({
        consts: {
          balances: { existentialDeposit: 1_000_000n },
          stabilizerBuys: { maxPriceAgeTicks: 10 },
        },
        query: {
          ticks: { currentTick: async () => 20 },
          stabilizerBuys: {
            approvedPool: async () => {
              if (!poolApproved) return null;

              return {
                chainId: 31337n,
                poolId,
                poolManager: addresses.poolManager,
                usdcToken: addresses.usdc,
                argonIsToken0,
              };
            },
            priceHistoryByTick: Object.assign(() => undefined, {
              multi: async (ticks: string[]) =>
                ticks.map(tick =>
                  BigInt(tick) === 20n
                    ? {
                        frame: 12,
                        rValue: BigNumber(1),
                        prices: {
                          argonUsdTargetPrice: BigNumber(1),
                          microgonsAtTargetPerUsdc: usdcUsdPrice.times(1_000_000),
                        },
                      }
                    : null,
                ),
            }),
          },
          priceIndex: { currentEthereumPrice: async () => null },
          crosschainTransfer: {
            chainConfigBySourceChain: async () => ({
              type: 'Evm',
              value: { chainId: 31337n, gateway: addresses.gateway, argonToken: addresses.argon },
            }),
          },
          stabilizerPools: {
            pools: async () => ({
              key: {
                currency0: argonIsToken0 ? addresses.argon : addresses.usdc,
                currency1: argonIsToken0 ? addresses.usdc : addresses.argon,
                fee: 3000,
                tickSpacing: 60,
                hooks: addresses.gateway,
              },
            }),
          },
        },
      }) as unknown as ArgonCurrentQueryClient;
      const contracts = new StabilizerBuyContracts(() => ethereum);
      const input = {
        client,
        maxUsdcIn: 500_000_000n,
        slippageBps: 50,
        deadline: 2_000n,
        destinationAddress: `0x${'99'.repeat(32)}`,
        sourceAddress: addresses.source,
        quoterAddress: addresses.quoter,
      };

      const exact = await contracts.quote(input);
      expect(exact.request.maxUsdcIn).toBe(500_000_000n);
      expect(exact.quotedMicrogonsOut).toBe(500_000_000n);
      expect(exact.request.minMicrogonsOut).toBe(497_500_000n);
      // Historical fee previews do not require a funded wallet.
      expect(await contracts.estimateMarketPurchaseGas(input)).toBe(640_000n);
      poolApproved = false;
      await expect(contracts.estimateMarketPurchaseGas(input)).rejects.toThrow('no approved purchase pool');
      poolApproved = true;
      simulate.mockClear();
      const opportunity = await contracts.quote({ ...input, sizeToTarget: true });
      expect(opportunity.request.maxUsdcIn).toBeGreaterThanOrEqual(49_750_000n);
      expect(opportunity.request.maxUsdcIn).toBeLessThanOrEqual(50_000_000n);
      expect(opportunity.request.minMicrogonsOut).toBe((opportunity.quotedMicrogonsOut * 9950n) / 10_000n);
      expect(simulate.mock.calls.length).toBeLessThan(20);
      expect(simulate.mock.calls.every(([request]) => request.blockNumber === 100n)).toBe(true);

      const small = await contracts.quote({ ...input, maxUsdcIn: 10_000_000n, sizeToTarget: true });
      expect(small.request.maxUsdcIn).toBe(10_000_000n);
      expect(small.qualifiesForRewards).toBe(true);

      minimum = 1_000_000n;
      outputPercent = 50n;
      const unfunded = await contracts.quote({ ...input, maxUsdcIn: undefined, sizeToTarget: true });
      expect(unfunded.request.minMicrogonsOut).toBeGreaterThanOrEqual(minimum);
      expect(unfunded.request.maxUsdcIn).toBeGreaterThan(1_256_282n);
      outputPercent = 100n;
      const minimumQuote = await contracts.quote({ ...input, maxUsdcIn: undefined, sizeToTarget: true });
      expect(minimumQuote.request.maxUsdcIn).toBe(1_005_026n);
      expect(minimumQuote.request.minMicrogonsOut).toBeGreaterThanOrEqual(minimum);
      await expect(contracts.quote({ ...input, maxUsdcIn: 1n })).rejects.toThrow('Minimum purchase amount: 1 ARGN.');

      // A prior approval must not prevent an empty wallet from previewing a future purchase.
      usdcAllowance = small.request.maxUsdcIn;
      expect(await contracts.estimatePurchaseGas(small)).toEqual({
        gasEstimate: 530_000n,
        needsApproval: false,
        usdcAllowance,
        usdcBalance,
      });

      usdcBalance = small.request.maxUsdcIn - 1n;
      expect(await contracts.estimatePurchaseGas(small)).toEqual({
        gasEstimate: 530_000n,
        needsApproval: false,
        usdcAllowance,
        usdcBalance,
      });

      usdcBalance = small.request.maxUsdcIn;
      expect(await contracts.estimatePurchaseGas(small)).toEqual({
        gasEstimate: 110_000n,
        needsApproval: false,
        usdcAllowance,
        usdcBalance,
      });

      const transaction = await contracts.buildNextTransaction({
        client,
        quote: small,
        sourceAddress: addresses.source,
      });
      const decoded = decodeFunctionData({ abi: EvmContracts.argonBuyAndTransferAbi, data: transaction.data });
      expect(decoded.functionName).toBe('buyAndTransfer');
      if (decoded.functionName === 'buyAndTransfer') {
        expect(decoded.args[0]).toMatchObject({
          repayLiquidId: 0n,
          repaySignature: '0x',
          maxUsdcIn: small.request.maxUsdcIn,
        });
      }

      // With USDC at $0.80, a $0.992 starting price is below target but above the $0.99 reward cutoff.
      startingPriceUsdc = BigNumber('1.24');
      const nearTarget = await contracts.quote({ ...input, maxUsdcIn: 1_100_000n });
      expect(nearTarget.quotedMicrogonsOut).toBeGreaterThanOrEqual(nearTarget.minimumRewardPrincipal);
      expect(nearTarget.qualifiesForRewards).toBe(false);

      // Exact integer square roots bracket $0.99: floor for token0 ARGN, ceil for token1 ARGN.
      usdcUsdPrice = BigNumber(1);
      startingPriceUsdc = BigNumber('0.99');
      outputPercent = 101n;
      startingSqrtPriceX96 = argonIsToken0
        ? 78_831_026_366_734_652_303_669n
        : 79_627_299_360_338_032_629_969_613_668_148_875n;
      expect((await contracts.quote({ ...input, maxUsdcIn: 1_100_000n })).qualifiesForRewards).toBe(true);
      startingSqrtPriceX96 += argonIsToken0 ? 1n : -1n;
      expect((await contracts.quote({ ...input, maxUsdcIn: 1_100_000n })).qualifiesForRewards).toBe(false);

      startingSqrtPriceX96 = undefined;
      usdcUsdPrice = BigNumber('0.8');
      outputPercent = 100n;
      startingPriceUsdc = BigNumber(1);

      minimum = 49_740_000n;
      const nearMinimum = await contracts.quote({ ...input, sizeToTarget: true });
      expect(nearMinimum.request.minMicrogonsOut).toBeGreaterThanOrEqual(minimum);
      expect(nearMinimum.request.maxUsdcIn).toBeLessThanOrEqual(50_000_000n);
      minimum = 60_000_000n;
      await expect(contracts.quote({ ...input, sizeToTarget: true })).rejects.toBeInstanceOf(
        StabilizerBuyQuoteUnavailableError,
      );
      await expect(contracts.quote({ ...input, maxUsdcIn: undefined, sizeToTarget: true })).rejects.toBeInstanceOf(
        StabilizerBuyQuoteUnavailableError,
      );

      simulate.mockRejectedValueOnce(new Error('RPC unavailable'));
      await expect(contracts.quote({ ...input, sizeToTarget: true })).rejects.toThrow('RPC unavailable');
    },
  );

  it('reads native bid keys and applies matching-basis inclusion independently of reward funding', async () => {
    const registry = getOfflineRegistry();
    const metadata = new Metadata(registry, { metadata: { V16: registry.metadata } });
    const storage = decorateStorage(registry, metadata.asLatest, metadata.version);
    const accounts = [33, 11, 22].map(byte => registry.createType('AccountId32', new Uint8Array(32).fill(byte)));
    const entries = [60n, 30n, 10n].map((basis, index) => [
      registry.createType('StorageKey', [
        storage.stabilizerBuys.bidsByAuction,
        [
          12,
          [
            (index + 1) * 10,
            { descendingAmount: toHex(maxUint128 - basis, { size: 16 }), orderedId: accounts[index].toHex() },
          ],
        ],
      ]),
      registry.createType('Null'),
    ]);
    const client = runtimeClient({
      registry,
      query: {
        stabilizerBuys: {
          bidsByAuction: Object.assign(() => undefined, { entries: async () => entries }),
          auctions: async () =>
            registry.createType('Option<PalletStabilizerBuysAuction>', {
              matchingRate: 1_000_000,
              totalMatchingBasis: 100,
              budget: 90,
              remainingBudget: 90,
              remainingMatchingBasis: 90,
              maturesAtFrame: 42,
            }),
        },
      },
    }) as unknown as ArgonCurrentQueryClient;

    const bids = await StabilizerBuy.getBids(client, 12);
    const current = (await client.query.stabilizerBuys.auctions(12))!;
    expect(bids.map(bid => [bid.latestBid, bid.matchingBasis])).toEqual([
      [10, 60n],
      [20, 30n],
      [30, 10n],
    ]);
    expect(StabilizerBuy.allocateBids(bids, current, BigNumber(0.9)).map(bid => bid.fundingEstimate)).toEqual([
      6n,
      6n,
      0n,
    ]);
    expect(
      StabilizerBuy.allocateBids(bids, { ...current, remainingBudget: 5n }, BigNumber(0.9)).map(
        bid => bid.fundingEstimate,
      ),
    ).toEqual([5n, 0n, 0n]);

    const underfunded = {
      ...current,
      totalMatchingBasis: 100_000_000n,
      budget: 5_000_000n,
      remainingBudget: 5_000_000n,
      remainingMatchingBasis: 90_000_000n,
    };
    const fundedBids = StabilizerBuy.allocateBids(
      bids.map(bid => ({ ...bid, matchingBasis: bid.matchingBasis * 1_000_000n })),
      underfunded,
      BigNumber(0.9),
    );
    // Each included bid keeps the original 5/90 funding ratio; the first cannot consume the reservation.
    expect(fundedBids.map(bid => bid.fundingEstimate)).toEqual([333_333n, 333_333n, 0n]);

    const tied = bids.map((bid, index) => ({ ...bid, latestBid: 50, matchingBasis: [60n, 25n, 15n][index] }));
    const ranked = StabilizerBuy.allocateBids(tied, current, BigNumber(0.9));
    expect(ranked.map(bid => [bid.ownerAccount, bid.fundingEstimate])).toEqual([
      [accounts[0].toString(), 30n],
      [accounts[1].toString(), 12n],
      [accounts[2].toString(), 2n],
    ]);
    expect(
      StabilizerBuy.allocateBids([{ ...bids[0], latestBid: 50, matchingBasis: 100n }], current, BigNumber(0.9))[0]
        .fundingEstimate,
    ).toBe(45n);
  });

  it.each([
    [60n, 30n, 40, 40],
    [30n, 60n, 40, 39],
    [30n, 30n, 40, 39],
    [60n, 30n, 1, 1],
    [30n, 60n, 1, undefined],
  ])(
    'moves %s basis ahead of %s at %s%% without giving up unnecessary reward',
    (ownBasis, aheadBasis, rate, expected) => {
      const totalMatchingBasis = ownBasis + aheadBasis;
      const budget = (totalMatchingBasis * 90n) / 100n;
      const current = {
        matchingRate: BigNumber(1),
        totalMatchingBasis,
        budget,
        remainingBudget: budget,
        remainingMatchingBasis: budget,
        maturesAtFrame: 42,
      };
      const ownerAccount = `0x${'33'.repeat(32)}`;
      const aheadAccount = `0x${'11'.repeat(32)}`;
      const bids = StabilizerBuy.allocateBids(
        [
          { ownerAccount, latestBid: 80, matchingBasis: ownBasis },
          { ownerAccount: aheadAccount, latestBid: rate, matchingBasis: aheadBasis },
        ],
        current,
        BigNumber(0.9),
      );

      const percent = StabilizerBuy.getBidAheadPercent(bids, ownerAccount);
      expect(percent).toBe(expected);
      expect(StabilizerBuy.getBidAheadPercent(bids, aheadAccount)).toBeUndefined();
      if (percent === undefined) return;

      const moved = bids.map(bid => {
        if (bid.ownerAccount === ownerAccount) return { ...bid, latestBid: percent };
        return bid;
      });
      expect(StabilizerBuy.allocateBids(moved, current, BigNumber(0.9))[0].ownerAccount).toBe(ownerAccount);
      moved.find(bid => bid.ownerAccount === ownerAccount)!.latestBid++;
      expect(StabilizerBuy.allocateBids(moved, current, BigNumber(0.9))[0].ownerAccount).toBe(aheadAccount);
    },
  );

  it('uses the newest accepted price observation without reviving invalid or stale prices', async () => {
    const registry = getOfflineRegistry();
    const observations = new Map<number, unknown>();
    const prices = {
      argonUsdTargetPrice: 1_020_000_000_000_000_000n,
      microgonsAtTargetPerUsdc: BigInt(
        BigNumber('0.995').div('1.02').times(1e24).integerValue(BigNumber.ROUND_CEIL).toFixed(0),
      ),
    };
    observations.set(10, { frame: 12, rValue: 1_000_000_000_000_000_000n, prices });
    const client = runtimeClient({
      registry,
      consts: {
        stabilizerBuys: { maxPriceAgeTicks: registry.createType('u64', 10) },
        priceIndex: { maxDowntimeTicksBeforeReset: registry.createType('u64', 10) },
      },
      query: {
        ticks: { currentTick: async () => 20 },
        stabilizerBuys: {
          priceHistoryByTick: Object.assign(() => undefined, {
            multi: async (ticks: string[]) =>
              ticks.map(tick =>
                registry.createType(
                  'Option<PalletStabilizerBuysPriceHistoryPriceObservation>',
                  observations.get(Number(BigInt(tick))),
                ),
              ),
          }),
        },
        priceIndex: { currentEthereumPrice: async () => null },
      },
    }) as unknown as ArgonCurrentQueryClient;

    const reference = await StabilizerBuyContracts.readPriceReference(client, 20);
    expect(reference?.tick).toBe(10);
    expect(reference?.argonUsdTargetPrice.toFixed(2)).toBe('1.02');
    expect(reference?.usdcUsdPrice.toFixed(3)).toBe('0.995');

    observations.set(15, { frame: 12, rValue: 0, prices: null });
    expect(await StabilizerBuyContracts.readPriceReference(client, 20)).toBeUndefined();
    expect(await StabilizerBuyContracts.readPriceReference(client, 14)).toEqual(reference);
    expect(await StabilizerBuyContracts.readPriceReference(client, 21)).toBeUndefined();

    observations.clear();
    observations.set(9, { frame: 12, rValue: 1_000_000_000_000_000_000n, prices });
    expect(await StabilizerBuyContracts.readPriceReference(client, 20)).toBeUndefined();
  });

  it('attributes failed bids only through calls that preserve the fee payer’s origin', () => {
    const registry = getOfflineRegistry();
    const metadata = new Metadata(registry, { metadata: { V16: registry.metadata } });
    const calls = decorateExtrinsics(registry, metadata.asLatest, metadata.version);
    const bid = calls.stabilizerBuys.bid(12, 25);
    expect(StabilizerBuy.getBidAdmissionFrames(bid)).toEqual([12]);
    expect(StabilizerBuy.getBidAdmissionFrames(calls.utility.batch([bid, calls.stabilizerBuys.bid(13, 10)]))).toEqual([
      12, 13,
    ]);
    const otherAccount = registry.createType('AccountId32', new Uint8Array(32).fill(21));
    expect(StabilizerBuy.getBidAdmissionFrames(calls.proxy.proxy(otherAccount, null, bid))).toEqual([]);
    expect(StabilizerBuy.getBidAdmissionFrames(calls.utility.asDerivative(1, bid))).toEqual([]);
  });
  it('uses the auction’s frozen matching policy and rounds each reward step down', () => {
    const position = new StabilizerBuy(12, purchase, auction);

    expect(position.matchingBasis).toBe(75n);
    expect(position.requestedReward).toBe(24n);
    expect(position.getBidError({ currentFrameId: 13, rewardPercent: 50, maxPositiveBids: 4 })).toBeUndefined();
  });

  it('opens bids only in F+1 after funding, including a funded zero budget', () => {
    const position = new StabilizerBuy(12, purchase, auction);
    expect(position.isBiddingOpen(12)).toBe(false);
    expect(position.isBiddingOpen(13)).toBe(true);
    expect(position.isBiddingOpen(14)).toBe(false);
    expect(new StabilizerBuy(12, purchase, { ...auction, budget: null }).isBiddingOpen(13)).toBe(false);
  });

  it('permits opting out after four positive bids without granting another revision', () => {
    const position = new StabilizerBuy(12, { ...purchase, positiveBidCount: 4 }, auction);
    expect(position.getBidError({ currentFrameId: 13, rewardPercent: 0, maxPositiveBids: 4 })).toBeUndefined();
    expect(position.getBidError({ currentFrameId: 13, rewardPercent: 50, maxPositiveBids: 4 })).toContain(
      'positive bids',
    );
    const optedOut = new StabilizerBuy(12, { ...purchase, bidRate: new BigNumber(0), positiveBidCount: 4 }, auction);
    expect(optedOut.getBidError({ currentFrameId: 13, rewardPercent: 50, maxPositiveBids: 4 })).toContain(
      'positive bids',
    );
  });

  it('rejects a fractional percent, unchanged positive bid, and a reward that rounds to zero', () => {
    const position = new StabilizerBuy(12, purchase, auction);
    expect(position.getBidError({ currentFrameId: 13, rewardPercent: 0.5, maxPositiveBids: 4 })).toContain('whole');
    expect(position.getBidError({ currentFrameId: 13, rewardPercent: 101, maxPositiveBids: 4 })).toContain('100');
    expect(position.getBidError({ currentFrameId: 13, rewardPercent: 33, maxPositiveBids: 4 })).toContain('different');
    expect(position.getBidError({ currentFrameId: 13, rewardPercent: 1, maxPositiveBids: 4 })).toContain('zero');
  });
});
