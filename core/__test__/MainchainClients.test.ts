import { describe, expect, it, vi } from 'vitest';
import { MainchainClients } from '../src/MainchainClients.ts';

describe('MainchainClients', () => {
  it('emits a degraded event when clearing an active pruned client', async () => {
    const archiveClient = createClient();
    const prunedClient = createClient();
    const clients = new MainchainClients('ws://archive', () => false, archiveClient as any);
    const internalClients = clients as unknown as {
      connectionStateByClient: { pruned: 'connected' | 'disconnected' };
      currentClientByType: { pruned?: ReturnType<typeof createClient> };
      prunedClientPromise?: Promise<ReturnType<typeof createClient>>;
      prunedUrl?: string;
    };
    const degraded = vi.fn();

    clients.events.on('degraded', degraded);

    internalClients.connectionStateByClient.pruned = 'connected';
    internalClients.currentClientByType.pruned = prunedClient;
    internalClients.prunedClientPromise = Promise.resolve(prunedClient);
    internalClients.prunedUrl = 'ws://pruned';

    clients.clearPrunedClient();
    await Promise.resolve();

    expect(degraded).toHaveBeenCalledOnce();
    expect(degraded).toHaveBeenCalledWith(undefined, 'pruned');
    expect(prunedClient.disconnect).toHaveBeenCalledOnce();
  });
});

function createClient() {
  const listeners: Record<string, Array<() => void>> = {};

  return {
    on: vi.fn((event: string, listener: () => void) => {
      listeners[event] ??= [];
      listeners[event].push(listener);
    }),
    disconnect: vi.fn(async () => {
      for (const listener of listeners.disconnected ?? []) {
        listener();
      }
    }),
  };
}
