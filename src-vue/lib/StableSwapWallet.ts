import { calculateProfitPct } from '@argonprotocol/apps-core';
import { BlockWatch } from '@argonprotocol/apps-core/src/BlockWatch.ts';
import { PriceIndex } from '@argonprotocol/mainchain';
import { decodeEventLog, isAddressEqual, type Address, type Hash, type PublicClient } from 'viem';
import { getMainchainClientAt } from '../stores/mainchain.ts';
import type {
  IStableSwapArgonPriceSnapshot,
  IStableSwapPoolMetadata,
  IStableSwapPurchaseBuildResult,
  IStableSwapWalletSnapshot,
} from '../interfaces/IStableSwap.ts';
import type { Db } from './Db.ts';
import { buildStableSwapReceiptProofs, type StableSwapReceiptProof } from './StableSwapProofs.ts';
import {
  type IStableSwapPurchaseRecord as IStableSwapPurchaseRow,
  StableSwapProofStatus,
} from './db/StableSwapPurchasesTable.ts';
import { type IStableSwapSyncStateRecord } from './db/StableSwapSyncStateTable.ts';
import {
  createStableSwapSdkPool,
  decimalToFixed18,
  ETHEREUM_ARGON_DECIMALS,
  FIXED_18,
  fixed18ToMicrogons,
  getStableSwapArgonToken,
  isLikelyRateLimit,
  STABLE_SWAP_TRANSFER_EVENT,
  stableSwapSdkPriceToFixed18,
  type StableSwapDecodedSwapLog,
  type StableSwapSdkPoolState,
  UNISWAP_V3_POOL_EVENTS_ABI,
  usdcToFixed18,
  usdcToMicrogons,
} from './StableSwapUtils.ts';
import { loadEthereumChainConfig } from './EthereumClient.ts';

export { buildStableSwapReceiptProofs, type StableSwapReceiptProof };

export async function buildStableSwapPurchaseFromTransaction(args: {
  client: PublicClient;
  walletAddress: string;
  pool: IStableSwapPoolMetadata;
  blockWatch: BlockWatch;
  microgonsPerUsd: bigint;
  transactionHash: Hash;
  blockCache?: Map<string, { blockHash: string; blockNumber: bigint; timestamp: bigint; receiptsRoot: string }>;
  argonPriceCache?: Map<number, Awaited<ReturnType<typeof getArgonPriceSnapshotAtTimestamp>>>;
}): Promise<IStableSwapPurchaseBuildResult | null> {
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
  const chainConfig = await loadEthereumChainConfig();
  const argonTokenAddress = chainConfig?.argonTokenAddress;
  if (!argonTokenAddress) {
    throw new Error('Ethereum gateway chain config is not available on this Argon network.');
  }
  const argonToken = getStableSwapArgonToken(argonTokenAddress, chainConfig.chainId);

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
    effectiveBuyPriceMicrogons: fixed18ToMicrogons(
      (costBasisFixed18 * FIXED_18) / ethereumArgonAmount,
      microgonsPerUsd,
    ),
    uniswapPriceMicrogons: fixed18ToMicrogons(
      stableSwapSdkPriceToFixed18(createStableSwapSdkPool(pool, argonToken, lastPoolState).priceOf(argonToken)),
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
): IStableSwapWalletSnapshot | null {
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

export async function loadStableSwapWalletSnapshot(args: {
  db: Db;
  walletAddress: string;
  currentPriceMicrogons: bigint;
  syncState?: IStableSwapSyncStateRecord;
  startedTracking?: boolean;
}): Promise<IStableSwapWalletSnapshot | null> {
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
  pool: IStableSwapPoolMetadata;
  blockWatch: BlockWatch;
  microgonsPerUsd: bigint;
  currentPriceMicrogons: bigint;
}): Promise<{ walletSnapshot: IStableSwapWalletSnapshot | null; message: string }> {
  const { db, client, walletAddress, pool, blockWatch, microgonsPerUsd, currentPriceMicrogons } = args;
  const argonTokenAddress = (await loadEthereumChainConfig())?.argonTokenAddress;
  if (!argonTokenAddress) {
    throw new Error('Ethereum gateway chain config is not available on this Argon network.');
  }

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
      address: argonTokenAddress,
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
    const argonPriceCache = new Map<number, IStableSwapArgonPriceSnapshot>();

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

function calculateCurrentValueMicrogons(ethereumArgonAmount: bigint, priceMicrogons: bigint): bigint {
  return (ethereumArgonAmount * priceMicrogons) / 10n ** BigInt(ETHEREUM_ARGON_DECIMALS);
}

async function getArgonPriceSnapshotAtTimestamp(
  timestamp: Date,
  blockWatch: BlockWatch,
  microgonsPerUsd: bigint,
  cache?: Map<number, IStableSwapArgonPriceSnapshot>,
): Promise<IStableSwapArgonPriceSnapshot> {
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
