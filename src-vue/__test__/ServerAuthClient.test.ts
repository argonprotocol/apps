import { beforeEach, describe, expect, it, vi } from 'vitest';
import { UserRole } from '@argonprotocol/apps-core';
import { ServerAuthClient } from '../lib/ServerAuthClient.ts';

const walletMock = vi.hoisted(() => {
  const signer = {
    address: 'admin-account',
    sign: vi.fn(() => new Uint8Array([1, 2, 3])),
  };
  const defaultSigner = {
    address: 'default-account',
    sign: vi.fn(() => new Uint8Array([7, 8, 9])),
  };
  const upstreamOperatorAuthSigner = {
    address: 'upstream-operator-auth-account',
    sign: vi.fn(() => new Uint8Array([4, 5, 6])),
  };

  return {
    signer,
    defaultSigner,
    upstreamOperatorAuthSigner,
    getDefaultArgonKeypair: vi.fn(),
    getOperationalKeypair: vi.fn(),
    getUpstreamOperatorAuthKeypair: vi.fn(),
  };
});

describe('ServerAuthClient', () => {
  let serverAuthClient: ServerAuthClient;

  beforeEach(() => {
    serverAuthClient = new ServerAuthClient(() => ({
      defaultArgonAddress: 'default-account',
      operationalAddress: 'admin-account',
      getDefaultArgonKeypair: walletMock.getDefaultArgonKeypair,
      getOperationalKeypair: walletMock.getOperationalKeypair,
      getUpstreamOperatorAuthKeypair: walletMock.getUpstreamOperatorAuthKeypair,
    }));
    walletMock.signer.sign.mockClear();
    walletMock.defaultSigner.sign.mockClear();
    walletMock.upstreamOperatorAuthSigner.sign.mockClear();
    walletMock.getOperationalKeypair.mockReset();
    walletMock.getDefaultArgonKeypair.mockReset();
    walletMock.getUpstreamOperatorAuthKeypair.mockReset();
    walletMock.getOperationalKeypair.mockResolvedValue(walletMock.signer);
    walletMock.getDefaultArgonKeypair.mockResolvedValue(walletMock.defaultSigner);
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

    await serverAuthClient.getAdminOperatorSessionId(baseUrl);
    await serverAuthClient.getAdminOperatorSessionId(baseUrl);

    expect(fetchPaths(fetchMock)).toEqual(['/auth/challenge', '/auth/login', '/auth/verify/admin']);
    expect(fetchUrls(fetchMock)[2].searchParams.get('sessionId')).toBe('session-admin-operator');
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

    const firstSession = serverAuthClient.getAdminOperatorSessionId(baseUrl);
    const secondSession = serverAuthClient.getAdminOperatorSessionId(baseUrl);

    expect(fetchMock).toHaveBeenCalledTimes(1);

    resolveChallenge(jsonResponse(createChallenge('nonce-1')));
    await Promise.all([firstSession, secondSession]);

    expect(fetchPaths(fetchMock)).toEqual(['/auth/challenge', '/auth/login', '/auth/verify/admin']);
    expect(walletMock.getOperationalKeypair).toHaveBeenCalledTimes(1);
  });

  it('creates a fresh session when a forced session check is rejected', async () => {
    const baseUrl = 'https://stale-session.example';
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

    await serverAuthClient.getAdminOperatorSessionId(baseUrl);
    await serverAuthClient.getAdminOperatorSessionId(baseUrl, { forceVerify: true });

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

    await expect(serverAuthClient.getAdminOperatorSessionId(baseUrl)).rejects.toThrow('Server auth is not configured.');
    await expect(serverAuthClient.getAdminOperatorSessionId(baseUrl)).rejects.toThrow('Server auth is not configured.');

    expect(fetchPaths(fetchMock)).toEqual(['/auth/challenge']);
    expect(walletMock.getOperationalKeypair).not.toHaveBeenCalled();
  });

  it('uses the derived upstream auth key for member sessions', async () => {
    const baseUrl = 'https://upstream-session.example';
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(createChallenge('nonce-1', UserRole.Member)))
      .mockResolvedValueOnce(jsonResponse(createSession(UserRole.Member)))
      .mockResolvedValueOnce(emptyResponse(204));
    vi.stubGlobal('fetch', fetchMock);

    await serverAuthClient.getMemberSessionId(baseUrl);

    expect(fetchPaths(fetchMock)).toEqual(['/auth/challenge', '/auth/login', '/auth/verify/member']);
    expect(fetchPayloads(fetchMock)).toMatchObject([
      {
        role: UserRole.Member,
        authAccountId: 'upstream-operator-auth-account',
        hasRestorePackage: false,
      },
      {
        role: UserRole.Member,
        authAccountId: 'upstream-operator-auth-account',
      },
    ]);
    expect(walletMock.upstreamOperatorAuthSigner.sign).toHaveBeenCalledTimes(1);
  });

  it('sends a cached package only when the member challenge requests it', async () => {
    const baseUrl = 'https://restore-session.example';
    const applyBootstrapEndpointSecret = vi.fn();
    const applyRestoreResult = vi.fn();
    serverAuthClient = new ServerAuthClient(
      () => ({
        defaultArgonAddress: 'default-account',
        operationalAddress: 'admin-account',
        getDefaultArgonKeypair: walletMock.getDefaultArgonKeypair,
        getOperationalKeypair: walletMock.getOperationalKeypair,
        getUpstreamOperatorAuthKeypair: walletMock.getUpstreamOperatorAuthKeypair,
      }),
      {
        getRestorePackage: () => ({
          restorePackage: 'cached-restore-package',
          restorePackageRevision: '2.1',
        }),
        getBootstrapEndpointPubkey: () => 'known-bootstrap-endpoint-pubkey',
        applyBootstrapEndpointSecret,
        applyRestoreResult,
      },
    );
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse({
          ...createChallenge('nonce-1', UserRole.Member),
          restorePackageRequired: true,
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          ...createSession(UserRole.Member),
          bootstrapEndpointSecret: 'replacement-bootstrap-endpoint-secret',
          restore: {
            fromName: 'Operator One',
            operatorAccountId: 'operator-account',
            restorePackage: 'current-restore-package',
            restorePackageRevision: '2.2',
            hasOperationsAccess: true,
            bitcoinLockCoupons: [],
          },
        }),
      )
      .mockResolvedValueOnce(emptyResponse(204));
    vi.stubGlobal('fetch', fetchMock);

    await serverAuthClient.getMemberSessionId(baseUrl);

    expect(fetchPaths(fetchMock)).toEqual(['/auth/challenge', '/auth/login', '/auth/verify/member']);
    expect(fetchPayloads(fetchMock)[0]).toMatchObject({
      role: UserRole.Member,
      authAccountId: 'upstream-operator-auth-account',
      hasRestorePackage: true,
      restorePackageRevision: '2.1',
      knownBootstrapEndpointPubkey: 'known-bootstrap-endpoint-pubkey',
    });
    expect(fetchPayloads(fetchMock)[0]).not.toHaveProperty('restorePackage');
    expect(fetchPayloads(fetchMock)[1]).toMatchObject({
      restorePackage: 'cached-restore-package',
      accountBinding: {
        accountId: 'default-account',
        operationalAccountId: 'admin-account',
        authAccountId: 'upstream-operator-auth-account',
      },
    });
    expect(applyBootstrapEndpointSecret).toHaveBeenCalledWith('replacement-bootstrap-endpoint-secret');
    expect(applyRestoreResult).toHaveBeenCalledWith({
      fromName: 'Operator One',
      operatorAccountId: 'operator-account',
      restorePackage: 'current-restore-package',
      restorePackageRevision: '2.2',
      hasOperationsAccess: true,
      bitcoinLockCoupons: [],
    });
  });

  it('does not cache transport failures as auth failures', async () => {
    const baseUrl = 'https://transport-failure.example';
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new TypeError('Load failed'))
      .mockResolvedValueOnce(jsonResponse(createChallenge('nonce-1')))
      .mockResolvedValueOnce(jsonResponse(createSession()))
      .mockResolvedValueOnce(emptyResponse(204));
    vi.stubGlobal('fetch', fetchMock);

    await expect(serverAuthClient.getAdminOperatorSessionId(baseUrl)).rejects.toThrow('Load failed');
    await expect(serverAuthClient.getAdminOperatorSessionId(baseUrl)).resolves.toBe('session-admin-operator');

    expect(fetchPaths(fetchMock)).toEqual(['/auth/challenge', '/auth/challenge', '/auth/login', '/auth/verify/admin']);
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
  const sessionIdByRole = {
    [UserRole.AdminOperator]: 'session-admin-operator',
    [UserRole.Member]: 'session-member',
  };

  return {
    sessionId: sessionIdByRole[role],
    role,
    accountId: role === UserRole.AdminOperator ? 'admin-account' : 'member-account',
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
  return fetchUrls(fetchMock).map(url => url.pathname);
}

function fetchUrls(fetchMock: ReturnType<typeof vi.fn>): URL[] {
  return fetchMock.mock.calls.map(([url]) => new URL(String(url)));
}

function fetchPayloads<T>(fetchMock: ReturnType<typeof vi.fn>): T[] {
  return fetchMock.mock.calls
    .map(([, init]) => (init as RequestInit | undefined)?.body)
    .filter(Boolean)
    .map(body => JSON.parse(String(body)) as T);
}
