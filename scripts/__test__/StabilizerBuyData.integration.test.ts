import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Interface } from 'ethers';
import BigNumber from 'bignumber.js';
import { TypeRegistry } from '@polkadot/types';
import { getClient } from '@argonprotocol/mainchain';
import { createPublicClient, toHex } from 'viem';
import { uniswapV4FixtureArtifacts } from '@argonprotocol/testing';
import v2Factory from '@uniswap/v2-core/build/UniswapV2Factory.json' with { type: 'json' };
import v2Pair from '@uniswap/v2-core/build/UniswapV2Pair.json' with { type: 'json' };
import v3Factory from '@uniswap/v3-core/artifacts/contracts/UniswapV3Factory.sol/UniswapV3Factory.json' with { type: 'json' };
import v3Pool from '@uniswap/v3-core/artifacts/contracts/UniswapV3Pool.sol/UniswapV3Pool.json' with { type: 'json' };
import { fetchStabilizerBuys } from '../../data-generators/fetchStabilizerBuys.ts';
import type IStabilizerBuyData from '../../core/src/interfaces/IStabilizerBuyData.ts';

vi.mock('@argonprotocol/mainchain', async importOriginal => ({
  ...(await importOriginal<typeof import('@argonprotocol/mainchain')>()),
  getClient: vi.fn(),
}));
vi.mock('viem', async importOriginal => ({
  ...(await importOriginal<typeof import('viem')>()),
  createPublicClient: vi.fn(),
}));

const registry = new TypeRegistry();
const argon = `0x${'f'.repeat(40)}`;
const usdc = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48';
const v2Address = `0x${'1'.repeat(40)}`;
const v3Address = `0x${'2'.repeat(40)}`;
const v4Id = `0x${'3'.repeat(64)}`;
const v4LaterId = `0x${'4'.repeat(64)}`;
const poolManager = '0x000000000004444c5dc75cB358380D2e3dE08A90';
const account = `0x${'5'.repeat(40)}`;
const zero = `0x${'0'.repeat(40)}`;
const genesis = Date.parse('2025-01-15T17:20:00Z') / 1000;
const pair = new Interface(v2Pair.abi);
const factoryV2 = new Interface(v2Factory.abi);
const factory = new Interface(v3Factory.abi);
const v3 = new Interface(v3Pool.abi);
const v4 = new Interface(JSON.stringify(uniswapV4FixtureArtifacts.poolManager.abi));

// Encode the external protocol events; production discovers, decodes, prices and persists them.
function eventLog(
  abi: Interface,
  event: string,
  values: unknown[],
  address: string,
  block: number,
  index: number,
  argonBlock = block,
) {
  const encoded = abi.encodeEventLog(abi.getEvent(event)!, values);
  return {
    ...encoded,
    topics: encoded.topics,
    address,
    blockNumber: toHex(block),
    logIndex: toHex(index),
    timeStamp: toHex(genesis + argonBlock * 60 + 30),
  };
}

describe('Below-target Uniswap history', { tags: ['no-argon-network'] }, () => {
  let directory: string;
  let indexerFails: boolean;
  let indexerIsBehind: boolean;
  let externalPricesFail: boolean;
  let invalidExternalPrice: boolean;
  let nativeUsdcUnavailable: boolean;
  let archiveFails: boolean;
  let fundingUnavailable: boolean;
  let logs: ReturnType<typeof eventLog>[];

  beforeEach(async () => {
    directory = await mkdtemp(path.join(tmpdir(), 'stabilizer-buy-data-'));
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2025-01-16T12:00:00Z'));
    indexerFails = false;
    indexerIsBehind = false;
    externalPricesFail = false;
    invalidExternalPrice = false;
    nativeUsdcUnavailable = false;
    archiveFails = false;
    fundingUnavailable = false;
    logs = [
      eventLog(
        factoryV2,
        'PairCreated',
        [usdc, argon, v2Address, 1],
        '0x5C69bEe701ef814a2B6a3EDD4B1652CB9cc5aA6f',
        1,
        1,
      ),
      eventLog(
        factory,
        'PoolCreated',
        [usdc, argon, 3000, 60, v3Address],
        '0x1F98431c8aD98523631AE4a59f267346ea31F984',
        1,
        0,
      ),
      eventLog(v4, 'Initialize', [v4Id, usdc, argon, 3000, 60, zero, 1n << 96n, 0], poolManager, 2, 0),
    ];

    vi.mocked(getClient).mockResolvedValue({
      query: {
        timestamp: {
          now: { at: async (hash: string) => registry.createType('u64', (genesis + Number(BigInt(hash)) * 60) * 1000) },
        },
      },
      rpc: {
        chain: {
          getFinalizedHead: async () => registry.createType('Hash', toHex(5000, { size: 32 })),
          getHeader: async () => ({ number: registry.createType('u32', 5000) }),
          getBlockHash: async (number: number) => {
            if (archiveFails) throw new Error('Archive unavailable');
            return registry.createType('Hash', toHex(number, { size: 32 }));
          },
        },
      },
      at: async (hash: string) => {
        const block = Number(BigInt(hash));
        return {
          consts: { treasury: { percentForVaultPool: BigNumber(0.4) } },
          query: {
            miningSlot: { frameStartBlockNumbers: async () => [2, 3] },
            system: {
              events: async () => {
                if (fundingUnavailable) return [];

                return [
                  {
                    event: {
                      section: 'treasury',
                      method: 'FrameEarningsDistributed',
                      data: {
                        frameId: block - 1,
                        bidPoolDistributed: block === 2 ? 50_000_000n : 100_000_000n,
                        vaultPoolDistributed: block === 2 ? 25_000_000n : 50_000_000n,
                        burned: block === 2 ? 40_000_000n : 80_000_000n,
                        treasuryReserves: block === 2 ? 10_000_000n : 20_000_000n,
                      },
                    },
                  },
                ];
              },
            },
            crosschainTransfer: {
              chainConfigBySourceChain: async () => ({ type: 'Evm', value: { argonToken: argon, chainId: 1n } }),
            },
            priceIndex: {
              current: async () => ({
                tick: Math.floor((genesis + block * 60) / 60),
                argonUsdTargetPrice: new BigNumber(block >= 20 ? '1.2' : '1'),
                usdcUsdPrice: block <= 11 || nativeUsdcUnavailable ? undefined : new BigNumber(1),
              }),
            },
          },
        };
      },
      disconnect: async () => {},
    } as unknown as Awaited<ReturnType<typeof getClient>>);

    vi.mocked(createPublicClient).mockReturnValue({
      getChainId: async () => 1,
      getBlock: async ({ blockNumber }: { blockNumber?: bigint }) => {
        const number = Number(blockNumber ?? 1000);
        const day = Math.floor(number / 100);
        let timestamp = genesis + number * 60;
        if (day > 0) timestamp = Date.UTC(2025, 0, 14 + day, 23, 59, 59) / 1000 + (number % 100) * 60;
        return { number: BigInt(number), timestamp: BigInt(Math.ceil(timestamp)) };
      },
    } as unknown as ReturnType<typeof createPublicClient>);

    vi.stubGlobal('fetch', async (url: string) => {
      const parsed = new URL(url);
      const params = parsed.searchParams;
      if (parsed.pathname.endsWith('/blocks')) {
        return Response.json({ items: [{ number: indexerIsBehind ? 1 : 1000 }] });
      }
      if (parsed.hostname === 'coins.llama.fi') {
        if (externalPricesFail) throw new Error('External price service unavailable');
        const start = Number(params.get('start'));
        const prices = Array.from({ length: Number(params.get('span')) }, (_, index) => ({
          timestamp: start + index * 3600,
          price: 0.9,
        }));
        if (invalidExternalPrice) prices[0].price = NaN;
        return Response.json({ coins: { [`ethereum:${usdc}`]: { prices } } });
      }
      if (parsed.hostname !== 'api.routescan.io') throw new Error(`Unexpected data source: ${url}`);
      if (indexerFails) return Response.json({ status: '0', message: 'Rate limit exceeded', result: 'Retry later' });
      const result = logs
        .filter(log => {
          if (log.address.toLowerCase() !== params.get('address')?.toLowerCase()) return false;
          if (
            Number(log.blockNumber) < Number(params.get('fromBlock')) ||
            Number(log.blockNumber) > Number(params.get('toBlock'))
          )
            return false;
          return log.topics.every(
            (topic, index) =>
              !params.has(`topic${index}`) || topic.toLowerCase() === params.get(`topic${index}`)?.toLowerCase(),
          );
        })
        .sort((a, b) => Number(a.blockNumber) - Number(b.blockNumber) || Number(a.logIndex) - Number(b.logIndex))
        .slice(0, Number(params.get('offset') ?? 100));
      return Response.json({ status: '1', message: 'OK', result });
    });
  });

  afterEach(async () => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    await rm(directory, { recursive: true, force: true });
  });

  it('prices actual v2/v3/v4 buys, preserves a failed update, and appends new days and pools', async () => {
    logs.push(
      eventLog(pair, 'Swap', [account, 100_000_000n, 0n, 0n, 200n * 10n ** 18n, account], v2Address, 10, 0),
      eventLog(v3, 'Swap', [account, account, 110_000_000n, -100n * 10n ** 18n, 1n << 120n, 1n, 0], v3Address, 11, 0),
      eventLog(v3, 'Swap', [account, account, 100_000_000n, -100n * 10n ** 18n, 1n, 1n, 0], v3Address, 15, 0),
      eventLog(v3, 'Swap', [account, account, -100_000_000n, 100n * 10n ** 18n, 1n, 1n, 0], v3Address, 16, 0),
      eventLog(v3, 'Swap', [account, account, 180_000_000n, -100n * 10n ** 18n, 1n, 1n, 0], v3Address, 19, 0),
      eventLog(v4, 'Swap', [v4Id, account, -90_000_000n, 100n * 10n ** 18n, 1n, 1n, 0, 3000], poolManager, 30, 0, 30),
      eventLog(v4, 'Swap', [v4Id, account, 90_000_000n, -100n * 10n ** 18n, 1n, 1n, 0, 3000], poolManager, 31, 0),
    );
    const file = path.join(directory, 'buys.json');
    await fetchStabilizerBuys(file);
    const firstBytes = await readFile(file, 'utf8');
    const first = JSON.parse(firstBytes) as IStabilizerBuyData;
    expect(first.throughDate).toBe('2025-01-15');
    // Cost is valued per trade: 100*0.9/1 + 110*0.9/1 + 90*1/1.2 = 264 ARGN.
    expect(first.days).toEqual([
      {
        date: '2025-01-15',
        buyCount: 3,
        argonBought: '400',
        usdcSpent: '300',
        costInTargetArgons: '264',
        ethereumPurchaseBlockRange: [10, 30],
        argonPriceBlockRange: [10, 30],
      },
    ]);
    // New funding is the unused vault allocation (15 and 30), not all 40 and 80 burned.
    expect(first.rewardFunding).toEqual({
      frameRange: [1, 2],
      argonBlockRange: [2, 3],
      frameCount: 2,
      averageArgonsPerFrame: '22.5',
    });
    expect(first).not.toHaveProperty('buys');
    expect(firstBytes).not.toContain(account);
    await fetchStabilizerBuys(file);
    expect(await readFile(file, 'utf8')).toBe(firstBytes);

    vi.setSystemTime(new Date('2025-01-17T12:00:00Z'));
    fundingUnavailable = true;
    await expect(fetchStabilizerBuys(file)).rejects.toThrow('No completed Treasury frames');
    expect(await readFile(file, 'utf8')).toBe(firstBytes);
    fundingUnavailable = false;
    indexerIsBehind = true;
    await expect(fetchStabilizerBuys(file)).rejects.toThrow('swap indexer has not reached');
    expect(await readFile(file, 'utf8')).toBe(firstBytes);
    indexerIsBehind = false;
    logs.push(
      eventLog(v3, 'Swap', [account, account, 80_000_000n, -100n * 10n ** 18n, 1n, 1n, 0], v3Address, 110, 0, 500),
      eventLog(v4, 'Initialize', [v4LaterId, usdc, argon, 3000, 60, zero, 1n << 96n, 0], poolManager, 120, 0, 500),
      eventLog(
        v4,
        'Swap',
        [v4LaterId, account, -70_000_000n, 100n * 10n ** 18n, 1n, 1n, 0, 3000],
        poolManager,
        150,
        0,
        500,
      ),
    );
    archiveFails = true;
    await expect(fetchStabilizerBuys(file)).rejects.toThrow('Archive unavailable');
    expect(await readFile(file, 'utf8')).toBe(firstBytes);
    expect(await readdir(directory)).toEqual(['buys.json']);

    archiveFails = false;
    nativeUsdcUnavailable = true;
    invalidExternalPrice = true;
    await expect(fetchStabilizerBuys(file)).rejects.toThrow('invalid price observation');
    expect(await readFile(file, 'utf8')).toBe(firstBytes);

    nativeUsdcUnavailable = false;
    externalPricesFail = true;
    await fetchStabilizerBuys(file);
    const updated = JSON.parse(await readFile(file, 'utf8')) as IStabilizerBuyData;
    expect(updated.throughDate).toBe('2025-01-16');
    expect(updated.ethereumBlockNumber).toBe(200);
    expect(updated.days[0]).toEqual(first.days[0]);
    expect(updated.days[1]).toEqual({
      date: '2025-01-16',
      buyCount: 2,
      argonBought: '200',
      usdcSpent: '150',
      costInTargetArgons: '125',
      ethereumPurchaseBlockRange: [110, 150],
      argonPriceBlockRange: [500, 500],
    });

    vi.setSystemTime(new Date('2025-01-18T12:00:00Z'));
    await fetchStabilizerBuys(file);
    const withEmptyDay = JSON.parse(await readFile(file, 'utf8')) as IStabilizerBuyData;
    expect(withEmptyDay.days.slice(0, 2)).toEqual(updated.days);
    expect(withEmptyDay.days[2]).toEqual({
      date: '2025-01-17',
      buyCount: 0,
      argonBought: '0',
      usdcSpent: '0',
      costInTargetArgons: '0',
    });
  });

  it('overlaps capped indexed pages and preserves the snapshot on a source failure or unpageable block', async () => {
    for (let index = 0; index < 999; index++) {
      logs.push(eventLog(v3, 'Swap', [account, account, -1_000_000n, 10n ** 18n, 1n, 1n, 0], v3Address, 40, index));
    }
    logs.push(
      eventLog(v3, 'Swap', [account, account, 80_000_000n, -100n * 10n ** 18n, 1n, 1n, 0], v3Address, 50, 0),
      eventLog(v3, 'Swap', [account, account, 85_000_000n, -100n * 10n ** 18n, 1n, 1n, 0], v3Address, 50, 1),
      eventLog(v3, 'Swap', [account, account, 90_000_000n, -100n * 10n ** 18n, 1n, 1n, 0], v3Address, 51, 0),
    );
    const file = path.join(directory, 'buys.json');
    await fetchStabilizerBuys(file);
    const firstBytes = await readFile(file, 'utf8');
    const first = JSON.parse(firstBytes) as IStabilizerBuyData;
    expect(first.days).toEqual([
      {
        date: '2025-01-15',
        buyCount: 3,
        argonBought: '300',
        usdcSpent: '255',
        costInTargetArgons: '212.5',
        ethereumPurchaseBlockRange: [50, 51],
        argonPriceBlockRange: [50, 51],
      },
    ]);

    vi.setSystemTime(new Date('2025-01-17T12:00:00Z'));
    indexerFails = true;
    await expect(fetchStabilizerBuys(file)).rejects.toThrow('Indexed log query failed');
    expect(await readFile(file, 'utf8')).toBe(firstBytes);

    indexerFails = false;
    for (let index = 0; index < 1000; index++) {
      logs.push(
        eventLog(
          v3,
          'Swap',
          [account, account, 80_000_000n, -100n * 10n ** 18n, 1n, 1n, 0],
          v3Address,
          150,
          index,
          500,
        ),
      );
    }
    await expect(fetchStabilizerBuys(file)).rejects.toThrow('single block reaches the indexer log limit');
    expect(await readFile(file, 'utf8')).toBe(firstBytes);
  });
});
