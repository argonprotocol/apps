import { NetworkConfig } from '@argonprotocol/apps-core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WalletForEthereum } from '../lib/WalletForEthereum.ts';
import { FinancialCacheTypes } from '../lib/db/FinancialCacheTable.ts';
import { createTestDb } from './helpers/db.ts';

type IWalletForEthereumInternals = {
  loadBalances(options?: { force?: boolean }): Promise<void>;
};

describe('WalletForEthereum balance refresh lifecycle', () => {
  beforeEach(() => {
    NetworkConfig.setNetwork('dev-docker');
    NetworkConfig.setRuntimeOverride('dev-docker', {
      ethereumNetwork: { executionRpcUrls: ['https://ethereum.test'] },
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    NetworkConfig.clearRuntimeOverride('dev-docker');
  });

  it('preserves a cached balance when this network has no Ethereum RPC', async () => {
    NetworkConfig.setRuntimeOverride('dev-docker', {
      ethereumNetwork: { executionRpcUrls: [] },
    });
    const db = await createTestDb();
    const address = '0x0000000000000000000000000000000000000001';
    await db.financialCacheTable.upsert(FinancialCacheTypes.ExternalWalletBalance, `ethereum:${address}`, {
      chain: 'ethereum',
      address,
      availableMicrogons: 11n,
      availableMicronots: 22n,
      otherTokens: [],
      observedAt: new Date('2026-08-29T12:00:00.000Z'),
    });
    const wallet = new WalletForEthereum(address, Promise.resolve(db.financialCacheTable));

    try {
      await wallet.load({ startRefresh: false });

      expect(wallet.data).toMatchObject({
        availableMicrogons: 11n,
        availableMicronots: 22n,
        totalMicrogons: 11n,
        totalMicronots: 22n,
        balanceIsCached: true,
        fetchErrorMsg: '',
      });
    } finally {
      wallet.dispose();
      await db.close();
    }
  });

  it('starts background refresh by default', async () => {
    const setInterval = vi.fn();
    vi.stubGlobal('window', { setInterval });
    vi.spyOn(WalletForEthereum.prototype as unknown as IWalletForEthereumInternals, 'loadBalances').mockResolvedValue();

    const wallet = new WalletForEthereum('0x0000000000000000000000000000000000000001');
    await wallet.load();

    expect(setInterval).toHaveBeenCalledOnce();
  });

  it('does not start background refresh for a one-off load', async () => {
    const addEventListener = vi.fn();
    const setInterval = vi.fn();
    vi.stubGlobal('window', { addEventListener, setInterval });
    vi.spyOn(WalletForEthereum.prototype as unknown as IWalletForEthereumInternals, 'loadBalances').mockResolvedValue();

    const wallet = new WalletForEthereum('0x0000000000000000000000000000000000000001');
    await wallet.load({ startRefresh: false });

    expect(addEventListener).not.toHaveBeenCalled();
    expect(setInterval).not.toHaveBeenCalled();
  });
});
