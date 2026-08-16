import { afterEach, describe, expect, it } from 'vitest';
import { getEthereumTransactionExplorerUrl, NetworkConfig } from '../src/NetworkConfig.ts';

describe('NetworkConfig', () => {
  afterEach(() => {
    NetworkConfig.clearRuntimeOverride();
  });

  it('builds Ethereum transaction links for the selected network', () => {
    NetworkConfig.setNetwork('testnet');

    expect(getEthereumTransactionExplorerUrl('0xabc')).toBe('https://sepolia.etherscan.io/tx/0xabc');
  });

  it('does not offer an Ethereum transaction link without a configured explorer', () => {
    NetworkConfig.setNetwork('dev-docker');

    expect(getEthereumTransactionExplorerUrl('0xabc')).toBeUndefined();
  });
});
