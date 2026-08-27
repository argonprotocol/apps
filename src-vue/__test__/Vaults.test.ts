import type { IAllVaultStats } from '@argonprotocol/apps-core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Vaults } from '../lib/Vaults.ts';
import { setMainchainClients } from '../stores/mainchain.ts';

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

  it('uses supplied storage when a virtual window has no Tauri runtime', async () => {
    globalThis.window = {} as Window & typeof globalThis;
    setMainchainClients({} as any);

    let savedStats: string | null = null;
    const vaults = new TestVaults('dev-docker', {} as any, {} as any, {
      read: async () => savedStats,
      write: async data => {
        savedStats = data;
      },
    });
    const stats: IAllVaultStats = {
      synchedToFrame: 1,
      argonotStakingByFrame: [],
      vaultsById: {},
    };

    await vaults.persist(stats);

    expect(savedStats).not.toBeNull();
    await expect(vaults.restore()).resolves.toEqual(stats);
  });
});

describe('Vault operator names', () => {
  it('loads requested names from operational profiles', async () => {
    const client = {
      query: {
        operationalAccounts: {
          operationalAccountBySubAccount: {
            multi: vi.fn(async () => [`0x${'01'.repeat(32)}`]),
          },
          operationalAccounts: {
            multi: vi.fn(async () => [{ name: new TextEncoder().encode('Atlas') }]),
          },
        },
      },
    };
    setMainchainClients({ get: vi.fn(async () => client) } as any);
    const vaults = new Vaults('dev-docker', {} as any, {} as any);

    await vaults.refreshOperatorNames({ vaults: [{ vaultId: 1, operatorAccountId: `0x${'02'.repeat(32)}` }] });

    expect(vaults.operatorNamesByVaultId[1]).toBe('Atlas');
  });
});
