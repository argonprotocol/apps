import { EvmContracts } from '@argonprotocol/mainchain';
import * as V3Sdk from '@uniswap/v3-sdk';
import type { TickConstructorArgs } from '@uniswap/v3-sdk';
import JSBIRuntime from 'jsbi';
import BigNumber from 'bignumber.js';
import {
  encodeAbiParameters,
  keccak256,
  parseAbi,
  parseAbiItem,
  toHex,
  maxUint128,
  maxUint160,
  type PublicClient,
  type Hash,
} from 'viem';
import {
  StabilizerBuyContracts,
  StabilizerBuyQuoteUnavailableError,
  type IStabilizerBuyEstimate,
  type IStabilizerBuyPriceReference,
  type IStabilizerBuyQuote,
} from './StabilizerBuyContracts.js';

// The SDK exposes CommonJS to Node/tsx and ES modules to Vite.
const sdk = V3Sdk as typeof V3Sdk & { default?: typeof V3Sdk };
const { TickListDataProvider, TickMath, v3Swap, encodeSqrtRatioX96 } = sdk.default ?? sdk;
// NodeNext types the CommonJS default as a namespace; Vite resolves the class.
type JSBIConstructor = typeof JSBIRuntime extends { default: infer Constructor } ? Constructor : typeof JSBIRuntime;
const JSBI = ('default' in JSBIRuntime ? JSBIRuntime.default : JSBIRuntime) as JSBIConstructor;

type PoolIdentity = Pick<IStabilizerBuyQuote, 'chainId' | 'poolManager' | 'poolId' | 'poolKey'>;

export interface IStabilizerBuyPoolSnapshot extends PoolIdentity {
  argonIsToken0: boolean;
  blockNumber: bigint;
  blockHash: Hash;
  sqrtPriceX96: bigint;
  tick: number;
  liquidity: bigint;
  buyFee: number;
  protocolFee: number;
  ticks: TickConstructorArgs[];
}

const storageAbi = parseAbi(['function extsload(bytes32[] slots) view returns (bytes32[])']);
const liquidityEvent = parseAbiItem(
  'event ModifyLiquidity(bytes32 indexed id, address indexed sender, int24 tickLower, int24 tickUpper, int256 liquidityDelta, bytes32 salt)',
);
const MAX_INITIALIZED_TICKS = 8_192;
const LOG_BLOCKS_PER_READ = 1_000n;

/** The approved pool's aggregated liquidity distribution; estimates never authorize a transaction. */
export class StabilizerBuyPool {
  private readonly tickData: InstanceType<typeof TickListDataProvider>;

  constructor(public readonly snapshot: IStabilizerBuyPoolSnapshot) {
    this.tickData = new TickListDataProvider(snapshot.ticks, snapshot.poolKey.tickSpacing);
  }

  public static async read({
    client,
    pool,
    argonIsToken0,
    previous,
    signal,
  }: {
    client: PublicClient;
    pool: PoolIdentity;
    argonIsToken0: boolean;
    previous?: IStabilizerBuyPoolSnapshot;
    signal?: AbortSignal;
  }): Promise<IStabilizerBuyPoolSnapshot> {
    signal?.throwIfAborted();
    const block = await client.getBlock();
    // Uniswap v4 StateLibrary: pools slot 6; liquidity, ticks and bitmap offsets 3, 4 and 5.
    const stateSlot = keccak256(encodeAbiParameters([{ type: 'bytes32' }, { type: 'uint256' }], [pool.poolId, 6n]));
    const [slot0, liquidity] = await this.readSlots({
      client,
      pool,
      slots: [stateSlot, toHex(BigInt(stateSlot) + 3n, { size: 32 })],
      blockNumber: block.number,
      signal,
    });
    const sqrtPriceX96 = slot0 & maxUint160;
    if (sqrtPriceX96 === 0n) throw new StabilizerBuyQuoteUnavailableError('The purchase pool is not initialized.');
    const tick = Number(BigInt.asIntN(24, slot0 >> 160n));
    const protocolFee = Number((slot0 >> 184n) & ((1n << 24n) - 1n));

    let ticks: TickConstructorArgs[] | undefined;
    let buyFee = previous?.buyFee;
    if (previous && previous.poolId === pool.poolId && previous.poolManager === pool.poolManager) {
      ticks = await this.applyLiquidityChanges({ client, pool, previous, blockNumber: block.number, signal });
      if (ticks && getActiveLiquidity(ticks, tick) !== liquidity) ticks = undefined;
    }

    if (!ticks) {
      ticks = await this.fetchTicks({ client, pool, stateSlot, blockNumber: block.number, signal });
      signal?.throwIfAborted();
      buyFee = await client.readContract({
        address: pool.poolKey.hooks,
        abi: EvmContracts.stabilizationPoolHookAbi,
        functionName: 'BUY_FEE',
        blockNumber: block.number,
      });
    }

    if (getActiveLiquidity(ticks, tick) !== liquidity)
      throw new StabilizerBuyQuoteUnavailableError('The purchase pool liquidity snapshot is inconsistent.');
    new TickListDataProvider(ticks, pool.poolKey.tickSpacing);

    signal?.throwIfAborted();
    const confirmed = await client.getBlock({ blockNumber: block.number });
    if (confirmed.hash !== block.hash)
      throw new Error('The purchase pool changed branches during refresh. Retry shortly.');

    return {
      ...pool,
      argonIsToken0,
      blockNumber: block.number,
      blockHash: block.hash,
      sqrtPriceX96,
      tick,
      liquidity,
      protocolFee,
      buyFee: buyFee!,
      ticks,
    };
  }

  public async estimate({
    maxUsdcIn,
    sqrtPriceX96,
    prices,
    sourceAddress,
    minimumMicrogons,
    minimumRewardPrincipal,
  }: {
    maxUsdcIn: bigint;
    sqrtPriceX96: bigint;
    prices: IStabilizerBuyPriceReference;
    sourceAddress: IStabilizerBuyQuote['sourceAddress'];
    minimumMicrogons: bigint;
    minimumRewardPrincipal: bigint;
  }): Promise<IStabilizerBuyEstimate | undefined> {
    const { snapshot } = this;
    if (!snapshot.ticks.length || sqrtPriceX96 <= 0n) return;
    const tick = TickMath.getTickAtSqrtRatio(JSBI.BigInt(sqrtPriceX96.toString()));
    const liquidity = getActiveLiquidity(snapshot.ticks, tick);
    const startingSqrtPrice = JSBI.BigInt(sqrtPriceX96.toString());

    const zeroForOne = !snapshot.argonIsToken0;
    let directionalProtocolFee = snapshot.protocolFee & 0xfff;
    if (!zeroForOne) directionalProtocolFee = snapshot.protocolFee >> 12;
    const swapFee =
      directionalProtocolFee + snapshot.buyFee - Math.floor((directionalProtocolFee * snapshot.buyFee) / 1_000_000);

    const targetUsdcPrice = prices.argonUsdTargetPrice.div(prices.usdcUsdPrice);
    const toSqrt = (price: BigNumber) => {
      const [numerator, denominator] = price.toFraction();
      const scaledDenominator = denominator.times(EvmContracts.MINTING_GATEWAY_RUNTIME_TO_ERC20_SCALE.toString());
      if (snapshot.argonIsToken0) return encodeSqrtRatioX96(numerator.toFixed(0), scaledDenominator.toFixed(0));
      return encodeSqrtRatioX96(scaledDenominator.toFixed(0), numerator.toFixed(0));
    };

    const targetSqrtPrice = toSqrt(targetUsdcPrice);
    if (zeroForOne && JSBI.greaterThanOrEqual(targetSqrtPrice, startingSqrtPrice)) return;
    if (!zeroForOne && JSBI.lessThanOrEqual(targetSqrtPrice, startingSqrtPrice)) return;

    const swap = (amount: bigint, limit: ReturnType<typeof encodeSqrtRatioX96>) =>
      v3Swap(
        JSBI.BigInt(swapFee),
        startingSqrtPrice,
        tick,
        JSBI.BigInt(liquidity.toString()),
        snapshot.poolKey.tickSpacing,
        this.tickData,
        zeroForOne,
        JSBI.BigInt(amount.toString()),
        limit,
      );

    // Fees move the maximum savings point slightly below target: marginal cost equals target value.
    const optimalSqrtPrice = toSqrt(targetUsdcPrice.times(1_000_000 - swapFee).div(1_000_000));
    let canImprove = JSBI.greaterThan(optimalSqrtPrice, startingSqrtPrice);
    if (zeroForOne) canImprove = JSBI.lessThan(optimalSqrtPrice, startingSqrtPrice);

    let purchaseUsdc = 0n;
    if (canImprove) {
      const optimum = await swap(-maxUint128, optimalSqrtPrice);
      purchaseUsdc = BigInt(optimum.amountCalculated.toString());
    }

    // Match the buy prompt's 50 basis-point slippage allowance at the gateway minimum.
    const minimumOutput =
      BigInt(BigNumber(minimumMicrogons).div('0.995').integerValue(BigNumber.ROUND_CEIL).toFixed(0)) *
      EvmContracts.MINTING_GATEWAY_RUNTIME_TO_ERC20_SCALE;
    const minimumQuote = await swap(-minimumOutput, targetSqrtPrice);
    const minimumUsdc = BigInt(minimumQuote.amountCalculated.toString()) + 1n;

    if (maxUsdcIn > 0n && maxUsdcIn < purchaseUsdc) purchaseUsdc = maxUsdcIn;
    // Keep a minimum-purchase funding preview when the wallet cannot fund a buy yet.
    if (purchaseUsdc < minimumUsdc || maxUsdcIn === 0n) purchaseUsdc = minimumUsdc;

    const result = await swap(purchaseUsdc, targetSqrtPrice);
    if (JSBI.equal(result.sqrtRatioX96, targetSqrtPrice)) return;
    const quotedMicrogonsOut =
      -BigInt(result.amountCalculated.toString()) / EvmContracts.MINTING_GATEWAY_RUNTIME_TO_ERC20_SCALE;
    if (quotedMicrogonsOut < minimumMicrogons) return;
    const sqrtPriceX96After = BigInt(result.sqrtRatioX96.toString());
    return {
      sourceAddress,
      poolId: snapshot.poolId,
      request: { maxUsdcIn: purchaseUsdc },
      quotedMicrogonsOut,
      minimumRewardPrincipal,
      sqrtPriceX96After,
      prices,
      qualifiesForRewards: StabilizerBuyContracts.qualifiesForRewards({
        prices,
        maxUsdcIn: purchaseUsdc,
        quotedMicrogonsOut,
        minimumRewardPrincipal,
        sqrtPriceX96Before: sqrtPriceX96,
        sqrtPriceX96After,
        argonIsToken0: snapshot.argonIsToken0,
      }),
    };
  }

  /** Apply this pool's changes only while the saved checkpoint is still canonical and nearby. */
  private static async applyLiquidityChanges({
    client,
    pool,
    previous,
    blockNumber,
    signal,
  }: {
    client: PublicClient;
    pool: PoolIdentity;
    previous: IStabilizerBuyPoolSnapshot;
    blockNumber: bigint;
    signal?: AbortSignal;
  }): Promise<TickConstructorArgs[] | undefined> {
    const distance = blockNumber - previous.blockNumber;
    if (distance < 0n || distance > 10_000n) return;

    const anchor = await client.getBlock({ blockNumber: previous.blockNumber }).catch(() => undefined);
    if (anchor?.hash !== previous.blockHash) return;

    const ticksByIndex = new Map(previous.ticks.map(tick => [tick.index, { ...tick }]));
    for (let fromBlock = previous.blockNumber + 1n; fromBlock <= blockNumber; fromBlock += LOG_BLOCKS_PER_READ) {
      const toBlock = fromBlock + LOG_BLOCKS_PER_READ - 1n;
      signal?.throwIfAborted();
      const logs = await client.getLogs({
        address: pool.poolManager,
        event: liquidityEvent,
        args: { id: pool.poolId },
        fromBlock,
        toBlock: toBlock < blockNumber ? toBlock : blockNumber,
        strict: true,
      });
      for (const { args } of logs) {
        if (args.liquidityDelta === 0n) continue;
        for (const index of [args.tickLower, args.tickUpper]) {
          const tick = ticksByIndex.get(index) ?? { index, liquidityGross: '0', liquidityNet: '0' };
          tick.liquidityGross = (BigInt(tick.liquidityGross.toString()) + args.liquidityDelta).toString();
          let netChange = args.liquidityDelta;
          if (index === args.tickUpper) netChange = -netChange;
          tick.liquidityNet = (BigInt(tick.liquidityNet.toString()) + netChange).toString();
          ticksByIndex.set(index, tick);
        }
      }
    }

    const ticks = [...ticksByIndex.values()];
    if (ticks.some(tick => BigInt(tick.liquidityGross.toString()) < 0n)) return;
    const initialized = ticks.filter(tick => BigInt(tick.liquidityGross.toString()) > 0n);
    if (initialized.length > MAX_INITIALIZED_TICKS) return;
    return initialized.sort((left, right) => left.index - right.index);
  }

  /** Fetch the initialized bitmap words first, then read just those ticks in batches. */
  private static async fetchTicks({
    client,
    pool,
    stateSlot,
    blockNumber,
    signal,
  }: {
    client: PublicClient;
    pool: PoolIdentity;
    stateSlot: Hash;
    blockNumber: bigint;
    signal?: AbortSignal;
  }): Promise<TickConstructorArgs[]> {
    const spacing = pool.poolKey.tickSpacing;
    const firstWord = Math.floor(Math.floor(TickMath.MIN_TICK / spacing) / 256);
    const lastWord = Math.floor(Math.floor(TickMath.MAX_TICK / spacing) / 256);
    const bitmapSlot = toHex(BigInt(stateSlot) + 5n, { size: 32 });
    const slots = Array.from({ length: lastWord - firstWord + 1 }, (_, index) =>
      keccak256(
        encodeAbiParameters([{ type: 'int256' }, { type: 'bytes32' }], [BigInt(firstWord + index), bitmapSlot]),
      ),
    );
    const bitmaps = await this.readSlots({ client, pool, slots, blockNumber, signal });

    const indices: number[] = [];
    for (let word = 0; word < bitmaps.length; word++) {
      for (let bit = 0; bit < 256; bit++) {
        if ((bitmaps[word] & (1n << BigInt(bit))) === 0n) continue;
        indices.push(((firstWord + word) * 256 + bit) * spacing);
        if (indices.length > MAX_INITIALIZED_TICKS)
          throw new StabilizerBuyQuoteUnavailableError('The purchase pool has too many liquidity bands to cache.');
      }
    }

    const tickSlot = toHex(BigInt(stateSlot) + 4n, { size: 32 });
    const values = await this.readSlots({
      client,
      pool,
      blockNumber,
      signal,
      slots: indices.map(index =>
        keccak256(encodeAbiParameters([{ type: 'int256' }, { type: 'bytes32' }], [BigInt(index), tickSlot])),
      ),
    });
    return indices.map((index, offset) => ({
      index,
      liquidityGross: (values[offset] & maxUint128).toString(),
      liquidityNet: BigInt.asIntN(128, values[offset] >> 128n).toString(),
    }));
  }

  private static async readSlots({
    client,
    pool,
    slots,
    blockNumber,
    signal,
  }: {
    client: PublicClient;
    pool: PoolIdentity;
    slots: Hash[];
    blockNumber: bigint;
    signal?: AbortSignal;
  }): Promise<bigint[]> {
    const result: bigint[] = [];
    for (let offset = 0; offset < slots.length; offset += 256) {
      signal?.throwIfAborted();
      const values = await client.readContract({
        address: pool.poolManager,
        abi: storageAbi,
        functionName: 'extsload',
        args: [slots.slice(offset, offset + 256)],
        blockNumber,
      });
      result.push(...values.map(value => BigInt(value)));
    }
    return result;
  }
}

function getActiveLiquidity(ticks: TickConstructorArgs[], currentTick: number): bigint {
  let liquidity = 0n;
  for (const tick of ticks) {
    if (tick.index <= currentTick) liquidity += BigInt(tick.liquidityNet.toString());
  }
  return liquidity;
}
