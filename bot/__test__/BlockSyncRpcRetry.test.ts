import { expect, it } from 'vitest';
import { once } from 'node:events';
import fs from 'node:fs/promises';
import os from 'node:os';
import Path from 'node:path';
import { WebSocketServer } from 'ws';
import { getOfflineRegistry, keyringFromSuri, u8aToHex } from '@argonprotocol/mainchain';
import { xxhashAsHex } from '@polkadot/util-crypto';
import { Accountset, MainchainClients, MiningFrames, NetworkConfig } from '@argonprotocol/apps-core';
import { BlockWatch } from '@argonprotocol/apps-core/src/BlockWatch.ts';
import { BlockSync } from '../src/BlockSync.ts';
import { Storage } from '../src/Storage.ts';
import runtimeVersion from '../../runtime-client/__test__/fixtures/runtime-159.json' with { type: 'json' };

it('retries startup on the same archive client after a missing header becomes available', async () => {
  NetworkConfig.setNetwork('dev-docker');
  const registry = getOfflineRegistry();
  const genesisHash = '0xee11bf2ff8838fcb0832c09085c5319a08ba6111c225ecd899fe659872d9d45d';
  const finalizedHeader = registry.createType('Header', {
    number: 8,
    parentHash: genesisHash,
    digest: {
      logs: [
        { preRuntime: ['aura', u8aToHex(registry.createType('u64', NetworkConfig.get().genesisTick + 8).toU8a())] },
        { preRuntime: ['pow_', registry.createType('AccountId32', `0x${'11'.repeat(32)}`).toHex()] },
        {
          consensus: [
            'fram',
            registry
              .createType('ArgonPrimitivesDigestsFrameInfo', {
                frameId: 0,
                isNewFrame: false,
                frameRewardTicksRemaining: 2,
              })
              .toHex(),
          ],
        },
      ],
    },
  });
  const bestHeader = registry.createType('Header', {
    ...finalizedHeader.toJSON(),
    number: 9,
    parentHash: finalizedHeader.hash.toHex(),
    digest: {
      logs: [
        { preRuntime: ['aura', u8aToHex(registry.createType('u64', NetworkConfig.get().genesisTick + 9).toU8a())] },
        ...finalizedHeader.digest.logs.slice(1),
      ],
    },
  });
  const systemNumberKey = xxhashAsHex('System', 128) + xxhashAsHex('Number', 128).slice(2);
  const methods = [
    'chain_getBlockHash',
    'chain_getHeader',
    'chain_getFinalizedHead',
    'chain_subscribeNewHeads',
    'chain_subscribeNewHead',
    'chain_subscribeFinalizedHeads',
    'chain_unsubscribeNewHeads',
    'chain_unsubscribeFinalizedHeads',
    'state_getRuntimeVersion',
    'state_getMetadata',
    'state_subscribeRuntimeVersion',
    'state_unsubscribeRuntimeVersion',
    'state_queryStorageAt',
    'state_getStorage',
    'state_subscribeStorage',
    'state_unsubscribeStorage',
    'state_getKeysPaged',
    'system_chain',
    'system_properties',
    'system_health',
    'rpc_methods',
  ];
  let archiveMissingHeader = true;
  let nextSubscription = 0;
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await once(server, 'listening');
  const address = server.address();
  if (typeof address === 'string' || !address) throw new Error('Missing test RPC address');
  const archiveUrl = `ws://127.0.0.1:${address.port}/archive`;
  const prunedUrl = `ws://127.0.0.1:${address.port}/pruned`;

  server.on('connection', (socket, request) => {
    socket.on('message', bytes => {
      const { id, method, params } = JSON.parse(bytes.toString());
      let result: unknown;
      let updateMethod: string | undefined;
      let update: unknown;
      const storageChanges = (keys: string[]) => ({
        block: bestHeader.hash.toHex(),
        changes: keys.map(key => [
          key,
          key === systemNumberKey ? u8aToHex(registry.createType('u32', 9).toU8a()) : null,
        ]),
      });
      switch (method) {
        case 'chain_getBlockHash':
          result =
            Number(params[0]) === 0
              ? genesisHash
              : Number(params[0]) === 8
                ? finalizedHeader.hash.toHex()
                : bestHeader.hash.toHex();
          break;
        case 'chain_getHeader':
          if (request.url === '/archive' && params[0] === bestHeader.hash.toHex()) {
            result = archiveMissingHeader ? null : bestHeader.toJSON();
          } else {
            result = params[0] === finalizedHeader.hash.toHex() ? finalizedHeader.toJSON() : bestHeader.toJSON();
          }
          break;
        case 'chain_getFinalizedHead':
          result = finalizedHeader.hash.toHex();
          break;
        case 'state_getRuntimeVersion':
          result = runtimeVersion;
          break;
        case 'state_getMetadata':
          // A known genesis/spec must initialize from bundled metadata even when this RPC fails.
          socket.send(
            JSON.stringify({
              jsonrpc: '2.0',
              id,
              error: { code: -32000, message: 'Metadata temporarily unavailable' },
            }),
          );
          return;
        case 'system_chain':
          result = 'Argon';
          break;
        case 'system_properties':
          result = { ss58Format: 42, tokenDecimals: 6, tokenSymbol: 'ARGN' };
          break;
        case 'system_health':
          result = { peers: 1, isSyncing: false, shouldHavePeers: false };
          break;
        case 'rpc_methods':
          result = { version: 1, methods };
          break;
        case 'state_queryStorageAt':
          result = [storageChanges(params[0])];
          break;
        case 'state_getStorage':
          result = params[0] === systemNumberKey ? u8aToHex(registry.createType('u32', 9).toU8a()) : null;
          break;
        case 'state_getKeysPaged':
          result = [];
          break;
        case 'state_subscribeStorage':
          updateMethod = 'state_storage';
          update = storageChanges(params[0]);
          break;
        case 'state_subscribeRuntimeVersion':
          updateMethod = 'state_runtimeVersion';
          update = runtimeVersion;
          break;
        case 'chain_subscribeNewHeads':
        case 'chain_subscribeNewHead':
          updateMethod = 'chain_newHead';
          update = bestHeader.toJSON();
          break;
        case 'chain_subscribeFinalizedHeads':
          updateMethod = 'chain_finalizedHead';
          update = finalizedHeader.toJSON();
          break;
        default:
          if (typeof method === 'string' && method.includes('unsubscribe')) result = true;
          else {
            socket.send(
              JSON.stringify({ jsonrpc: '2.0', id, error: { code: -32601, message: `Unexpected RPC ${method}` } }),
            );
            return;
          }
      }
      if (updateMethod) result = String(++nextSubscription);
      socket.send(JSON.stringify({ jsonrpc: '2.0', id, result }));
      if (updateMethod)
        socket.send(
          JSON.stringify({ jsonrpc: '2.0', method: updateMethod, params: { subscription: result, result: update } }),
        );
    });
  });

  const botDataDir = await fs.mkdtemp(Path.join(os.tmpdir(), 'block-sync-rpc-retry-'));
  const storage = new Storage(botDataDir);
  const clients = new MainchainClients(archiveUrl, () => false);
  const blockWatch = new BlockWatch(clients);
  const miningFrames = new MiningFrames(clients, blockWatch);
  try {
    const localClient = await clients.setPrunedClient(prunedUrl);
    const accountset = new Accountset({
      client: localClient,
      txSubmitter: keyringFromSuri('//Alice'),
      subaccountRange: [],
    });
    const blockSync = new BlockSync(accountset, storage, clients, miningFrames, blockWatch, 0);
    const block = BlockWatch.readHeader(bestHeader);
    // A valid saved checkpoint still needs its historical API during startup.
    await blockSync.blockSyncFile.mutate(state => {
      state.syncedToBlockNumber = 9;
      state.bestBlockNumber = 9;
      state.blocksByNumber[9] = {
        hash: block.blockHash,
        number: 9,
        tick: block.tick,
        author: block.author,
        frameId: 0,
        isNewFrame: false,
        frameRewardTicksRemaining: 2,
      };
    });

    await expect(blockSync.load()).rejects.toThrow(
      'ARCHIVE_RPC: Unable to retrieve header and parent from supplied hash',
    );
    expect(blockSync.accountMiners).toBeUndefined();

    archiveMissingHeader = false;
    const retainedClient = await clients.archiveClientPromise;
    await expect(blockSync.load()).resolves.toBeUndefined();
    expect(await clients.archiveClientPromise).toBe(retainedClient);
    expect(blockSync.accountMiners).toBeDefined();
    await storage.close();
    const reopenedStorage = new Storage(botDataDir);
    try {
      const saved = await reopenedStorage.botBlockSyncFile().get();
      expect(saved.syncedToBlockNumber).toBe(9);
      expect(saved.blocksByNumber[9].hash).toBe(bestHeader.hash.toHex());
    } finally {
      await reopenedStorage.close();
    }
  } finally {
    await miningFrames.stop();
    blockWatch.destroy();
    await clients.disconnect();
    await storage.close();
    for (const socket of server.clients) socket.terminate();
    await new Promise<void>(resolve => server.close(() => resolve()));
    await fs.rm(botDataDir, { recursive: true, force: true });
  }
});
