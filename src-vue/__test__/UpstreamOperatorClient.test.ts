import type { ITreasuryMemberSeal } from '@argonprotocol/apps-core';
import { afterEach, expect, it, vi } from 'vitest';
import { RequestStatusError, ServerAuthClient } from '../lib/ServerAuthClient.ts';
import { hasOperationsUpgradeRequest, UpstreamOperatorClient } from '../lib/UpstreamOperatorClient.ts';
import { WalletSigningUnavailableError } from '../lib/WalletKeys.ts';
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
const roleClaim = {
  discordApplicationId: '123456789012345678',
  verificationCode: `ARGON-${'a'.repeat(32)}`,
  operationalAccountId: 'operational-account',
};

vi.mock('../stores/config.ts', () => ({
  getConfig: () => storeMocks.config,
}));
vi.mock('../stores/server.ts', () => ({
  getUpstreamOperatorAuthClient: () => undefined,
}));
vi.mock('../stores/wallets.ts', () => ({
  getWalletKeys: () => ({ canSign: true }),
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

it('recognizes an operations upgrade request from the restored package revision', () => {
  expect(
    hasOperationsUpgradeRequest({
      restorePackageRevision: '3.1.1788969734729',
    }),
  ).toBe(true);
});

it('does not confuse a coupon revision with an operations upgrade request', () => {
  expect(
    hasOperationsUpgradeRequest({
      restorePackageRevision: '3.0.1',
    }),
  ).toBe(false);
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

it('does not repeatedly recover an upstream endpoint when wallet signing is unavailable', async () => {
  const recoverOperatorHost = vi.fn().mockRejectedValue(new WalletSigningUnavailableError());
  const client = new UpstreamOperatorClient(undefined, undefined, recoverOperatorHost);

  await expect(client.resolveOperatorHost()).resolves.toBeUndefined();
  await expect(client.resolveOperatorHost()).resolves.toBeUndefined();

  expect(recoverOperatorHost).toHaveBeenCalledOnce();
});

it('loads a persisted upstream host without signing or contacting it', async () => {
  const recoverOperatorHost = vi.fn();
  const fetchMock = vi.fn();
  const serverAuthClient = new ServerAuthClient(() =>
    createMockWalletKeys('//ReadOnlyUpstream', { canSign: false, canAccessServer: false }),
  );
  const client = new UpstreamOperatorClient(serverAuthClient, () => 'https://operator.example', recoverOperatorHost);
  vi.stubGlobal('fetch', fetchMock);

  await expect(client.resolveOperatorHost()).resolves.toBe('https://operator.example');
  await expect(client.getMemberSessionId()).rejects.toMatchObject({ name: 'WalletSigningUnavailableError' });
  expect(recoverOperatorHost).not.toHaveBeenCalled();
  expect(fetchMock).not.toHaveBeenCalled();
});

it('authenticates to an upstream independently of access to the managed server', async () => {
  const serverAuthClient = new ServerAuthClient(() =>
    createMockWalletKeys('//RemoteSignerUpstream', { canSign: true, canAccessServer: false }),
  );
  const getMemberSessionId = vi.spyOn(serverAuthClient, 'getMemberSessionId').mockResolvedValue('member-session');
  const client = new UpstreamOperatorClient(serverAuthClient, () => 'https://operator.example');

  await expect(client.getMemberSessionId()).resolves.toBe('member-session');
  expect(getMemberSessionId).toHaveBeenCalledWith('https://operator.example', {});
});

it('requests a Treasury member seal with the authenticated member session', async () => {
  const proof: ITreasuryMemberSeal = {
    genesisHash: `0x${'11'.repeat(32)}`,
    vaultId: 12,
    signature: '0x1234',
  };
  const authClient = new ServerAuthClient(() => createMockWalletKeys('//TreasuryMemberProof'));
  const sessionId = 'member-session';
  vi.spyOn(authClient, 'getMemberSessionId').mockResolvedValue(sessionId);
  const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => Response.json(proof));
  vi.stubGlobal('fetch', fetchMock);
  const client = new UpstreamOperatorClient(authClient, () => 'https://operator.example');

  await expect(client.getTreasuryMemberSeal(roleClaim)).resolves.toEqual(proof);
  expect(fetchMock).toHaveBeenCalledOnce();
  expect(fetchMock.mock.calls[0]?.[0]).toBe(
    `https://operator.example/auth/member-proof?sessionId=${encodeURIComponent(sessionId)}`,
  );
  expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({
    method: 'POST',
    body: JSON.stringify(roleClaim),
  });
});

it('skips the Treasury member seal when there is no upstream operator', async () => {
  const fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
  const client = new UpstreamOperatorClient(new ServerAuthClient(() => createMockWalletKeys('//NoUpstream')));

  await expect(client.getTreasuryMemberSeal(roleClaim)).resolves.toBeUndefined();
  expect(fetchMock).not.toHaveBeenCalled();
});

it('skips the Treasury member seal when the upstream router predates the endpoint', async () => {
  const authClient = new ServerAuthClient(() => createMockWalletKeys('//LegacyUpstream'));
  vi.spyOn(authClient, 'getMemberSessionId').mockResolvedValue('member-session');
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response('Not Found', { status: 404 })),
  );
  const client = new UpstreamOperatorClient(authClient, () => 'https://operator.example');

  await expect(client.getTreasuryMemberSeal(roleClaim)).resolves.toBeUndefined();
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
