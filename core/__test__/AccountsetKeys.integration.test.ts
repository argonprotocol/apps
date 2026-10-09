import { once } from 'node:events';
import { createServer } from 'node:http';
import { getClient, getOfflineRegistry, Keyring } from '@argonprotocol/mainchain';
import { getBundledMetadata } from '@argonprotocol/runtime-client';
import { expect, inject, it } from 'vitest';
import { Accountset } from '../src/Accountset.ts';
import { createArgonClient, type ArgonClient } from '../src/MainchainClients.ts';
import { integrationAccountUri } from './integrationNetwork.ts';

it(
  'registers mining keys while runtime state is unavailable and rejects keys the node did not retain',
  { tags: ['no-argon-network'] },
  async () => {
    const registry = getOfflineRegistry();
    const version = registry.metadata.pallets
      .find(pallet => pallet.name.eq('System'))!
      .constants.find(constant => constant.name.eq('Version'))!;
    const runtimeVersion = registry.createType('RuntimeVersion', version.value);
    const metadata = Object.entries(getBundledMetadata()).find(([key]) =>
      key.endsWith(`-${runtimeVersion.specVersion.toNumber()}`),
    )![1];

    const registeredKeys = new Map<string, string>();
    let runtimeUnavailable = false;
    let discardKeys = false;

    const server = createServer(async (request, response) => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(chunk);
      const { id, method, params } = JSON.parse(Buffer.concat(chunks).toString());
      response.setHeader('Content-Type', 'application/json');

      if (method === 'state_getRuntimeVersion' && runtimeUnavailable) {
        response.end(
          JSON.stringify({
            jsonrpc: '2.0',
            id,
            error: { code: 4003, message: 'Api called for an unknown Block: State already discarded' },
          }),
        );
        return;
      }

      let result: unknown;
      if (method === 'author_insertKey') {
        const [keyType, seed, publicKey] = params;
        if (!discardKeys) registeredKeys.set(`${keyType}:${publicKey}`, seed);
        result = null;
      } else if (method === 'author_hasKey') {
        const [publicKey, keyType] = params;
        result = registeredKeys.has(`${keyType}:${publicKey}`);
      } else if (method === 'state_getRuntimeVersion') {
        result = runtimeVersion;
      } else if (method === 'state_getMetadata') {
        result = metadata;
      } else if (method === 'chain_getBlockHash') {
        result = `0x${'11'.repeat(32)}`;
      } else if (method === 'system_chain') {
        result = 'Argon Development';
      } else if (method === 'system_properties') {
        result = { ss58Format: 42, tokenDecimals: 6, tokenSymbol: 'ARGN' };
      } else if (method === 'rpc_methods') {
        result = {
          methods: [
            'author_insertKey',
            'author_hasKey',
            'state_getRuntimeVersion',
            'state_getMetadata',
            'chain_getBlockHash',
            'system_chain',
            'system_properties',
            'rpc_methods',
          ],
        };
      } else {
        response.end(
          JSON.stringify({ jsonrpc: '2.0', id, error: { code: -32601, message: `Unknown method ${method}` } }),
        );
        return;
      }
      response.end(JSON.stringify({ jsonrpc: '2.0', id, result }));
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    let client: ArgonClient | undefined;

    try {
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('Missing test RPC address');
      const url = `http://127.0.0.1:${address.port}`;
      client = createArgonClient(await getClient(url, { throwOnConnect: true }));

      const accountUri = integrationAccountUri(inject('argonIntegrationRunId'), import.meta.filename, 'mining-keys');
      const accountset = new Accountset({
        client,
        txSubmitter: new Keyring({ type: 'sr25519' }).addFromUri(accountUri),
        subaccountRange: [],
        sessionMiniSecretOrMnemonic: accountUri,
      });

      runtimeUnavailable = true;
      await accountset.registerKeys(url.replace('http:', 'ws:'));

      for (const [keyType, key] of Object.entries(accountset.keys())) {
        expect(registeredKeys.get(`${keyType}:${key.publicKey}`)).toBe(key.privateKey);
      }
      expect(registeredKeys.size).toBe(2);

      registeredKeys.clear();
      discardKeys = true;
      await expect(accountset.registerKeys(url)).rejects.toThrow('Failed to register seal key');
      expect(registeredKeys.size).toBe(0);
    } finally {
      await client?.disconnect();
      server.closeAllConnections();
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
  },
);
