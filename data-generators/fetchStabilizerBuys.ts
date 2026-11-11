import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { Interface } from 'ethers';
import { format, resolveConfig } from 'prettier';
import BigNumber from 'bignumber.js';
import { getClient } from '@argonprotocol/mainchain';
import { runtimeClient, toRuntimeEvent } from '@argonprotocol/runtime-client';
import { NetworkConfigSettings } from '@argonprotocol/apps-core';
import { uniswapV4FixtureArtifacts } from '@argonprotocol/testing';
import { createPublicClient, fallback, http, formatUnits, type Hex, type RpcLog } from 'viem';
import v2Factory from '@uniswap/v2-core/build/UniswapV2Factory.json' with { type: 'json' };
import v2Pair from '@uniswap/v2-core/build/UniswapV2Pair.json' with { type: 'json' };
import v3Factory from '@uniswap/v3-core/artifacts/contracts/UniswapV3Factory.sol/UniswapV3Factory.json' with { type: 'json' };
import v3Pool from '@uniswap/v3-core/artifacts/contracts/UniswapV3Pool.sol/UniswapV3Pool.json' with { type: 'json' };
import type IStabilizerBuyData from '../core/src/interfaces/IStabilizerBuyData.ts';

const logsApi = 'https://api.routescan.io/v2/network/mainnet/evm/1/etherscan/api';
const v2FactoryAddress = '0x5C69bEe701ef814a2B6a3EDD4B1652CB9cc5aA6f';
const v3FactoryAddress = '0x1F98431c8aD98523631AE4a59f267346ea31F984';
const poolManagerAddress = '0x000000000004444c5dc75cB358380D2e3dE08A90';
const v2 = new Interface(v2Pair.abi);
const v3 = new Interface(v3Pool.abi);
const v4 = new Interface(JSON.stringify(uniswapV4FixtureArtifacts.poolManager.abi));

type IndexedLog = RpcLog & { timeStamp: Hex };

/** Complete UTC days only. A failed fetch leaves both the previous rows and their checkpoint intact. */
export async function fetchStabilizerBuys(
  filePath = path.join(process.cwd(), 'core/src/data/stabilizerBuys.mainnet.json'),
) {
  const midnight = new Date();
  midnight.setUTCHours(0, 0, 0, 0);
  const throughTimestamp = midnight.getTime() / 1000 - 1;
  const throughDate = new Date(throughTimestamp * 1000).toISOString().slice(0, 10);
  let previous: IStabilizerBuyData | undefined;
  try {
    previous = JSON.parse(await fs.readFile(filePath, 'utf8')) as IStabilizerBuyData;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  if (previous?.rewardFunding && previous.throughDate >= throughDate) {
    console.log(`Stabilizer buy history is current through ${previous.throughDate}.`);
    return;
  }

  const settings = NetworkConfigSettings.mainnet;
  const rpcUrls = process.env.ETHEREUM_EXECUTION_RPC_URL
    ? [process.env.ETHEREUM_EXECUTION_RPC_URL]
    : settings.ethereumNetwork.executionRpcUrls;
  const ethereum = createPublicClient({
    transport: fallback(rpcUrls.map(url => http(url, { timeout: 20_000 }))),
  });
  const raw = await getClient(settings.archiveUrl);
  const client = runtimeClient(raw);
  const blocks = new Map<number, Promise<{ hash: Hex; timestamp: number }>>();
  const ethereumBlocks = new Map<number, ReturnType<typeof ethereum.getBlock>>();
  try {
    const finalizedHash = await raw.rpc.chain.getFinalizedHead();
    const finalizedNumber = (await raw.rpc.chain.getHeader(finalizedHash)).number.toNumber();
    const finalized = await client.at(finalizedHash);
    const config = await finalized.query.crosschainTransfer.chainConfigBySourceChain('Ethereum');
    if (config?.type !== 'Evm') throw new Error('Mainnet has no Ethereum token configuration.');
    const argonTokenAddress = config.value.argonToken.toLowerCase();
    const usdcTokenAddress = settings.ethereumNetwork.usdcTokenAddress.toLowerCase();
    if (
      previous &&
      (previous.argonTokenAddress !== argonTokenAddress || previous.usdcTokenAddress !== usdcTokenAddress)
    )
      throw new Error('The token pair changed. Rebuild the history in a new file.');

    const [chainId, ethereumFinalized, argonFinalized] = await Promise.all([
      ethereum.getChainId(),
      ethereum.getBlock({ blockTag: 'finalized' }),
      readBlock(finalizedNumber),
    ]);
    if (BigInt(chainId) !== config.value.chainId) throw new Error('The Ethereum RPC is on another network.');
    if (ethereumFinalized.timestamp < throughTimestamp || argonFinalized.timestamp < throughTimestamp)
      throw new Error('The completed UTC day is not finalized on both chains yet.');

    // Finalized block timestamps define the completed UTC-day boundary.
    let low = previous?.ethereumBlockNumber ?? 0;
    let high = Number(ethereumFinalized.number);
    let ethereumBlockNumber = low;
    while (low <= high) {
      const middle = Math.floor((low + high) / 2);
      const block = await readEthereumBlock(middle);
      if (block.timestamp <= throughTimestamp) {
        ethereumBlockNumber = middle;
        low = middle + 1;
      } else high = middle - 1;
    }

    const indexed = await readJson<{ items: { number: number }[] }>(
      'https://api.routescan.io/v2/network/mainnet/evm/1/blocks?limit=1',
    );
    if (!(indexed.items[0]?.number >= ethereumBlockNumber))
      throw new Error('The swap indexer has not reached the completed UTC day. Retry after it catches up.');

    const argonIsToken0 = BigInt(argonTokenAddress) < BigInt(usdcTokenAddress);
    const token0 = argonIsToken0 ? argonTokenAddress : usdcTokenAddress;
    const token1 = argonIsToken0 ? usdcTokenAddress : argonTokenAddress;
    const pools = [...(previous?.pools ?? [])];
    const discoveryFromBlock = previous ? previous.ethereumBlockNumber + 1 : 0;
    const factories = [
      {
        version: 2,
        address: v2FactoryAddress,
        abi: new Interface(v2Factory.abi),
        event: 'PairCreated',
        filter: [token0, token1],
      },
      {
        version: 3,
        address: v3FactoryAddress,
        abi: new Interface(v3Factory.abi),
        event: 'PoolCreated',
        filter: [token0, token1],
      },
      { version: 4, address: poolManagerAddress, abi: v4, event: 'Initialize', filter: [null, token0, token1] },
    ] as const;
    for (const factory of factories) {
      const logs = await readLogs(
        factory.address,
        factory.abi.encodeFilterTopics(factory.event, [...factory.filter]),
        discoveryFromBlock,
        ethereumBlockNumber,
      );
      for (const log of logs) {
        const args = factory.abi.parseLog(log)!.args;
        let id: string;
        if (factory.version === 2) id = args.pair;
        else if (factory.version === 3) id = args.pool;
        else id = args.id;
        pools.push({
          version: factory.version,
          id: id.toLowerCase(),
          createdAt: Number(log.timeStamp),
          createdAtBlock: Number(log.blockNumber),
          argonIsToken0,
        });
      }
    }
    if (!pools.length) throw new Error('No ARGN/USDC Uniswap pools were found.');

    const candidates: {
      log: IndexedLog;
      timestamp: number;
      argon: BigNumber;
      usdc: BigNumber;
    }[] = [];
    for (const pool of pools) {
      let abi = v4;
      if (pool.version === 2) abi = v2;
      else if (pool.version === 3) abi = v3;
      const address = pool.version === 4 ? poolManagerAddress : pool.id;
      const topics = abi.encodeFilterTopics('Swap', pool.version === 4 ? [pool.id] : []);
      const fromBlock = Math.max(pool.createdAtBlock, (previous?.ethereumBlockNumber ?? -1) + 1);
      const logs = await readLogs(address, topics, fromBlock, ethereumBlockNumber);
      for (const log of logs) {
        const args = abi.parseLog(log)!.args;
        let delta0: bigint;
        let delta1: bigint;
        if (pool.version === 2) {
          delta0 = BigInt(args.amount0In) - BigInt(args.amount0Out);
          delta1 = BigInt(args.amount1In) - BigInt(args.amount1Out);
        } else {
          delta0 = args.amount0;
          delta1 = args.amount1;
          // v4 reports the caller's delta; v2/v3 report the pool's delta.
          if (pool.version === 4) {
            delta0 = -delta0;
            delta1 = -delta1;
          }
        }
        const argonDelta = pool.argonIsToken0 ? delta0 : delta1;
        const usdcDelta = pool.argonIsToken0 ? delta1 : delta0;
        if (argonDelta >= 0n || usdcDelta <= 0n) continue;
        candidates.push({
          log,
          timestamp: Number(log.timeStamp),
          argon: BigNumber(formatUnits(-argonDelta, 18)),
          usdc: BigNumber(formatUnits(usdcDelta, 6)),
        });
      }
      console.log(`Read ${logs.length} swaps from Uniswap v${pool.version} pool ${pool.id}.`);
    }

    // Include every covered day so days without opportunities remain part of the history.
    const daysByDate = new Map<string, IStabilizerBuyData['days'][number]>();
    let firstDayTimestamp = Math.min(...pools.map(pool => pool.createdAt));
    if (previous) firstDayTimestamp = Date.parse(previous.throughDate) / 1000 + 86400;
    firstDayTimestamp = Math.floor(firstDayTimestamp / 86400) * 86400;
    for (let timestamp = firstDayTimestamp; timestamp <= throughTimestamp; timestamp += 86400) {
      const date = new Date(timestamp * 1000).toISOString().slice(0, 10);
      daysByDate.set(date, {
        date,
        buyCount: 0,
        argonBought: '0',
        usdcSpent: '0',
        costInTargetArgons: '0',
      });
    }

    let usdcHistoryPromise: ReturnType<typeof readUsdcPrices> | undefined;
    for (let start = 0; start < candidates.length; start += 8) {
      const rows = await Promise.all(
        candidates.slice(start, start + 8).map(async ({ log, timestamp, argon, usdc }) => {
          const reference = await readPrices(timestamp, finalizedNumber);
          let usdcUsdPrice = reference.prices.usdcUsdPrice;
          if (!usdcUsdPrice?.gt(0)) {
            let observed: [number, number] | undefined;
            const usdcHistory = await (usdcHistoryPromise ??= readUsdcPrices(
              candidates.map(candidate => candidate.timestamp),
              usdcTokenAddress,
            ));
            for (const point of usdcHistory) {
              if (point[0] > timestamp) break;
              observed = point;
            }
            if (!observed || timestamp - observed[0] > 7200 || observed[1] <= 0)
              throw new Error(`No prior hourly USDC price covers ${new Date(timestamp * 1000).toISOString()}.`);
            usdcUsdPrice = BigNumber(observed[1]);
          }
          const argonTargetPrice = reference.prices.argonUsdTargetPrice;
          if (usdc.times(usdcUsdPrice).gte(argon.times(argonTargetPrice))) return;

          return {
            date: new Date(timestamp * 1000).toISOString().slice(0, 10),
            argon,
            usdc,
            costInTargetArgons: usdc.times(usdcUsdPrice).div(argonTargetPrice),
            ethereumBlockNumber: Number(log.blockNumber),
            argonPriceBlockNumber: reference.blockNumber,
          };
        }),
      );
      for (const row of rows) {
        if (!row) continue;

        const day = daysByDate.get(row.date);
        if (!day) throw new Error('The swap timestamp falls outside the days being updated.');

        day.buyCount += 1;
        day.argonBought = BigNumber(day.argonBought).plus(row.argon).toFixed();
        day.usdcSpent = BigNumber(day.usdcSpent).plus(row.usdc).toFixed();
        day.costInTargetArgons = BigNumber(day.costInTargetArgons).plus(row.costInTargetArgons).toFixed();
        day.ethereumPurchaseBlockRange = [
          Math.min(day.ethereumPurchaseBlockRange?.[0] ?? row.ethereumBlockNumber, row.ethereumBlockNumber),
          Math.max(day.ethereumPurchaseBlockRange?.[1] ?? row.ethereumBlockNumber, row.ethereumBlockNumber),
        ];
        day.argonPriceBlockRange = [
          Math.min(day.argonPriceBlockRange?.[0] ?? row.argonPriceBlockNumber, row.argonPriceBlockNumber),
          Math.max(day.argonPriceBlockRange?.[1] ?? row.argonPriceBlockNumber, row.argonPriceBlockNumber),
        ];
      }
      console.log(`Matched historical prices for ${Math.min(start + 8, candidates.length)}/${candidates.length} buys.`);
    }

    // Sample completed frames, not changes in the reserve balance: returned budgets are not new funding.
    const funding: { frame: number; block: number; amount: BigNumber }[] = [];
    const frameBlocks = await finalized.query.miningSlot.frameStartBlockNumbers();
    for (const blockNumber of [...(frameBlocks ?? [])].sort((a, b) => b - a)) {
      const block = await readBlock(blockNumber);
      if (block.timestamp > throughTimestamp) continue;

      const api = await raw.at(block.hash);
      const snapshot = runtimeClient(api);
      for (const { event: rawEvent } of await api.query.system.events()) {
        const event = toRuntimeEvent(rawEvent);
        if (event?.section !== 'treasury' || event.method !== 'FrameEarningsDistributed') continue;

        const { frameId, bidPoolDistributed, vaultPoolDistributed, burned, treasuryReserves } = event.data;
        if (burned === undefined || vaultPoolDistributed === undefined || treasuryReserves === undefined) continue;

        const fullPool = BigNumber(bidPoolDistributed).plus(burned).plus(treasuryReserves);
        const vaultAllocation = fullPool
          .times(snapshot.consts.treasury.percentForVaultPool)
          .integerValue(BigNumber.ROUND_FLOOR);
        const unusedVaultAllocation = BigNumber.maximum(0, vaultAllocation.minus(vaultPoolDistributed));

        funding.push({ frame: frameId, block: blockNumber, amount: BigNumber.minimum(unusedVaultAllocation, burned) });
      }
      if (funding.length >= 30) break;
    }
    if (!funding.length) throw new Error('No completed Treasury frames expose the inputs for modeled reward funding.');

    const snapshot: IStabilizerBuyData = {
      throughDate,
      ethereumBlockNumber,
      argonTokenAddress,
      usdcTokenAddress,
      pools,
      rewardFunding: {
        frameRange: [Math.min(...funding.map(row => row.frame)), Math.max(...funding.map(row => row.frame))],
        argonBlockRange: [Math.min(...funding.map(row => row.block)), Math.max(...funding.map(row => row.block))],
        frameCount: funding.length,
        averageArgonsPerFrame: funding
          .reduce((sum, row) => sum.plus(row.amount), BigNumber(0))
          .div(funding.length)
          .div(1e6)
          .toFixed(),
      },
      days: [...(previous?.days ?? []), ...daysByDate.values()],
    };
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    const temporary = `${filePath}.${process.pid}.tmp`;
    try {
      const prettierConfig = await resolveConfig(filePath);
      const json = await format(JSON.stringify(snapshot), { ...prettierConfig, parser: 'json' });
      await fs.writeFile(temporary, json);
      await fs.rename(temporary, filePath);
    } finally {
      await fs.rm(temporary, { force: true });
    }
    console.log(`Saved ${snapshot.days.length} daily buy summaries through ${throughDate} to ${filePath}.`);
  } finally {
    await raw.disconnect();
  }

  function readEthereumBlock(blockNumber: number) {
    let block = ethereumBlocks.get(blockNumber);
    if (!block) {
      block = ethereum.getBlock({ blockNumber: BigInt(blockNumber) });
      ethereumBlocks.set(blockNumber, block);
    }
    return block;
  }

  async function readLogs(
    address: string,
    topics: ReturnType<Interface['encodeFilterTopics']>,
    fromBlock: number,
    toBlock: number,
  ) {
    const params = new URLSearchParams({
      module: 'logs',
      action: 'getLogs',
      address,
      toBlock: String(toBlock),
      page: '1',
      offset: '1000',
    });
    const indices: number[] = [];
    topics.forEach((topic, index) => {
      if (topic) {
        params.set(`topic${index}`, String(topic));
        indices.push(index);
      }
    });
    for (let a = 0; a < indices.length; a++) {
      for (let b = a + 1; b < indices.length; b++) params.set(`topic${indices[a]}_${indices[b]}_opr`, 'and');
    }
    const logs = new Map<string, IndexedLog>();
    let cursor = fromBlock;
    while (cursor <= toBlock) {
      params.set('fromBlock', String(cursor));
      const response = await readJson<{ status: string; message: string; result: IndexedLog[] | string }>(
        `${logsApi}?${params}`,
      );
      if (response.status === '0' && ['No records found', 'No logs found'].includes(response.message)) break;
      if (response.status !== '1' || !Array.isArray(response.result))
        throw new Error(`Indexed log query failed: ${response.message}`);
      let lastBlock = cursor;
      for (const log of response.result) {
        if (
          !Number.isSafeInteger(Number(log.blockNumber)) ||
          !Number.isSafeInteger(Number(log.logIndex)) ||
          log.blockNumber === null ||
          log.logIndex === null ||
          Number(log.logIndex) < 0 ||
          Number(log.blockNumber) < cursor ||
          Number(log.blockNumber) > toBlock
        )
          throw new Error('The indexer returned a log outside the requested finalized range.');
        if (Number(log.blockNumber) < lastBlock)
          throw new Error('The indexer did not return logs in ascending block order; history was not updated.');
        if (
          log.address.toLowerCase() !== address.toLowerCase() ||
          indices.some(index => log.topics[index]?.toLowerCase() !== params.get(`topic${index}`)?.toLowerCase())
        )
          throw new Error('The indexer returned a log outside the requested pool/event filter.');
        if (
          !Number.isFinite(Number(log.timeStamp)) ||
          Number(log.timeStamp) <= 0 ||
          Number(log.timeStamp) > throughTimestamp
        )
          throw new Error('The indexer returned a log outside the completed UTC day.');
        lastBlock = Math.max(lastBlock, Number(log.blockNumber));
        logs.set(`${Number(log.blockNumber)}:${Number(log.logIndex)}`, log);
      }
      if (response.result.length < 1000) break;
      if (lastBlock === cursor)
        throw new Error('A single block reaches the indexer log limit; history was not updated.');
      cursor = lastBlock;
    }
    return [...logs.values()];
  }

  function readBlock(blockNumber: number) {
    let block = blocks.get(blockNumber);
    if (!block) {
      block = (async () => {
        const hash = await raw.rpc.chain.getBlockHash(blockNumber);
        const timestamp = await raw.query.timestamp.now.at(hash);
        return { hash: hash.toHex(), timestamp: timestamp.toNumber() / 1000 };
      })();
      blocks.set(blockNumber, block);
    }
    return block;
  }

  async function readUsdcPrices(timestamps: number[], usdcTokenAddress: string) {
    const usdcPrices = new Map<number, number>();
    if (timestamps.length) {
      const oldest = Math.min(...timestamps);
      for (let start = Math.floor(oldest / 3600) * 3600 - 3600; start <= throughTimestamp; start += 500 * 3600) {
        const params = new URLSearchParams({
          start: String(start),
          span: String(Math.min(500, Math.ceil((throughTimestamp - start) / 3600) + 1)),
          period: '1h',
          searchWidth: '1h',
        });
        const response = await readJson<{ coins: Record<string, { prices: { timestamp: number; price: number }[] }> }>(
          `https://coins.llama.fi/chart/ethereum:${usdcTokenAddress}?${params}`,
        );
        const prices = response.coins[`ethereum:${usdcTokenAddress}`]?.prices;
        if (!prices?.length) throw new Error('Historical USDC/USD prices are unavailable.');
        for (const price of prices) {
          if (
            !Number.isFinite(price.timestamp) ||
            price.timestamp <= 0 ||
            !Number.isFinite(price.price) ||
            price.price <= 0
          )
            throw new Error('Historical USDC/USD data contains an invalid price observation.');
          usdcPrices.set(price.timestamp, price.price);
        }
      }
    }
    return [...usdcPrices].sort(([a], [b]) => a - b);
  }

  async function readPrices(timestamp: number, finalizedNumber: number) {
    let low = 0;
    let high = finalizedNumber;
    let blockNumber = 0;
    while (low <= high) {
      const middle = Math.floor((low + high) / 2);
      const block = await readBlock(middle);
      if (block.timestamp <= timestamp) {
        blockNumber = middle;
        low = middle + 1;
      } else high = middle - 1;
    }
    const block = await readBlock(blockNumber);
    if (block.timestamp > timestamp) throw new Error('The swap predates Argon price history.');
    const historical = await client.at(block.hash);
    const prices = await historical.query.priceIndex.current();
    if (!prices?.argonUsdTargetPrice.gt(0))
      throw new Error(`No target price is available at Argon block ${blockNumber}.`);
    return { blockNumber, prices };
  }
}

async function readJson<Result>(url: string): Promise<Result> {
  for (let attempt = 0; ; attempt++) {
    const response = await fetch(url, { signal: AbortSignal.timeout(30_000) });
    if (response.ok) return response.json() as Promise<Result>;

    const retryable = response.status === 429 || response.status >= 500;
    if (!retryable || attempt === 3)
      throw new Error(`Data source returned HTTP ${response.status}: ${new URL(url).hostname}`);

    await response.body?.cancel();
    await new Promise(resolve => setTimeout(resolve, 1000 * 2 ** attempt));
  }
}
