import { createRequire } from 'node:module';
import { afterEach, expect, it, vi } from 'vitest';
import { firstValueFrom } from 'rxjs';
import { RpcCore } from '@polkadot/rpc-core';
import type { RpcInterface } from '@polkadot/rpc-core/types/jsonrpc';
import { WsProvider } from '@polkadot/rpc-provider';
import type { ProviderInterfaceCallback } from '@polkadot/rpc-provider/types';
import { Metadata, TypeRegistry } from '@polkadot/types';
import { decorateStorage } from '@polkadot/types/metadata/decorate';
import type { Option } from '@polkadot/types-codec';
import type {
  PalletOperationalAccountsOperationalAccount,
  PalletTreasuryPositionsPosition,
} from '@argonprotocol/mainchain';
import { getBundledMetadata } from '../src/MainchainApi.ts';

const require = createRequire(import.meta.url);
const CommonJsRpcCore: typeof RpcCore = require('@polkadot/rpc-core').RpcCore;

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

it.each([
  { format: 'ESM', loss: 'expiry', Rpc: RpcCore, capacity: 1024, idleMs: 31_000 },
  { format: 'ESM', loss: 'eviction', Rpc: RpcCore, capacity: 1, idleMs: 0 },
  { format: 'CommonJS', loss: 'expiry', Rpc: CommonJsRpcCore, capacity: 1024, idleMs: 31_000 },
  { format: 'CommonJS', loss: 'eviction', Rpc: CommonJsRpcCore, capacity: 1, idleMs: 0 },
])(
  '$format subscriptions preserve live accounts through $loss and historical reads',
  async ({ Rpc, capacity, idleMs }) => {
    vi.useFakeTimers();
    const registry = new TypeRegistry();
    const metadata = new Metadata(
      registry,
      Object.entries(getBundledMetadata()).find(([key]) => key.endsWith('-160'))![1],
    );
    registry.setMetadata(metadata);
    const storage = decorateStorage(registry, metadata.asLatest, metadata.version);
    const accountId = new Uint8Array(32).fill(17);
    const vaultAccount = new Uint8Array(32).fill(34);
    const accountKey = registry.createType('StorageKey', [
      storage.operationalAccounts.operationalAccounts,
      [accountId],
    ]);
    const positionKey = registry.createType('StorageKey', [
      storage.treasuryPositions.positionsByAccount,
      [vaultAccount],
    ]);
    const blockKey = registry.createType('StorageKey', [storage.system.number, []]);
    const account = registry.createType('PalletOperationalAccountsOperationalAccount', {
      vaultAccount,
      miningAccount: vaultAccount,
      encryptionPubkey: vaultAccount,
      isOperationallyCertified: true,
    });
    let position = registry.createType('PalletTreasuryPositionsPosition', { bondPrincipal: 2_500_000_000n });
    const block = `0x${'00'.repeat(32)}`;
    const provider = new WsProvider('ws://127.0.0.1:9944', false);
    const callbacks = new Map<number, ProviderInterfaceCallback>();
    let subscriptionId = 0;
    vi.spyOn(provider, 'subscribe').mockImplementation(async (_type, _method, _params, callback) => {
      callbacks.set(++subscriptionId, callback);
      return subscriptionId;
    });
    vi.spyOn(provider, 'unsubscribe').mockImplementation(async (_type, _method, id) => callbacks.delete(Number(id)));
    const send = vi.spyOn(provider, 'send');
    const rpc = new Rpc('subscription-state', registry, { provider, rpcCacheCapacity: capacity }) as RpcCore &
      RpcInterface;
    const observed: [Option<PalletOperationalAccountsOperationalAccount>, Option<PalletTreasuryPositionsPosition>][] =
      [];
    const subscription = rpc.state
      .subscribeStorage<
        [Option<PalletOperationalAccountsOperationalAccount>, Option<PalletTreasuryPositionsPosition>]
      >([accountKey, positionKey])
      .subscribe(values => observed.push(values));
    const update = callbacks.get(subscriptionId)!;
    update(null, {
      block,
      changes: [
        [accountKey.toHex(), account.toHex()],
        [positionKey.toHex(), position.toHex()],
      ],
    });
    expect(observed.at(-1)?.[0].unwrap().isOperationallyCertified.valueOf()).toBe(true);

    vi.advanceTimersByTime(idleMs);
    send.mockResolvedValueOnce([
      { block, changes: [[blockKey.toHex(), registry.createType('BlockNumber', 7).toHex()]] },
    ]);
    await firstValueFrom(rpc.state.queryStorageAt([blockKey]));
    position = registry.createType('PalletTreasuryPositionsPosition', { bondPrincipal: 3_000_000_000n });
    update(null, { block, changes: [[positionKey.toHex(), position.toHex()]] });
    expect(observed.at(-1)?.[0].isSome).toBe(true);
    expect(observed.at(-1)?.[0].unwrap().isOperationallyCertified.valueOf()).toBe(true);
    expect(observed.at(-1)?.[1].unwrap().bondPrincipal.toBigInt()).toBe(3_000_000_000n);

    const overlapping = rpc.state.subscribeStorage([accountKey]).subscribe();
    callbacks.get(subscriptionId)!(null, { block, changes: [[accountKey.toHex(), null]] });
    send.mockResolvedValueOnce([{ block, changes: [[accountKey.toHex(), null]] }]);
    await firstValueFrom(rpc.state.queryStorageAt([accountKey], block));
    position = registry.createType('PalletTreasuryPositionsPosition', { bondPrincipal: 4_000_000_000n });
    update(null, { block, changes: [[positionKey.toHex(), position.toHex()]] });
    expect(observed.at(-1)?.[0].unwrap().isOperationallyCertified.valueOf()).toBe(true);
    expect(observed.at(-1)?.[1].unwrap().bondPrincipal.toBigInt()).toBe(4_000_000_000n);

    const rawObserved: unknown[] = [];
    const raw = rpc.state.subscribeStorage.raw([accountKey, positionKey]).subscribe(values => rawObserved.push(values));
    const rawUpdate = callbacks.get(subscriptionId)!;
    rawUpdate(null, {
      block,
      changes: [
        [accountKey.toHex(), account.toHex()],
        [positionKey.toHex(), position.toHex()],
      ],
    });
    const delta = { block, changes: [[positionKey.toHex(), position.toHex()]] };
    rawUpdate(null, delta);
    expect(rawObserved.at(-1)).toEqual(delta);

    update(null, { block, changes: [[accountKey.toHex(), null]] });
    expect(observed.at(-1)?.[0].isNone).toBe(true);
    expect(observed.at(-1)?.[1].unwrap().bondPrincipal.toBigInt()).toBe(4_000_000_000n);

    // A reconnect delivers a complete current snapshot through the existing callback.
    position = registry.createType('PalletTreasuryPositionsPosition', { bondPrincipal: 5_000_000_000n });
    update(null, {
      block,
      changes: [
        [accountKey.toHex(), account.toHex()],
        [positionKey.toHex(), position.toHex()],
      ],
    });
    expect(observed.at(-1)?.[0].unwrap().isOperationallyCertified.valueOf()).toBe(true);
    expect(observed.at(-1)?.[1].unwrap().bondPrincipal.toBigInt()).toBe(5_000_000_000n);

    subscription.unsubscribe();
    overlapping.unsubscribe();
    raw.unsubscribe();
    await vi.advanceTimersByTimeAsync(2_000);
    expect(callbacks.size).toBe(0);
    const publishedBeforeLateUpdate = observed.length;
    update(null, { block, changes: [[accountKey.toHex(), null]] });
    expect(observed).toHaveLength(publishedBeforeLateUpdate);

    const restarted: boolean[] = [];
    const fresh = rpc.state
      .subscribeStorage<
        [Option<PalletOperationalAccountsOperationalAccount>, Option<PalletTreasuryPositionsPosition>]
      >([accountKey, positionKey])
      .subscribe(([account]) => restarted.push(account.isSome));
    expect(restarted).toEqual([]);
    callbacks.get(subscriptionId)!(null, {
      block,
      changes: [
        [accountKey.toHex(), null],
        [positionKey.toHex(), position.toHex()],
      ],
    });
    expect(restarted).toEqual([false]);
    fresh.unsubscribe();
    await vi.advanceTimersByTimeAsync(2_000);
  },
);
