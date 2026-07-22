import { afterEach, describe, expect, it, vi } from 'vitest';
import { WalletForEthereum } from '../lib/WalletForEthereum.ts';

type IWalletForEthereumInternals = {
  loadBalances(options?: { force?: boolean }): Promise<void>;
};

describe('WalletForEthereum balance refresh lifecycle', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('starts background refresh by default', async () => {
    const addEventListener = vi.fn();
    const setInterval = vi.fn();
    vi.stubGlobal('window', { addEventListener, setInterval });
    vi.spyOn(WalletForEthereum.prototype as unknown as IWalletForEthereumInternals, 'loadBalances').mockResolvedValue();

    const wallet = new WalletForEthereum('0x0000000000000000000000000000000000000001');
    await wallet.load();

    expect(addEventListener).toHaveBeenCalledOnce();
    expect(addEventListener).toHaveBeenCalledWith('focus', expect.any(Function));
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
