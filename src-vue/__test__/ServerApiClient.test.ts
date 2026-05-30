import { afterEach, describe, expect, it, vi } from 'vitest';
import { ServerType } from '../interfaces/IConfig.ts';
import { ServerApiClient } from '../lib/ServerApiClient.ts';
import type { ServerAuthClient } from '../lib/ServerAuthClient.ts';

describe('ServerApiClient', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
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
    const client = new ServerApiClient(() => serverDetails, serverAuthClient);
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

    await expect(client.getTreasuryAppInvites()).resolves.toEqual([]);

    expect(invalidateAdminOperatorSessionId).toHaveBeenCalledWith('https://203.0.113.10');
    expect(fetchMock.mock.calls.map(([url]) => new URL(String(url)).searchParams.get('sessionId'))).toEqual([
      'stale-session',
      'fresh-session',
    ]);
  });
});
