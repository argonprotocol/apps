import { expect, it, vi } from 'vitest';
import { RequestStatusError, ServerAuthClient } from '../lib/ServerAuthClient.ts';
import { UpstreamOperatorClient } from '../lib/UpstreamOperatorClient.ts';
import { createMockWalletKeys } from './helpers/wallet.ts';

it('queries a missing upstream endpoint only once', async () => {
  const recoverOperatorHost = vi.fn().mockResolvedValue(undefined);
  const client = new UpstreamOperatorClient(undefined, undefined, recoverOperatorHost);

  await expect(client.resolveOperatorHost()).resolves.toBeUndefined();
  await expect(client.resolveOperatorHost()).resolves.toBeUndefined();

  expect(recoverOperatorHost).toHaveBeenCalledOnce();
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
