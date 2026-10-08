import { JsonExt, NetworkConfig, type ArgonClient, type IAllVaultStats } from '@argonprotocol/apps-core';
import BigNumber from 'bignumber.js';
import { getOfflineRegistry, PriceIndex } from '@argonprotocol/mainchain';
import { getBundledMetadata, runtimeClient, toPlain } from '@argonprotocol/runtime-client';
import { Metadata, TypeRegistry } from '@polkadot/types';
import { createPinia, setActivePinia } from 'pinia';
import { computed, reactive } from 'vue';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Vaults } from '../lib/Vaults.ts';
import { setMainchainClients } from '../stores/mainchain.ts';
import { useVaultingStats } from '../stores/vaultingStats.ts';
import { patchVaultHistory } from '../../scripts/patchVaultHistory.ts';

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

describe('Vaults stats storage', () => {
  const originalWindow = globalThis.window;

  afterEach(() => {
    globalThis.window = originalWindow;
  });

  it.each(['separate vault rewards', 'combined vault and bond rewards', 'earlier pool rules'])(
    'patches %s once, then records only new frame history through Retry',
    async poolModel => {
      globalThis.window = {} as Window & typeof globalThis;
      NetworkConfig.setNetwork('mainnet');
      setActivePinia(createPinia());
      setMainchainClients({} as any);

      const registry = getOfflineRegistry();
      const deployedRegistry = new TypeRegistry();
      const metadata = Object.entries(getBundledMetadata()).find(([key]) => key.endsWith('-159'))![1];
      deployedRegistry.setMetadata(new Metadata(deployedRegistry, metadata));
      const hasSecuritizationHistory = poolModel !== 'earlier pool rules';
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
      const frames = {
        load: async () => undefined,
        currentFrameId: 21,
        frameIds: [21],
        framesById: { 21: { firstBlockHash: '0x21' } },
        getFrameStart: async (frameId: number) => ({
          frame: {
            firstBlockSpecVersion: frameId > 21 || hasSecuritizationHistory ? 160 : 145,
            firstBlockNumber: frameId,
            firstBlockHash: `0x${frameId}`,
            firstBlockTick: frameId * 10,
          },
          api: runtimeClient({
            registry,
            consts: {
              treasury: {
                palletId: '0x7472656173757279',
                ...(hasSecuritizationHistory
                  ? {
                      percentForTreasuryReserves: BigNumber(0.1),
                      percentForArgonotBondPool: BigNumber(0.2),
                    }
                  : { bidPoolBurnPercent: BigNumber(0.1) }),
                ...(frameId > 21 || poolModel === 'separate vault rewards'
                  ? { percentForVaultPool: BigNumber(0.3) }
                  : {}),
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
                    return [[{ args: [1] }, [...revenue(), { ...revenue()[0], frameId: 21 }]]];
                  },
                },
              },
            },
          }),
        }),
        blockWatch: {
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
                  currentFrameArgonotBondParticipants: async () => ({ frameId: 20, totalBonds: 10 }),
                  currentFrameVaultCapital: async () => {
                    if (poolModel === 'combined vault and bond rewards') {
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

      vaults.currentState = reactive({ ...vaults.currentState, isLoaded: true });
      observedVaults = vaults;
      await vaults.updateVaultRevenue(1, revenue());
      const returns = useVaultingStats();
      const annualEarnings = computed(() => (returns.averageAPR * 1_000) / 100);
      await returns.isLoadedPromise;
      expect(annualEarnings.value).toBeCloseTo(36_500);

      fees = 50_000_000n;
      await vaults.updateVaultRevenue(1, revenue());
      await vi.waitFor(() => expect(annualEarnings.value).toBeCloseTo(18_250));

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
      ).toBe(600_000_000n);
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
        expect(restored?.networkPoolsByFrame?.[20].vaultPoolMicrogons).toBeUndefined();
      }
      expect(restored?.networkPoolsByFrame?.[21]).toMatchObject({
        auctionPoolMicrogons: 1_000_000_001n,
        vaultPoolMicrogons: 300_000_000n,
        includesBondPayments: false,
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
      returns.$dispose();
    },
  );
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
    setMainchainClients({ get: vi.fn(async () => client) } as any);
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
    setMainchainClients({ get: vi.fn(async () => client) } as any);
    const vaults = new Vaults('dev-docker', {} as any, {} as any);
    vaults.vaultsById[1] = { operatorAccountId: `0x${'02'.repeat(32)}` } as never;
    const onUpdate = vi.fn();

    await expect(vaults.subscribeToOperatorName(1, onUpdate)).resolves.toBe(unsubscribe);

    expect(vaults.operatorNamesByVaultId[1]).toBe('Atlas');
    expect(onUpdate).toHaveBeenCalledWith('Atlas');
  });
});
