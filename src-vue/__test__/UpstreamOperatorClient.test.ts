import { afterEach, expect, it, vi } from 'vitest';
import { RequestStatusError, ServerAuthClient } from '../lib/ServerAuthClient.ts';
import { hasOperationsUpgradeRequest, UpstreamOperatorClient } from '../lib/UpstreamOperatorClient.ts';
import { createMockWalletKeys } from './helpers/wallet.ts';
import { BootstrapType } from '../interfaces/IConfig.ts';

const storeMocks = vi.hoisted(() => ({
  config: {
    bootstrapDetails: undefined as { type: string; routerHost: string } | undefined,
    upstreamOperator: undefined as { name: string } | undefined,
    isLoadedPromise: Promise.resolve(),
  },
  recoverUpstreamHost: vi.fn(),
}));

vi.mock('../stores/config.ts', () => ({
  getConfig: () => storeMocks.config,
}));
vi.mock('../stores/server.ts', () => ({
  getUpstreamOperatorAuthClient: () => undefined,
}));
vi.mock('../stores/bootstrapRecovery.ts', () => ({
  enrollUpstreamRecovery: vi.fn(),
  recoverUpstreamHost: storeMocks.recoverUpstreamHost,
}));

afterEach(() => {
  vi.unstubAllGlobals();
});

it('keeps an operations upgrade pending after the upstream records the request', () => {
  expect(
    hasOperationsUpgradeRequest({
      operationsUpgradeRequestedAt: new Date('2026-08-10T12:00:00Z'),
      restorePackageRevision: '2.0',
    }),
  ).toBe(true);
});

it('refuses redirects when claiming a pasted invite', async () => {
  const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response('{}'));
  vi.stubGlobal('fetch', fetchMock);
  const walletKeys = createMockWalletKeys('//InviteRedirect');

  await UpstreamOperatorClient.claimInvite({
    operatorHost: 'https://203.0.113.10',
    inviteCode: 'member-invite-1',
    defaultAccountKeypair: await walletKeys.getLiquidLockingKeypair(),
    authKeypair: await walletKeys.getUpstreamOperatorAuthKeypair(),
  });

  expect(fetchMock).toHaveBeenCalledOnce();
  expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({
    method: 'POST',
    redirect: 'error',
  });
});

it('queries a missing upstream endpoint only once', async () => {
  const recoverOperatorHost = vi.fn().mockResolvedValue(undefined);
  const client = new UpstreamOperatorClient(undefined, undefined, recoverOperatorHost);

  await expect(client.resolveOperatorHost()).resolves.toBeUndefined();
  await expect(client.resolveOperatorHost()).resolves.toBeUndefined();

  expect(recoverOperatorHost).toHaveBeenCalledOnce();
});

it('does not treat a legacy public RPC host as an upstream operator', async () => {
  storeMocks.config.bootstrapDetails = {
    type: BootstrapType.Public,
    routerHost: 'rpc.argon.network',
  };
  storeMocks.config.upstreamOperator = undefined;
  storeMocks.recoverUpstreamHost.mockResolvedValue(undefined);
  const { getUpstreamOperatorClient } = await import('../stores/upstreamOperator.ts');

  await expect(getUpstreamOperatorClient().resolveOperatorHost()).resolves.toBeUndefined();

  expect(storeMocks.recoverUpstreamHost).toHaveBeenCalledOnce();
});

it('retries upstream resolution after a transient failure', async () => {
  const recoverOperatorHost = vi
    .fn()
    .mockRejectedValueOnce(new Error('Archive RPC unavailable'))
    .mockResolvedValue(undefined);
  const client = new UpstreamOperatorClient(undefined, undefined, recoverOperatorHost);

  await expect(client.resolveOperatorHost()).rejects.toThrow('Archive RPC unavailable');
  await expect(client.resolveOperatorHost()).resolves.toBeUndefined();

  expect(recoverOperatorHost).toHaveBeenCalledTimes(2);
});

it('retries an HTTP failure when chain recovery resolves a different host', async () => {
  const oldHost = 'https://old-router.example';
  const recoveredHost = 'https://new-router.example';
  const authClient = new ServerAuthClient(() => createMockWalletKeys('//HttpRecovery'));
  const getMemberSessionId = vi.spyOn(authClient, 'getMemberSessionId').mockImplementation(async host => {
    if (host === oldHost) {
      throw new RequestStatusError('Old router no longer serves this member.', 404);
    }

    return 'session-member';
  });
  const recoverOperatorHost = vi.fn().mockResolvedValue(recoveredHost);
  const client = new UpstreamOperatorClient(authClient, () => oldHost, recoverOperatorHost);

  await expect(client.getMemberSessionId()).resolves.toBe('session-member');
  await expect(client.getMemberSessionId()).resolves.toBe('session-member');

  expect(getMemberSessionId).toHaveBeenNthCalledWith(1, oldHost, {});
  expect(getMemberSessionId).toHaveBeenNthCalledWith(2, recoveredHost, {});
  expect(getMemberSessionId).toHaveBeenNthCalledWith(3, oldHost, {});
  expect(getMemberSessionId).toHaveBeenNthCalledWith(4, recoveredHost, {});
  expect(recoverOperatorHost).toHaveBeenCalledTimes(2);
});

it('preserves a router upgrade requirement for the calling workflow', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => {
      return new Response(
        JSON.stringify({
          error: 'Update Argon Desktop and try again.',
          code: 'DESKTOP_UPGRADE_REQUIRED',
          minimumDesktopVersion: '2.3.5',
        }),
        { status: 426 },
      );
    }),
  );

  await expect(
    UpstreamOperatorClient.getBitcoinLockStatus('https://operator.example', 'offer-code'),
  ).rejects.toMatchObject({
    status: 426,
    code: 'DESKTOP_UPGRADE_REQUIRED',
    minimumDesktopVersion: '2.3.5',
  });
});
