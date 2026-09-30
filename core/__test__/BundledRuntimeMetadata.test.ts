import { expect, it } from 'vitest';
import { once } from 'node:events';
import { WebSocketServer } from 'ws';
import { Metadata, TypeRegistry } from '@polkadot/types';
import { getBundledMetadata, toHistoricalEvent } from '@argonprotocol/runtime-client';
import { getMainchainClient } from '../src/MainchainRpcProvider.ts';
// Unmodified runtime descriptors from the published 1.4.12 and 1.4.13 SDK source maps.
import runtime158 from '../../runtime-client/__test__/fixtures/runtime-158.json' with { type: 'json' };
import runtime159 from '../../runtime-client/__test__/fixtures/runtime-159.json' with { type: 'json' };

const mainnetGenesis = '0xee11bf2ff8838fcb0832c09085c5319a08ba6111c225ecd899fe659872d9d45d';

it.each([
  { genesis: mainnetGenesis, bundled: true },
  { genesis: `0x${'99'.repeat(32)}`, bundled: false },
])('decodes upgrade-block events without changing live decoding (bundled=$bundled)', async ({ genesis, bundled }) => {
  const metadata = getBundledMetadata();
  const registries = new Map<number, TypeRegistry>();
  const encodedEvents = new Map<number, string>();
  for (const specVersion of [158, 159]) {
    const registry = new TypeRegistry();
    registry.setMetadata(
      new Metadata(registry, metadata[`${mainnetGenesis}-${specVersion}`]),
      undefined,
      undefined,
      true,
    );
    registries.set(specVersion, registry);
    const pallet = registry.metadata.pallets.find(pallet => pallet.name.eq('BitcoinLocks'))!;
    const variant = registry.lookup
      .getSiType(pallet.events.unwrap().type)
      .def.asVariant.variants.find(event => event.name.eq('BitcoinUtxoCosignRequested'))!;
    const index = Uint8Array.of(pallet.index.toNumber(), variant.index.toNumber());
    const EventData = registry.findMetaEvent(index);
    const data = new EventData(registry, specVersion === 158 ? [4, 3] : [4, 3, 2]);
    const event = registry.createType('Event', Uint8Array.from([...index, ...data.toU8a()]));
    encodedEvents.set(
      specVersion,
      registry.createType('Vec<EventRecord>', [{ phase: { ApplyExtrinsic: 0 }, event, topics: [] }]).toHex(),
    );
  }
  const preUpgradeHash = `0x${'09'.repeat(32)}`;
  const upgradeHeader = registries.get(158)!.createType('Header', { number: 10, parentHash: preUpgradeHash });
  const nextHeader = registries.get(159)!.createType('Header', { number: 11, parentHash: upgradeHeader.hash });
  let metadataUnavailable = bundled;
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing RPC address');
  server.on('connection', socket => {
    socket.on('message', bytes => {
      const { id, method, params } = JSON.parse(bytes.toString()) as {
        id: number;
        method: string;
        params: (string | string[])[];
      };
      let result: unknown;
      switch (method) {
        case 'chain_getBlockHash':
          result = Number(params[0]) === 0 ? genesis : nextHeader.hash.toHex();
          break;
        case 'chain_getHeader':
          result = params[0] === upgradeHeader.hash.toHex() ? upgradeHeader.toJSON() : nextHeader.toJSON();
          break;
        case 'state_getRuntimeVersion':
          // An upgrade block's post-state is 159; its parent executed it with 158.
          result = params[0] === preUpgradeHash ? runtime158 : runtime159;
          break;
        case 'system_chain':
          result = 'Argon';
          break;
        case 'system_properties':
          result = { ss58Format: 42, tokenDecimals: 6, tokenSymbol: 'ARGN' };
          break;
        case 'rpc_methods':
          result = {
            version: 1,
            methods: [
              'chain_getBlockHash',
              'chain_getHeader',
              'state_getRuntimeVersion',
              'state_getMetadata',
              'state_getStorage',
              'state_queryStorageAt',
              'state_subscribeRuntimeVersion',
              'state_unsubscribeRuntimeVersion',
              'system_chain',
              'system_properties',
              'rpc_methods',
            ],
          };
          break;
        case 'state_getMetadata':
          if (metadataUnavailable) {
            socket.send(
              JSON.stringify({
                jsonrpc: '2.0',
                id,
                error: { code: -32000, message: 'Historical metadata unavailable' },
              }),
            );
            return;
          }
          result = metadata[`${mainnetGenesis}-${params[0] === preUpgradeHash ? 158 : 159}`];
          break;
        case 'state_getStorage':
          result = encodedEvents.get(params[1] === upgradeHeader.hash.toHex() ? 158 : 159);
          break;
        case 'state_queryStorageAt':
          result = [
            {
              block: params[1] ?? nextHeader.hash.toHex(),
              changes: (params[0] as string[]).map(key => [
                key,
                encodedEvents.get(params[1] === upgradeHeader.hash.toHex() ? 158 : 159),
              ]),
            },
          ];
          break;
        case 'state_subscribeRuntimeVersion':
          result = '1';
          break;
        case 'state_unsubscribeRuntimeVersion':
          result = true;
          break;
        default:
          socket.send(
            JSON.stringify({ jsonrpc: '2.0', id, error: { code: -32601, message: `Unsupported RPC ${method}` } }),
          );
          return;
      }
      socket.send(JSON.stringify({ jsonrpc: '2.0', id, result }));
    });
  });
  const clients: Awaited<ReturnType<typeof getMainchainClient>>[] = [];
  try {
    const client = await getMainchainClient(`ws://127.0.0.1:${address.port}`);
    clients.push(client);
    metadataUnavailable = true;
    if (!bundled) {
      await expect(client.at(upgradeHeader.hash)).rejects.toThrow('Historical metadata unavailable');
      metadataUnavailable = false;
    }
    const older = await client.at(upgradeHeader.hash);
    expect(older.runtimeVersion.specVersion.toNumber()).toBe(158);
    expect(toHistoricalEvent((await older.query.system.events())[0].event)).toEqual({
      section: 'bitcoinLocks',
      method: 'BitcoinUtxoCosignRequested',
      data: { utxoId: 4, vaultId: 3 },
    });
    expect(toHistoricalEvent((await client.query.system.events())[0].event)).toEqual({
      section: 'bitcoinLocks',
      method: 'BitcoinUtxoCosignRequested',
      data: { lockId: 4, vaultId: 3, releaseNumber: 2 },
    });
    const newer = await client.at(nextHeader.hash);
    expect(newer.runtimeVersion.specVersion.toNumber()).toBe(159);
    expect(toHistoricalEvent((await newer.query.system.events())[0].event)).toEqual({
      section: 'bitcoinLocks',
      method: 'BitcoinUtxoCosignRequested',
      data: { lockId: 4, vaultId: 3, releaseNumber: 2 },
    });
    if (bundled) {
      const clone = client.clone();
      clients.push(clone);
      await clone.isReadyOrError;
      const cloned = await clone.at(upgradeHeader.hash);
      expect(toHistoricalEvent((await cloned.query.system.events())[0].event)?.data).toEqual({
        utxoId: 4,
        vaultId: 3,
      });
      const restarted = await getMainchainClient(`ws://127.0.0.1:${address.port}`);
      clients.push(restarted);
      const afterRestart = await restarted.at(upgradeHeader.hash);
      expect(toHistoricalEvent((await afterRestart.query.system.events())[0].event)?.data).toEqual({
        utxoId: 4,
        vaultId: 3,
      });
    }
  } finally {
    await Promise.all(clients.map(client => client.disconnect()));
    for (const socket of server.clients) socket.terminate();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});
