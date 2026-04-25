import { beforeEach, describe, expect, it, vi } from 'vitest';
import { UserRole } from '@argonprotocol/apps-core';
import { ServerAuthClient } from '../lib/ServerAuthClient.ts';

const walletMock = vi.hoisted(() => {
  const signer = {
    address: 'admin-account',
    sign: vi.fn(() => new Uint8Array([1, 2, 3])),
  };
  const upstreamOperatorAuthSigner = {
    address: 'upstream-operator-auth-account',
    sign: vi.fn(() => new Uint8Array([4, 5, 6])),
  };

  return {
    signer,
    upstreamOperatorAuthSigner,
    getOperationalKeypair: vi.fn(),
    getUpstreamOperatorAuthKeypair: vi.fn(),
  };
});

describe('ServerAuthClient', () => {
  let serverAuthClient: ServerAuthClient;

  beforeEach(() => {
    serverAuthClient = new ServerAuthClient(() => ({
      operationalAddress: 'admin-account',
      getOperationalKeypair: walletMock.getOperationalKeypair,
      getUpstreamOperatorAuthKeypair: walletMock.getUpstreamOperatorAuthKeypair,
    }));
    walletMock.signer.sign.mockClear();
    walletMock.upstreamOperatorAuthSigner.sign.mockClear();
    walletMock.getOperationalKeypair.mockReset();
    walletMock.getUpstreamOperatorAuthKeypair.mockReset();
    walletMock.getOperationalKeypair.mockResolvedValue(walletMock.signer);
    walletMock.getUpstreamOperatorAuthKeypair.mockResolvedValue(walletMock.upstreamOperatorAuthSigner);
    vi.unstubAllGlobals();
  });

  it('creates a fresh session and reuses the in-memory verification', async () => {
    const baseUrl = 'https://fresh-session.example';
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(createChallenge('nonce-1')))
      .mockResolvedValueOnce(jsonResponse(createSession()))
      .mockResolvedValueOnce(emptyResponse(204));
    vi.stubGlobal('fetch', fetchMock);

    await serverAuthClient.ensureAdminOperatorSession(baseUrl);
    await serverAuthClient.ensureAdminOperatorSession(baseUrl);

    expect(fetchPaths(fetchMock)).toEqual(['/auth/challenge', '/auth/login', '/auth/verify/admin']);
    expect(fetchCredentials(fetchMock)).toEqual(['include', 'include', 'include']);
    expect(walletMock.getOperationalKeypair).toHaveBeenCalledTimes(1);
  });

  it('shares one login flow between concurrent callers', async () => {
    const baseUrl = 'https://concurrent-session.example';
    let resolveChallenge!: (response: Response) => void;
    const challengePromise = new Promise<Response>(resolve => {
      resolveChallenge = resolve;
    });
    const fetchMock = vi
      .fn()
      .mockReturnValueOnce(challengePromise)
      .mockResolvedValueOnce(jsonResponse(createSession()))
      .mockResolvedValueOnce(emptyResponse(204));
    vi.stubGlobal('fetch', fetchMock);

    const firstSession = serverAuthClient.ensureAdminOperatorSession(baseUrl);
    const secondSession = serverAuthClient.ensureAdminOperatorSession(baseUrl);

    expect(fetchMock).toHaveBeenCalledTimes(1);

    resolveChallenge(jsonResponse(createChallenge('nonce-1')));
    await Promise.all([firstSession, secondSession]);

    expect(fetchPaths(fetchMock)).toEqual(['/auth/challenge', '/auth/login', '/auth/verify/admin']);
    expect(walletMock.getOperationalKeypair).toHaveBeenCalledTimes(1);
  });

  it('creates a fresh session when a forced session check is rejected', async () => {
    const baseUrl = 'https://stale-cookie.example';
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(createChallenge('nonce-1')))
      .mockResolvedValueOnce(jsonResponse(createSession()))
      .mockResolvedValueOnce(emptyResponse(204))
      .mockResolvedValueOnce(emptyResponse(401))
      .mockResolvedValueOnce(jsonResponse(createChallenge('nonce-2')))
      .mockResolvedValueOnce(jsonResponse(createSession()))
      .mockResolvedValueOnce(emptyResponse(204));
    vi.stubGlobal('fetch', fetchMock);

    await serverAuthClient.ensureAdminOperatorSession(baseUrl);
    await serverAuthClient.ensureAdminOperatorSession(baseUrl, { forceVerify: true });

    expect(fetchPaths(fetchMock)).toEqual([
      '/auth/challenge',
      '/auth/login',
      '/auth/verify/admin',
      '/auth/verify/admin',
      '/auth/challenge',
      '/auth/login',
      '/auth/verify/admin',
    ]);
    expect(walletMock.getOperationalKeypair).toHaveBeenCalledTimes(2);
  });

  it('fails fast after auth is unavailable', async () => {
    const baseUrl = 'https://auth-unavailable.example';
    const fetchMock = vi.fn().mockResolvedValueOnce(emptyResponse(503));
    vi.stubGlobal('fetch', fetchMock);

    await expect(serverAuthClient.ensureAdminOperatorSession(baseUrl)).rejects.toThrow(
      'Server auth is not configured.',
    );
    await expect(serverAuthClient.ensureAdminOperatorSession(baseUrl)).rejects.toThrow(
      'Server auth is not configured.',
    );

    expect(fetchPaths(fetchMock)).toEqual(['/auth/challenge']);
    expect(walletMock.getOperationalKeypair).not.toHaveBeenCalled();
  });

  it('uses the derived upstream auth key for invited sessions', async () => {
    const baseUrl = 'https://upstream-session.example';
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(createChallenge('nonce-1', UserRole.TreasuryUser)))
      .mockResolvedValueOnce(jsonResponse(createSession(UserRole.TreasuryUser)))
      .mockResolvedValueOnce(emptyResponse(204));
    vi.stubGlobal('fetch', fetchMock);

    await serverAuthClient.ensureTreasurySession(baseUrl);

    expect(fetchPaths(fetchMock)).toEqual(['/auth/challenge', '/auth/login', '/auth/verify/treasury-coupon']);
    expect(fetchPayloads(fetchMock)).toMatchObject([
      {
        role: UserRole.TreasuryUser,
        authAccountId: 'upstream-operator-auth-account',
      },
      {
        role: UserRole.TreasuryUser,
        authAccountId: 'upstream-operator-auth-account',
      },
    ]);
    expect(walletMock.upstreamOperatorAuthSigner.sign).toHaveBeenCalledTimes(1);
  });
});

function createChallenge(nonce = 'nonce', role = UserRole.AdminOperator) {
  return {
    role,
    authAccountId: role === UserRole.AdminOperator ? 'admin-account' : 'upstream-operator-auth-account',
    nonce,
    expiresAt: Date.now() + 60_000,
  };
}

function createSession(role = UserRole.AdminOperator) {
  return {
    role,
    accountId: role === UserRole.AdminOperator ? 'admin-account' : 'treasury-account',
    expiresAt: new Date(Date.now() + 60 * 60_000).toISOString(),
  };
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

function emptyResponse(status: number): Response {
  return new Response(null, { status });
}

function fetchPaths(fetchMock: ReturnType<typeof vi.fn>): string[] {
  return fetchMock.mock.calls.map(([url]) => new URL(String(url)).pathname);
}

function fetchCredentials(fetchMock: ReturnType<typeof vi.fn>): Array<RequestInit['credentials']> {
  return fetchMock.mock.calls.map(([, init]) => (init as RequestInit | undefined)?.credentials);
}

function fetchPayloads<T>(fetchMock: ReturnType<typeof vi.fn>): T[] {
  return fetchMock.mock.calls
    .map(([, init]) => (init as RequestInit | undefined)?.body)
    .filter(Boolean)
    .map(body => JSON.parse(String(body)) as T);
}
