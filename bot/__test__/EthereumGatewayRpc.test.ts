import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { cryptoWaitReady } from '@polkadot/util-crypto';
import { Keyring } from '@argonprotocol/mainchain';
import { NetworkConfig, TxSigner, type ArgonClient, type BlockWatch } from '@argonprotocol/apps-core';
import { DelegateSubmitLane } from '../src/DelegateSubmitLane.ts';
import { EthereumGatewayProverService } from '../src/EthereumGatewayProverService.ts';

it('bounds gateway discovery requests when the execution RPC rate limits the relay', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'gateway-rpc-'));
  let contractReads = 0;
  const server = createServer(async (request, response) => {
    let body = '';
    for await (const chunk of request) body += chunk;
    const rpc = JSON.parse(body);
    response.writeHead(200, { 'content-type': 'application/json' });
    if (rpc.method === 'eth_getBlockByNumber') {
      response.end(
        JSON.stringify({
          jsonrpc: '2.0',
          id: rpc.id,
          result: { number: '0x1', hash: `0x${'11'.repeat(32)}`, transactions: [] },
        }),
      );
      return;
    }
    contractReads++;
    response.end(
      JSON.stringify({
        jsonrpc: '2.0',
        id: rpc.id,
        error: { code: -32005, message: 'Provider request limit exceeded' },
      }),
    );
  });
  let prover: EthereumGatewayProverService | undefined;
  try {
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Missing test RPC listener');
    NetworkConfig.setNetwork('dev-docker');
    NetworkConfig.setRuntimeOverride('dev-docker', {
      ethereumNetwork: { executionRpcUrls: [`http://127.0.0.1:${address.port}`] },
    });

    await cryptoWaitReady();
    const signer = new TxSigner(new Keyring({ type: 'sr25519' }).createFromUri('//GatewayRpcRetry'));
    const lane = new DelegateSubmitLane(signer);
    // Native RPC is external to the retry boundary; the requested checkpoint has not been consumed.
    lane.client = {
      tx: { crosschainTransfer: {} },
      query: {
        crosschainTransfer: {
          gatewaySyncPauseBySourceChain: async () => null,
          gatewayStateBySourceChain: async () => ({ gatewayActivityNonce: 0n }),
          chainConfigBySourceChain: async () => ({
            type: 'Evm',
            value: { gateway: '0x0000000000000000000000000000000000000001' },
          }),
        },
      },
    } as unknown as ArgonClient;
    const blockWatch = { getFinalizedApi: vi.fn() } as unknown as BlockWatch;
    prover = new EthereumGatewayProverService(lane, blockWatch, directory);

    await expect(
      prover.runToCheckpoint({ sourceChain: 'Ethereum', throughGatewayActivityNonce: 1n }),
    ).rejects.toThrow();
    // One attempt plus the configured provider retry; SDK defaults would make four calls.
    expect(contractReads).toBe(2);
  } finally {
    await prover?.shutdown();
    if (server.listening) await new Promise<void>(resolve => server.close(() => resolve()));
    NetworkConfig.clearRuntimeOverride('dev-docker');
    await rm(directory, { recursive: true, force: true });
  }
});
