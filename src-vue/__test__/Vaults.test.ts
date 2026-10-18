import {
  createTypedEventEmitter,
  BlockWatch,
  JsonExt,
  NetworkConfig,
  type ArgonApi,
  type ArgonClient,
  type ArgonCurrentQueryClient,
  type IAllVaultStats,
  type IBlockHeaderInfo,
  type RuntimeSystemEventRecord,
} from '@argonprotocol/apps-core';
import BigNumber from 'bignumber.js';
import { getOfflineRegistry, PriceIndex } from '@argonprotocol/mainchain';
import { getBundledMetadata, runtimeClient, toPlain } from '@argonprotocol/runtime-client';
import { Metadata, TypeRegistry } from '@polkadot/types';
import { decorateConstants } from '@polkadot/types/metadata/decorate';
import { createPinia, setActivePinia } from 'pinia';
import { computed, shallowReactive } from 'vue';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Vaults } from '../lib/Vaults.ts';
import { setMainchainClients } from '../stores/mainchain.ts';
import { useVaultingStats } from '../stores/vaultingStats.ts';
import { patchVaultHistory } from '../../scripts/patchVaultHistory.ts';
import { ProfitAnalysis } from '../lib/ProfitAnalysis.ts';
import { readVaultNetworkPool } from '../lib/recovery/MyVault.ts';
import type { MyVault } from '../lib/MyVault.ts';
import type { ArgonBonds } from '../lib/ArgonBonds.ts';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const cacheFiles = vi.hoisted(() => ({ directory: '', failNextWrite: false }));
vi.mock('@tauri-apps/plugin-fs', async importOriginal => {
  const actual = await importOriginal<typeof import('@tauri-apps/plugin-fs')>();
  const fs = await import('node:fs/promises');
  const path = await import('node:path');
  return {
    ...actual,
    mkdir: async (name: string) => fs.mkdir(path.join(cacheFiles.directory, name), { recursive: true }),
    readTextFile: async (name: string) => fs.readFile(path.join(cacheFiles.directory, name), 'utf8'),
    writeTextFile: async (name: string, data: string) => {
      if (cacheFiles.failNextWrite) {
        cacheFiles.failNextWrite = false;
        throw new Error('Cache disk unavailable');
      }
      await fs.writeFile(path.join(cacheFiles.directory, name), data);
    },
    rename: async (oldName: string, newName: string) =>
      fs.rename(path.join(cacheFiles.directory, oldName), path.join(cacheFiles.directory, newName)),
  };
});
vi.mock('../../core/src/data/vaultRevenue.mainnet.json', () => ({
  default: {
    formatVersion: 2,
    synchedToFrame: 20,
    argonotStakingByFrame: [],
    vaultsById: {},
    networkPoolsByFrame: {
      20: { auctionPoolMicrogons: '1000000n', vaultPoolMicrogons: '300000n', includesBondPayments: false },
    },
  },
}));
vi.mock('../../core/src/data/vaultRevenue.testnet.json', () => ({
  default: {
    formatVersion: 2,
    synchedToFrame: 24,
    argonotStakingByFrame: [],
    vaultsById: {},
    networkPoolsByFrame: {
      24: { auctionPoolMicrogons: '2000000n', vaultPoolMicrogons: '600000n', includesBondPayments: false },
    },
  },
}));

let observedVaults: Vaults;
const currency = {
  load: async () => undefined,
  fetchMainchainRates: async () => undefined,
  priceIndex: new PriceIndex(),
  convertMicrogonTo: (value: bigint) => Number(value) / 1_000_000,
};
vi.mock('../stores/vaults.ts', () => ({ getVaults: () => observedVaults }));
vi.mock('../stores/currency.ts', () => ({ getCurrency: () => currency }));

type OperationalAccountListener = Parameters<ArgonClient['query']['operationalAccounts']['operationalAccounts']>[1];

class TestVaults extends Vaults {
  public async persist(stats: IAllVaultStats): Promise<void> {
    this.stats = stats;
    await this.saveStats();
  }

  public async restore(): Promise<IAllVaultStats | void> {
    return await this.loadStatsFromFile();
  }
}

it('preserves the visible reward estimate after a failed frame read and publishes the notified frame on retry', async () => {
  const registry = getOfflineRegistry();
  const metadata = new Metadata(
    registry,
    Object.entries(getBundledMetadata()).find(([key]) => key.endsWith('-160'))![1],
  );
  const constants = decorateConstants(registry, metadata.asLatest, metadata.version);
  let frameUnavailable = true;
  const apis = [10, 11].map(
    frameId =>
      runtimeClient({
        registry,
        consts: constants,
        query: {
          treasury: {
            upstreamParticipationFactor: async () => registry.createType('Percent', 5),
            currentFrameVaultCapital: async () => {
              if (frameId === 11 && frameUnavailable) throw new Error('Frame temporarily unavailable');
              return registry.createType('PalletTreasuryFrameVaultCapital', {
                frameId,
                targetSecuritization: 1_000n,
                totalSecuritization: 1_000n,
                vaultSecuritizationPositions: {
                  4: {
                    securitization: 1_000n,
                    activatedSecuritization: 1_000n,
                    bitcoinLockedMicrogons: 1_000n,
                    activeBondMicrogons: 1_000n,
                    upstreamParticipation: 950_000_000_000_000_000n,
                  },
                },
              });
            },
          },
          priceIndex: {
            historicArgonotAverageByFrame: async () =>
              registry.createType('BTreeMap<u32, u128>', { [frameId - 1]: BigInt(frameId) * 1_000_000n }),
          },
          system: {
            number: async () => registry.createType('u32', frameId * 10),
            account: async () => registry.createType('AccountInfo', { data: { free: BigInt(frameId) * 10_000n } }),
          },
          vaults: { vaultsById: { entries: async () => [] } },
        },
      }) as unknown as ArgonCurrentQueryClient,
  );
  const events = createTypedEventEmitter();
  const header = BlockWatch.readHeader(registry.createType('Header', { number: 110 }), true);
  header.frameId = 11;
  const blockWatch = {
    events,
    getApi: async (block: IBlockHeaderInfo) => apis[block.frameId === 11 ? 1 : 0],
    // The finalized notification arrives before BlockWatch advances this cached head.
    getFinalizedApi: async () => apis[0],
  };
  setMainchainClients({ events: createTypedEventEmitter(), currentClient: apis[0], get: async () => apis[0] } as any);
  const vaults = new Vaults('dev-docker', currency as any, { blockWatch } as any);
  vaults.currentState = shallowReactive(vaults.currentState);
  const visibleEarnings = computed(() => vaults.rewards?.vaultRevenuePotential(4)?.actualEarnings);
  await vaults.loadCurrentState();
  await vi.waitFor(() => expect(visibleEarnings.value).toBe(48_500n));

  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  try {
    events.emit('finalized', [header]);
    await new Promise(resolve => setImmediate(resolve));
    expect(vaults.rewards?.capital.frameId).toBe(10);
    expect(visibleEarnings.value).toBe(48_500n);

    frameUnavailable = false;
    events.emit('finalized', [header]);
    await vi.waitFor(() => expect(visibleEarnings.value).toBe(53_350n));
    expect(vaults.rewards?.capital.frameId).toBe(11);
    expect(vaults.rewards?.averageMicrogonsPerArgonot).toBe(11_000_000n);

    const published = vaults.rewards;
    events.emit('finalized', [header]);
    await new Promise(resolve => setImmediate(resolve));
    expect(vaults.rewards).toBe(published);
    expect(visibleEarnings.value).toBe(53_350n);
  } finally {
    vi.useRealTimers();
  }
});

describe('Vaults stats storage', () => {
  const originalWindow = globalThis.window;

  afterEach(() => {
    globalThis.window = originalWindow;
  });

  it.each([true, false])('reads the payout balance with mining rewards first: %s', async rewardsBeforePayout => {
    const registry = getOfflineRegistry();
    const poolAddress = registry.createType('AccountId32', `0x6d6f646c7472656173757279${'00'.repeat(20)}`).toString();
    const sender = registry.createType('AccountId32', new Uint8Array(32).fill(1)).toString();
    const events: RuntimeSystemEventRecord[] = [
      {
        phase: { type: 'ApplyExtrinsic', value: 0 },
        event: { section: 'balances', method: 'Transfer', data: { from: sender, to: poolAddress, amount: 100n } },
        topics: [],
      },
      {
        phase: { type: 'ApplyExtrinsic', value: 1 },
        event: { section: 'balances', method: 'Transfer', data: { from: poolAddress, to: sender, amount: 1n } },
        topics: [],
      },
      {
        phase: { type: 'Finalization' },
        event: {
          section: 'balances',
          method: 'Transfer',
          data: {
            from: poolAddress,
            to: sender,
            amount: rewardsBeforePayout ? 100_000_020n : 100_000_010n,
          },
        },
        topics: [],
      },
    ];
    // Specs 147–150 mint block rewards before Treasury; other supported eras mint afterward.
    events.splice(rewardsBeforePayout ? 2 : 3, 0, {
      phase: { type: 'Finalization' },
      event: { section: 'balances', method: 'Minted', data: { who: poolAddress, amount: 100n } },
      topics: [],
    });
    const payoutApi = runtimeClient({
      registry,
      consts: { treasury: { palletId: '0x7472656173757279', percentForTreasuryReserves: BigNumber(0.1) } },
      query: { system: { events: async () => events } },
    }) as unknown as ArgonApi;
    const beforePayoutApi = runtimeClient({
      query: {
        system: {
          account: async () => registry.createType('FrameSystemAccountInfo', { data: { free: 1_000_000_001n } }),
        },
      },
    }) as unknown as ArgonApi;

    const pool = await readVaultNetworkPool({ frameId: 20, api: payoutApi, parentApi: beforePayoutApi });
    expect(pool.auctionPoolMicrogons).toBe(rewardsBeforePayout ? 1_000_000_200n : 1_000_000_100n);
    expect(pool.vaultPoolMicrogons).toBe(rewardsBeforePayout ? 900_000_180n : 900_000_090n);
  });

  it.each([
    'separate vault rewards',
    'combined vault and bond rewards',
    'reserves without Argonot bonds',
    'earlier pool rules',
  ])(
    'patches %s once, then publishes new frame history through Retry without replacing loaded returns',
    async poolModel => {
      globalThis.window = {} as Window & typeof globalThis;
      NetworkConfig.setNetwork('mainnet');
      setActivePinia(createPinia());
      setMainchainClients({ events: createTypedEventEmitter() } as any);

      const registry = getOfflineRegistry();
      const deployedRegistry = new TypeRegistry();
      const metadata = Object.entries(getBundledMetadata()).find(([key]) => key.endsWith('-159'))![1];
      deployedRegistry.setMetadata(new Metadata(deployedRegistry, metadata));
      const hasSecuritizationHistory =
        poolModel === 'separate vault rewards' || poolModel === 'combined vault and bond rewards';
      const commitment = (heldMicronots: bigint) =>
        toPlain(
          registry.createType('Option<ArgonPrimitivesVaultVaultArgonotSecuritization>', {
            heldMicronots,
            committedMicronots: heldMicronots,
            encumberedMicronots: 0n,
          }),
        );
      let fees = 100_000_000n;
      const revenue = () =>
        toPlain(
          registry.createType('Vec<PalletVaultsVaultFrameRevenue>', [
            {
              frameId: 20,
              bitcoinLockFeeRevenue: fees,
              securitization: 1_000_000_000n,
            },
          ]),
        ) as Parameters<Vaults['updateVaultRevenue']>[1];
      let historyError = false;
      let latestRevenueFrame = 21;
      const events = createTypedEventEmitter<{ finalized: (headers: IBlockHeaderInfo[]) => void }>();
      const frames = {
        load: async () => undefined,
        currentFrameId: 21,
        frameIds: [21],
        framesById: { 21: { firstBlockHash: '0x21' } },
        getTickStart: (frameId: number) => frameId * 1_440,
        getFrameStart: async (frameId: number) => {
          const separatePool = poolModel === 'separate vault rewards' || (!hasSecuritizationHistory && frameId > 21);
          let specVersion = 160;
          if (poolModel === 'combined vault and bond rewards') specVersion = 159;
          else if (poolModel === 'reserves without Argonot bonds' && frameId <= 21) specVersion = 155;
          else if (poolModel === 'earlier pool rules' && frameId <= 21) specVersion = 145;
          return {
            frame: {
              firstBlockSpecVersion: specVersion,
              firstBlockNumber: frameId,
              firstBlockHash: `0x${frameId}`,
              firstBlockTick: frameId * 10,
            },
            api: runtimeClient({
              registry,
              consts: {
                treasury: {
                  palletId: '0x7472656173757279',
                  ...(poolModel === 'earlier pool rules'
                    ? { bidPoolBurnPercent: BigNumber(0.1) }
                    : { percentForTreasuryReserves: BigNumber(0.1) }),
                  ...(hasSecuritizationHistory ? { percentForArgonotBondPool: BigNumber(0.2) } : {}),
                  ...(separatePool ? { percentForVaultPool: BigNumber(0.3) } : {}),
                },
              },
              query: {
                system: { events: async () => [] },
                treasury: {},
                vaults: {
                  ...(hasSecuritizationHistory
                    ? {
                        argonotSecuritizationByVaultId: {
                          entries: async () => [[{ args: [1] }, commitment(888_000_000n)]],
                        },
                      }
                    : {}),
                  revenuePerFrameByVault: {
                    entries: async () => {
                      if (historyError) throw new Error('History RPC unavailable');
                      return [[{ args: [1] }, [...revenue(), { ...revenue()[0], frameId: latestRevenueFrame }]]];
                    },
                  },
                },
              },
            }),
          };
        },
        blockWatch: {
          events,
          finalizedBlockHeader: { blockNumber: 100 },
          getHeader: async (blockNumber: number) => ({ blockNumber, blockHash: `0x${blockNumber}` }),
          getApi: async ({ blockNumber }: { blockNumber: number }) =>
            runtimeClient({
              query: {
                system: {
                  account: async () =>
                    toPlain(
                      registry.createType('FrameSystemAccountInfo', {
                        data: { free: 1_000_000_001n },
                      }),
                    ),
                },
                treasury: {
                  ...(hasSecuritizationHistory
                    ? { currentFrameArgonotBondParticipants: async () => ({ frameId: blockNumber, totalBonds: 10 }) }
                    : {}),
                  currentFrameVaultCapital: async () => {
                    if (poolModel === 'combined vault and bond rewards' && blockNumber === 20) {
                      return toPlain(
                        deployedRegistry.createType('PalletTreasuryFrameVaultCapital', {
                          frameId: blockNumber,
                          vaults: { 1: { flexibleProrata: 333_333_333_333_333_333n } },
                        }),
                      );
                    }
                    return toPlain(
                      registry.createType('PalletTreasuryFrameVaultCapital', {
                        frameId: blockNumber,
                        totalActiveBonds: 100n,
                        vaultSecuritizationPositions: {
                          1: { upstreamParticipation: 500_000_000_000_000_000n },
                        },
                      }),
                    );
                  },
                },
                vaults: {
                  argonotSecuritizationByVaultId: {
                    entries: async () => [
                      [{ args: [1] }, commitment(blockNumber === 20 ? 500_000_000n : 600_000_000n)],
                    ],
                  },
                },
              },
            }),
        },
      };

      let savedStats: string | null = null;
      const vaults = new TestVaults('dev-docker', currency as any, frames as any, {
        read: async () => savedStats,
        write: async data => {
          savedStats = data;
        },
      });
      const stats: IAllVaultStats = {
        synchedToFrame: 20,
        argonotStakingByFrame: [],
        vaultsById: {},
      };

      await vaults.persist(stats);

      expect(savedStats).not.toBeNull();
      await expect(vaults.restore()).resolves.toEqual(stats);

      vaults.currentState = shallowReactive({ ...vaults.currentState, isLoaded: true });
      observedVaults = vaults;
      await vaults.updateVaultRevenue(1, revenue());
      const returns = useVaultingStats();
      const annualEarnings = computed(() => (returns.averageAPR * 1_000) / 100);
      await returns.isLoadedPromise;
      expect(annualEarnings.value).toBeCloseTo(36_500);
      const chartOwner = { vaultId: 1, vaults, data: { stats: vaults.stats!.vaultsById[1] } } as unknown as MyVault;
      const chart = new ProfitAnalysis(
        chartOwner,
        frames as any,
        { data: { bondLots: [], bondHistory: [], dailyEarnings: [], isLoaded: true } } as unknown as ArgonBonds,
        21,
      );
      chart.update();
      expect(chart.records.find(record => record.id === 20)?.earningsMicrogons).toBe(100_000_000n);

      fees = 50_000_000n;
      await vaults.updateVaultRevenue(1, revenue());
      await vi.waitFor(() => expect(annualEarnings.value).toBeCloseTo(18_250));
      chart.update();
      expect(chart.records.find(record => record.id === 20)?.earningsMicrogons).toBe(50_000_000n);

      // The maintenance script works on a detached file, preserving the loaded display until publication.
      const patchInput = (await vaults.restore())!;
      if (poolModel === 'combined vault and bond rewards') {
        patchInput.vaultsById[1].changesByFrame[0].treasuryPool = {
          totalEarnings: 101_000_001n,
          vaultEarnings: 33_666_666n,
          vaultCapital: 50_000_000n,
          externalCapital: 50_000_000n,
        };
      } else if (poolModel === 'separate vault rewards') {
        patchInput.argonBondsByFrame = [{ frameId: 20, poolDistributed: 1_000_000n }];
      }
      await patchVaultHistory(patchInput, frames as any);
      if (poolModel === 'combined vault and bond rewards') {
        expect(patchInput.vaultsById[1].changesByFrame[0].treasuryPool.flexibleBondEarnings).toBe(33_666_666n);
      } else if (poolModel === 'separate vault rewards') {
        expect(patchInput.argonBondsByFrame?.[0].participatingBonds).toBe(100n);
      }
      await vaults.persist(patchInput);
      const patched = await vaults.restore();
      await patchVaultHistory(patched!, frames as any);
      expect(patched).toEqual(await vaults.restore());

      savedStats = JsonExt.stringify(patched!, 2, { sortKeys: true }) + '\n';
      await expect(vaults.restore()).resolves.toEqual(patched);
      const original = savedStats;
      const reordered = JsonExt.parse<IAllVaultStats>(
        JSON.stringify(JSON.parse(original), (_key, value: unknown) => {
          if (value === null || typeof value !== 'object' || Array.isArray(value)) return value;
          return Object.fromEntries(Object.entries(value).reverse());
        }),
      );
      expect(JsonExt.stringify(reordered, 2, { sortKeys: true }) + '\n' === original).toBe(true);

      // Updating one value must leave the surrounding fields and other records unchanged.
      const vault = Object.values(reordered.vaultsById)[0];
      const previousFees = vault.changesByFrame[0].bitcoinFeeRevenue;
      vault.changesByFrame[0].bitcoinFeeRevenue += 1n;
      const updated = JsonExt.stringify(reordered, 2, { sortKeys: true }) + '\n';
      const originalLines = new Set(original.split('\n'));
      const updatedLines = new Set(updated.split('\n'));
      expect([...updatedLines].filter(line => !originalLines.has(line))).toEqual([
        `          "bitcoinFeeRevenue": "${previousFees + 1n}n",`,
      ]);
      expect([...originalLines].filter(line => !updatedLines.has(line))).toEqual([
        `          "bitcoinFeeRevenue": "${previousFees}n",`,
      ]);

      frames.currentFrameId = 22;
      frames.frameIds.push(22);
      Object.assign(frames.framesById, { 22: { firstBlockHash: '0x22' } });

      historyError = true;
      await expect(returns.update(true)).rejects.toThrow('History RPC unavailable');
      expect(annualEarnings.value).toBeCloseTo(18_250);
      historyError = false;
      fees = 75_000_000n;
      await returns.update(true);
      expect(annualEarnings.value).toBeCloseTo(22_812.5);
      const restored = await vaults.restore();
      expect(
        restored?.vaultsById[1].changesByFrame.find(frame => frame.frameId === 20)?.argonotSecuritizationMicronots,
      ).toBe(hasSecuritizationHistory ? 500_000_000n : undefined);
      expect(
        restored?.vaultsById[1].changesByFrame.find(frame => frame.frameId === 21)?.argonotSecuritizationMicronots,
      ).toBe(poolModel === 'combined vault and bond rewards' ? undefined : 600_000_000n);
      expect(restored?.networkPoolsByFrame?.[20]).toMatchObject({
        auctionPoolMicrogons: 1_000_000_001n,
        includesBondPayments: poolModel !== 'separate vault rewards',
      });
      // Pool availability is independent of actual rewards paid. Old reserves round up.
      if (poolModel === 'separate vault rewards') {
        expect(restored?.networkPoolsByFrame?.[20].vaultPoolMicrogons).toBe(300_000_000n);
      } else if (poolModel === 'combined vault and bond rewards') {
        expect(restored?.networkPoolsByFrame?.[20].vaultPoolMicrogons).toBe(700_000_000n);
      } else {
        expect(restored?.networkPoolsByFrame?.[20].vaultPoolMicrogons).toBe(900_000_000n);
      }
      expect(restored?.networkPoolsByFrame?.[21]).toMatchObject({
        auctionPoolMicrogons: 1_000_000_001n,
        vaultPoolMicrogons: poolModel === 'combined vault and bond rewards' ? 700_000_000n : 300_000_000n,
        includesBondPayments: poolModel === 'combined vault and bond rewards',
      });

      // Once caught up, an unavailable archive cannot replace the completed snapshot or its visible return.
      historyError = true;
      await returns.update(true);
      expect(annualEarnings.value).toBeCloseTo(22_812.5);
      expect(await vaults.restore()).toEqual(restored);

      fees = 50_000_000n;
      await vaults.updateVaultRevenue(1, revenue());
      expect(vaults.stats?.vaultsById[1].changesByFrame.find(frame => frame.frameId === 20)).toMatchObject({
        bitcoinFeeRevenue: fees,
        ...(hasSecuritizationHistory ? { argonotSecuritizationMicronots: 500_000_000n } : {}),
      });

      // Live frame earnings arrive without pool or collateral history. Finalized
      // blocks must enrich the mounted chart without replacing its valid history.
      latestRevenueFrame = 22;
      frames.currentFrameId = 23;
      frames.frameIds.unshift(23);
      Object.assign(frames.framesById, { 23: { firstBlockHash: '0x23' } });
      events.emit('finalized', [{ blockNumber: 23, frameId: 23 } as IBlockHeaderInfo]);
      await new Promise(resolve => setTimeout(resolve, 0));
      expect(vaults.stats?.synchedToFrame).toBe(21);
      expect(vaults.stats?.networkPoolsByFrame?.[21]).toEqual(restored?.networkPoolsByFrame?.[21]);

      historyError = false;
      events.emit('finalized', [{ blockNumber: 24, frameId: 23 } as IBlockHeaderInfo]);
      await vi.waitFor(() => expect(vaults.stats?.synchedToFrame).toBe(22));
      expect(vaults.stats?.networkPoolsByFrame?.[22]).toMatchObject({
        auctionPoolMicrogons: 1_000_000_001n,
        vaultPoolMicrogons: poolModel === 'combined vault and bond rewards' ? 700_000_000n : 300_000_000n,
      });
      if (poolModel !== 'combined vault and bond rewards') {
        expect(vaults.stats?.vaultsById[1].changesByFrame.find(frame => frame.frameId === 22)).toMatchObject({
          argonotSecuritizationMicronots: 600_000_000n,
          upstreamParticipation: new BigNumber(0.5),
        });
      }
      expect(await vaults.restore()).toEqual(vaults.stats);

      // Explicit maintenance can repair development caches created before the
      // new chart detail without rebuilding the already-recorded pools/holdings.
      const cachedStats = (await vaults.restore())!;
      for (const vault of Object.values(cachedStats.vaultsById)) {
        for (const frame of vault.changesByFrame) delete frame.upstreamParticipation;
      }
      await patchVaultHistory(cachedStats, frames as any);
      expect(cachedStats.vaultsById[1].changesByFrame.find(frame => frame.frameId === 22)).toMatchObject({
        argonotSecuritizationMicronots: 600_000_000n,
        upstreamParticipation: new BigNumber(0.5),
      });
      expect(cachedStats.networkPoolsByFrame).toEqual(vaults.stats?.networkPoolsByFrame);
      returns.$dispose();
    },
  );
});

describe('Vaults cache upgrades', () => {
  const originalWindow = globalThis.window;

  afterEach(async () => {
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.restoreAllMocks();
    globalThis.window = originalWindow;
    cacheFiles.failNextWrite = false;
    if (cacheFiles.directory) await rm(cacheFiles.directory, { recursive: true, force: true });
    cacheFiles.directory = '';
  });

  it('retains historical revenue and website counts while dropping collection status and unused liquidity', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    globalThis.window = {} as Window & typeof globalThis;
    NetworkConfig.setNetwork('mainnet');
    cacheFiles.directory = await mkdtemp(join(tmpdir(), 'vault-cache-upgrade-'));
    await mkdir(join(cacheFiles.directory, 'mainnet'));
    const statsFile = join(cacheFiles.directory, 'mainnet', 'vaultStats.json');
    const frame = {
      frameId: 30,
      bitcoinFeeRevenue: 500_000n,
      bitcoinFeeCouponValueUsed: 100_000n,
      bitcoinLocksCreated: 2,
      securitization: 1_000_000n,
      securitizationActivated: 800_000n,
      treasuryPool: { totalEarnings: 250_000n, vaultEarnings: 100_000n, vaultCapital: 0n, externalCapital: 0n },
    };
    await writeFile(
      statsFile,
      JsonExt.stringify({
        formatVersion: 2,
        synchedToFrame: 30,
        argonotStakingByFrame: [],
        vaultsById: {
          1: {
            openedTick: 1,
            baseline: { bitcoinLocks: 7, feeRevenue: 100_000n, satoshis: 50n, microgonLiquidityRealized: 100n },
            changesByFrame: [
              {
                ...frame,
                uncollectedEarnings: 0n,
                satoshisAdded: 5n,
                microgonLiquidityAdded: 10n,
                securitizationRelockable: 20n,
              },
            ],
          },
        },
      }),
    );
    setMainchainClients({
      events: createTypedEventEmitter(),
      get: async () => ({ query: { vaults: { vaultsById: { entries: async () => [] } } } }),
    } as any);
    const frames = {
      load: async () => undefined,
      currentFrameId: 31,
      blockWatch: { events: createTypedEventEmitter<{ finalized: (headers: IBlockHeaderInfo[]) => void }>() },
    };
    const vaults = new Vaults('mainnet', currency as any, frames as any);
    await vaults.load();
    expect(vaults.stats?.synchedToFrame).toBe(30);
    expect(vaults.stats?.revenueBackfill).toEqual({ nextFrame: 31, throughFrame: 31 });
    expect(vaults.stats?.vaultsById[1]).toEqual({
      openedTick: 1,
      baseline: { bitcoinLocks: 7, feeRevenue: 100_000n },
      changesByFrame: [frame],
    });
    expect(vaults.calculateApr()).toBeCloseTo(18_250);

    const registry = getOfflineRegistry();
    const revenue = toPlain(
      registry.createType('Vec<PalletVaultsVaultFrameRevenue>', [
        {
          frameId: 30,
          bitcoinLockFeeRevenue: 500_000n,
          bitcoinLockFeeCouponValueUsed: 100_000n,
          bitcoinLocksCreated: 2,
          securitization: 1_000_000n,
          securitizationActivated: 800_000n,
          treasuryTotalEarnings: 250_000n,
          treasuryVaultEarnings: 100_000n,
          uncollectedRevenue: 600_000n,
        },
      ]),
    ) as Parameters<Vaults['updateVaultRevenue']>[1];
    await vaults.updateVaultRevenue(1, revenue);
    const beforeCollection = await readFile(statsFile, 'utf8');
    await vaults.updateVaultRevenue(1, [{ ...revenue[0], uncollectedRevenue: 0n }]);
    expect(await readFile(statsFile, 'utf8')).toBe(beforeCollection);

    const restarted = new Vaults('mainnet', currency as any, frames as any);
    await restarted.load();
    expect(restarted.stats).toEqual(vaults.stats);
    expect(restarted.stats?.vaultsById[1].changesByFrame).toEqual([frame]);
    expect(restarted.calculateApr()).toBeCloseTo(18_250);
  });

  it.each([
    { network: 'mainnet', checkpoint: 20, auctionPoolMicrogons: 1_000_000n },
    { network: 'testnet', checkpoint: 24, auctionPoolMicrogons: 2_000_000n },
  ])(
    'replaces the old $network cache once and retains subsequent earnings on restart',
    async ({ network, checkpoint, auctionPoolMicrogons }) => {
      vi.useFakeTimers();
      globalThis.window = {} as Window & typeof globalThis;
      cacheFiles.directory = await mkdtemp(join(tmpdir(), 'vault-cache-upgrade-'));
      await mkdir(join(cacheFiles.directory, network));
      const statsFile = join(cacheFiles.directory, network, 'vaultStats.json');
      await writeFile(
        statsFile,
        JsonExt.stringify({ formatVersion: 1, synchedToFrame: 30, argonotStakingByFrame: [], vaultsById: {} }),
      );

      setMainchainClients({
        events: createTypedEventEmitter(),
        get: async () => ({
          consts: { treasury: {} },
          query: { vaults: { vaultsById: { entries: async () => [] } } },
        }),
      } as any);
      const frames = {
        load: async () => undefined,
        currentFrameId: checkpoint + 3,
        blockWatch: { events: createTypedEventEmitter<{ finalized: (headers: IBlockHeaderInfo[]) => void }>() },
      };
      const vaults = new Vaults(network, currency as any, frames as any);
      await vaults.load();

      expect(vaults.stats?.synchedToFrame).toBe(checkpoint);
      expect(vaults.stats?.networkPoolsByFrame?.[checkpoint].auctionPoolMicrogons).toBe(auctionPoolMicrogons);
      expect(vaults.stats?.revenueBackfill).toEqual({ nextFrame: checkpoint + 3, throughFrame: checkpoint + 2 });
      const replacement = JsonExt.parse<IAllVaultStats>(await readFile(statsFile, 'utf8'));
      expect(replacement.formatVersion).toBe(2);
      expect(replacement.synchedToFrame).toBe(checkpoint);
      expect(replacement.networkPoolsByFrame).toEqual(vaults.stats?.networkPoolsByFrame);

      const registry = getOfflineRegistry();
      const revenue = toPlain(
        registry.createType('Vec<PalletVaultsVaultFrameRevenue>', [
          { frameId: checkpoint + 2, bitcoinLockFeeRevenue: 500_000n, securitization: 1_000_000n },
        ]),
      ) as Parameters<Vaults['updateVaultRevenue']>[1];
      await vaults.updateVaultRevenue(1, revenue);
      const updatedFile = await readFile(statsFile, 'utf8');

      const restarted = new Vaults(network, currency as any, frames as any);
      await restarted.load();
      expect(restarted.stats?.vaultsById[1].changesByFrame[0]).toMatchObject({
        frameId: checkpoint + 2,
        bitcoinFeeRevenue: 500_000n,
      });
      expect(restarted.stats?.networkPoolsByFrame).toEqual(replacement.networkPoolsByFrame);
      expect(restarted.stats?.revenueBackfill).toEqual({ nextFrame: checkpoint + 3, throughFrame: checkpoint + 2 });
      expect(await readFile(statsFile, 'utf8')).toBe(updatedFile);
    },
  );

  it('keeps previous files through failed cache writes and retries without blocking live earnings', async () => {
    vi.useFakeTimers();
    globalThis.window = {} as Window & typeof globalThis;
    cacheFiles.directory = await mkdtemp(join(tmpdir(), 'vault-cache-upgrade-'));
    await mkdir(join(cacheFiles.directory, 'mainnet'));
    const statsFile = join(cacheFiles.directory, 'mainnet', 'vaultStats.json');
    const oldCache = JsonExt.stringify({
      formatVersion: 1,
      synchedToFrame: 30,
      argonotStakingByFrame: [],
      vaultsById: {},
    });
    await writeFile(statsFile, oldCache);
    await writeFile(statsFile + '.tmp', 'stale temporary file');
    cacheFiles.failNextWrite = true;
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    setMainchainClients({
      events: createTypedEventEmitter(),
      get: async () => ({
        consts: { treasury: {} },
        query: { vaults: { vaultsById: { entries: async () => [] } } },
      }),
    } as any);
    const frames = {
      load: async () => undefined,
      currentFrameId: 21,
      blockWatch: { events: createTypedEventEmitter<{ finalized: (headers: IBlockHeaderInfo[]) => void }>() },
    };
    const vaults = new Vaults('mainnet', currency as any, frames as any);
    await expect(vaults.load()).resolves.toBeUndefined();
    expect(vaults.stats?.synchedToFrame).toBe(20);
    expect(vaults.stats?.networkPoolsByFrame?.[20].auctionPoolMicrogons).toBe(1_000_000n);
    expect(await readFile(statsFile, 'utf8')).toBe(oldCache);
    expect(await readFile(statsFile + '.tmp', 'utf8')).toBe('stale temporary file');

    const restarted = new Vaults('mainnet', currency as any, frames as any);
    await restarted.load();
    const savedStats = JsonExt.parse<IAllVaultStats>(await readFile(statsFile, 'utf8'));
    expect(savedStats).toEqual(restarted.stats);
    expect(savedStats.formatVersion).toBe(2);
    expect(savedStats.synchedToFrame).toBe(20);
    await expect(readFile(statsFile + '.tmp', 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });

    const savedFile = await readFile(statsFile, 'utf8');
    await writeFile(statsFile + '.tmp', 'stale temporary file');
    cacheFiles.failNextWrite = true;
    const registry = getOfflineRegistry();
    const revenue = toPlain(
      registry.createType('Vec<PalletVaultsVaultFrameRevenue>', [
        { frameId: 20, bitcoinLockFeeRevenue: 500_000n, securitization: 1_000_000n },
      ]),
    ) as Parameters<Vaults['updateVaultRevenue']>[1];
    const previousRevision = restarted.currentState.statsRevision;
    await expect(restarted.updateVaultRevenue(1, revenue)).resolves.toBeUndefined();
    expect(restarted.stats?.vaultsById[1].changesByFrame[0].bitcoinFeeRevenue).toBe(500_000n);
    expect(restarted.currentState.statsRevision).toBe(previousRevision + 1);
    expect(await readFile(statsFile, 'utf8')).toBe(savedFile);
    expect(await readFile(statsFile + '.tmp', 'utf8')).toBe('stale temporary file');

    await restarted.updateVaultRevenue(1, revenue);
    expect(JsonExt.parse<IAllVaultStats>(await readFile(statsFile, 'utf8'))).toEqual(restarted.stats);
    await expect(readFile(statsFile + '.tmp', 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  });
});

describe('Vault operator names', () => {
  it('loads vault names from operational profile entries', async () => {
    const operationalAccountId = `0x${'01'.repeat(32)}`;
    const operatorAccountId = `0x${'02'.repeat(32)}`;
    const client = {
      query: {
        operationalAccounts: {
          operationalAccountBySubAccount: {
            entries: vi.fn(async () => [[{ args: [operatorAccountId] }, operationalAccountId]]),
          },
          operationalAccounts: {
            entries: vi.fn(async () => [
              [{ args: [operationalAccountId] }, { name: new TextEncoder().encode('Atlas') }],
            ]),
          },
        },
      },
    };
    setMainchainClients({ events: createTypedEventEmitter(), get: vi.fn(async () => client) } as any);
    const vaults = new Vaults('dev-docker', {} as any, {} as any);

    await vaults.refreshOperatorNames({ vaults: [{ vaultId: 1, operatorAccountId }] });

    expect(vaults.operatorNamesByVaultId[1]).toBe('Atlas');
  });

  it('publishes operator profile subscription updates', async () => {
    const unsubscribe = vi.fn();
    const operationalAccountId = `0x${'01'.repeat(32)}`;
    const client = {
      query: {
        operationalAccounts: {
          operationalAccountBySubAccount: vi.fn(async () => operationalAccountId),
          operationalAccounts: vi.fn(async (_accountId, onUpdate: OperationalAccountListener) => {
            onUpdate({ name: new TextEncoder().encode('Atlas') } as Parameters<OperationalAccountListener>[0]);
            return unsubscribe;
          }),
        },
      },
    };
    setMainchainClients({ events: createTypedEventEmitter(), get: vi.fn(async () => client) } as any);
    const vaults = new Vaults('dev-docker', {} as any, {} as any);
    vaults.vaultsById[1] = { operatorAccountId: `0x${'02'.repeat(32)}` } as never;
    const onUpdate = vi.fn();

    await expect(vaults.subscribeToOperatorName(1, onUpdate)).resolves.toBe(unsubscribe);

    expect(vaults.operatorNamesByVaultId[1]).toBe('Atlas');
    expect(onUpdate).toHaveBeenCalledWith('Atlas');
  });
});
