import {
  setFetchImplementation,
  type ITreasuryMemberSeal,
  type IBitcoinCooperativeReleaseRequest,
} from '@argonprotocol/apps-core';
import { fetch as tauriFetch } from '@tauri-apps/plugin-http';
import { afterEach, expect, it, vi } from 'vitest';
import { RequestStatusError, ServerAuthClient } from '../lib/ServerAuthClient.ts';
import { hasOperationsUpgradeRequest, UpstreamOperatorClient } from '../lib/UpstreamOperatorClient.ts';
import { WalletSigningUnavailableError } from '../lib/WalletKeys.ts';
import { createMockWalletKeys } from './helpers/wallet.ts';
import { BootstrapType, ServerType } from '../interfaces/IConfig.ts';
import { ServerApiClient } from '../lib/ServerApiClient.ts';

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
  setFetchImplementation();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

it.each(['capability', 'mailbox', 'authentication', 'relay', 'canceled relay'])(
  'releases a stalled native %s response by its deadline so another check can run',
  async operation => {
    vi.useFakeTimers();
    let requests = 0;
    const sentBodyChunks = new Set<number>();
    vi.stubGlobal('window', {
      __TAURI_INTERNALS__: {
        invoke: async (command: string, args: { rid: number }) => {
          if (command === 'plugin:http|fetch') return ++requests;
          if (command === 'plugin:http|fetch_send') {
            return { status: 200, statusText: 'OK', url: 'https://operator.example/', headers: [], rid: args.rid };
          }
          if (command === 'plugin:http|fetch_read_body') {
            if (args.rid === 1) return new Promise(() => {});
            if (sentBodyChunks.has(args.rid)) return new Uint8Array([1]).buffer;
            sentBodyChunks.add(args.rid);
            const body = JSON.stringify({ bitcoinCooperativeReleaseMailboxVersion: 1 });
            return new Uint8Array([...new TextEncoder().encode(body), 0]).buffer;
          }
          if (command === 'plugin:http|fetch_cancel' || command === 'plugin:http|fetch_cancel_body') return;
          throw new Error(`Unexpected native HTTP command: ${command}`);
        },
      },
    });
    setFetchImplementation(tauriFetch);
    const auth = new ServerAuthClient(() => createMockWalletKeys('//StalledServerAuth'));
    if (operation === 'relay' || operation === 'canceled relay') {
      vi.spyOn(auth, 'getMemberSessionId').mockResolvedValue('synthetic-session');
    }
    const operator = new UpstreamOperatorClient(auth, () => 'https://operator.example');
    const server = new ServerApiClient(() => ({ type: ServerType.CustomServer, ipAddress: '203.0.113.10' }), auth, {
      canAccessServer: true,
    });
    let outcome = 'pending';
    const controller = new AbortController();
    let request: Promise<unknown>;
    if (operation === 'authentication') request = operator.getMemberSessionId();
    else if (operation === 'mailbox') request = server.getPendingBitcoinCooperativeReleases();
    else if (operation === 'relay' || operation === 'canceled relay') {
      request = operator.requestEthereumGatewayCatchUp(
        { sourceChain: 'Ethereum', throughGatewayActivityNonce: 7n },
        controller.signal,
      );
    } else request = operator.checkBitcoinCooperativeReleaseSupport();
    const settled = request.then(
      () => {
        outcome = 'finished';
      },
      error => {
        outcome = error.name;
      },
    );

    await vi.advanceTimersByTimeAsync(10_001);
    if (operation === 'relay') {
      expect(outcome).toBe('pending');
      await vi.advanceTimersByTimeAsync(20_000);
    } else if (operation === 'canceled relay') {
      expect(outcome).toBe('pending');
      controller.abort();
      await vi.advanceTimersByTimeAsync(0);
    }

    let expectedOutcome = 'TimeoutError';
    if (operation === 'mailbox') expectedOutcome = 'finished';
    if (operation === 'canceled relay') expectedOutcome = 'AbortError';
    expect(outcome).toBe(expectedOutcome);
    await settled;
    await expect(operator.checkBitcoinCooperativeReleaseSupport()).resolves.toBeUndefined();
  },
);

it('does not post or recover hosts when a relay is canceled during authentication', async () => {
  const fetchMock = vi.fn(async () => new Response(JSON.stringify({ outcome: 'Noop' })));
  vi.stubGlobal('fetch', fetchMock);
  const auth = new ServerAuthClient(() => createMockWalletKeys('//CanceledRelay'));
  let releaseAuth!: (session: string) => void;
  const getMemberSessionId = vi.spyOn(auth, 'getMemberSessionId').mockImplementation(
    () =>
      new Promise<string>(resolve => {
        releaseAuth = resolve;
      }),
  );
  const recoverHost = vi.fn(async () => 'https://replacement.example');
  const client = new UpstreamOperatorClient(auth, () => 'https://operator.example', recoverHost);
  const controller = new AbortController();
  const request = client.requestEthereumGatewayCatchUp(
    { sourceChain: 'Ethereum', throughGatewayActivityNonce: 7n },
    controller.signal,
  );
  await vi.waitFor(() => expect(getMemberSessionId).toHaveBeenCalledOnce());
  controller.abort();
  releaseAuth('session');
  await expect(request).rejects.toThrow();
  expect(fetchMock).not.toHaveBeenCalled();
  expect(recoverHost).not.toHaveBeenCalled();
});

it('shows an upgrade requirement before authenticating or posting a return to the current router protocol', async () => {
  const fetchMock = vi.fn(async () => new Response(JSON.stringify({ status: 'ok', authEnabled: true })));
  vi.stubGlobal('fetch', fetchMock);
  const authClient = new ServerAuthClient(() => createMockWalletKeys('//ReturnMailboxUpgrade'));
  const getMemberSessionId = vi.spyOn(authClient, 'getMemberSessionId');
  const client = new UpstreamOperatorClient(authClient, () => 'https://operator.example');
  const request: IBitcoinCooperativeReleaseRequest = {
    version: 1,
    releaseId: 'synthetic-return',
    ownerAccount: '5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY',
    vaultId: 7,
    lockId: 42,
    createdAtArgonBlock: 123,
    utxoRef: { txid: `0x${'42'.repeat(32)}`, outputIndex: 0 },
    satoshis: 50_000n,
    toScriptPubkey: `0x0014${'12'.repeat(20)}`,
    destinationSatoshis: 49_000n,
    changeSatoshis: 0n,
    bitcoinNetworkFee: 1_000n,
    feeRatePerSatVb: 5n,
    expectedTransactionId: `0x${'24'.repeat(32)}`,
    requestSignature: `0x${'11'.repeat(65)}`,
  };
  await expect(client.submitBitcoinCooperativeRelease(request)).rejects.toThrow('operator server needs an upgrade');
  expect(getMemberSessionId).not.toHaveBeenCalled();
  expect(fetchMock.mock.calls).toHaveLength(1);
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
    defaultAccountSigner: await walletKeys.getLiquidLockingSigner(),
    authSigner: await walletKeys.getUpstreamOperatorAuthSigner(),
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
