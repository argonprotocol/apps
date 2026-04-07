import { calculateProfitPct, NetworkConfig } from '@argonprotocol/apps-core';
import { BlockWatch } from '@argonprotocol/apps-core/src/BlockWatch.ts';
import { PriceIndex } from '@argonprotocol/mainchain';
import JSBI from 'jsbi';
import { ChainId, CurrencyAmount, Token, TradeType } from '@uniswap/sdk-core';
import uniswapV3PoolEventsArtifact from '@uniswap/v3-core/artifacts/contracts/interfaces/pool/IUniswapV3PoolEvents.sol/IUniswapV3PoolEvents.json';
import uniswapV3PoolStateArtifact from '@uniswap/v3-core/artifacts/contracts/interfaces/pool/IUniswapV3PoolState.sol/IUniswapV3PoolState.json';
import { FeeAmount, Pool as UniswapV3Pool, Route as UniswapV3Route, SwapQuoter, TickMath } from '@uniswap/v3-sdk';
import {
  createPublicClient,
  decodeEventLog,
  erc20Abi,
  formatUnits,
  getAddress,
  http,
  isAddressEqual,
  parseUnits,
  type Abi,
  type Address,
  type Hash,
  type Hex,
  type PublicClient,
} from 'viem';
import { mainnet } from 'viem/chains';
import { NETWORK_NAME } from './Env.ts';
import { getMainchainClientAt } from '../stores/mainchain.ts';
import type { Db } from './Db.ts';
import { buildStableSwapReceiptProofs, type StableSwapReceiptProof } from './StableSwapProofs.ts';
import { type IStableSwapMarketStateRecord } from './db/StableSwapMarketStateTable.ts';
import {
  type IStableSwapPurchaseRecord as IStableSwapPurchaseRow,
  StableSwapProofStatus,
} from './db/StableSwapPurchasesTable.ts';
import { type IStableSwapSyncStateRecord } from './db/StableSwapSyncStateTable.ts';

export { buildStableSwapReceiptProofs, type StableSwapReceiptProof };

export interface StableSwapPoolMetadata {
  poolAddress: Address;
  poolFee: number;
  poolLiquidity: bigint;
  currentSqrtPriceX96: bigint;
  currentTick: number;
  argonIsToken0: boolean;
}

export interface StableSwapMarketSnapshot {
  poolAddress: string;
  poolFee: number;
  poolLiquidity: bigint;
  currentPriceMicrogons: bigint;
  targetPriceMicrogons?: bigint;
  discountedEthereumArgonAmount: bigint;
  costToTargetMicrogons: bigint;
  projectedProfitMicrogons: bigint;
  updatedAt: Date;
}

export interface StableSwapPurchaseRecord extends IStableSwapPurchaseRow {
  currentValueMicrogons: bigint;
  currentProfitMicrogons: bigint;
}

export interface StableSwapAddressSummary {
  walletAddress: string;
  watchedSinceBlockNumber?: number;
  capitalAppliedMicrogons: bigint;
  currentValueMicrogons: bigint;
  currentProfitMicrogons: bigint;
  returnPct: number;
  purchaseCount: number;
}

export interface StableSwapWalletSnapshot {
  startedTracking: boolean;
  purchases: StableSwapPurchaseRecord[];
  summary: StableSwapAddressSummary;
  syncState: IStableSwapSyncStateRecord;
}

type StableSwapArgonPriceSnapshot = {
  argonBlockNumber?: number;
  argonBlockHash?: string;
  argonOraclePriceMicrogons?: bigint;
  argonOracleTargetPriceMicrogons?: bigint;
};

type StableSwapPurchaseBuildResult = Omit<IStableSwapPurchaseRow, 'id' | 'createdAt' | 'updatedAt'>;

export interface StableSwapQuoteResult {
  amountOut: bigint;
  amountIn: bigint;
  priceAfterFixed18: bigint;
}

type StableSwapSdkPoolState = {
  sqrtPriceX96: bigint;
  liquidity: bigint;
  tickCurrent: number;
};

type StableSwapPoolSlot0 = readonly [bigint, number, number, number, number, number, boolean];

type StableSwapDecodedSwapLog = {
  args: {
    amount0: bigint;
    amount1: bigint;
    sqrtPriceX96: bigint;
    liquidity: bigint;
    tick: number;
  };
};

const UNISWAP_V3_POOL_STATE_ABI = uniswapV3PoolStateArtifact.abi as Abi;
const UNISWAP_V3_POOL_EVENTS_ABI = uniswapV3PoolEventsArtifact.abi as Abi;

const FIXED_18 = 10n ** 18n;
const USDC_TO_FIXED_18_FACTOR = 10n ** 12n;
const STABLE_SWAP_CHAIN_ID = ChainId.MAINNET;
const ETHEREUM_ARGON_DECIMALS = 18;
const USDC_DECIMALS = 6;
const ONE_ETHEREUM_ARGON = 10n ** BigInt(ETHEREUM_ARGON_DECIMALS);
export const STABLE_SWAP_QUOTE_TOLERANCE_ETHEREUM_ARGON_AMOUNT = 10n ** 12n;
const UNISWAP_FEE_TIERS = [FeeAmount.LOWEST, FeeAmount.LOW, FeeAmount.MEDIUM, FeeAmount.HIGH] as const;
const UNISWAP_V3_QUOTER_V2_ADDRESS = getAddress('0x61fFE014bA17989E743c5F6cB21bF9697530B21e');
const STABLE_SWAP_TRANSFER_EVENT = erc20Abi.find(item => item.type === 'event' && item.name === 'Transfer')!;

export function createStableSwapPublicClient(rpcUrl?: string): PublicClient {
  return createPublicClient({
    chain: mainnet,
    transport: http(rpcUrl?.trim() || getStableSwapEthereumSettings().rpcUrl, {
      retryCount: 1,
      timeout: 15_000,
    }),
  });
}

export function normalizeStableSwapAddress(address: string): Address {
  return getAddress(address.trim());
}

export function getStableSwapArgonTokenAddress(): Address {
  return getStableSwapEthereumSettings().argonTokenAddress;
}

export async function fetchStableSwapPoolMetadata(
  client: PublicClient,
  blockNumber?: bigint,
): Promise<StableSwapPoolMetadata> {
  const argonToken = getStableSwapArgonToken();
  const usdcToken = getStableSwapUsdcToken();
  const argonIsToken0 = argonToken.sortsBefore(usdcToken);

  const pools = await Promise.all(
    UNISWAP_FEE_TIERS.map(async poolFee => {
      const poolAddress = getAddress(UniswapV3Pool.getAddress(argonToken, usdcToken, poolFee));

      try {
        const [liquidity, slot0] = (await Promise.all([
          client.readContract({
            address: poolAddress,
            abi: UNISWAP_V3_POOL_STATE_ABI,
            functionName: 'liquidity',
            blockNumber,
          }),
          client.readContract({
            address: poolAddress,
            abi: UNISWAP_V3_POOL_STATE_ABI,
            functionName: 'slot0',
            blockNumber,
          }),
        ])) as [bigint, StableSwapPoolSlot0];

        return {
          poolAddress,
          poolFee,
          poolLiquidity: liquidity,
          currentSqrtPriceX96: slot0[0],
          currentTick: Number(slot0[1]),
          argonIsToken0,
        } satisfies StableSwapPoolMetadata;
      } catch {
        return null;
      }
    }),
  );

  const activePool = pools
    .filter((pool): pool is StableSwapPoolMetadata => Boolean(pool))
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

export async function fetchStableSwapMarketSnapshot(
  client: PublicClient,
  microgonsPerUsd: bigint,
  targetPriceFixed18?: bigint,
  pool?: StableSwapPoolMetadata,
  blockNumber?: bigint,
): Promise<{ pool: StableSwapPoolMetadata; snapshot: StableSwapMarketSnapshot }> {
  const activePool = pool ?? (await fetchStableSwapPoolMetadata(client, blockNumber));
  const currentPriceFixed18 = getStableSwapPoolPriceFixed18(activePool);

  let discountedEthereumArgonAmount = 0n;
  let costToTargetMicrogons = 0n;
  let projectedProfitMicrogons = 0n;

  if (targetPriceFixed18 && currentPriceFixed18 < targetPriceFixed18) {
    const quote = await findStableSwapAmountToTarget({
      client,
      pool: activePool,
      targetPriceFixed18,
      blockNumber,
    });
    if (quote) {
      discountedEthereumArgonAmount = quote.amountOut;
      costToTargetMicrogons = usdcToMicrogons(quote.amountIn, microgonsPerUsd);
      projectedProfitMicrogons = fixed18ToMicrogons(
        calculateCurrentValueFixed18(quote.amountOut, targetPriceFixed18) - usdcToFixed18(quote.amountIn),
        microgonsPerUsd,
      );
    }
  }

  return {
    pool: activePool,
    snapshot: {
      poolAddress: activePool.poolAddress,
      poolFee: activePool.poolFee,
      poolLiquidity: activePool.poolLiquidity,
      currentPriceMicrogons: fixed18ToMicrogons(currentPriceFixed18, microgonsPerUsd),
      targetPriceMicrogons: targetPriceFixed18 ? fixed18ToMicrogons(targetPriceFixed18, microgonsPerUsd) : undefined,
      discountedEthereumArgonAmount,
      costToTargetMicrogons,
      projectedProfitMicrogons,
      updatedAt: new Date(),
    },
  };
}

export function getStableSwapPoolPriceFixed18(pool: StableSwapPoolMetadata, state?: StableSwapSdkPoolState): bigint {
  return stableSwapSdkPriceToFixed18(createStableSwapSdkPool(pool, state).priceOf(getStableSwapArgonToken()));
}

export async function buildStableSwapPurchaseFromTransaction(args: {
  client: PublicClient;
  walletAddress: string;
  pool: StableSwapPoolMetadata;
  blockWatch: BlockWatch;
  microgonsPerUsd: bigint;
  transactionHash: Hash;
  blockCache?: Map<string, { blockHash: string; blockNumber: bigint; timestamp: bigint; receiptsRoot: string }>;
  argonPriceCache?: Map<number, Awaited<ReturnType<typeof getArgonPriceSnapshotAtTimestamp>>>;
}): Promise<StableSwapPurchaseBuildResult | null> {
  const { client, walletAddress, pool, blockWatch, microgonsPerUsd, transactionHash, blockCache, argonPriceCache } =
    args;

  const [transaction, receipt] = await Promise.all([
    client.getTransaction({ hash: transactionHash }),
    client.getTransactionReceipt({ hash: transactionHash }),
  ]);

  if (!isAddressEqual(transaction.from, walletAddress as Address)) {
    return null;
  }

  let ethereumArgonAmount = 0n;
  let costBasisUsdc = 0n;
  let lastPoolState: StableSwapSdkPoolState | undefined;

  for (const log of receipt.logs) {
    if (!isAddressEqual(log.address, pool.poolAddress)) {
      continue;
    }

    const decoded = decodeEventLog({
      abi: UNISWAP_V3_POOL_EVENTS_ABI,
      data: log.data,
      topics: log.topics,
    }) as unknown as StableSwapDecodedSwapLog;

    const argonDelta = pool.argonIsToken0 ? decoded.args.amount0 : decoded.args.amount1;
    const usdcDelta = pool.argonIsToken0 ? decoded.args.amount1 : decoded.args.amount0;
    if (argonDelta >= 0n || usdcDelta <= 0n) {
      continue;
    }

    ethereumArgonAmount += -argonDelta;
    costBasisUsdc += usdcDelta;

    lastPoolState = {
      sqrtPriceX96: decoded.args.sqrtPriceX96,
      liquidity: decoded.args.liquidity,
      tickCurrent: Number(decoded.args.tick),
    };
  }

  if (ethereumArgonAmount <= 0n || costBasisUsdc <= 0n || !receipt.blockHash || !lastPoolState) {
    return null;
  }

  const blockDetails = await getEthereumBlockDetails(client, receipt.blockHash, blockCache);
  const ethereumTimestamp = new Date(Number(blockDetails.timestamp) * 1_000);
  const argonPriceSnapshot = await getArgonPriceSnapshotAtTimestamp(
    ethereumTimestamp,
    blockWatch,
    microgonsPerUsd,
    argonPriceCache,
  );
  const costBasisFixed18 = usdcToFixed18(costBasisUsdc);

  return {
    walletAddress,
    txHash: transactionHash,
    blockNumber: Number(blockDetails.blockNumber),
    blockHash: blockDetails.blockHash,
    transactionIndex: Number(receipt.transactionIndex),
    receiptRoot: blockDetails.receiptsRoot,
    ethereumTimestamp,
    poolAddress: pool.poolAddress,
    poolFee: pool.poolFee,
    ethereumArgonAmount,
    costBasisUsdc,
    costBasisMicrogons: usdcToMicrogons(costBasisUsdc, microgonsPerUsd),
    effectiveBuyPriceMicrogons:
      ethereumArgonAmount > 0n
        ? fixed18ToMicrogons((costBasisFixed18 * FIXED_18) / ethereumArgonAmount, microgonsPerUsd)
        : 0n,
    uniswapPriceMicrogons: fixed18ToMicrogons(
      stableSwapSdkPriceToFixed18(createStableSwapSdkPool(pool, lastPoolState).priceOf(getStableSwapArgonToken())),
      microgonsPerUsd,
    ),
    argonBlockNumber: argonPriceSnapshot.argonBlockNumber,
    argonBlockHash: argonPriceSnapshot.argonBlockHash,
    argonOraclePriceMicrogons: argonPriceSnapshot.argonOraclePriceMicrogons,
    argonOracleTargetPriceMicrogons: argonPriceSnapshot.argonOracleTargetPriceMicrogons,
    proofStatus: StableSwapProofStatus.Pending,
    proofPayload: undefined,
    proofError: undefined,
  };
}

export function hydrateStableSwapWallet(
  walletAddress: string,
  purchases: IStableSwapPurchaseRow[],
  currentPriceMicrogons: bigint,
  syncState?: IStableSwapSyncStateRecord,
): StableSwapWalletSnapshot | null {
  if (!syncState) {
    return null;
  }

  const hydratedPurchases = purchases.map(purchase => {
    const currentValueMicrogons = calculateCurrentValueMicrogons(purchase.ethereumArgonAmount, currentPriceMicrogons);
    return {
      ...purchase,
      currentValueMicrogons,
      currentProfitMicrogons: currentValueMicrogons - purchase.costBasisMicrogons,
    };
  });

  const capitalAppliedMicrogons = hydratedPurchases.reduce((sum, purchase) => sum + purchase.costBasisMicrogons, 0n);
  const currentValueMicrogons = hydratedPurchases.reduce((sum, purchase) => sum + purchase.currentValueMicrogons, 0n);
  const currentProfitMicrogons = currentValueMicrogons - capitalAppliedMicrogons;

  return {
    startedTracking: false,
    purchases: hydratedPurchases,
    summary: {
      walletAddress,
      watchedSinceBlockNumber: syncState.startBlockNumber,
      capitalAppliedMicrogons,
      currentValueMicrogons,
      currentProfitMicrogons,
      returnPct: calculateProfitPct(capitalAppliedMicrogons, currentValueMicrogons) * 100,
      purchaseCount: hydratedPurchases.length,
    },
    syncState,
  };
}

export function buildStableSwapUniswapUrl(ethereumArgonAmount: bigint): string | null {
  if (ethereumArgonAmount <= 0n) {
    return null;
  }

  return `https://app.uniswap.org/#/swap?chain=mainnet&outputCurrency=${getStableSwapArgonTokenAddress()}&exactField=output&exactAmount=${formatUnits(ethereumArgonAmount, ETHEREUM_ARGON_DECIMALS)}`;
}

export function stableSwapMarketRecordToSnapshot(record: IStableSwapMarketStateRecord): StableSwapMarketSnapshot {
  return {
    poolAddress: record.poolAddress,
    poolFee: record.poolFee,
    poolLiquidity: record.poolLiquidity,
    currentPriceMicrogons: record.currentPriceMicrogons,
    targetPriceMicrogons: record.targetPriceMicrogons,
    discountedEthereumArgonAmount: record.discountedEthereumArgonAmount,
    costToTargetMicrogons: record.costToTargetMicrogons,
    projectedProfitMicrogons: record.projectedProfitMicrogons,
    updatedAt: record.updatedAt,
  };
}

export async function storeStableSwapMarketSnapshot(args: {
  db: Db;
  snapshot: StableSwapMarketSnapshot;
}): Promise<void> {
  const { db, snapshot } = args;

  await db.stableSwapMarketStateTable.upsert({
    poolAddress: snapshot.poolAddress,
    poolFee: snapshot.poolFee,
    poolLiquidity: snapshot.poolLiquidity,
    currentPriceMicrogons: snapshot.currentPriceMicrogons,
    targetPriceMicrogons: snapshot.targetPriceMicrogons,
    discountedEthereumArgonAmount: snapshot.discountedEthereumArgonAmount,
    costToTargetMicrogons: snapshot.costToTargetMicrogons,
    projectedProfitMicrogons: snapshot.projectedProfitMicrogons,
  });
}

export async function loadStableSwapWalletSnapshot(args: {
  db: Db;
  walletAddress: string;
  currentPriceMicrogons: bigint;
  syncState?: IStableSwapSyncStateRecord;
  startedTracking?: boolean;
}): Promise<StableSwapWalletSnapshot | null> {
  const { db, walletAddress, currentPriceMicrogons, syncState: existingSyncState, startedTracking = false } = args;
  const syncState = existingSyncState ?? (await db.stableSwapSyncStateTable.get(walletAddress));
  const purchases = await db.stableSwapPurchasesTable.fetchByWallet(walletAddress);
  const hydrated = hydrateStableSwapWallet(walletAddress, purchases, currentPriceMicrogons, syncState ?? undefined);
  if (!hydrated) {
    return null;
  }

  hydrated.startedTracking = startedTracking;
  return hydrated;
}

export async function syncStableSwapWallet(args: {
  db: Db;
  client: PublicClient;
  walletAddress: Address;
  pool: StableSwapPoolMetadata;
  blockWatch: BlockWatch;
  microgonsPerUsd: bigint;
  currentPriceMicrogons: bigint;
}): Promise<{ walletSnapshot: StableSwapWalletSnapshot | null; message: string }> {
  const { db, client, walletAddress, pool, blockWatch, microgonsPerUsd, currentPriceMicrogons } = args;

  const currentBlockNumber = Number(await client.getBlockNumber());
  let syncState = await db.stableSwapSyncStateTable.get(walletAddress);
  let startedTracking = false;
  let message = '';

  if (!syncState) {
    syncState = (await db.stableSwapSyncStateTable.upsert({
      walletAddress,
      startBlockNumber: currentBlockNumber,
      lastScannedBlockNumber: currentBlockNumber,
    }))!;
    startedTracking = true;
    message = 'Tracking this wallet from the current Ethereum block.';
  }

  if (syncState.lastScannedBlockNumber < currentBlockNumber) {
    const transferLogs = await client.getLogs({
      address: getStableSwapArgonTokenAddress(),
      event: STABLE_SWAP_TRANSFER_EVENT,
      args: {
        to: walletAddress,
      },
      fromBlock: BigInt(syncState.lastScannedBlockNumber + 1),
      toBlock: BigInt(currentBlockNumber),
    });

    const txHashes = [
      ...new Set(transferLogs.map(log => log.transactionHash).filter((hash): hash is `0x${string}` => Boolean(hash))),
    ];

    const blockCache = new Map<
      string,
      { blockHash: string; blockNumber: bigint; timestamp: bigint; receiptsRoot: string }
    >();
    const argonPriceCache = new Map<number, StableSwapArgonPriceSnapshot>();

    for (const txHash of txHashes) {
      const purchase = await buildStableSwapPurchaseFromTransaction({
        client,
        walletAddress,
        pool,
        blockWatch,
        microgonsPerUsd,
        transactionHash: txHash,
        blockCache,
        argonPriceCache,
      });
      if (!purchase) {
        continue;
      }

      await db.stableSwapPurchasesTable.upsert(purchase);
    }

    syncState = (await db.stableSwapSyncStateTable.upsert({
      walletAddress,
      startBlockNumber: syncState.startBlockNumber,
      lastScannedBlockNumber: currentBlockNumber,
    }))!;
  }

  return {
    walletSnapshot: await loadStableSwapWalletSnapshot({
      db,
      walletAddress,
      currentPriceMicrogons,
      syncState,
      startedTracking,
    }),
    message,
  };
}

export async function backfillStableSwapProofs(args: {
  db: Db;
  client: PublicClient;
  walletAddress: string;
}): Promise<void> {
  const { db, client, walletAddress } = args;
  const rows = await db.stableSwapPurchasesTable.fetchMissingProofs(walletAddress);
  if (!rows.length) {
    return;
  }

  const rowsByBlockHash = new Map<string, typeof rows>();
  for (const row of rows) {
    const key = row.blockHash.toLowerCase();
    const existing = rowsByBlockHash.get(key) ?? [];
    existing.push(row);
    rowsByBlockHash.set(key, existing);
  }

  for (const [blockHash, blockRows] of rowsByBlockHash.entries()) {
    try {
      const proofs = await buildStableSwapReceiptProofs({
        client,
        blockHash: blockHash as `0x${string}`,
        txHashes: blockRows.map(row => row.txHash),
      });

      for (const row of blockRows) {
        const proof = proofs[row.txHash.toLowerCase()];
        if (!proof) {
          await db.stableSwapPurchasesTable.updateProof(walletAddress, row.txHash, {
            proofStatus: StableSwapProofStatus.Failed,
            proofError: 'Receipt proof was not available for this transaction in the Ethereum block trie.',
          });
          continue;
        }

        await db.stableSwapPurchasesTable.updateProof(walletAddress, row.txHash, {
          proofStatus: StableSwapProofStatus.Ready,
          proofPayload: proof,
          proofError: undefined,
        });
      }
    } catch (error) {
      const proofStatus = isLikelyRateLimit(error) ? StableSwapProofStatus.Pending : StableSwapProofStatus.Failed;
      const proofError = error instanceof Error ? error.message : 'Proof generation failed.';
      for (const row of blockRows) {
        await db.stableSwapPurchasesTable.updateProof(walletAddress, row.txHash, {
          proofStatus,
          proofError,
        });
      }
    }
  }
}

export async function findStableSwapAmountToTarget(args: {
  client: PublicClient;
  pool: StableSwapPoolMetadata;
  targetPriceFixed18: bigint;
  blockNumber?: bigint;
}): Promise<StableSwapQuoteResult | null> {
  const { client, pool, targetPriceFixed18, blockNumber } = args;
  const poolArgonBalance = await client.readContract({
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

  const quoteCache = new Map<string, StableSwapQuoteResult | null>();
  const quoteAmountOut = async (amountOut: bigint) => {
    const cacheKey = amountOut.toString();
    if (!quoteCache.has(cacheKey)) {
      quoteCache.set(
        cacheKey,
        await quoteStableSwapExactOutput({
          client,
          pool,
          amountOut,
          blockNumber,
        }),
      );
    }

    return quoteCache.get(cacheKey)!;
  };

  let bestQuote: StableSwapQuoteResult | null = null;
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

export async function quoteStableSwapExactOutput(args: {
  client: PublicClient;
  pool: StableSwapPoolMetadata;
  amountOut: bigint;
  blockNumber?: bigint;
  throwOnError?: boolean;
}): Promise<StableSwapQuoteResult | null> {
  const { client, pool, amountOut, blockNumber, throwOnError = false } = args;
  const argonToken = getStableSwapArgonToken();
  const usdcToken = getStableSwapUsdcToken();
  const route = new UniswapV3Route([createStableSwapSdkPool(pool)], usdcToken, argonToken);

  try {
    const quotedAmountOut = CurrencyAmount.fromRawAmount(argonToken, amountOut.toString());
    const { calldata } = SwapQuoter.quoteCallParameters(route, quotedAmountOut, TradeType.EXACT_OUTPUT, {
      useQuoterV2: true,
    });

    const quoteResult = await client.call({
      to: UNISWAP_V3_QUOTER_V2_ADDRESS,
      data: calldata as Hex,
      blockNumber,
    });
    if (!quoteResult.data) {
      return null;
    }

    const { amountIn, sqrtPriceX96After } = decodeStableSwapExactOutputQuote(quoteResult.data);
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

function calculateCurrentValueFixed18(ethereumArgonAmount: bigint, priceFixed18: bigint): bigint {
  return (ethereumArgonAmount * priceFixed18) / FIXED_18;
}

function calculateCurrentValueMicrogons(ethereumArgonAmount: bigint, priceMicrogons: bigint): bigint {
  return (ethereumArgonAmount * priceMicrogons) / 10n ** BigInt(ETHEREUM_ARGON_DECIMALS);
}

async function getArgonPriceSnapshotAtTimestamp(
  timestamp: Date,
  blockWatch: BlockWatch,
  microgonsPerUsd: bigint,
  cache?: Map<number, StableSwapArgonPriceSnapshot>,
): Promise<StableSwapArgonPriceSnapshot> {
  await blockWatch.start();

  const targetTime = timestamp.getTime();
  const bestBlockNumber = blockWatch.bestBlockHeader.blockNumber;
  let low = 0;
  let high = bestBlockNumber;
  let matchedBlockNumber = 0;

  while (low <= high) {
    const mid = Math.floor((low + high) / 2);
    const header = await blockWatch.getHeader(mid);
    if (header.blockTime <= targetTime) {
      matchedBlockNumber = mid;
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }

  if (cache?.has(matchedBlockNumber)) {
    return cache.get(matchedBlockNumber)!;
  }

  const header = await blockWatch.getHeader(matchedBlockNumber);
  const clientAt = await getMainchainClientAt(matchedBlockNumber, true);
  const priceIndex = new PriceIndex();
  await priceIndex.load(clientAt);

  const result = {
    argonBlockNumber: matchedBlockNumber,
    argonBlockHash: header.blockHash,
    argonOraclePriceMicrogons: priceIndex.argonUsdPrice
      ? fixed18ToMicrogons(decimalToFixed18(priceIndex.argonUsdPrice.toString()), microgonsPerUsd)
      : undefined,
    argonOracleTargetPriceMicrogons: priceIndex.argonUsdTargetPrice
      ? fixed18ToMicrogons(decimalToFixed18(priceIndex.argonUsdTargetPrice.toString()), microgonsPerUsd)
      : undefined,
  };

  cache?.set(matchedBlockNumber, result);
  return result;
}

async function getEthereumBlockDetails(
  client: PublicClient,
  blockHash: Hash,
  cache?: Map<string, { blockHash: string; blockNumber: bigint; timestamp: bigint; receiptsRoot: string }>,
): Promise<{ blockHash: string; blockNumber: bigint; timestamp: bigint; receiptsRoot: string }> {
  const normalizedHash = blockHash.toLowerCase();
  if (cache?.has(normalizedHash)) {
    return cache.get(normalizedHash)!;
  }

  const block = await client.getBlock({
    blockHash,
  });

  const details = {
    blockHash,
    blockNumber: block.number,
    timestamp: block.timestamp,
    receiptsRoot: block.receiptsRoot,
  };

  cache?.set(normalizedHash, details);
  return details;
}

function decimalToFixed18(value: string): bigint {
  return parseUnits(value, 18);
}

function fixed18ToMicrogons(valueFixed18: bigint, microgonsPerUsd: bigint): bigint {
  return (valueFixed18 * microgonsPerUsd) / FIXED_18;
}

function usdcToFixed18(usdc: bigint): bigint {
  return usdc * USDC_TO_FIXED_18_FACTOR;
}

function usdcToMicrogons(usdc: bigint, microgonsPerUsd: bigint): bigint {
  return (usdc * microgonsPerUsd) / 1_000_000n;
}

function decodeStableSwapExactOutputQuote(data: Hex): {
  amountIn: bigint;
  sqrtPriceX96After: bigint;
} {
  const decoded = SwapQuoter.V2INTERFACE.decodeFunctionResult(
    'quoteExactOutputSingle',
    data,
  ) as unknown as readonly [{ toString(): string }, { toString(): string }];

  return {
    amountIn: BigInt(decoded[0].toString()),
    sqrtPriceX96After: BigInt(decoded[1].toString()),
  };
}

function createStableSwapSdkPool(pool: StableSwapPoolMetadata, state?: StableSwapSdkPoolState): UniswapV3Pool {
  const argonToken = getStableSwapArgonToken();
  const usdcToken = getStableSwapUsdcToken();
  const poolState = state ?? {
    sqrtPriceX96: pool.currentSqrtPriceX96,
    liquidity: pool.poolLiquidity,
    tickCurrent: pool.currentTick,
  };

  return new UniswapV3Pool(
    argonToken,
    usdcToken,
    pool.poolFee as FeeAmount,
    poolState.sqrtPriceX96.toString(),
    poolState.liquidity.toString(),
    poolState.tickCurrent,
  );
}

function stableSwapSdkPriceToFixed18(price: ReturnType<UniswapV3Pool['priceOf']>): bigint {
  const numerator = BigInt(price.numerator.toString());
  const denominator = BigInt(price.denominator.toString());
  const baseScalar = 10n ** BigInt(price.baseCurrency.decimals);
  const quoteScalar = 10n ** BigInt(price.quoteCurrency.decimals);

  if (numerator <= 0n || denominator <= 0n) {
    return 0n;
  }

  return (numerator * baseScalar * FIXED_18) / (denominator * quoteScalar);
}

function getStableSwapArgonToken(): Token {
  return new Token(
    STABLE_SWAP_CHAIN_ID,
    getStableSwapEthereumSettings().argonTokenAddress,
    ETHEREUM_ARGON_DECIMALS,
    'ARGN',
    'Argon',
  );
}

function getStableSwapUsdcToken(): Token {
  return new Token(
    STABLE_SWAP_CHAIN_ID,
    getStableSwapEthereumSettings().usdcTokenAddress,
    USDC_DECIMALS,
    'USDC',
    'USD Coin',
  );
}

function getStableSwapEthereumSettings(): {
  rpcUrl: string;
  argonTokenAddress: Address;
  usdcTokenAddress: Address;
} {
  // NETWORK_NAME is imported so Env.ts initializes NetworkConfig before this helper is used.
  void NETWORK_NAME;

  const { ethereum } = NetworkConfig.get();
  return {
    rpcUrl: ethereum.rpcUrl,
    argonTokenAddress: getAddress(ethereum.argonTokenAddress),
    usdcTokenAddress: getAddress(ethereum.usdcTokenAddress),
  };
}

function isLikelyRateLimit(error: unknown): boolean {
  const message = error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase();
  return message.includes('429') || message.includes('rate') || message.includes('limit');
}
