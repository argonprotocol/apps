import { afterEach, describe, expect, it, vi } from 'vitest';
import { ServerType } from '../interfaces/IConfig.ts';
import { ServerApiClient } from '../lib/ServerApiClient.ts';
import type { ServerAuthClient } from '../lib/ServerAuthClient.ts';

describe('ServerApiClient', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('requires a server upgrade before starting authenticated mailbox work on the current server protocol', async () => {
    // The current router root contract has no Bitcoin mailbox capability.
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ status: 'ok', authEnabled: true })));
    vi.stubGlobal('fetch', fetchMock);
    const getAdminOperatorSessionId = vi.fn(async () => 'admin-session');
    const client = new ServerApiClient(
      () => ({ type: ServerType.CustomServer, ipAddress: '203.0.113.10', gatewayPort: 443 }),
      { getAdminOperatorSessionId, invalidateAdminOperatorSessionId: vi.fn() },
      { canAccessServer: true },
    );
    await expect(client.getPendingBitcoinCooperativeReleases()).rejects.toThrow('Upgrade the operator server');
    expect(getAdminOperatorSessionId).not.toHaveBeenCalled();
    expect(fetchMock.mock.calls).toHaveLength(1);
  });

  it('uses localhost for local loopback gateway urls', () => {
    const serverDetails = {
      type: ServerType.LocalComputer,
      ipAddress: '127.0.0.1',
      gatewayPort: 59397,
    };

    expect(ServerApiClient.getGatewayHttpUrl(serverDetails, '/auth/challenge')).toBe(
      'https://localhost:59397/auth/challenge',
    );
    expect(ServerApiClient.getGatewayWebsocketUrl(serverDetails, '/bot/')).toBe('wss://localhost:59397/bot/');
    expect(ServerApiClient.getGatewayWebsocketUrl(serverDetails, '/substrate', 'session-123')).toBe(
      'wss://localhost:59397/substrate?sessionId=session-123',
    );
  });

  it('keeps the configured host for remote gateway urls', () => {
    expect(
      ServerApiClient.getGatewayHttpUrl({
        type: ServerType.CustomServer,
        ipAddress: '203.0.113.10',
        gatewayPort: 443,
      }),
    ).toBe('https://203.0.113.10');
  });

  it('surfaces non-json server errors', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('Not Found', { status: 404 })),
    );

    await expect(
      ServerApiClient.getArgonInstallProgress({
        type: ServerType.CustomServer,
        ipAddress: '203.0.113.10',
        gatewayPort: 443,
      }),
    ).rejects.toThrow('Not Found');
  });

  it('retries authenticated requests after the session is rejected', async () => {
    const serverDetails = {
      type: ServerType.CustomServer,
      ipAddress: '203.0.113.10',
      gatewayPort: 443,
    };
    const getAdminOperatorSessionId = vi
      .fn()
      .mockResolvedValueOnce('stale-session')
      .mockResolvedValueOnce('fresh-session');
    const invalidateAdminOperatorSessionId = vi.fn();
    const serverAuthClient = {
      getAdminOperatorSessionId,
      invalidateAdminOperatorSessionId,
    } satisfies Pick<ServerAuthClient, 'getAdminOperatorSessionId' | 'invalidateAdminOperatorSessionId'>;
    const client = new ServerApiClient(() => serverDetails, serverAuthClient, { canAccessServer: true });
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ error: 'Unauthorized' }), {
          status: 401,
          headers: { 'Content-Type': 'application/json' },
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ invites: [] }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      );
    vi.stubGlobal('fetch', fetchMock);

    await expect(client.getInvites()).resolves.toEqual([]);

    expect(invalidateAdminOperatorSessionId).toHaveBeenCalledWith('https://203.0.113.10');
    expect(fetchMock.mock.calls.map(([url]) => new URL(String(url)).searchParams.get('sessionId'))).toEqual([
      'stale-session',
      'fresh-session',
    ]);
  });

  it('does not contact a configured server when server access is unavailable', async () => {
    const fetchMock = vi.fn();
    const getAdminOperatorSessionId = vi.fn();
    const client = new ServerApiClient(
      () => ({
        type: ServerType.CustomServer,
        ipAddress: '203.0.113.10',
        gatewayPort: 443,
      }),
      {
        getAdminOperatorSessionId,
        invalidateAdminOperatorSessionId: vi.fn(),
      },
      { canAccessServer: false },
    );
    vi.stubGlobal('fetch', fetchMock);

    await expect(client.getAdminOperatorSessionId()).rejects.toThrow('Server access is unavailable');
    await expect(client.isGatewayReady()).resolves.toBe(false);
    await expect(client.getInvites()).rejects.toThrow('Server access is unavailable');
    expect(getAdminOperatorSessionId).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
