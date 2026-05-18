import { afterEach, describe, expect, it, vi } from 'vitest';
import { NetworkConfig } from '@argonprotocol/apps-core';
import { PublicRelayerClient } from '../lib/PublicRelayerClient.ts';

describe('PublicRelayerClient', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    NetworkConfig.clearRuntimeOverride();
  });

  it('uses the default relayer host', async () => {
    NetworkConfig.setNetwork('testnet');
    const fetch = vi.fn(
      async () =>
        new Response(JSON.stringify({ outcome: 'Rejected', reason: 'Not eligible' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
    );
    vi.stubGlobal('fetch', fetch);

    const client = new PublicRelayerClient();

    await expect(client.relayEthereumProof({ transferProof: { Ethereum: {} } } as any)).resolves.toEqual({
      outcome: 'Rejected',
      reason: 'Not eligible',
    });
    expect(fetch).toHaveBeenCalledWith(
      'https://relayer.testnet.argonprotocol.org/ethereum-proof-relay',
      expect.objectContaining({
        method: 'POST',
      }),
    );
  });
});
